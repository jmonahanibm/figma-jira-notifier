'use strict';

const { buildCommentAdf, buildCommentAdfList, chunkAdfDocument, fetchWatchers, searchUsers } = require('../src/jiraClient');
const { adfMention } = require('../src/adf');
const axios = require('axios');
jest.mock('axios');
const treeBefore = require('./fixtures/tree-before.json');
const treeAfter  = require('./fixtures/tree-after.json');
const { diffTrees } = require('../src/differ');

// ---------------------------------------------------------------------------
// Shared fixture data
// ---------------------------------------------------------------------------
const FIGMA_FILE_KEY = 'C03gFAqd4DfgSLN06KrUIt';
const FIGMA_URL      = 'https://www.figma.com/design/C03gFAqd4DfgSLN06KrUIt';
const RUN_AT        = '2026-08-26T17:03:10Z';
const SNAPSHOT_DATE = '2026-07-30T15:22:19Z';

const MENTIONED_USERS = [
  { displayName: 'Alice Dev',   jiraAccountId: 'accountid:alice' },
  { displayName: 'Bob Frontend', jiraAccountId: 'accountid:bob' }
];

const diffResult  = diffTrees(treeBefore, treeAfter);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Recursively collects all ADF nodes of a given type from a document.
 */
function collectNodes(node, type, acc = []) {
  if (!node) return acc;
  if (node.type === type) acc.push(node);
  if (Array.isArray(node.content)) {
    for (const child of node.content) collectNodes(child, type, acc);
  }
  return acc;
}

/**
 * Extracts all plain text strings from a document's text nodes.
 */
function extractText(doc) {
  return collectNodes(doc, 'text').map(n => n.text).join(' ');
}

// ---------------------------------------------------------------------------
// Document structure
// ---------------------------------------------------------------------------
describe('buildCommentAdf — document structure', () => {
  let adf;

  beforeAll(() => {
    adf = buildCommentAdf(diffResult, FIGMA_FILE_KEY, FIGMA_URL, RUN_AT, MENTIONED_USERS, SNAPSHOT_DATE);
  });

  test('returns an object with version, type: doc, and content array', () => {
    expect(adf).toMatchObject({ version: 1, type: 'doc' });
    expect(Array.isArray(adf.content)).toBe(true);
    expect(adf.content.length).toBeGreaterThan(0);
  });

  test('all top-level content nodes have a type property', () => {
    for (const node of adf.content) {
      expect(node).toHaveProperty('type');
    }
  });

  test('contains at least one rule (horizontal divider)', () => {
    const rules = collectNodes(adf, 'rule');
    expect(rules.length).toBeGreaterThan(0);
  });

  test('contains *(Type)* italic badges on entries', () => {
    const allText = extractText(adf);
    // New format: *(Frame)*, *(Text)*, *(Instance)*, etc.
    expect(allText).toMatch(/\*\([A-Za-z ]+\)\*/);
  });
});

// ---------------------------------------------------------------------------
// Comments section in ADF
// ---------------------------------------------------------------------------
describe('buildCommentAdf — comments section', () => {
  test('includes Comments section with New, Completed, and Open categories', () => {
    const diffWithComments = {
      ...diffResult,
      commentsDiff: {
        newComments: [{ id: '101', user: { handle: 'DesignerDan' }, message: 'Please update button color.' }],
        resolvedComments: [{ id: '102', user: { handle: 'Alice' }, message: 'Fixed alignment issues.' }],
        openComments: [{ id: '103', user: { handle: 'Bob' }, message: 'Checking contrast on card.' }]
      },
      totalChanges: diffResult.totalChanges + 2
    };
    const adf = buildCommentAdf(diffWithComments, FIGMA_FILE_KEY, FIGMA_URL, RUN_AT, [], SNAPSHOT_DATE);
    const text = extractText(adf);
    expect(text).toContain('Comments');
    expect(text).toContain('New comments');
    expect(text).toContain('DesignerDan:');
    expect(text).toContain('Please update button color.');
    expect(text).toContain('Completed comments');
    expect(text).toContain('Fixed alignment issues.');
    expect(text).toContain('Open comments');
    expect(text).toContain('Checking contrast on card.');
  });
});

// ---------------------------------------------------------------------------
// Header metadata
// ---------------------------------------------------------------------------
describe('buildCommentAdf — header metadata', () => {
  let adf;

  beforeAll(() => {
    adf = buildCommentAdf(diffResult, FIGMA_FILE_KEY, FIGMA_URL, RUN_AT, MENTIONED_USERS, SNAPSHOT_DATE);
  });

  test('includes the Figma file key in the output', () => {
    expect(extractText(adf)).toContain(FIGMA_FILE_KEY);
  });

  test('includes a clickable Figma URL link node', () => {
    function collectLinks(node, acc = []) {
      if (node.marks && node.marks.some(m => m.type === 'link')) acc.push(node);
      if (Array.isArray(node.content)) node.content.forEach(c => collectLinks(c, acc));
      return acc;
    }
    const links = collectLinks(adf);
    expect(links.length).toBeGreaterThan(0);
    expect(links[0].marks[0].attrs.href).toContain(FIGMA_FILE_KEY);
  });

  test('does NOT include the raw ISO run timestamp (formatted instead)', () => {
    // RUN_AT = '2026-08-26T17:03:10Z' — the formatted version should be "26 Aug 2026 at 17:03 UTC"
    expect(extractText(adf)).not.toContain(RUN_AT);
    expect(extractText(adf)).toContain('26 Aug 2026 at 17:03 UTC');
  });

  test('does NOT include the snapshot date', () => {
    expect(extractText(adf)).not.toContain(SNAPSHOT_DATE);
  });

  test('includes "Run:" label and formatted date in the header', () => {
    expect(extractText(adf)).toContain('Run:');
  });

  test('includes "Pages affected:" label in the header', () => {
    expect(extractText(adf)).toContain('Pages affected:');
  });

  test('includes a summary sentence with element count', () => {
    const text = extractText(adf);
    // Summary sentence: "N elements changed across S screens on P pages."
    expect(text).toMatch(/\d+ element[s]? changed/);
  });

  test('includes the page name "Final" in the output', () => {
    expect(extractText(adf)).toContain('Final');
  });
});

// ---------------------------------------------------------------------------
// @mention nodes
// ---------------------------------------------------------------------------
describe('buildCommentAdf — @mention nodes', () => {
  let adf;

  beforeAll(() => {
    adf = buildCommentAdf(diffResult, FIGMA_FILE_KEY, FIGMA_URL, RUN_AT, MENTIONED_USERS, SNAPSHOT_DATE);
  });

  test('includes a mention node for each configured user', () => {
    const mentions = collectNodes(adf, 'mention');
    expect(mentions.length).toBe(MENTIONED_USERS.length);
  });

  test('mention nodes carry the correct accountId', () => {
    const mentions = collectNodes(adf, 'mention');
    const ids = mentions.map(m => m.attrs.id);
    expect(ids).toContain('accountid:alice');
    expect(ids).toContain('accountid:bob');
  });

  test('mention nodes carry the display name prefixed with @', () => {
    const mentions = collectNodes(adf, 'mention');
    const texts = mentions.map(m => m.attrs.text);
    expect(texts).toContain('@Alice Dev');
    expect(texts).toContain('@Bob Frontend');
  });
});

// ---------------------------------------------------------------------------
// No mentions configured
// ---------------------------------------------------------------------------
describe('buildCommentAdf — no mentions', () => {
  test('does not emit mention nodes when mentionedUsers is empty', () => {
    const adf = buildCommentAdf(diffResult, FIGMA_FILE_KEY, FIGMA_URL, RUN_AT, [], SNAPSHOT_DATE);
    const mentions = collectNodes(adf, 'mention');
    expect(mentions.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// First run (no snapshot date)
// ---------------------------------------------------------------------------
describe('buildCommentAdf — first run', () => {
  test('includes first-run warning when snapshotDate is null', () => {
    const emptyDiff = { added: [], removed: [], updated: [], totalChanges: 0, pages: [] };
    const adf = buildCommentAdf(emptyDiff, FIGMA_FILE_KEY, FIGMA_URL, RUN_AT, [], null);
    expect(extractText(adf)).toMatch(/first run|No previous snapshot/i);
  });

  test('does not include Added/Updated/Removed headings when diff is empty', () => {
    const emptyDiff = { added: [], removed: [], updated: [], totalChanges: 0, pages: [] };
    const adf = buildCommentAdf(emptyDiff, FIGMA_FILE_KEY, FIGMA_URL, RUN_AT, [], null);
    const headings = collectNodes(adf, 'heading');
    const headingTexts = headings.flatMap(h => collectNodes(h, 'text').map(t => t.text)).join(' ');
    expect(headingTexts).not.toContain('Added');
    expect(headingTexts).not.toContain('Updated');
    expect(headingTexts).not.toContain('Removed');
  });
});

// ---------------------------------------------------------------------------
// Per-screen (frame) breakdown
// ---------------------------------------------------------------------------
describe('buildCommentAdf — screen breakdown and deep links', () => {
  test('Jira output uses ONLY browser links — no figma:// links (G5)', () => {
    const adf = buildCommentAdf(diffResult, FIGMA_FILE_KEY, FIGMA_URL, RUN_AT, [], SNAPSHOT_DATE);
    function collectLinks(node, acc = []) {
      if (node.marks && node.marks.some(m => m.type === 'link')) acc.push(node);
      if (Array.isArray(node.content)) node.content.forEach(c => collectLinks(c, acc));
      return acc;
    }
    const links = collectLinks(adf);
    // Must have at least one browser link to node entries
    const hasBrowser = links.some(l => l.marks.some(m => m.attrs.href.includes('figma.com/design')));
    expect(hasBrowser).toBe(true);
    // Must have NO figma:// links (Jira strips them — Item 2 / G5)
    const hasFigmaApp = links.some(l => l.marks.some(m => m.attrs.href.startsWith('figma://')));
    expect(hasFigmaApp).toBe(false);
  });

  test('page headings appear in the output', () => {
    const adf = buildCommentAdf(diffResult, FIGMA_FILE_KEY, FIGMA_URL, RUN_AT, [], SNAPSHOT_DATE);
    const headings = collectNodes(adf, 'heading');
    expect(headings.length).toBeGreaterThan(0);
  });

  test('formats structured copy changes into readable natural text', () => {
    const customDiff = {
      added: [],
      removed: [],
      updated: [{
        id: '1:2',
        name: 'Submit Button',
        type: 'TEXT',
        pageName: 'Final',
        frameName: 'Login Flow',
        frameId: '1:1',
        changes: [{ type: 'text_change', emoji: '✏️', label: 'Copy changed from "Sign in" to "Log in"', oldValue: 'Sign in', newValue: 'Log in' }]
      }],
      totalChanges: 1,
      pages: ['Final']
    };
    const adf = buildCommentAdf(customDiff, FIGMA_FILE_KEY, FIGMA_URL, RUN_AT, [], SNAPSHOT_DATE);
    const text = extractText(adf);
    expect(text).toContain('Login Flow / Submit Button');
    // New badge format: *(Text)* not (Updated, Text, Final)
    expect(text).toContain('*(Text)*');
    expect(text).not.toContain('(Updated, Text, Final)');
    expect(text).toContain('Copy changed from "Sign in" to "Log in"');
    // Jira mode: no figma:// link on the node name
    function collectLinks(node, acc = []) {
      if (node.marks && node.marks.some(m => m.type === 'link')) acc.push(node);
      if (Array.isArray(node.content)) node.content.forEach(c => collectLinks(c, acc));
      return acc;
    }
    const links = collectLinks(adf);
    const hasFigmaApp = links.some(l => l.marks.some(m => m.attrs.href.startsWith('figma://')));
    expect(hasFigmaApp).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Global updates section in ADF (Item 2)
// ---------------------------------------------------------------------------
describe('buildCommentAdf — Global updates section', () => {
  /**
   * 3 nodes with the same change type on the same page → "Global updates" heading
   * appears and each node is listed once (not again under its screen).
   */
  const GLOBAL_DIFF = {
    added: [],
    removed: [],
    updated: [
      { id: '1:1', name: 'Top bar',  type: 'COMPONENT', pageName: 'Components', frameName: 'Navigation', frameId: '1:0',
        changes: [{ type: 'fill_change', emoji: '🎨', label: 'Background / fill colour updated' }] },
      { id: '1:2', name: 'Tab bar',  type: 'COMPONENT', pageName: 'Components', frameName: 'Navigation', frameId: '1:0',
        changes: [{ type: 'fill_change', emoji: '🎨', label: 'Background / fill colour updated' }] },
      { id: '1:3', name: 'Footer',   type: 'COMPONENT', pageName: 'Components', frameName: 'Navigation', frameId: '1:0',
        changes: [{ type: 'fill_change', emoji: '🎨', label: 'Background / fill colour updated' }] }
    ],
    totalChanges: 3,
    pages: ['Components']
  };

  test('emits a "Global updates" heading when ≥3 nodes share a change type', () => {
    const adf = buildCommentAdf(GLOBAL_DIFF, FIGMA_FILE_KEY, FIGMA_URL, RUN_AT, [], SNAPSHOT_DATE);
    const text = extractText(adf);
    expect(text).toContain('Global updates');
  });

  test('lists all affected nodes under the Global updates section', () => {
    const adf = buildCommentAdf(GLOBAL_DIFF, FIGMA_FILE_KEY, FIGMA_URL, RUN_AT, [], SNAPSHOT_DATE);
    const text = extractText(adf);
    expect(text).toContain('Top bar');
    expect(text).toContain('Tab bar');
    expect(text).toContain('Footer');
  });

  test('does NOT emit Global updates when fewer than 3 nodes share a change type', () => {
    const twoNodeDiff = {
      ...GLOBAL_DIFF,
      updated: GLOBAL_DIFF.updated.slice(0, 2),
      totalChanges: 2
    };
    const adf = buildCommentAdf(twoNodeDiff, FIGMA_FILE_KEY, FIGMA_URL, RUN_AT, [], SNAPSHOT_DATE);
    const text = extractText(adf);
    expect(text).not.toContain('Global updates');
  });
});

// ---------------------------------------------------------------------------
// Truncation note in ADF (Item 2)
// ---------------------------------------------------------------------------
describe('buildCommentAdfList — truncation note', () => {
  test('adds "…and X more changes" note when maxNodesInNotification is exceeded', () => {
    // 5 nodes but limit 2 → 3 truncated
    const manyDiff = {
      added: [],
      removed: [],
      updated: [1, 2, 3, 4, 5].map(i => ({
        id: `1:${i}`, name: `Node ${i}`, type: 'INSTANCE',
        pageName: 'Final', frameName: 'Screen', frameId: '1:0',
        changes: [{ type: `unique_type_${i}`, emoji: '✏️', label: `Change ${i}` }]
      })),
      totalChanges: 5,
      pages: ['Final']
    };
    const docs = buildCommentAdfList(manyDiff, FIGMA_FILE_KEY, FIGMA_URL, RUN_AT, [], SNAPSHOT_DATE, 2);
    const allText = docs.map(extractText).join(' ');
    expect(allText).toMatch(/and \d+ more change/);
  });

  test('does NOT add truncation note when maxNodesInNotification is 0 (unlimited)', () => {
    const manyDiff = {
      added: [],
      removed: [],
      updated: [1, 2, 3].map(i => ({
        id: `1:${i}`, name: `Node ${i}`, type: 'INSTANCE',
        pageName: 'Final', frameName: 'Screen', frameId: '1:0',
        changes: [{ type: `type_${i}`, emoji: '✏️', label: `Change ${i}` }]
      })),
      totalChanges: 3,
      pages: ['Final']
    };
    const docs = buildCommentAdfList(manyDiff, FIGMA_FILE_KEY, FIGMA_URL, RUN_AT, [], SNAPSHOT_DATE, 0);
    const allText = docs.map(extractText).join(' ');
    expect(allText).not.toMatch(/and \d+ more change/);
  });
});

// ---------------------------------------------------------------------------
// Removed-node rule: no link in ADF (Item 2)
// ---------------------------------------------------------------------------
describe('buildCommentAdf — removed node has no link', () => {
  test('removed node appears as plain bold text — no href link on its name', () => {
    const removedDiff = {
      added: [],
      removed: [{ id: '9:1', name: 'Divider', type: 'RECTANGLE', pageName: 'Final', frameName: 'Checkout', frameId: '9:0' }],
      updated: [],
      totalChanges: 1,
      pages: ['Final']
    };
    const adf = buildCommentAdf(removedDiff, FIGMA_FILE_KEY, FIGMA_URL, RUN_AT, [], SNAPSHOT_DATE);
    const text = extractText(adf);
    expect(text).toContain('Divider');

    // Collect all links in the document — the removed node name must not be linked
    function collectLinks(node, acc = []) {
      if (node.type === 'text' && node.marks && node.marks.some(m => m.type === 'link')) acc.push(node.text || '');
      if (Array.isArray(node.content)) node.content.forEach(c => collectLinks(c, acc));
      return acc;
    }
    const linkedTexts = collectLinks(adf).join(' ');
    expect(linkedTexts).not.toContain('Divider');
  });
});

// ---------------------------------------------------------------------------
// ADF node validity — no invalid node types
// ---------------------------------------------------------------------------
describe('buildCommentAdf — ADF node validity', () => {
  const VALID_TYPES = new Set([
    'doc', 'paragraph', 'text', 'heading', 'bulletList',
    'listItem', 'mention', 'rule', 'hardBreak'
  ]);

  test('fetchWatchers parses Jira watchers list correctly', async () => {
    axios.get.mockResolvedValueOnce({
      data: {
        watchers: [
          { accountId: 'acc1', displayName: 'Jane Dev', emailAddress: 'jane@ibm.com' },
          { accountId: 'acc2', displayName: 'Bob Tester', emailAddress: '' }
        ]
      }
    });

    const watchers = await fetchWatchers('https://example.atlassian.net', 'user@ibm.com', 'token', 'PROJ-123');
    expect(watchers.length).toBe(2);
    expect(watchers[0]).toEqual({ accountId: 'acc1', displayName: 'Jane Dev', email: 'jane@ibm.com' });
    expect(watchers[1].displayName).toBe('Bob Tester');
  });

  test('all nodes use valid ADF types', () => {
    const adf = buildCommentAdf(diffResult, FIGMA_FILE_KEY, FIGMA_URL, RUN_AT, MENTIONED_USERS, SNAPSHOT_DATE);
    const invalid = [];

    function walk(node) {
      if (node.type && !VALID_TYPES.has(node.type)) invalid.push(node.type);
      if (Array.isArray(node.content)) node.content.forEach(walk);
    }
    walk(adf);

    expect(invalid).toEqual([]);
  });

  test('text nodes all have a string text property', () => {
    const adf = buildCommentAdf(diffResult, FIGMA_FILE_KEY, FIGMA_URL, RUN_AT, MENTIONED_USERS, SNAPSHOT_DATE);
    const textNodes = collectNodes(adf, 'text');
    for (const node of textNodes) {
      expect(typeof node.text).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// Chunking large ADF payloads
// ---------------------------------------------------------------------------
describe('chunkAdfDocument', () => {
  test('chunks large ADF document when body size exceeds threshold', () => {
    const header = [{ type: 'paragraph', content: [{ type: 'text', text: 'Header' }] }];
    const footer = [{ type: 'paragraph', content: [{ type: 'text', text: 'Footer' }] }];
    const body = Array.from({ length: 50 }, (_, i) => ({
      type: 'paragraph',
      content: [{ type: 'text', text: `Detailed long change description entry ${i}: `.repeat(15) }]
    }));

    const docs = chunkAdfDocument(header, body, footer, 2000);
    expect(docs.length).toBeGreaterThan(1);
    for (let i = 0; i < docs.length; i++) {
      expect(docs[i].type).toBe('doc');
      const text = extractText(docs[i]);
      expect(text).toContain(`Part ${i + 1} of ${docs.length}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Item 1 — fetchWatchers: email field behaviour
// ---------------------------------------------------------------------------
describe('fetchWatchers — email field', () => {
  test('returns the real email when Jira provides it', async () => {
    axios.get.mockResolvedValueOnce({
      data: {
        watchers: [{ accountId: 'acc1', displayName: 'Alice', emailAddress: 'alice@ibm.com' }]
      }
    });
    const [w] = await fetchWatchers('https://example.atlassian.net', 'me@ibm.com', 'token', 'PROJ-1');
    expect(w.email).toBe('alice@ibm.com');
  });

  test('returns null (not a fake address) when Jira hides the email', async () => {
    axios.get.mockResolvedValueOnce({
      data: {
        watchers: [{ accountId: 'acc2', displayName: 'Bob Dev', emailAddress: '' }]
      }
    });
    const [w] = await fetchWatchers('https://example.atlassian.net', 'me@ibm.com', 'token', 'PROJ-1');
    expect(w.email).toBeNull();
  });

  test('still returns accountId and displayName regardless of email visibility', async () => {
    axios.get.mockResolvedValueOnce({
      data: {
        watchers: [{ accountId: 'acc3', displayName: 'Carol PM', emailAddress: '' }]
      }
    });
    const [w] = await fetchWatchers('https://example.atlassian.net', 'me@ibm.com', 'token', 'PROJ-1');
    expect(w.accountId).toBe('acc3');
    expect(w.displayName).toBe('Carol PM');
  });
});

// ---------------------------------------------------------------------------
// Item 1 — searchUsers
// ---------------------------------------------------------------------------
describe('searchUsers', () => {
  beforeEach(() => { axios.get.mockClear(); });

  test('returns mapped user objects for a successful search', async () => {
    axios.get.mockResolvedValueOnce({
      data: [
        { accountId: 'id1', displayName: 'Alice Dev', emailAddress: 'alice@ibm.com' },
        { accountId: 'id2', displayName: 'Alice Admin', emailAddress: null }
      ]
    });
    const users = await searchUsers('https://example.atlassian.net', 'me@ibm.com', 'token', 'alice');
    expect(users).toHaveLength(2);
    expect(users[0]).toEqual({ accountId: 'id1', displayName: 'Alice Dev', email: 'alice@ibm.com' });
    expect(users[1]).toEqual({ accountId: 'id2', displayName: 'Alice Admin', email: null });
  });

  test('returns empty array for a blank query without calling the API', async () => {
    const users = await searchUsers('https://example.atlassian.net', 'me@ibm.com', 'token', '  ');
    expect(users).toEqual([]);
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('returns empty array (does not throw) when Jira responds 403 (missing permission)', async () => {
    const err = new Error('Forbidden');
    err.response = { status: 403, data: { errorMessages: ['No permission'] } };
    axios.get.mockRejectedValueOnce(err);
    const users = await searchUsers('https://example.atlassian.net', 'me@ibm.com', 'token', 'alice');
    expect(users).toEqual([]);
  });

  test('throws on non-403 API errors', async () => {
    const err = new Error('Server error');
    err.response = { status: 500, data: { errorMessages: ['Internal error'] } };
    axios.get.mockRejectedValueOnce(err);
    await expect(searchUsers('https://example.atlassian.net', 'me@ibm.com', 'token', 'alice'))
      .rejects.toThrow('Jira searchUsers failed');
  });
});

// ---------------------------------------------------------------------------
// Item 1 — adfMention: correct mention vs plain-text fallback
// ---------------------------------------------------------------------------
describe('adfMention — mention node vs plain text', () => {
  test('emits a mention node when jiraAccountId is a real accountId', () => {
    const node = adfMention({ displayName: 'Alice Dev', jiraAccountId: 'accountid:abc123', email: 'alice@ibm.com' });
    expect(node.type).toBe('mention');
    expect(node.attrs.id).toBe('accountid:abc123');
    expect(node.attrs.text).toBe('@Alice Dev');
  });

  test('emits plain bold text when jiraAccountId is an email (v1 bug)', () => {
    const node = adfMention({ displayName: 'Bob', jiraAccountId: 'bob@ibm.com', email: 'bob@ibm.com' });
    expect(node.type).toBe('text');
    expect(node.marks).toEqual([{ type: 'strong' }]);
    expect(node.text).toBe('@Bob');
  });

  test('emits plain bold text when jiraAccountId is null', () => {
    const node = adfMention({ displayName: 'Carol', jiraAccountId: null, email: 'carol@ibm.com' });
    expect(node.type).toBe('text');
    expect(node.text).toBe('@Carol');
  });

  test('emits plain bold text for a legacy plain-string user', () => {
    const node = adfMention('dave@ibm.com');
    expect(node.type).toBe('text');
    expect(node.text).toBe('@dave');
  });

  test('mention node carries the accountId — not email — as the id attribute', () => {
    const node = adfMention({ displayName: 'Eve', jiraAccountId: 'accountid:eve999', email: 'eve@ibm.com' });
    expect(node.attrs.id).toBe('accountid:eve999');
    expect(node.attrs.id).not.toContain('@');
  });
});
