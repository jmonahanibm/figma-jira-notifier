'use strict';

/**
 * Pure ADF (Atlassian Document Format) builders and Jira comment formatters.
 *
 * No Node-only imports (no fs, no axios). Safe to require from the server
 * and to bundle for the browser.
 */

const { buildNodeLinks } = require('./figmaLinks');

// ---------------------------------------------------------------------------
// Low-level ADF node constructors
// ---------------------------------------------------------------------------

function adfText(text, bold = false) {
  const node = { type: 'text', text };
  if (bold) node.marks = [{ type: 'strong' }];
  return node;
}

function adfLink(text, href) {
  return { type: 'text', text, marks: [{ type: 'link', attrs: { href } }] };
}

function adfParagraph(...inlineNodes) {
  return { type: 'paragraph', content: inlineNodes };
}

function adfBulletList(items) {
  return {
    type: 'bulletList',
    content: items.map(item => ({
      type: 'listItem',
      content: [adfParagraph(...(Array.isArray(item) ? item : [adfText(item)]))]
    }))
  };
}

function adfHeading(level, text) {
  return { type: 'heading', attrs: { level }, content: [adfText(text)] };
}

/**
 * Builds an ADF mention node for a user.
 *
 * A real Jira mention requires a proper accountId (not an email, not a display
 * name). When the user record has no real jiraAccountId, we emit bold plain
 * text instead — it is visible in the comment but does not @-notify anyone.
 *
 * Rules:
 *  - `jiraAccountId` present and not an email → real mention node
 *  - everything else → bold text paragraph node (plain @Name)
 *
 * @param {object|string} user
 * @returns {object}  ADF inline node (mention or text)
 */
function adfMention(user) {
  // Legacy: plain string (old format stored just an email or name)
  if (typeof user === 'string') {
    // A string that looks like an email or plain name has no real accountId.
    return adfText(`@${user.includes('@') ? user.split('@')[0] : user}`, true);
  }

  const { jiraAccountId, displayName, email } = user;
  const label = displayName || (email ? email.split('@')[0] : jiraAccountId || 'unknown');

  // Only emit a mention when jiraAccountId is a real Jira accountId.
  // A real accountId never contains '@'; if it does, it is an email saved by v1.
  const hasRealAccountId = jiraAccountId && !jiraAccountId.includes('@');
  if (hasRealAccountId) {
    return { type: 'mention', attrs: { id: jiraAccountId, text: `@${label}` } };
  }

  // No real accountId — plain bold text so the name is still visible.
  return adfText(`@${label}`, true);
}

function adfRule() {
  return { type: 'rule' };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Human-readable label for a Figma node type. */
function typeLabel(type) {
  const map = {
    FRAME: 'Frame', GROUP: 'Group', COMPONENT: 'Component',
    COMPONENT_SET: 'Component Set', INSTANCE: 'Instance',
    TEXT: 'Text', RECTANGLE: 'Rectangle', ELLIPSE: 'Ellipse',
    VECTOR: 'Vector', BOOLEAN_OPERATION: 'Boolean Op', SECTION: 'Section'
  };
  return map[type] || type;
}

/**
 * Detects "sweeping" changes — change descriptions shared by >= threshold nodes
 * across the whole page. Returns { sweepingDescs, restEntries }.
 *
 * Works with structured change objects: equality is tested by JSON key
 * `type` (e.g. 'fill_colour') rather than object identity, so two change
 * objects with the same type are treated as the same sweeping change.
 */
function partitionSweeping(entries, threshold = 3) {
  // Key changes by their `type` field (structured) or full string (legacy).
  function changeKey(c) {
    return (c && typeof c === 'object' && c.type) ? c.type : String(c);
  }

  // Count how many entries carry each change type
  const changeCount = new Map();
  for (const entry of entries) {
    const seenInEntry = new Set();
    for (const c of (entry.changes || [])) {
      const key = changeKey(c);
      if (!seenInEntry.has(key)) {
        changeCount.set(key, (changeCount.get(key) || 0) + 1);
        seenInEntry.add(key);
      }
    }
  }

  // Collect representative change objects for keys that meet the threshold
  const sweepingKeys = new Set(
    [...changeCount.entries()].filter(([, n]) => n >= threshold).map(([k]) => k)
  );

  // For each sweeping key, pick the first encountered change object as the rep
  const sweepingDescs = new Map(); // key → representative change object
  for (const entry of entries) {
    for (const c of (entry.changes || [])) {
      const key = changeKey(c);
      if (sweepingKeys.has(key) && !sweepingDescs.has(key)) {
        sweepingDescs.set(key, c);
      }
    }
  }

  // Build restEntries: keep entries whose changes survive after removing sweeping keys.
  // Also keep entries that had NO changes (added/removed nodes) — sweeping doesn't apply to them.
  const restEntriesFinal = entries.map(entry => {
    const orig = entry.changes || [];
    const filtered = orig.filter(c => !sweepingKeys.has(changeKey(c)));
    // Keep entry if it originally had no changes (added/removed) OR still has changes
    if (orig.length === 0 || filtered.length > 0) return { ...entry, changes: filtered };
    return null;
  }).filter(Boolean);

  return { sweepingDescs: new Map([...sweepingDescs.entries()]), sweepingKeys, restEntries: restEntriesFinal };
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

/**
 * Builds the inline nodes for a single entry header line.
 *
 * Layout (spec Item 2):
 *   Updated/Added: **[Frame / Node](url)** [(Browser)(url)] *(Type)*
 *   Removed:       **Frame / Node** (Removed) *(Type)*
 *
 * jiraMode=true  → browser link only (no figma:// — Jira drops them)
 * jiraMode=false → both app and browser links
 *
 * Removed nodes get no links regardless of mode.
 */
function formatNodeHeader(node, action, figmaFileKey, figmaFileName, jiraMode = false) {
  const displayName = node.frameName ? `${node.frameName} / ${node.name}` : node.name;
  // Spec: *(Type)* — italic type label only, no action or page in the badge
  const typeBadge = `*(${typeLabel(node.type)})*`;

  const isRemoved = action === 'Removed';
  const inlines = [];

  if (isRemoved) {
    // No links for removed nodes — the node no longer exists in the file.
    inlines.push(adfText(displayName, true));
    inlines.push(adfText(' (Removed) '));
  } else {
    const { app: appUrl, browser: browserUrl } = buildNodeLinks(figmaFileKey, figmaFileName, node.id);
    if (jiraMode) {
      // Jira: browser link only (figma:// is stripped by Jira)
      if (browserUrl) {
        inlines.push(adfLink(displayName, browserUrl));
      } else {
        inlines.push(adfText(displayName, true));
      }
      inlines.push(adfText(' '));
    } else {
      // Non-Jira: app link for the name, separate Browser link
      if (appUrl) {
        inlines.push(adfLink(displayName, appUrl));
      } else {
        inlines.push(adfText(displayName, true));
      }
      if (browserUrl) {
        inlines.push(adfText(' ('));
        inlines.push(adfLink('Browser', browserUrl));
        inlines.push(adfText(') '));
      } else {
        inlines.push(adfText(' '));
      }
    }
  }

  inlines.push(adfText(typeBadge));
  return inlines;
}

/**
 * Renders one change object (structured) or string (legacy) as an ADF text node.
 * Structured: { emoji, label }. String: plain text (capitalised).
 */
function renderChangeLine(c) {
  if (c && typeof c === 'object' && c.label) {
    return [adfText(`${c.emoji} ${c.label}`)];
  }
  // Legacy string fallback
  const s = String(c);
  if (s.startsWith('text updated: ')) {
    const parts = s.replace('text updated: ', '').split(' → ');
    if (parts.length === 2) return [adfText(`✏️ Copy changed from "${parts[0]}" to "${parts[1]}"`)];
  }
  return [adfText(s.charAt(0).toUpperCase() + s.slice(1))];
}

function buildNodeEntryBlocks(node, action, figmaFileKey, figmaFileName, jiraMode = false) {
  const blocks = [];
  const headerInlines = formatNodeHeader(node, action, figmaFileKey, figmaFileName, jiraMode);
  blocks.push(adfParagraph(...headerInlines));

  if (action === 'Updated' && node.changes && node.changes.length > 0) {
    blocks.push(adfBulletList(node.changes.map(c => renderChangeLine(c))));
  } else if (action === 'Added') {
    blocks.push(adfBulletList([[adfText(`➕ New element added`)]]));
  } else if (action === 'Removed') {
    blocks.push(adfBulletList([[adfText(`➖ Removed`)]]));
  }
  return blocks;
}

function formatCommentBullet(comment) {
  const author = (comment.user && (comment.user.handle || comment.user.name)) || 'Unknown user';
  const message = comment.message || '(no message)';
  return [adfText(`${author}: `, true), adfText(message)];
}

/**
 * Builds the Comments section (New, Completed/Resolved, and Currently Open comments).
 */
function buildCommentsSection(commentsDiff) {
  if (!commentsDiff) return [];
  const newComments      = Array.isArray(commentsDiff) ? commentsDiff : (commentsDiff.newComments || []);
  const resolvedComments = Array.isArray(commentsDiff) ? [] : (commentsDiff.resolvedComments || []);
  const openComments     = Array.isArray(commentsDiff) ? [] : (commentsDiff.openComments || []);

  if (newComments.length === 0 && resolvedComments.length === 0 && openComments.length === 0) return [];

  const content = [adfHeading(3, 'Comments')];
  if (newComments.length > 0) {
    content.push(adfParagraph(adfText('New comments', true)));
    content.push(adfBulletList(newComments.map(formatCommentBullet)));
  }
  if (resolvedComments.length > 0) {
    content.push(adfParagraph(adfText('Completed comments', true)));
    content.push(adfBulletList(resolvedComments.map(formatCommentBullet)));
  }
  if (openComments.length > 0) {
    content.push(adfParagraph(adfText('Open comments', true)));
    content.push(adfBulletList(openComments.map(formatCommentBullet)));
  }
  content.push(adfRule());
  return content;
}

/**
 * Builds all page → screen → entry blocks.
 *
 * Layout per page:
 *   heading 2 — page name
 *   [Global updates section if partitionSweeping finds any]
 *   heading 3 — screen name (grouped by frameName)
 *     one entry block per changed node
 *   rule after each page
 *
 * @param {object[]} added
 * @param {object[]} removed
 * @param {object[]} updated
 * @param {string}   figmaFileKey
 * @param {string}   figmaFileName
 * @param {boolean}  jiraMode   When true, use browser links only (no figma://)
 * @param {number}   maxNodes   Stop after this many node entries (0 = unlimited)
 * @returns {{ content: object[], truncatedCount: number }}
 */
function buildPageSections(added, removed, updated, figmaFileKey = '', figmaFileName = '', jiraMode = false, maxNodes = 0) {
  const allPages = new Set([
    ...added.map(n => n.pageName || 'Unknown page'),
    ...removed.map(n => n.pageName || 'Unknown page'),
    ...updated.map(n => n.pageName || 'Unknown page'),
  ]);

  const content = [];
  let nodeCount = 0;
  let truncatedCount = 0;

  for (const page of allPages) {
    const pageAdded   = added.filter(n => (n.pageName || 'Unknown page') === page);
    const pageRemoved = removed.filter(n => (n.pageName || 'Unknown page') === page);
    const pageUpdated = updated.filter(n => (n.pageName || 'Unknown page') === page);
    const allPageEntries = [...pageUpdated, ...pageAdded, ...pageRemoved];

    content.push(adfHeading(2, page));

    // --- Global updates (sweeping changes): changes shared by ≥ 3 nodes on the page ---
    const { sweepingDescs, sweepingKeys, restEntries } = partitionSweeping(allPageEntries, 3);
    const updatedRest = restEntries.filter(e => pageUpdated.some(u => u.id === e.id));

    if (sweepingDescs.size > 0) {
      content.push(adfHeading(3, 'Global updates'));
      for (const [, repChange] of sweepingDescs) {
        // repChange is the representative structured change object for this sweep
        const descLabel = (repChange && typeof repChange === 'object' && repChange.label)
          ? `${repChange.emoji} ${repChange.label}`
          : String(repChange);
        const changeKey = (c) => (c && typeof c === 'object' && c.type) ? c.type : String(c);
        const matchingNodes = allPageEntries.filter(e =>
          (e.changes || []).some(c => sweepingKeys.has(changeKey(c)))
        );
        content.push(adfParagraph(adfText(`${descLabel} — ${matchingNodes.length} elements:`, false)));
        for (const node of matchingNodes) {
          if (maxNodes > 0 && nodeCount >= maxNodes) { truncatedCount++; continue; }
          const headerInlines = formatNodeHeader(node, 'Updated', figmaFileKey, figmaFileName, jiraMode);
          content.push(adfParagraph(...headerInlines));
          nodeCount++;
        }
      }
    }

    // --- Per-screen entries (remaining after removing sweeping-only nodes) ---
    // Collect all non-sweeping entries: updated (minus sweeping), added, removed
    const nonSweepUpdated = updatedRest;
    const screenNames = new Set([
      ...nonSweepUpdated.map(n => n.frameName || ''),
      ...pageAdded.map(n => n.frameName || ''),
      ...pageRemoved.map(n => n.frameName || '')
    ]);

    for (const screen of screenNames) {
      const screenUpdated = nonSweepUpdated.filter(n => (n.frameName || '') === screen);
      const screenAdded   = pageAdded.filter(n => (n.frameName || '') === screen);
      const screenRemoved = pageRemoved.filter(n => (n.frameName || '') === screen);

      const screenLabel = screen || page;
      content.push(adfHeading(3, screenLabel));

      for (const node of [...screenUpdated, ...screenAdded, ...screenRemoved]) {
        if (maxNodes > 0 && nodeCount >= maxNodes) { truncatedCount++; continue; }
        const action = screenUpdated.includes(node) ? 'Updated'
          : screenAdded.includes(node) ? 'Added' : 'Removed';
        content.push(...buildNodeEntryBlocks(node, action, figmaFileKey, figmaFileName, jiraMode));
        nodeCount++;
      }
    }

    content.push(adfRule());
  }

  return { content, truncatedCount };
}

// ---------------------------------------------------------------------------
// Chunker
// ---------------------------------------------------------------------------

function chunkAdfDocument(headerNodes, bodyNodes, footerNodes, maxCharsPerDoc = 24000) {
  if (bodyNodes.length === 0) {
    return [{ version: 1, type: 'doc', content: [...headerNodes, ...footerNodes] }];
  }

  const chunks = [];
  let currentBody = [];

  function calcDocSize(body) {
    return JSON.stringify({ version: 1, type: 'doc', content: [...headerNodes, ...body, ...footerNodes] }).length;
  }

  for (const node of bodyNodes) {
    const testBody = [...currentBody, node];
    if (currentBody.length > 0 && calcDocSize(testBody) > maxCharsPerDoc) {
      chunks.push(currentBody);
      currentBody = [node];
    } else {
      currentBody.push(node);
    }
  }
  if (currentBody.length > 0) chunks.push(currentBody);

  const totalParts = chunks.length;
  if (totalParts <= 1) {
    return [{ version: 1, type: 'doc', content: [...headerNodes, ...(chunks[0] || []), ...footerNodes] }];
  }

  return chunks.map((chunkNodes, index) => {
    const partNum = index + 1;
    const partHeaderNodes = headerNodes.map((hNode, hIdx) => {
      if (hIdx === 0 && hNode.type === 'paragraph' && Array.isArray(hNode.content)) {
        return { ...hNode, content: [...hNode.content, adfText(` (Part ${partNum} of ${totalParts})`, true)] };
      }
      return hNode;
    });
    return {
      version: 1, type: 'doc',
      content: [...partHeaderNodes, ...chunkNodes, ...(partNum === totalParts ? footerNodes : [])]
    };
  });
}

// ---------------------------------------------------------------------------
// Top-level comment builders
// ---------------------------------------------------------------------------

function buildCommentAdf(diffResult, figmaFileName, figmaUrl, runAt, mentionedUsers, snapshotDate, maxNodesInNotification = 0) {
  return buildCommentAdfList(diffResult, figmaFileName, figmaUrl, runAt, mentionedUsers, snapshotDate, maxNodesInNotification)[0];
}

/**
 * Builds the ADF comment list for a Jira post.
 *
 * Always uses jiraMode=true (browser links only — figma:// is stripped by Jira).
 * Large changelogs are split into multiple Jira comments by chunkAdfDocument.
 *
 * @param {object}   diffResult
 * @param {string}   figmaFileName
 * @param {string}   figmaUrl
 * @param {string}   runAt          ISO timestamp
 * @param {object[]} mentionedUsers
 * @param {string|null} snapshotDate
 * @param {number}   maxNodesInNotification  0 = unlimited
 * @returns {object[]}  Array of ADF doc objects (one per Jira comment part)
 */
function buildCommentAdfList(diffResult, figmaFileName, figmaUrl, runAt, mentionedUsers, snapshotDate, maxNodesInNotification = 0) {
  const { added, removed, updated, commentsDiff, comments = [], totalChanges, pages } = diffResult;
  const pagesLabel = pages.length > 0 ? pages.join(', ') : 'Unknown';

  const mentionNodes = mentionedUsers.flatMap(u => [adfMention(u), adfText(' ')]);

  const fileNameNode = figmaUrl
    ? { type: 'text', text: figmaFileName, marks: [{ type: 'link', attrs: { href: figmaUrl } }] }
    : adfText(figmaFileName);

  // Format run date: "D MMM YYYY at HH:MM UTC"
  let runLabel = runAt;
  try {
    const d = new Date(runAt);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const pad = n => String(n).padStart(2, '0');
    runLabel = `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} at ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
  } catch { /* keep raw string */ }

  // Header: # Design Changelog — {issueKey or filename}, File, Run, Pages affected
  const issueKeyMatch = figmaUrl ? null : null; // issueKey is not passed here; use fileName
  const titleText = `Design Changelog — ${figmaFileName}`;

  const headerNodes = [
    adfParagraph(adfText(titleText, true)),
    adfParagraph(adfText('File: ', true), fileNameNode),
    adfParagraph(adfText('Run: ', true), adfText(runLabel)),
    adfParagraph(adfText('Pages affected: ', true), adfText(pagesLabel)),
  ];

  if (!snapshotDate) {
    headerNodes.push(adfParagraph(adfText('No previous snapshot found. This is the first run — baseline saved, no diff to report.')));
  }
  headerNodes.push(adfRule());

  // Summary sentence: "N elements changed across S screens on P pages."
  if (totalChanges > 0 && (added.length + removed.length + updated.length) > 0) {
    const nodeChanges = added.length + removed.length + updated.length;
    const screenSet = new Set([
      ...added.map(n => n.frameName || n.pageName || ''),
      ...removed.map(n => n.frameName || n.pageName || ''),
      ...updated.map(n => n.frameName || n.pageName || '')
    ].filter(Boolean));
    const pageCount = pages.length;
    const screenCount = screenSet.size;
    const summaryParts = [
      `${nodeChanges} element${nodeChanges === 1 ? '' : 's'} changed`,
      screenCount > 0 ? `across ${screenCount} screen${screenCount === 1 ? '' : 's'}` : '',
      pageCount > 0 ? `on ${pageCount} page${pageCount === 1 ? '' : 's'}` : ''
    ].filter(Boolean).join(' ');
    headerNodes.push(adfParagraph(adfText(summaryParts + '.')));
  }

  const bodyNodes = [];
  const activeCommentsDiff = commentsDiff || (comments.length > 0 ? { newComments: comments } : null);
  if (activeCommentsDiff) bodyNodes.push(...buildCommentsSection(activeCommentsDiff));

  const fileKey = (figmaUrl ? (figmaUrl.match(/figma\.com\/(?:design|file)\/([A-Za-z0-9]+)/)?.[1] || '') : '') || figmaFileName;
  if (added.length > 0 || removed.length > 0 || updated.length > 0) {
    // jiraMode=true: browser links only (no figma:// links — Jira strips them)
    const { content: pageSectionContent, truncatedCount } = buildPageSections(
      added, removed, updated, fileKey, figmaFileName, true, maxNodesInNotification
    );
    bodyNodes.push(...pageSectionContent);
    if (truncatedCount > 0) {
      bodyNodes.push(adfParagraph(adfText(`…and ${truncatedCount} more change${truncatedCount === 1 ? '' : 's'} not shown.`)));
    }
  }

  const footerNodes = [];
  if (mentionNodes.length > 0) {
    footerNodes.push(adfRule());
    footerNodes.push(adfParagraph(adfText('Notifying: ', true), ...mentionNodes));
  }

  return chunkAdfDocument(headerNodes, bodyNodes, footerNodes);
}

module.exports = {
  adfText, adfLink, adfParagraph, adfBulletList, adfHeading, adfMention, adfRule,
  typeLabel, partitionSweeping,
  buildCommentsSection, buildPageSections,
  chunkAdfDocument, buildCommentAdf, buildCommentAdfList
};
