'use strict';

/**
 * Pure functions for building a standalone changelog export document.
 *
 * No I/O — no fs, no axios. Safe to use on the server, in the browser,
 * and in the pkg binary.
 *
 * Layout (matches Item 2 notification layout):
 *   # Design Changelog — <issueKey>
 *   **File:** <name>   **Run:** <date>   **Pages affected:** <pages>
 *   ---
 *   ## <page name>
 *   ### <screen name>
 *   **[Screen / Node](figma://…)** [(Browser)](https://…) *(Type)*
 *   ✏️ Copy changed from "X" to "Y"
 *   ...
 *   ---
 *   *N changes across P pages — exported by Design Change Log*
 *
 * deepLinkTarget: 'app' | 'browser' | 'both' (default 'both')
 *   'app'     — primary link is figma://, no (Browser) link
 *   'browser' — primary link is https://, no (Browser) link
 *   'both'    — figma:// as primary, https:// as (Browser) (default)
 */

const { buildNodeLinks } = require('./figmaLinks');
const { partitionSweeping } = require('./adf');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Human-readable label for a Figma node type (mirrors adf.js). */
function typeLabel(type) {
  const map = {
    FRAME: 'Frame', GROUP: 'Group', COMPONENT: 'Component',
    COMPONENT_SET: 'Component Set', INSTANCE: 'Instance',
    TEXT: 'Text', RECTANGLE: 'Rectangle', ELLIPSE: 'Ellipse',
    VECTOR: 'Vector', BOOLEAN_OPERATION: 'Boolean Op', SECTION: 'Section'
  };
  return map[type] || type;
}

/** Formats a Date as "D MMM YYYY at HH:MM UTC". */
function formatRunDate(iso) {
  try {
    const d = new Date(iso);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const pad = n => String(n).padStart(2, '0');
    return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} at ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
  } catch {
    return iso;
  }
}

/**
 * Builds the markdown node-header line for one changed node.
 *   **[Frame / Node](figma://…)** [(Browser)](https://…) *(Type)*
 *   or for removed: **Frame / Node** (Removed) *(Type)*
 */
function nodeHeaderMd(node, action, fileKey, fileName, deepLinkTarget = 'both') {
  const displayName = node.frameName ? `${node.frameName} / ${node.name}` : node.name;
  const typeMd = `*(${typeLabel(node.type)})*`;

  if (action === 'Removed') {
    return `**${displayName}** (Removed) ${typeMd}`;
  }

  const { app, browser } = buildNodeLinks(fileKey, fileName, node.id);

  if (deepLinkTarget === 'browser') {
    return browser ? `**[${displayName}](${browser})** ${typeMd}` : `**${displayName}** ${typeMd}`;
  }

  if (deepLinkTarget === 'app') {
    return app ? `**[${displayName}](${app})** ${typeMd}` : `**${displayName}** ${typeMd}`;
  }

  // 'both' (default): figma:// primary + (Browser) secondary
  const primary = app ? `**[${displayName}](${app})**` : `**${displayName}**`;
  const secondary = browser ? ` [(Browser)](${browser})` : '';
  return `${primary}${secondary} ${typeMd}`;
}

/** Renders one change (structured object or legacy string) as a markdown line. */
function changeLineMd(c) {
  if (c && typeof c === 'object' && c.label) {
    return `${c.emoji} ${c.label}`;
  }
  const s = String(c);
  if (s.startsWith('text updated: ')) {
    const parts = s.replace('text updated: ', '').split(' → ');
    if (parts.length === 2) return `✏️ Copy changed from "${parts[0]}" to "${parts[1]}"`;
  }
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// Core layout builder (shared by md and html)
// ---------------------------------------------------------------------------

/**
 * Builds the full structured export: header, per-page sections, footer.
 * Returns an array of lines (joined by \n for markdown).
 *
 * @param {object} diffResult
 * @param {string} fileKey
 * @param {string} fileName
 * @param {string} runAt         ISO timestamp
 * @param {string} jiraIssueKey  Used in title (may be empty for projects without Jira)
 * @param {string} deepLinkTarget 'app' | 'browser' | 'both'
 * @returns {string[]}
 */
function buildLines(diffResult, fileKey, fileName, runAt, jiraIssueKey = '', deepLinkTarget = 'both', maxNodes = 0) {
  const { added = [], removed = [], updated = [], pages = [] } = diffResult;
  const totalChanges = added.length + removed.length + updated.length;

  const title = jiraIssueKey ? `Design Changelog — ${jiraIssueKey}` : 'Design Changelog';
  const pagesLabel = pages.length > 0 ? pages.join(', ') : 'Unknown';
  const runLabel = formatRunDate(runAt);

  const lines = [
    `# ${title}`,
    `**File:** ${fileName || fileKey}`,
    `**Run:** ${runLabel}`,
    `**Pages affected:** ${pagesLabel}`,
    '',
    '---',
    ''
  ];

  // Summary sentence
  if (totalChanges > 0) {
    const screenSet = new Set([
      ...added.map(n => n.frameName || n.pageName || ''),
      ...removed.map(n => n.frameName || n.pageName || ''),
      ...updated.map(n => n.frameName || n.pageName || '')
    ].filter(Boolean));
    const screenCount = screenSet.size;
    const pageCount = pages.length;
    const summaryParts = [
      `${totalChanges} element${totalChanges === 1 ? '' : 's'} changed`,
      screenCount > 0 ? `across ${screenCount} screen${screenCount === 1 ? '' : 's'}` : '',
      pageCount > 0 ? `on ${pageCount} page${pageCount === 1 ? '' : 's'}` : ''
    ].filter(Boolean).join(' ');
    lines.push(summaryParts + '.', '');
  }

  // --- Pages ---
  const allPages = new Set([
    ...added.map(n => n.pageName || 'Unknown page'),
    ...removed.map(n => n.pageName || 'Unknown page'),
    ...updated.map(n => n.pageName || 'Unknown page')
  ]);

  let nodeCount = 0;
  let truncatedCount = 0;

  for (const page of allPages) {
    const pageAdded   = added.filter(n => (n.pageName || 'Unknown page') === page);
    const pageRemoved = removed.filter(n => (n.pageName || 'Unknown page') === page);
    const pageUpdated = updated.filter(n => (n.pageName || 'Unknown page') === page);
    const allPageEntries = [...pageUpdated, ...pageAdded, ...pageRemoved];

    lines.push(`## ${page}`, '');

    // --- Global updates (sweeping): changes shared by ≥ 3 nodes on this page ---
    const { sweepingDescs, sweepingKeys, restEntries } = partitionSweeping(allPageEntries, 3);
    const updatedRest = restEntries.filter(e => pageUpdated.some(u => u.id === e.id));
    const changeKeyFn = c => (c && typeof c === 'object' && c.type) ? c.type : String(c);

    if (sweepingDescs.size > 0) {
      lines.push(`### Global updates`, '');
      for (const [, repChange] of sweepingDescs) {
        const descLabel = changeLineMd(repChange);
        const matchingNodes = allPageEntries.filter(e =>
          (e.changes || []).some(c => sweepingKeys.has(changeKeyFn(c)))
        );
        lines.push(`${descLabel} — ${matchingNodes.length} elements:`);
        for (const node of matchingNodes) {
          if (maxNodes > 0 && nodeCount >= maxNodes) { truncatedCount++; continue; }
          lines.push(nodeHeaderMd(node, 'Updated', fileKey, fileName, deepLinkTarget));
          nodeCount++;
        }
        lines.push('');
      }
    }

    // Group remaining entries by screen
    const screens = new Set([
      ...updatedRest.map(n => n.frameName || ''),
      ...pageAdded.map(n => n.frameName || ''),
      ...pageRemoved.map(n => n.frameName || '')
    ]);

    for (const screen of screens) {
      const screenUpdated = updatedRest.filter(n => (n.frameName || '') === screen);
      const screenAdded   = pageAdded.filter(n => (n.frameName || '') === screen);
      const screenRemoved = pageRemoved.filter(n => (n.frameName || '') === screen);

      const screenLabel = screen || page;
      lines.push(`### ${screenLabel}`, '');

      for (const node of [...screenUpdated, ...screenAdded, ...screenRemoved]) {
        if (maxNodes > 0 && nodeCount >= maxNodes) { truncatedCount++; continue; }
        const action = screenUpdated.includes(node) ? 'Updated'
          : screenAdded.includes(node) ? 'Added' : 'Removed';

        lines.push(nodeHeaderMd(node, action, fileKey, fileName, deepLinkTarget));

        if (action === 'Added') {
          lines.push('➕ New element added');
        } else if (action === 'Removed') {
          lines.push('➖ Removed');
        } else if (node.changes && node.changes.length > 0) {
          for (const c of node.changes) {
            lines.push(changeLineMd(c));
          }
        }
        lines.push('');
        nodeCount++;
      }
    }

    lines.push('---', '');
  }

  if (truncatedCount > 0) {
    lines.push(`*…and ${truncatedCount} more change${truncatedCount === 1 ? '' : 's'} not shown.*`, '');
  }

  lines.push(`*${totalChanges} change${totalChanges === 1 ? '' : 's'} across ${allPages.size} page${allPages.size === 1 ? '' : 's'} — exported by Design Change Log*`);

  return lines;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Builds a standalone markdown changelog document.
 * @returns {string}
 */
function buildMarkdown(diffResult, fileKey, fileName, runAt, jiraIssueKey = '', deepLinkTarget = 'both', maxNodes = 0) {
  return buildLines(diffResult, fileKey, fileName, runAt, jiraIssueKey, deepLinkTarget, maxNodes).join('\n');
}

/**
 * Builds a self-contained HTML changelog document (inline CSS, no external deps).
 * @returns {string}
 */
function buildHtml(diffResult, fileKey, fileName, runAt, jiraIssueKey = '', deepLinkTarget = 'both', maxNodes = 0) {
  const lines = buildLines(diffResult, fileKey, fileName, runAt, jiraIssueKey, deepLinkTarget, maxNodes);
  const md = lines.join('\n');

  // Minimal markdown-to-HTML conversion: headings, bold, italic, links, hr, paragraphs
  function mdToHtml(text) {
    return text
      .split('\n')
      .map(line => {
        if (line.startsWith('### ')) return `<h3>${esc(line.slice(4))}</h3>`;
        if (line.startsWith('## '))  return `<h2>${esc(line.slice(3))}</h2>`;
        if (line.startsWith('# '))   return `<h1>${esc(line.slice(2))}</h1>`;
        if (line.trim() === '---')   return '<hr>';
        if (line.trim() === '')      return '';
        // Inline: links, bold, italic — order matters
        let out = esc(line);
        // Restore escaped links/bold/italic patterns (re-apply after escaping)
        out = line
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          // links: [label](url)
          .replace(/\*?\*?\[([^\]]+)\]\(([^)]+)\)\*?\*?/g, (_, label, url) => `<a href="${url}">${label}</a>`)
          // bold: **text**
          .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
          // italic: *text*
          .replace(/\*([^*]+)\*/g, '<em>$1</em>');
        return `<p>${out}</p>`;
      })
      .filter(l => l !== '')
      .join('\n');
  }

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  const title = jiraIssueKey ? `Design Changelog — ${jiraIssueKey}` : 'Design Changelog';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(title)}</title>
  <style>
    body{font-family:-apple-system,"Segoe UI",system-ui,sans-serif;max-width:800px;margin:40px auto;padding:0 20px;color:#1f2328;line-height:1.6}
    h1{border-bottom:2px solid #e5e7eb;padding-bottom:8px}
    h2{margin-top:32px;color:#3b82d4}
    h3{margin-top:20px}
    hr{border:none;border-top:1px solid #e5e7eb;margin:24px 0}
    a{color:#3b82d4}
    p{margin:4px 0}
    em{color:#57606a}
  </style>
</head>
<body>
${mdToHtml(md)}
</body>
</html>`;
}

module.exports = { buildMarkdown, buildHtml };
