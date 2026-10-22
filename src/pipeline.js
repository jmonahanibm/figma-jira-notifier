'use strict';

/**
 * The per-project diff pipeline, with all I/O injected.
 *
 * No Node-only imports (no fs, no axios), so the same code runs on the server
 * (src/diffRunner.js) and in the browser (gui/adapters.js).
 *
 * deps: {
 *   fetchFileTree(fileKey, token)                       -> document node
 *   fetchComments(fileKey, token)                       -> comment[]
 *   postCommentToFigma(fileKey, token, message, meta)   -> created comment
 *   postJiraComment(config, issueKey, adfList)          -> void
 *   getSnapshot(fileKey)                                -> snapshot | null  (may be async)
 *   saveSnapshot(fileKey, snapshot)                     -> void             (may be async)
 *   saveExport?(projectId, issueKey, content, ext)      -> void             (optional)
 *   notifySlack?(webhookUrl, message)                   -> void             (optional)
 *   notifyTeams?(webhookUrl, message)                   -> void             (optional)
 * }
 */

const { diffTrees, trimTree } = require('./differ');
const { buildCommentAdfList } = require('./adf');
const { buildMarkdown, buildHtml } = require('./exportBuilder');
const { buildSlackMessage, buildTeamsMessage } = require('./messageFormatter');

/** Current snapshot format. Older (or unversioned) snapshots are re-baselined. */
const SNAPSHOT_VERSION = 2;

/**
 * Extracts the document tree from a snapshot data structure.
 * Supports legacy format (document tree at root) and new format ({ document, knownCommentIds, knownResolvedCommentIds }).
 * @param {object|null} snapshot
 * @returns {object|null}
 */
function extractDocTree(snapshot) {
  if (!snapshot) return null;
  if (snapshot.document && snapshot.document.id) {
    return snapshot.document;
  }
  return snapshot;
}

/**
 * Extracts known comment IDs array from a snapshot data structure.
 * @param {object|null} snapshot
 * @returns {string[]}
 */
function extractKnownCommentIds(snapshot) {
  if (!snapshot) return [];
  if (Array.isArray(snapshot.knownCommentIds)) {
    return snapshot.knownCommentIds;
  }
  if (Array.isArray(snapshot._knownCommentIds)) {
    return snapshot._knownCommentIds;
  }
  return [];
}

/**
 * Extracts known resolved comment IDs array from a snapshot data structure.
 * @param {object|null} snapshot
 * @returns {string[]}
 */
function extractKnownResolvedCommentIds(snapshot) {
  if (!snapshot) return [];
  if (Array.isArray(snapshot.knownResolvedCommentIds)) {
    return snapshot.knownResolvedCommentIds;
  }
  return [];
}

/**
 * Posts a single consolidated changelog comment per file back to Figma.
 *
 * The comment text uses plain Figma-safe formatting:
 *   - One header line with date, Jira issue key (clickable link) and change count
 *   - One section per page/screen listing each changed node with its emoji change lines
 *
 * Gated on `enabled` — pass `false` to suppress the post entirely (per-project toggle).
 *
 * @param {Function} postCommentToFigma  (fileKey, token, message, clientMeta) => created comment
 * @param {string}   fileKey
 * @param {string}   token
 * @param {object}   diffResult
 * @param {string}   runAt         ISO date string
 * @param {string}   jiraIssueKey
 * @param {string}   jiraBaseUrl   Used to build a clickable Jira link in the comment
 * @param {boolean}  [enabled=true]
 * @returns {Promise<string|null>} Id of the created Figma comment, or null if none was posted
 */
async function syncChangesToFigma(postCommentToFigma, fileKey, token, diffResult, runAt, jiraIssueKey, jiraBaseUrl = '', enabled = true) {
  if (!enabled) return null;
  if (!token || !fileKey) return null;

  // Build a clickable Jira link when we have a base URL, otherwise plain text
  const jiraRef = (jiraBaseUrl && jiraIssueKey)
    ? `${jiraIssueKey} (${jiraBaseUrl.replace(/\/$/, '')}/browse/${jiraIssueKey})`
    : jiraIssueKey;

  // Notification line prepended to the Item 2 layout
  const notificationLine = jiraRef
    ? `🔔 Design changes were logged to ${jiraRef} — developers have been notified.`
    : '🔔 Design changes detected — developers have been notified.';

  // Use the shared Item 2 export layout (same format as Slack/Teams/export)
  const { buildMarkdown } = require('./exportBuilder');
  const figmaFileName = diffResult.figmaFileName || '';
  const changelog = buildMarkdown(diffResult, fileKey, figmaFileName, runAt, jiraIssueKey, 'both');

  const message = `${notificationLine}\n\n${changelog}`;

  // Anchor to the first changed top-level frame; fall back to canvas origin
  let clientMeta = { x: 0, y: 0 };
  const firstFrameId = (diffResult.updated.find(n => n.frameId) || diffResult.added.find(n => n.frameId))?.frameId;
  if (firstFrameId) {
    clientMeta = { node_id: firstFrameId, node_offset: { x: 0, y: 0 } };
  }

  try {
    const created = await postCommentToFigma(fileKey, token, message, clientMeta);
    console.log(`[Runner] Posted consolidated changelog comment to Figma for file ${fileKey}.`);
    return (created && created.id) || null;
  } catch (err) {
    console.warn(`[Runner] Failed to post single comment to Figma: ${err.message}`);
    return null;
  }
}

/**
 * Runs the full diff pipeline for a single project config entry.
 *
 * Steps:
 *  1. Fetch current Figma document tree and (if syncComments is enabled) comments
 *  2. Load previous snapshot
 *  3. Diff trees and find new, completed, and open comments
 *  4. If changes exist, build ADF comment and post to Jira
 *  5. Save new snapshot (only after successful Jira post)
 *
 * @param {object} project   A single entry from config.projects
 * @param {object} config    The full config object (for tokens/credentials)
 * @param {object} deps      Injected I/O — see the file header
 * @returns {Promise<{projectId: string, figmaFileName: string, status: 'posted'|'no_changes'|'first_run'|'rebaselined'|'error', changesCount: number, error?: string}>}
 */
async function runProjectPipeline(project, config, deps) {
  const { id: projectId, figmaFileKey, figmaUrl = '', figmaFileName, jiraIssueKey, mentionedUsers = [], syncComments = true, postFigmaComment = true, exportFormat = 'none', exclusions = null, channelOverride = null } = project;

  try {
    console.log(`[Runner] Starting project "${figmaFileName}" (${figmaFileKey}) → ${jiraIssueKey}`);

    const [currentTree, currentComments] = await Promise.all([
      deps.fetchFileTree(figmaFileKey, config.figmaToken),
      syncComments
        ? Promise.resolve(deps.fetchComments(figmaFileKey, config.figmaToken)).catch(err => {
            console.warn(`[Runner] Failed to fetch comments for "${figmaFileName}": ${err.message}`);
            return [];
          })
        : Promise.resolve([])
    ]);

    const previousSnapshot = await deps.getSnapshot(figmaFileKey);

    // No snapshot (first run) or an older/unversioned one (taken before full-depth
    // fetches and top-level screen grouping): save a fresh baseline and post nothing.
    // Diffing against an old snapshot would report every nested node as "added".
    const isStale = !previousSnapshot || previousSnapshot._snapshotVersion !== SNAPSHOT_VERSION;
    if (isStale) {
      const baselineSnapshot = {
        _snapshotVersion: SNAPSHOT_VERSION,
        document: trimTree(currentTree),
        knownCommentIds: currentComments.map(c => c.id).filter(Boolean),
        knownResolvedCommentIds: currentComments.filter(c => Boolean(c.resolved_at)).map(c => c.id).filter(Boolean),
        _savedAt: new Date().toISOString()
      };
      await deps.saveSnapshot(figmaFileKey, baselineSnapshot);
      const status = previousSnapshot ? 'rebaselined' : 'first_run';
      console.log(`[Runner] ${status === 'first_run' ? 'First run' : 'Snapshot format upgraded'} for "${figmaFileName}" — baseline snapshot saved (${currentComments.length} comments recorded). No comment posted.`);
      return { projectId, figmaFileName, status, changesCount: 0 };
    }

    const previousDoc = extractDocTree(previousSnapshot);
    const knownCommentIds = new Set(extractKnownCommentIds(previousSnapshot));
    const knownResolvedCommentIds = new Set(extractKnownResolvedCommentIds(previousSnapshot));

    let commentsDiff = { newComments: [], resolvedComments: [], openComments: [] };

    if (syncComments) {
      // 1. New comments: IDs not seen in previous snapshot
      const newComments = currentComments.filter(c => c && c.id && !knownCommentIds.has(c.id));

      // 2. Completed comments: Was open before, now has resolved_at
      const resolvedComments = currentComments.filter(c =>
        c && c.id && c.resolved_at && !knownResolvedCommentIds.has(c.id) && knownCommentIds.has(c.id)
      );

      // 3. Open comments: Currently unresolved comments on the file
      const openComments = currentComments.filter(c => c && c.id && !c.resolved_at);

      commentsDiff = { newComments, resolvedComments, openComments };
    }

    const diffResult = diffTrees(previousDoc, currentTree, commentsDiff, exclusions ? { exclusions } : {});

    if (diffResult.totalChanges === 0) {
      console.log(`[Runner] No changes detected for "${figmaFileName}" — skipping Jira comment.`);
      return { projectId, figmaFileName, status: 'no_changes', changesCount: 0 };
    }

    const runAt = new Date().toISOString();
    const snapshotDate = previousSnapshot._savedAt || null;

    const adfList = buildCommentAdfList(
      diffResult,
      figmaFileName,
      figmaUrl,
      runAt,
      mentionedUsers,
      snapshotDate
    );

    // -----------------------------------------------------------------------
    // G7 partial-failure delivery policy (Items 6 + 7)
    //
    // Notification channels (Jira, Slack, Teams) are tried independently.
    // The snapshot is saved if at least one succeeds.
    // Optional outputs (export, Figma comment) never affect the snapshot.
    // -----------------------------------------------------------------------

    // Resolve effective channel config: per-project override takes precedence.
    const globalChannels = config.channels || {};
    const effectiveChannels = channelOverride ? { ...globalChannels, ...channelOverride } : globalChannels;
    const jiraEnabled  = effectiveChannels.jira !== false; // on by default
    const slackEnabled = !!(effectiveChannels.slackWebhookUrl && deps.notifySlack);
    const teamsEnabled = !!(effectiveChannels.teamsWebhookUrl && deps.notifyTeams);

    // Build the shared message content for Slack/Teams.
    // fileKey is extracted from the Figma URL or falls back to figmaFileKey.
    const msgFileKey = (figmaUrl ? (figmaUrl.match(/figma\.com\/(?:design|file)\/([A-Za-z0-9]+)/)?.[1] || '') : '') || figmaFileKey;
    const deepLinkTarget = config.deepLinkTarget || 'both';

    const channelResults = {};

    // --- Jira (notification channel) ---
    if (jiraEnabled) {
      try {
        await deps.postJiraComment(config, jiraIssueKey, adfList);
        channelResults.jira = { status: 'sent' };
      } catch (jiraErr) {
        channelResults.jira = { status: 'failed', error: jiraErr.message };
        console.warn(`[Runner] Jira post failed for "${figmaFileName}": ${jiraErr.message}`);
      }
    }

    // --- Slack (notification channel) ---
    if (slackEnabled) {
      try {
        const slackMsg = buildSlackMessage(diffResult, msgFileKey, figmaFileName, runAt, jiraIssueKey, mentionedUsers, deepLinkTarget);
        await deps.notifySlack(effectiveChannels.slackWebhookUrl, slackMsg);
        channelResults.slack = { status: 'sent' };
      } catch (slackErr) {
        channelResults.slack = { status: 'failed', error: slackErr.message };
        console.warn(`[Runner] Slack notification failed for "${figmaFileName}": ${slackErr.message}`);
      }
    }

    // --- Teams (notification channel) ---
    if (teamsEnabled) {
      try {
        const teamsMsg = buildTeamsMessage(diffResult, msgFileKey, figmaFileName, runAt, jiraIssueKey, mentionedUsers, deepLinkTarget);
        await deps.notifyTeams(effectiveChannels.teamsWebhookUrl, teamsMsg);
        channelResults.teams = { status: 'sent' };
      } catch (teamsErr) {
        channelResults.teams = { status: 'failed', error: teamsErr.message };
        console.warn(`[Runner] Teams notification failed for "${figmaFileName}": ${teamsErr.message}`);
      }
    }

    // --- Snapshot rule (G7) ---
    // At least one notification channel must succeed to save the snapshot.
    const notificationChannels = Object.keys(channelResults);
    const anyChannelSucceeded = notificationChannels.some(ch => channelResults[ch] && channelResults[ch].status === 'sent');
    // Guard: treat "no channels enabled" the same as all failed (nothing was sent).
    const allChannelsFailed = notificationChannels.length === 0 ||
      notificationChannels.every(ch => channelResults[ch] && channelResults[ch].status === 'failed');

    if (allChannelsFailed) {
      // Do not advance the snapshot; the next run will pick up the same changes.
      const runStatus = 'error';
      const errMsg = notificationChannels.map(ch => channelResults[ch] && channelResults[ch].error).filter(Boolean).join('; ');
      if (deps.appendRunEntry) {
        try {
          deps.appendRunEntry({
            projectId, figmaFileName, jiraIssueKey,
            runAt, status: runStatus,
            changesCount: diffResult.totalChanges,
            channels: channelResults,
            adfList
          });
        } catch { /* run log is non-critical */ }
      }
      return { projectId, figmaFileName, status: runStatus, changesCount: diffResult.totalChanges, channels: channelResults, error: errMsg };
    }

    // --- Optional outputs (do not affect snapshot) ---

    // Export document
    if (exportFormat && exportFormat !== 'none' && deps.saveExport) {
      const deepLinkTarget = config.deepLinkTarget || 'both';
      const exportFileKey = (figmaUrl ? (figmaUrl.match(/figma\.com\/(?:design|file)\/([A-Za-z0-9]+)/)?.[1] || '') : '') || figmaFileKey;
      try {
        if (exportFormat === 'md' || exportFormat === 'both') {
          const md = buildMarkdown(diffResult, exportFileKey, figmaFileName, runAt, jiraIssueKey, deepLinkTarget);
          await deps.saveExport(projectId, jiraIssueKey, md, 'md');
        }
        if (exportFormat === 'html' || exportFormat === 'both') {
          const html = buildHtml(diffResult, exportFileKey, figmaFileName, runAt, jiraIssueKey, deepLinkTarget);
          await deps.saveExport(projectId, jiraIssueKey, html, 'html');
        }
        console.log(`[Runner] Export (${exportFormat}) saved for "${figmaFileName}".`);
      } catch (exportErr) {
        console.warn(`[Runner] Note: Could not save export for "${figmaFileName}": ${exportErr.message}`);
      }
    }

    // Figma comment post-back (optional output)
    let ownCommentId = null;
    try {
      ownCommentId = await syncChangesToFigma(
        deps.postCommentToFigma, figmaFileKey, config.figmaToken,
        diffResult, runAt, jiraIssueKey,
        config.jiraBaseUrl || '', postFigmaComment
      );
    } catch (figmaErr) {
      console.warn(`[Runner] Note: Could not post changelog comment to Figma: ${figmaErr.message}`);
    }

    // --- Save updated snapshot ---
    const allCommentIds = Array.from(new Set([
      ...Array.from(knownCommentIds),
      ...currentComments.map(c => c.id).filter(Boolean),
      ...(ownCommentId ? [ownCommentId] : [])
    ]));

    const allResolvedCommentIds = Array.from(new Set([
      ...Array.from(knownResolvedCommentIds),
      ...currentComments.filter(c => Boolean(c.resolved_at)).map(c => c.id).filter(Boolean)
    ]));

    const newSnapshot = {
      _snapshotVersion: SNAPSHOT_VERSION,
      document: trimTree(currentTree),
      knownCommentIds: allCommentIds,
      knownResolvedCommentIds: allResolvedCommentIds,
      _savedAt: runAt
    };
    await deps.saveSnapshot(figmaFileKey, newSnapshot);

    // 'partial' when some notification channels failed; 'posted' when all succeeded
    const anyFailed = notificationChannels.some(ch => channelResults[ch] && channelResults[ch].status === 'failed');
    const runStatus = anyFailed ? 'partial' : 'posted';

    if (deps.appendRunEntry) {
      try {
        deps.appendRunEntry({
          projectId, figmaFileName, jiraIssueKey,
          runAt, status: runStatus,
          changesCount: diffResult.totalChanges,
          channels: channelResults,
          adfList
        });
      } catch { /* run log is non-critical */ }
    }

    const commentsSummary = syncComments
      ? `(${commentsDiff.newComments.length} new, ${commentsDiff.resolvedComments.length} resolved comments)`
      : '(comments disabled)';
    console.log(`[Runner] ${runStatus === 'partial' ? 'Partial post' : 'Posted'} ${diffResult.totalChanges} changes ${commentsSummary} for "${figmaFileName}" to ${jiraIssueKey}.`);
    return { projectId, figmaFileName, status: runStatus, changesCount: diffResult.totalChanges, channels: channelResults };

  } catch (err) {
    console.error(`[Runner] Error processing "${figmaFileName}": ${err.message}`);
    return { projectId, figmaFileName, status: 'error', changesCount: 0, error: err.message };
  }
}

module.exports = {
  SNAPSHOT_VERSION,
  runProjectPipeline,
  syncChangesToFigma,
  extractDocTree,
  extractKnownCommentIds,
  extractKnownResolvedCommentIds
};
