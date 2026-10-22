'use strict';

/**
 * Item 5 — Exclusion rules: integration test through pipeline.
 * Item 6 — G7 partial-failure delivery policy.
 *
 * These tests drive the shared pipeline (src/pipeline.js) directly with
 * injected in-memory deps so no real I/O is needed.
 */

const { runProjectPipeline } = require('../src/pipeline');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTree(label = 'A') {
  return {
    id: '0:0', name: 'Document', type: 'DOCUMENT',
    children: [{
      id: '0:1', name: 'Final', type: 'CANVAS',
      children: [{
        id: '1:1', name: 'Screen', type: 'FRAME',
        children: [{ id: '1:2', name: 'Label', type: 'TEXT', characters: label }]
      }]
    }]
  };
}

function makeProject(extra = {}) {
  return {
    id: 'p1',
    figmaFileKey: 'ABC',
    figmaUrl: 'https://www.figma.com/design/ABC/Test',
    figmaFileName: 'Test file',
    jiraIssueKey: 'PROJ-1',
    mentionedUsers: [],
    syncComments: false,
    ...extra
  };
}

const CONFIG = {
  figmaToken: 'figd',
  jiraBaseUrl: 'https://jira.example.com',
  jiraEmail: 'a@b.c',
  jiraApiToken: 'token'
};

const V2_SNAPSHOT = snap => ({ _snapshotVersion: 2, document: snap, knownCommentIds: [], knownResolvedCommentIds: [], _savedAt: '2025-01-01T00:00:00.000Z' });

function makeDeps(overrides = {}) {
  const snapshots = new Map();
  return {
    fetchFileTree: jest.fn(async () => makeTree('A')),
    fetchComments: jest.fn(async () => []),
    postCommentToFigma: jest.fn(async () => ({ id: 'fc1' })),
    postJiraComment: jest.fn(async () => {}),
    getSnapshot: jest.fn(key => snapshots.has(key) ? JSON.parse(snapshots.get(key)) : null),
    saveSnapshot: jest.fn((key, snap) => snapshots.set(key, JSON.stringify(snap))),
    _snapshots: snapshots,
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Item 5 — exclusions propagate through the pipeline
// ---------------------------------------------------------------------------

describe('pipeline — exclusions (Item 5)', () => {
  test('pages matching exclusion do not appear in diff results', async () => {
    const treeWithWip = {
      id: '0:0', name: 'Document', type: 'DOCUMENT',
      children: [
        { id: 'p1', name: 'Final', type: 'CANVAS', children: [
          { id: '1:1', name: 'Screen', type: 'FRAME', children: [
            { id: '1:2', name: 'Label', type: 'TEXT', characters: 'v1' }
          ]}
        ]},
        { id: 'p2', name: 'WIP exploration', type: 'CANVAS', children: [
          { id: '2:1', name: 'DraftScreen', type: 'FRAME', children: [
            { id: '2:2', name: 'DraftLabel', type: 'TEXT', characters: 'draft' }
          ]}
        ]}
      ]
    };

    const deps = makeDeps({ fetchFileTree: jest.fn(async () => treeWithWip) });
    const project = makeProject({ exclusions: { pages: ['WIP*'], frames: [] } });

    // First run: baseline
    await runProjectPipeline(project, CONFIG, deps);

    // Mutate ONLY the WIP page text
    const tree2 = JSON.parse(JSON.stringify(treeWithWip));
    tree2.children[1].children[0].children[0].characters = 'changed';
    deps.fetchFileTree.mockResolvedValue(tree2);

    const result = await runProjectPipeline(project, CONFIG, deps);

    // The WIP change should be excluded → no changes posted
    expect(result.status).toBe('no_changes');
    expect(deps.postJiraComment).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Item 6 — G7 partial-failure delivery policy
// ---------------------------------------------------------------------------

describe('pipeline — G7 partial-failure policy (Item 6)', () => {
  test('snapshot IS saved when Jira succeeds', async () => {
    const deps = makeDeps();
    const project = makeProject();

    await runProjectPipeline(project, CONFIG, deps); // baseline
    deps.fetchFileTree.mockResolvedValue(makeTree('B'));

    const result = await runProjectPipeline(project, CONFIG, deps);

    expect(result.status).toBe('posted');
    expect(deps.saveSnapshot).toHaveBeenCalledTimes(2); // baseline + posted
    expect(result.channels.jira.status).toBe('sent');
  });

  test('snapshot is NOT saved when all notification channels fail', async () => {
    const jiraError = new Error('Jira 503');
    const deps = makeDeps({ postJiraComment: jest.fn(async () => { throw jiraError; }) });
    const project = makeProject();

    await runProjectPipeline(project, CONFIG, deps); // baseline (saveSnapshot called once)
    deps.fetchFileTree.mockResolvedValue(makeTree('B'));

    const result = await runProjectPipeline(project, CONFIG, deps);

    expect(result.status).toBe('error');
    // saveSnapshot should NOT have been called a second time (only the baseline call)
    expect(deps.saveSnapshot).toHaveBeenCalledTimes(1);
    expect(result.channels.jira.status).toBe('failed');
    expect(result.channels.jira.error).toBe('Jira 503');
  });

  test('optional output (export) failure does not block the snapshot', async () => {
    const exportError = new Error('disk full');
    const deps = makeDeps({
      saveExport: jest.fn(async () => { throw exportError; })
    });
    const project = makeProject({ exportFormat: 'md' });

    await runProjectPipeline(project, CONFIG, deps); // baseline
    deps.fetchFileTree.mockResolvedValue(makeTree('B'));

    const result = await runProjectPipeline(project, CONFIG, deps);

    // Jira succeeded → snapshot should be saved, status 'posted'
    expect(result.status).toBe('posted');
    expect(deps.saveSnapshot).toHaveBeenCalledTimes(2);
  });

  test('optional output (Figma comment) failure does not block the snapshot', async () => {
    const deps = makeDeps({
      postCommentToFigma: jest.fn(async () => { throw new Error('Figma 403'); })
    });
    const project = makeProject();

    await runProjectPipeline(project, CONFIG, deps); // baseline
    deps.fetchFileTree.mockResolvedValue(makeTree('B'));

    const result = await runProjectPipeline(project, CONFIG, deps);

    expect(result.status).toBe('posted');
    expect(deps.saveSnapshot).toHaveBeenCalledTimes(2);
  });

  test('appendRunEntry is called after a posted run', async () => {
    const entries = [];
    const deps = makeDeps({ appendRunEntry: jest.fn(e => entries.push(e)) });
    const project = makeProject();

    await runProjectPipeline(project, CONFIG, deps); // baseline
    deps.fetchFileTree.mockResolvedValue(makeTree('B'));
    await runProjectPipeline(project, CONFIG, deps);

    expect(deps.appendRunEntry).toHaveBeenCalledTimes(1);
    const entry = entries[0];
    expect(entry.status).toBe('posted');
    expect(entry.channels.jira.status).toBe('sent');
    expect(entry.jiraIssueKey).toBe('PROJ-1');
  });

  test('appendRunEntry is called with status error when all channels fail', async () => {
    const entries = [];
    const deps = makeDeps({
      postJiraComment: jest.fn(async () => { throw new Error('nope'); }),
      appendRunEntry: jest.fn(e => entries.push(e))
    });
    const project = makeProject();

    await runProjectPipeline(project, CONFIG, deps); // baseline
    deps.fetchFileTree.mockResolvedValue(makeTree('B'));
    await runProjectPipeline(project, CONFIG, deps);

    expect(deps.appendRunEntry).toHaveBeenCalledTimes(1);
    expect(entries[0].status).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// Item 6 — runLog.js unit tests
// ---------------------------------------------------------------------------

describe('runLog', () => {
  // Use a fresh temp file for each test
  const os = require('os');
  const path = require('path');
  const fs = require('fs');

  let origDir;
  beforeEach(() => {
    origDir = process.env.RUNTIME_DIR_OVERRIDE;
    // Point configStore.runtimeDir() at a temp dir by monkeypatching
  });
  afterEach(() => {
    if (origDir !== undefined) process.env.RUNTIME_DIR_OVERRIDE = origDir;
    else delete process.env.RUNTIME_DIR_OVERRIDE;
  });

  test('appendRunEntry stores an entry and returns it with an id', () => {
    // Use a fresh module instance backed by a temp dir
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runlog-'));
    jest.resetModules();
    jest.doMock('../src/configStore', () => ({ runtimeDir: () => tmpDir }));
    const { appendRunEntry, getRunLog, clearRunLog } = require('../src/runLog');

    const entry = appendRunEntry({ projectId: 'p1', figmaFileName: 'Test', runAt: '2025-01-01T00:00:00Z', status: 'posted', changesCount: 3, channels: { jira: { status: 'sent' } } });

    expect(entry.id).toBeDefined();
    const log = getRunLog();
    expect(log).toHaveLength(1);
    expect(log[0].status).toBe('posted');

    clearRunLog();
    expect(getRunLog()).toHaveLength(0);
  });

  test('enforces MAX_ENTRIES cap', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runlog-cap-'));
    jest.resetModules();
    jest.doMock('../src/configStore', () => ({ runtimeDir: () => tmpDir }));
    const { appendRunEntry, getRunLog, MAX_ENTRIES } = require('../src/runLog');

    for (let i = 0; i < MAX_ENTRIES + 5; i++) {
      appendRunEntry({ projectId: 'p1', figmaFileName: 'F', runAt: new Date().toISOString(), status: 'posted', changesCount: 1, channels: {} });
    }
    expect(getRunLog().length).toBe(MAX_ENTRIES);
  });

  test('updateChannelResult updates a stored entry', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runlog-upd-'));
    jest.resetModules();
    jest.doMock('../src/configStore', () => ({ runtimeDir: () => tmpDir }));
    const { appendRunEntry, updateChannelResult, getRunLog } = require('../src/runLog');

    const stored = appendRunEntry({ projectId: 'p1', figmaFileName: 'F', runAt: new Date().toISOString(), status: 'error', changesCount: 1, channels: { jira: { status: 'failed', error: 'x' } } });
    const ok = updateChannelResult(stored.id, 'jira', { status: 'sent' });
    expect(ok).toBe(true);
    const log = getRunLog();
    expect(log[0].channels.jira.status).toBe('sent');
  });
});

// ---------------------------------------------------------------------------
// Item 4 — syncChangesToFigma uses Item 2 layout
// ---------------------------------------------------------------------------

describe('syncChangesToFigma — Item 2 layout (Item 4)', () => {
  const { syncChangesToFigma } = require('../src/pipeline');

  const DIFF = {
    added: [],
    removed: [],
    updated: [{
      id: '1:2', name: 'Label', type: 'TEXT',
      pageName: 'Final', frameName: 'Screen', frameId: '1:1',
      changes: [{ type: 'text_change', emoji: '✏️', label: 'Copy changed from "A" to "B"', oldValue: 'A', newValue: 'B' }]
    }],
    totalChanges: 1,
    pages: ['Final'],
    figmaFileName: 'My Design'
  };

  test('posts a comment with the 🔔 notification line', async () => {
    const captured = [];
    const mockPost = jest.fn(async (fk, tok, msg) => { captured.push(msg); return { id: 'c1' }; });

    await syncChangesToFigma(mockPost, 'AbC123', 'figd', DIFF, '2025-07-14T08:00:00Z', 'PROJ-1', 'https://jira.example.com');

    expect(captured[0]).toMatch(/🔔.*PROJ-1/);
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  test('posts a comment using the Item 2 layout (Design Changelog header + page heading)', async () => {
    const captured = [];
    const mockPost = jest.fn(async (fk, tok, msg) => { captured.push(msg); return { id: 'c1' }; });

    await syncChangesToFigma(mockPost, 'AbC123', 'figd', DIFF, '2025-07-14T08:00:00Z', 'PROJ-1', '');

    const msg = captured[0];
    expect(msg).toContain('# Design Changelog');
    expect(msg).toContain('## Final');
    expect(msg).toContain('✏️ Copy changed from "A" to "B"');
  });

  test('returns null and does not call postCommentToFigma when enabled is false', async () => {
    const mockPost = jest.fn();
    const result = await syncChangesToFigma(mockPost, 'AbC123', 'figd', DIFF, '2025-07-14T08:00:00Z', 'PROJ-1', '', false);
    expect(result).toBeNull();
    expect(mockPost).not.toHaveBeenCalled();
  });

  test('returns null without posting when token is missing', async () => {
    const mockPost = jest.fn();
    const result = await syncChangesToFigma(mockPost, 'AbC123', '', DIFF, '2025-07-14T08:00:00Z', 'PROJ-1', '');
    expect(result).toBeNull();
    expect(mockPost).not.toHaveBeenCalled();
  });
});
