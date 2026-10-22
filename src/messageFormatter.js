'use strict';

/**
 * Builds plain-markdown messages for Slack and Microsoft Teams.
 *
 * Both channels receive the same layout as the Jira comment (Item 2) and
 * the export document (Item 13): page/screen headings, per-node entries with
 * emoji change lines, and a "Notifying" footer.
 *
 * The content is built by reusing buildMarkdown from exportBuilder.js
 * (which owns the shared layout logic) and appending the mentions footer.
 *
 * deepLinkTarget: 'app' | 'browser' | 'both' (global config setting, default 'both')
 *   Slack has been tested with figma:// links (they work in the desktop client).
 *   Teams is untested (G5) — default 'both' emits both links; users can switch to
 *   'browser' if figma:// links don't render.
 *
 * Slack @mentions (v2): plain display names only.
 *   Full mention support requires a Slack app integration (out of scope for v2).
 */

const { buildMarkdown } = require('./exportBuilder');

/**
 * Returns a plain-text mentions footer line, e.g. "Notifying: @Alice Dev, @Bob"
 * For Slack/Teams, users are rendered as plain display names (not linked).
 *
 * @param {Array<object|string>} mentionedUsers
 * @returns {string}  Empty string when no users are listed.
 */
function buildMentionsLine(mentionedUsers) {
  if (!Array.isArray(mentionedUsers) || mentionedUsers.length === 0) return '';
  const names = mentionedUsers.map(u => {
    if (typeof u === 'string') return `@${u.includes('@') ? u.split('@')[0] : u}`;
    const label = u.displayName || (u.email ? u.email.split('@')[0] : null) || 'unknown';
    return `@${label}`;
  });
  return `Notifying: ${names.join(', ')}`;
}

/**
 * Builds a Slack / Teams notification message.
 *
 * Both channels use the same markdown format; the only caller-controlled
 * difference is `deepLinkTarget`. A single internal implementation keeps
 * the two builders in sync automatically.
 *
 * @param {object}   diffResult
 * @param {string}   fileKey
 * @param {string}   fileName
 * @param {string}   runAt         ISO timestamp
 * @param {string}   jiraIssueKey
 * @param {Array}    mentionedUsers
 * @param {string}   [deepLinkTarget='both']
 * @returns {string}  Markdown text ready to POST to a webhook
 */
function buildWebhookMessage(diffResult, fileKey, fileName, runAt, jiraIssueKey, mentionedUsers, deepLinkTarget = 'both') {
  const body = buildMarkdown(diffResult, fileKey, fileName, runAt, jiraIssueKey, deepLinkTarget);
  const mentions = buildMentionsLine(mentionedUsers);
  return mentions ? `${body}\n\n${mentions}` : body;
}

/**
 * Builds the message for a Slack incoming webhook.
 * deepLinkTarget defaults to 'both' (figma:// + browser link); Slack renders both.
 */
function buildSlackMessage(diffResult, fileKey, fileName, runAt, jiraIssueKey, mentionedUsers, deepLinkTarget = 'both') {
  return buildWebhookMessage(diffResult, fileKey, fileName, runAt, jiraIssueKey, mentionedUsers, deepLinkTarget);
}

/**
 * Builds the message for a Microsoft Teams incoming webhook.
 * deepLinkTarget defaults to 'both'; set to 'browser' if figma:// links don't render in Teams.
 */
function buildTeamsMessage(diffResult, fileKey, fileName, runAt, jiraIssueKey, mentionedUsers, deepLinkTarget = 'both') {
  return buildWebhookMessage(diffResult, fileKey, fileName, runAt, jiraIssueKey, mentionedUsers, deepLinkTarget);
}

module.exports = { buildSlackMessage, buildTeamsMessage, buildMentionsLine };
