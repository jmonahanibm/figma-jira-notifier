'use strict';

/**
 * Unit tests for src/exportBuilder.js
 *
 * Pure functions — no mocking required.
 */

const { buildMarkdown, buildHtml } = require('../src/exportBuilder');

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

function makeDiffResult(overrides = {}) {
  return {
    added: [],
    removed: [],
    updated: [],
    pages: ['Final'],
    totalChanges: 0,
    commentsDiff: { newComments: [], resolvedComments: [], openComments: [] },
    ...overrides
  };
}

const FILE_KEY = 'AbC123';
const FILE_NAME = 'My Product Design';
const RUN_AT = '2025-07-14T08:00:00.000Z';
const ISSUE_KEY = 'PROJ-123';

// ---------------------------------------------------------------------------
// buildMarkdown
// ---------------------------------------------------------------------------

describe('buildMarkdown', () => {
  test('includes the title with the Jira issue key', () => {
    const md = buildMarkdown(makeDiffResult(), FILE_KEY, FILE_NAME, RUN_AT, ISSUE_KEY);
    expect(md).toContain('# Design Changelog — PROJ-123');
  });

  test('includes file name and run date', () => {
    const md = buildMarkdown(makeDiffResult(), FILE_KEY, FILE_NAME, RUN_AT, ISSUE_KEY);
    expect(md).toContain('**File:** My Product Design');
    expect(md).toContain('14 Jul 2025');
  });

  test('falls back gracefully when no issue key', () => {
    const md = buildMarkdown(makeDiffResult(), FILE_KEY, FILE_NAME, RUN_AT, '');
    expect(md).toContain('# Design Changelog');
    expect(md).not.toContain('# Design Changelog —');
  });

  test('renders an updated node with structured change label and emoji', () => {
    const diffResult = makeDiffResult({
      updated: [{
        id: '1:2', name: 'Primary button', type: 'INSTANCE',
        pageName: 'Final', frameName: 'Login Flow', frameId: '1:1',
        changes: [{ type: 'text_change', emoji: '✏️', label: 'Copy changed from "Submit" to "Continue"', oldValue: 'Submit', newValue: 'Continue' }]
      }],
      pages: ['Final'],
      totalChanges: 1
    });
    const md = buildMarkdown(diffResult, FILE_KEY, FILE_NAME, RUN_AT, ISSUE_KEY);
    expect(md).toContain('Login Flow / Primary button');
    expect(md).toContain('✏️ Copy changed from "Submit" to "Continue"');
    expect(md).toContain('*(Instance)*');
  });

  test('renders an added node with ➕', () => {
    const diffResult = makeDiffResult({
      added: [{ id: '2:1', name: 'Confirmation modal', type: 'FRAME', pageName: 'Final', frameName: 'Checkout', frameId: '2:0' }],
      pages: ['Final'],
      totalChanges: 1
    });
    const md = buildMarkdown(diffResult, FILE_KEY, FILE_NAME, RUN_AT, ISSUE_KEY);
    expect(md).toContain('➕ New element added');
    expect(md).toContain('Checkout / Confirmation modal');
  });

  test('renders a removed node as plain text with (Removed) — no links', () => {
    const diffResult = makeDiffResult({
      removed: [{ id: '3:1', name: 'Divider', type: 'RECTANGLE', pageName: 'Final', frameName: 'Checkout', frameId: '3:0' }],
      pages: ['Final'],
      totalChanges: 1
    });
    const md = buildMarkdown(diffResult, FILE_KEY, FILE_NAME, RUN_AT, ISSUE_KEY);
    expect(md).toContain('**Checkout / Divider** (Removed)');
    expect(md).toContain('➖ Removed');
    // Removed nodes must not have links
    expect(md).not.toMatch(/\[Checkout \/ Divider\]\(http/);
  });

  test('deepLinkTarget: "browser" — no figma:// links', () => {
    const diffResult = makeDiffResult({
      updated: [{ id: '1:2', name: 'Button', type: 'INSTANCE', pageName: 'Final', frameName: 'Screen', frameId: '1:1', changes: [] }],
      pages: ['Final'],
      totalChanges: 1
    });
    const md = buildMarkdown(diffResult, FILE_KEY, FILE_NAME, RUN_AT, ISSUE_KEY, 'browser');
    expect(md).toContain('https://www.figma.com/design');
    expect(md).not.toContain('figma://');
  });

  test('deepLinkTarget: "both" — includes both figma:// and (Browser) links', () => {
    const diffResult = makeDiffResult({
      updated: [{ id: '1:2', name: 'Button', type: 'INSTANCE', pageName: 'Final', frameName: 'Screen', frameId: '1:1', changes: [] }],
      pages: ['Final'],
      totalChanges: 1
    });
    const md = buildMarkdown(diffResult, FILE_KEY, FILE_NAME, RUN_AT, ISSUE_KEY, 'both');
    expect(md).toContain('figma://');
    expect(md).toContain('(Browser)');
  });

  test('node-id is written in hyphen form (1-2), not colon form (1:2)', () => {
    const diffResult = makeDiffResult({
      updated: [{ id: '1:2', name: 'Button', type: 'INSTANCE', pageName: 'Final', frameName: 'Screen', frameId: '1:1', changes: [] }],
      pages: ['Final'],
      totalChanges: 1
    });
    const md = buildMarkdown(diffResult, FILE_KEY, FILE_NAME, RUN_AT, ISSUE_KEY);
    expect(md).toContain('node-id=1-2');
    expect(md).not.toContain('node-id=1:2');
  });

  test('footer shows total change count', () => {
    const diffResult = makeDiffResult({
      added: [{ id: '2:1', name: 'X', type: 'FRAME', pageName: 'Final', frameName: 'S', frameId: '2:0' }],
      pages: ['Final'],
      totalChanges: 1
    });
    const md = buildMarkdown(diffResult, FILE_KEY, FILE_NAME, RUN_AT, ISSUE_KEY);
    expect(md).toContain('1 change');
    expect(md).toContain('exported by Design Change Log');
  });

  test('groups nodes by page heading (##) and screen heading (###)', () => {
    const diffResult = makeDiffResult({
      updated: [
        { id: '1:2', name: 'A', type: 'TEXT', pageName: 'PageOne', frameName: 'ScreenA', frameId: '1:1', changes: [] },
        { id: '2:2', name: 'B', type: 'TEXT', pageName: 'PageTwo', frameName: 'ScreenB', frameId: '2:1', changes: [] }
      ],
      pages: ['PageOne', 'PageTwo'],
      totalChanges: 2
    });
    const md = buildMarkdown(diffResult, FILE_KEY, FILE_NAME, RUN_AT, ISSUE_KEY);
    expect(md).toContain('## PageOne');
    expect(md).toContain('### ScreenA');
    expect(md).toContain('## PageTwo');
    expect(md).toContain('### ScreenB');
  });
});

// ---------------------------------------------------------------------------
// Item 2 — summary sentence
// ---------------------------------------------------------------------------
describe('buildMarkdown — summary sentence (Item 2)', () => {
  test('includes a summary sentence with element count when there are changes', () => {
    const diffResult = makeDiffResult({
      updated: [
        { id: '1:2', name: 'A', type: 'TEXT', pageName: 'Final', frameName: 'Screen', frameId: '1:1', changes: [] },
        { id: '1:3', name: 'B', type: 'TEXT', pageName: 'Final', frameName: 'Screen', frameId: '1:1', changes: [] }
      ],
      pages: ['Final'],
      totalChanges: 2
    });
    const md = buildMarkdown(diffResult, FILE_KEY, FILE_NAME, RUN_AT, ISSUE_KEY);
    expect(md).toMatch(/2 elements changed/);
    expect(md).toMatch(/on 1 page/);
  });

  test('omits summary sentence when there are no changes', () => {
    const md = buildMarkdown(makeDiffResult(), FILE_KEY, FILE_NAME, RUN_AT, ISSUE_KEY);
    expect(md).not.toMatch(/elements changed/);
  });
});

// ---------------------------------------------------------------------------
// Item 2 — Global updates section
// ---------------------------------------------------------------------------
describe('buildMarkdown — Global updates section (Item 2)', () => {
  /**
   * When 3 or more nodes on the same page share the same change type, a
   * "### Global updates" section should appear before the per-screen entries.
   */
  function makeGlobalDiff() {
    return makeDiffResult({
      updated: [
        { id: '2:1', name: 'Top bar',  type: 'COMPONENT', pageName: 'Components', frameName: 'Navigation', frameId: '2:0',
          changes: [{ type: 'fill_change', emoji: '🎨', label: 'Background / fill colour updated' }] },
        { id: '2:2', name: 'Tab bar',  type: 'COMPONENT', pageName: 'Components', frameName: 'Navigation', frameId: '2:0',
          changes: [{ type: 'fill_change', emoji: '🎨', label: 'Background / fill colour updated' }] },
        { id: '2:3', name: 'Footer',   type: 'COMPONENT', pageName: 'Components', frameName: 'Navigation', frameId: '2:0',
          changes: [{ type: 'fill_change', emoji: '🎨', label: 'Background / fill colour updated' }] }
      ],
      pages: ['Components'],
      totalChanges: 3
    });
  }

  test('emits "### Global updates" when ≥3 nodes share a change type', () => {
    const md = buildMarkdown(makeGlobalDiff(), FILE_KEY, FILE_NAME, RUN_AT, ISSUE_KEY);
    expect(md).toContain('### Global updates');
  });

  test('lists all affected nodes under Global updates', () => {
    const md = buildMarkdown(makeGlobalDiff(), FILE_KEY, FILE_NAME, RUN_AT, ISSUE_KEY);
    expect(md).toContain('Top bar');
    expect(md).toContain('Tab bar');
    expect(md).toContain('Footer');
  });

  test('does NOT emit Global updates for fewer than 3 nodes with the same type', () => {
    const twoNodeDiff = makeDiffResult({
      updated: [
        { id: '3:1', name: 'A', type: 'COMPONENT', pageName: 'Final', frameName: 'Nav', frameId: '3:0',
          changes: [{ type: 'fill_change', emoji: '🎨', label: 'Colour updated' }] },
        { id: '3:2', name: 'B', type: 'COMPONENT', pageName: 'Final', frameName: 'Nav', frameId: '3:0',
          changes: [{ type: 'fill_change', emoji: '🎨', label: 'Colour updated' }] }
      ],
      pages: ['Final'],
      totalChanges: 2
    });
    const md = buildMarkdown(twoNodeDiff, FILE_KEY, FILE_NAME, RUN_AT, ISSUE_KEY);
    expect(md).not.toContain('### Global updates');
  });
});

// ---------------------------------------------------------------------------
// Item 2 — Truncation
// ---------------------------------------------------------------------------
describe('buildMarkdown — truncation (Item 2)', () => {
  test('adds "…and X more changes not shown" when maxNodes is exceeded', () => {
    const diffResult = makeDiffResult({
      updated: [1, 2, 3, 4, 5].map(i => ({
        id: `4:${i}`, name: `Node ${i}`, type: 'TEXT',
        pageName: 'Final', frameName: 'Screen', frameId: '4:0',
        changes: [{ type: `type_${i}`, emoji: '✏️', label: `Change ${i}` }]
      })),
      pages: ['Final'],
      totalChanges: 5
    });
    const md = buildMarkdown(diffResult, FILE_KEY, FILE_NAME, RUN_AT, ISSUE_KEY, 'both', 2);
    expect(md).toMatch(/and \d+ more change/);
  });

  test('does NOT add truncation note when maxNodes is 0 (unlimited)', () => {
    const diffResult = makeDiffResult({
      updated: [1, 2, 3].map(i => ({
        id: `5:${i}`, name: `Node ${i}`, type: 'TEXT',
        pageName: 'Final', frameName: 'Screen', frameId: '5:0',
        changes: [{ type: `type_${i}`, emoji: '✏️', label: `Change ${i}` }]
      })),
      pages: ['Final'],
      totalChanges: 3
    });
    const md = buildMarkdown(diffResult, FILE_KEY, FILE_NAME, RUN_AT, ISSUE_KEY, 'both', 0);
    expect(md).not.toMatch(/and \d+ more change/);
  });
});

// ---------------------------------------------------------------------------
// buildHtml
// ---------------------------------------------------------------------------

describe('buildHtml', () => {
  test('is a valid self-contained HTML document', () => {
    const html = buildHtml(makeDiffResult(), FILE_KEY, FILE_NAME, RUN_AT, ISSUE_KEY);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('</html>');
    expect(html).toContain('<style>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<link');
  });

  test('includes the issue key in the title', () => {
    const html = buildHtml(makeDiffResult(), FILE_KEY, FILE_NAME, RUN_AT, ISSUE_KEY);
    expect(html).toContain('Design Changelog — PROJ-123');
  });

  test('includes a changed node entry with an anchor link', () => {
    const diffResult = makeDiffResult({
      updated: [{
        id: '1:2', name: 'Button', type: 'INSTANCE',
        pageName: 'Final', frameName: 'Login', frameId: '1:1',
        changes: [{ type: 'text_change', emoji: '✏️', label: 'Copy changed from "A" to "B"', oldValue: 'A', newValue: 'B' }]
      }],
      pages: ['Final'],
      totalChanges: 1
    });
    const html = buildHtml(diffResult, FILE_KEY, FILE_NAME, RUN_AT, ISSUE_KEY);
    expect(html).toContain('<a href=');
    expect(html).toContain('Login / Button');
  });
});
