'use strict';

/**
 * G19 — Figma comment feedback loop.
 *
 * Simulates Figma, the snapshot store and Jira in memory and runs the real
 * runProject() pipeline several times. The tool's own Figma comment must not
 * be reported as a "new comment" on the following run.
 */

const mockFigma = { tree: null, comments: [], nextCommentId: 1 };
const mockSnapshots = new Map();
const mockJiraPosts = [];

jest.mock('../src/configStore', () => ({ getConfig: jest.fn(() => ({ projects: [] })) }));

jest.mock('../src/figmaClient', () => ({
  fetchFileTree: jest.fn(async () => mockFigma.tree),
  fetchComments: jest.fn(async () => mockFigma.comments.map(c => ({ ...c }))),
  // Like the real Figma API, the created comment appears in later fetches
  // and is returned to the caller.
  postCommentToFigma: jest.fn(async (fileKey, token, message) => {
    const comment = {
      id: `bot-${mockFigma.nextCommentId++}`,
      message,
      user: { handle: 'design-changelog-bot' },
      resolved_at: null
    };
    mockFigma.comments.push(comment);
    return comment;
  })
}));

jest.mock('../src/snapshotStore', () => ({
  getSnapshot: jest.fn(key => (mockSnapshots.has(key) ? JSON.parse(mockSnapshots.get(key)) : null)),
  saveSnapshot: jest.fn((key, data) => { mockSnapshots.set(key, JSON.stringify(data)); })
}));

jest.mock('../src/jiraClient', () => ({
  buildCommentAdfList: jest.fn(() => [{ version: 1, type: 'doc', content: [] }]),
  postComment: jest.fn(async (...args) => { mockJiraPosts.push(args); })
}));

const { runProject } = require('../src/diffRunner');
const figmaClient = require('../src/figmaClient');

const FILE_KEY = 'AbC123';
const CONFIG = { figmaToken: 'figd_token', jiraBaseUrl: 'https://x.atlassian.net', jiraEmail: 'a@b.c', jiraApiToken: 't' };

function buildTree(buttonLabel) {
  return {
    id: '0:0', name: 'Document', type: 'DOCUMENT',
    children: [{
      id: '0:1', name: 'Final', type: 'CANVAS',
      children: [{
        id: '1:1', name: 'Login Flow', type: 'FRAME',
        children: [{ id: '1:2', name: 'Button label', type: 'TEXT', characters: buttonLabel }]
      }]
    }]
  };
}

function makeProject(syncComments, extra = {}) {
  return {
    id: 'p1',
    figmaFileKey: FILE_KEY,
    figmaUrl: `https://www.figma.com/design/${FILE_KEY}/Test`,
    figmaFileName: 'Test file',
    jiraIssueKey: 'PROJ-123',
    mentionedUsers: [],
    syncComments,
    ...extra
  };
}

beforeEach(() => {
  mockFigma.tree = buildTree('Submit');
  mockFigma.comments = [];
  mockFigma.nextCommentId = 1;
  mockSnapshots.clear();
  mockJiraPosts.length = 0;
  jest.clearAllMocks();
});

describe('runProject — Figma comment feedback loop (G19)', () => {
  test('baseline run, one real design change, then an unchanged file → no_changes', async () => {
    const project = makeProject(true);

    const first = await runProject(project, CONFIG);
    expect(first.status).toBe('first_run');

    mockFigma.tree = buildTree('Continue');
    const second = await runProject(project, CONFIG);
    expect(second.status).toBe('posted');
    expect(mockJiraPosts).toHaveLength(1);
    expect(figmaClient.postCommentToFigma).toHaveBeenCalledTimes(1);

    // Nothing changed in the design since the previous run. The only new
    // thing in the file is the comment the tool itself posted to Figma.
    const third = await runProject(project, CONFIG);

    expect(third.status).toBe('no_changes');
    expect(third.changesCount).toBe(0);
    expect(mockJiraPosts).toHaveLength(1);
    expect(figmaClient.postCommentToFigma).toHaveBeenCalledTimes(1);
  });

  test('stays quiet over several consecutive unchanged runs', async () => {
    const project = makeProject(true);

    await runProject(project, CONFIG);
    mockFigma.tree = buildTree('Continue');
    await runProject(project, CONFIG);

    const statuses = [];
    for (let i = 0; i < 3; i++) {
      statuses.push((await runProject(project, CONFIG)).status);
    }

    expect(statuses).toEqual(['no_changes', 'no_changes', 'no_changes']);
    expect(mockJiraPosts).toHaveLength(1);
  });

  test('a comment written by a person after the tool posted is still reported as new', async () => {
    const project = makeProject(true);

    await runProject(project, CONFIG);
    mockFigma.tree = buildTree('Continue');
    await runProject(project, CONFIG);

    mockFigma.comments.push({
      id: 'human-1', message: 'Can we make this button larger?',
      user: { handle: 'alice' }, resolved_at: null
    });

    const result = await runProject(project, CONFIG);

    expect(result.status).toBe('posted');
    expect(result.changesCount).toBe(1);
    expect(mockJiraPosts).toHaveLength(2);
  });

  test('control: with syncComments off, an unchanged file is already no_changes', async () => {
    const project = makeProject(false);

    await runProject(project, CONFIG);
    mockFigma.tree = buildTree('Continue');
    await runProject(project, CONFIG);

    const third = await runProject(project, CONFIG);

    expect(third.status).toBe('no_changes');
    expect(mockJiraPosts).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Item 15 — snapshot version stamp and re-baseline
// ---------------------------------------------------------------------------

describe('runProject — snapshot version stamp', () => {
  test('a new baseline snapshot carries _snapshotVersion: 2', async () => {
    const project = makeProject(false);
    await runProject(project, CONFIG);
    const saved = JSON.parse(mockSnapshots.get(FILE_KEY));
    expect(saved._snapshotVersion).toBe(2);
  });

  test('a posted snapshot carries _snapshotVersion: 2', async () => {
    const project = makeProject(false);
    await runProject(project, CONFIG);
    mockFigma.tree = buildTree('Changed');
    await runProject(project, CONFIG);
    const saved = JSON.parse(mockSnapshots.get(FILE_KEY));
    expect(saved._snapshotVersion).toBe(2);
  });
});

describe('runProject — re-baseline on stale snapshot', () => {
  function saveStaleSnapshot(key, tree) {
    mockSnapshots.set(key, JSON.stringify({
      document: tree,
      knownCommentIds: [],
      knownResolvedCommentIds: [],
      _savedAt: '2024-01-01T00:00:00.000Z'
      // no _snapshotVersion — this is a v1 snapshot
    }));
  }

  test('a snapshot without a version triggers rebaselined status and no Jira post', async () => {
    const project = makeProject(false);
    saveStaleSnapshot(FILE_KEY, mockFigma.tree);
    const result = await runProject(project, CONFIG);
    expect(result.status).toBe('rebaselined');
    expect(mockJiraPosts).toHaveLength(0);
  });

  test('re-baseline saves a v2 snapshot', async () => {
    const project = makeProject(false);
    saveStaleSnapshot(FILE_KEY, mockFigma.tree);
    await runProject(project, CONFIG);
    const saved = JSON.parse(mockSnapshots.get(FILE_KEY));
    expect(saved._snapshotVersion).toBe(2);
  });

  test('after a re-baseline the next run diffs normally', async () => {
    const project = makeProject(false);
    saveStaleSnapshot(FILE_KEY, mockFigma.tree);
    await runProject(project, CONFIG);              // rebaseline

    mockFigma.tree = buildTree('Changed label');
    const result = await runProject(project, CONFIG);
    expect(result.status).toBe('posted');
    expect(mockJiraPosts).toHaveLength(1);
  });

  test('re-baseline stores current comment ids so existing comments are not re-reported', async () => {
    const project = makeProject(true);
    mockFigma.comments = [
      { id: 'c1', message: 'Old comment', user: { handle: 'alice' }, resolved_at: null }
    ];
    saveStaleSnapshot(FILE_KEY, mockFigma.tree);
    await runProject(project, CONFIG);              // rebaseline

    // New unchanged run — only the pre-existing comment is in the file, nothing new
    const result = await runProject(project, CONFIG);
    expect(result.status).toBe('no_changes');
  });
});

// ---------------------------------------------------------------------------
// Item 4 — postFigmaComment per-project toggle
// ---------------------------------------------------------------------------

describe('runProject — postFigmaComment toggle', () => {
  test('Figma comment is posted by default (postFigmaComment unset)', async () => {
    const project = makeProject(false); // no postFigmaComment field

    await runProject(project, CONFIG);                     // first_run baseline
    mockFigma.tree = buildTree('Changed');
    await runProject(project, CONFIG);                     // posted run

    expect(figmaClient.postCommentToFigma).toHaveBeenCalledTimes(1);
  });

  test('Figma comment is suppressed when postFigmaComment: false', async () => {
    const project = makeProject(false, { postFigmaComment: false });

    await runProject(project, CONFIG);                     // first_run baseline
    mockFigma.tree = buildTree('Changed');
    await runProject(project, CONFIG);                     // posted run

    expect(figmaClient.postCommentToFigma).not.toHaveBeenCalled();
  });

  test('Jira comment is still posted even when postFigmaComment: false', async () => {
    const project = makeProject(false, { postFigmaComment: false });

    await runProject(project, CONFIG);
    mockFigma.tree = buildTree('Changed');
    const result = await runProject(project, CONFIG);

    expect(result.status).toBe('posted');
    expect(mockJiraPosts).toHaveLength(1);
  });

  test('comment text includes the Jira back-link when jiraBaseUrl is set', async () => {
    const project = makeProject(false);

    await runProject(project, CONFIG);
    mockFigma.tree = buildTree('Changed');
    await runProject(project, CONFIG);

    const [, , message] = figmaClient.postCommentToFigma.mock.calls[0];
    // CONFIG.jiraBaseUrl is 'https://x.atlassian.net' and jiraIssueKey is 'PROJ-123'
    expect(message).toContain('PROJ-123');
    expect(message).toContain('https://x.atlassian.net/browse/PROJ-123');
  });

  test('comment text uses emoji change lines from structured describeChanges', async () => {
    const project = makeProject(false);

    await runProject(project, CONFIG);
    mockFigma.tree = buildTree('Changed');
    await runProject(project, CONFIG);

    const [, , message] = figmaClient.postCommentToFigma.mock.calls[0];
    // The diff contains a text change; structured changes carry emoji labels
    expect(message).toMatch(/✏️|➕|➖|🎨|🔄|👁️|🔔/);
  });
});
