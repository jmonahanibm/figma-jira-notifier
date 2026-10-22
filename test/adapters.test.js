'use strict';

const { detectMode, createServerAdapter, createBrowserAdapter, createAdapter, MASK } = require('../gui/adapters');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: k => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: k => { data.delete(k); },
    _data: data
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

const CONFIG_KEY = 'figma-changelog-config';

function treeWithLabel(label) {
  return {
    id: '0:0', name: 'Document', type: 'DOCUMENT',
    children: [{
      id: '0:1', name: 'Final', type: 'CANVAS',
      children: [{
        id: '1:1', name: 'Login', type: 'FRAME',
        children: [{ id: '1:2', name: 'Button label', type: 'TEXT', characters: label }]
      }]
    }]
  };
}

// ---------------------------------------------------------------------------
// Mode detection
// ---------------------------------------------------------------------------

describe('detectMode', () => {
  test('server when GET /api/config returns a JSON object', async () => {
    const fetch = jest.fn(async () => jsonResponse({ projects: [] }));
    expect(await detectMode(fetch)).toBe('server');
    expect(fetch).toHaveBeenCalledWith('/api/config');
  });

  test('hosted when /api/config is 404 (static host)', async () => {
    expect(await detectMode(async () => jsonResponse({}, 404))).toBe('hosted');
  });

  test('hosted when the response is not JSON (static host returning an HTML page)', async () => {
    const fetch = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } });
    expect(await detectMode(fetch)).toBe('hosted');
  });

  test('hosted when the request itself fails', async () => {
    expect(await detectMode(async () => { throw new TypeError('Failed to fetch'); })).toBe('hosted');
  });
});

describe('createAdapter', () => {
  test('returns the server adapter in server mode', async () => {
    const adapter = await createAdapter({ fetch: async () => jsonResponse({ projects: [] }), storage: memoryStorage() });
    expect(adapter.mode).toBe('server');
  });

  test('returns the browser adapter in hosted mode', async () => {
    const adapter = await createAdapter({ fetch: async () => jsonResponse({}, 404), storage: memoryStorage() });
    expect(adapter.mode).toBe('hosted');
  });
});

// ---------------------------------------------------------------------------
// Server adapter
// ---------------------------------------------------------------------------

describe('server adapter', () => {
  test('getConfig GETs /api/config', async () => {
    const fetch = jest.fn(async () => jsonResponse({ projects: [], figmaToken: MASK }));
    const adapter = createServerAdapter({ fetch });
    expect(await adapter.getConfig()).toEqual({ projects: [], figmaToken: MASK });
    expect(fetch).toHaveBeenCalledWith('/api/config', { method: 'GET' });
  });

  test('saveConfig POSTs the config as JSON', async () => {
    const fetch = jest.fn(async () => jsonResponse({ ok: true }));
    const adapter = createServerAdapter({ fetch });
    await adapter.saveConfig({ schedule: '0 9 * * *' });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('/api/config');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ schedule: '0 9 * * *' });
  });

  test('runAll POSTs an empty body and returns results', async () => {
    const results = [{ projectId: 'p1', status: 'no_changes' }];
    const fetch = jest.fn(async () => jsonResponse({ ok: true, results }));
    const adapter = createServerAdapter({ fetch });
    expect(await adapter.runAll()).toEqual(results);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({});
  });

  test('runProject POSTs the projectId', async () => {
    const fetch = jest.fn(async () => jsonResponse({ ok: true, results: [{ projectId: 'p1' }] }));
    const adapter = createServerAdapter({ fetch });
    await adapter.runProject('p1');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ projectId: 'p1' });
  });

  test('getWatchers GETs the watchers route with an encoded key', async () => {
    const fetch = jest.fn(async () => jsonResponse({ watchers: [{ email: 'a@b.c' }] }));
    const adapter = createServerAdapter({ fetch });
    expect(await adapter.getWatchers('PROJ-1')).toEqual([{ email: 'a@b.c' }]);
    expect(fetch.mock.calls[0][0]).toBe('/api/jira/watchers?issueKey=PROJ-1');
  });

  test('surfaces the server error message on a failed request', async () => {
    const adapter = createServerAdapter({ fetch: async () => jsonResponse({ error: 'Project not found' }, 404) });
    await expect(adapter.runProject('nope')).rejects.toThrow('Project not found');
  });

  test('last-run time round-trips through the supplied storage', () => {
    const adapter = createServerAdapter({ fetch: jest.fn(), storage: memoryStorage() });
    expect(adapter.getLastRun()).toBeNull();
    adapter.setLastRun('2025-01-01T00:00:00.000Z');
    expect(adapter.getLastRun()).toBe('2025-01-01T00:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// Browser adapter — config
// ---------------------------------------------------------------------------

describe('browser adapter — config', () => {
  test('getConfig returns defaults when nothing is stored', async () => {
    const adapter = createBrowserAdapter({ fetch: jest.fn(), storage: memoryStorage() });
    const config = await adapter.getConfig();
    expect(config.projects).toEqual([]);
    expect(config.schedule).toBe('0 8 * * *');
  });

  test('getConfig masks stored secrets like the server does', async () => {
    const storage = memoryStorage({
      [CONFIG_KEY]: JSON.stringify({ projects: [], figmaToken: 'figd_secret', jiraApiToken: 'jira_secret' })
    });
    const adapter = createBrowserAdapter({ fetch: jest.fn(), storage });
    const config = await adapter.getConfig();
    expect(config.figmaToken).toBe(MASK);
    expect(config.jiraApiToken).toBe(MASK);
  });

  test('getConfig leaves empty secrets empty (so the UI can show "not set")', async () => {
    const adapter = createBrowserAdapter({ fetch: jest.fn(), storage: memoryStorage() });
    const config = await adapter.getConfig();
    expect(config.figmaToken).toBe('');
  });

  test('saveConfig stores the config in localStorage', async () => {
    const storage = memoryStorage();
    const adapter = createBrowserAdapter({ fetch: jest.fn(), storage });
    await adapter.saveConfig({ projects: [{ id: 'p1' }], jiraBaseUrl: 'https://x.atlassian.net', figmaToken: 'figd_new' });
    const stored = JSON.parse(storage.getItem(CONFIG_KEY));
    expect(stored.projects).toEqual([{ id: 'p1' }]);
    expect(stored.figmaToken).toBe('figd_new');
  });

  test("saveConfig keeps the stored secret when the incoming value is '***'", async () => {
    const storage = memoryStorage({
      [CONFIG_KEY]: JSON.stringify({ projects: [], figmaToken: 'figd_secret', jiraApiToken: 'jira_secret' })
    });
    const adapter = createBrowserAdapter({ fetch: jest.fn(), storage });
    await adapter.saveConfig({ projects: [], figmaToken: MASK, jiraApiToken: MASK, schedule: '0 9 * * *' });
    const stored = JSON.parse(storage.getItem(CONFIG_KEY));
    expect(stored.figmaToken).toBe('figd_secret');
    expect(stored.jiraApiToken).toBe('jira_secret');
    expect(stored.schedule).toBe('0 9 * * *');
  });

  test('a corrupt stored config falls back to defaults', async () => {
    const storage = memoryStorage({ [CONFIG_KEY]: '{not json' });
    const adapter = createBrowserAdapter({ fetch: jest.fn(), storage });
    expect((await adapter.getConfig()).projects).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Browser adapter — snapshots
// ---------------------------------------------------------------------------

describe('browser adapter — snapshots', () => {
  test('getSnapshot returns null when none is stored', () => {
    const adapter = createBrowserAdapter({ fetch: jest.fn(), storage: memoryStorage() });
    expect(adapter.getSnapshot('AbC')).toBeNull();
  });

  test('saveSnapshot / getSnapshot round-trip', () => {
    const adapter = createBrowserAdapter({ fetch: jest.fn(), storage: memoryStorage() });
    const snap = { _snapshotVersion: 2, document: { id: '0:0' }, knownCommentIds: ['c1'] };
    adapter.saveSnapshot('AbC', snap);
    expect(adapter.getSnapshot('AbC')).toEqual(snap);
  });

  test('a corrupt stored snapshot reads as null', () => {
    const storage = memoryStorage({ 'figma-snapshot-AbC': 'garbage' });
    const adapter = createBrowserAdapter({ fetch: jest.fn(), storage });
    expect(adapter.getSnapshot('AbC')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Browser adapter — runs
// ---------------------------------------------------------------------------

describe('browser adapter — runs', () => {
  const FILE_KEY = 'AbC123';
  const project = {
    id: 'p1', figmaFileKey: FILE_KEY, figmaUrl: `https://www.figma.com/design/${FILE_KEY}/Test`,
    figmaFileName: 'Test file', jiraIssueKey: 'PROJ-1', mentionedUsers: [], syncComments: true
  };

  /** A fake Figma + Jira reachable through one fetch. */
  function makeFetch(state) {
    const calls = [];
    const fetch = jest.fn(async (url, init = {}) => {
      calls.push({ url, init });
      if (url.startsWith('https://api.figma.com/v1/files/') && url.includes('/comments')) {
        if (init.method === 'POST') {
          const created = { id: `bot-${state.nextId++}`, message: JSON.parse(init.body).message, resolved_at: null };
          state.comments.push(created);
          return jsonResponse(created);
        }
        return jsonResponse({ comments: state.comments });
      }
      if (url.startsWith('https://api.figma.com/v1/files/')) {
        return jsonResponse({ document: state.tree });
      }
      if (url.includes('/rest/api/3/issue/') && url.endsWith('/comment')) {
        state.jiraPosts.push(JSON.parse(init.body));
        return jsonResponse({ id: '1' }, 201);
      }
      if (url.endsWith('/watchers')) {
        return jsonResponse({ watchers: [{ accountId: 'a1', displayName: 'Alice Doe', emailAddress: 'alice@x.com' }, { accountId: 'a2', displayName: 'Bob' }] });
      }
      return jsonResponse({}, 404);
    });
    fetch.calls = calls;
    return fetch;
  }

  function setup(overrides = {}) {
    const state = { tree: treeWithLabel('Submit'), comments: [], nextId: 1, jiraPosts: [] };
    const config = {
      projects: [project], figmaToken: 'figd_tok', jiraBaseUrl: 'https://x.atlassian.net/',
      jiraEmail: 'me@x.com', jiraApiToken: 'jira_tok', schedule: '0 8 * * *', ...overrides
    };
    const storage = memoryStorage({ [CONFIG_KEY]: JSON.stringify(config) });
    const fetch = makeFetch(state);
    const adapter = createBrowserAdapter({ fetch, storage, btoa: s => Buffer.from(s).toString('base64') });
    return { state, storage, fetch, adapter };
  }

  test('first run saves a baseline snapshot and posts nothing', async () => {
    const { adapter, state } = setup();
    const results = await adapter.runAll();
    expect(results[0].status).toBe('first_run');
    expect(state.jiraPosts).toHaveLength(0);
    expect(adapter.getSnapshot(FILE_KEY)._snapshotVersion).toBe(2);
  });

  test('a design change is posted to Jira with Basic auth and the snapshot advances', async () => {
    const { adapter, state, fetch } = setup();
    await adapter.runAll();
    state.tree = treeWithLabel('Continue');

    const results = await adapter.runAll();

    expect(results[0].status).toBe('posted');
    expect(state.jiraPosts).toHaveLength(1);
    expect(state.jiraPosts[0].body.type).toBe('doc');
    const jiraCall = fetch.calls.find(c => c.url.endsWith('/comment') && c.url.includes('/rest/api/3/'));
    expect(jiraCall.url).toBe('https://x.atlassian.net/rest/api/3/issue/PROJ-1/comment');
    expect(jiraCall.init.headers.Authorization).toBe('Basic ' + Buffer.from('me@x.com:jira_tok').toString('base64'));
  });

  test("the tool's own Figma comment is not reported on the next run (G19, browser path)", async () => {
    const { adapter, state } = setup();
    await adapter.runAll();
    state.tree = treeWithLabel('Continue');
    await adapter.runAll();

    const third = await adapter.runAll();

    expect(third[0].status).toBe('no_changes');
    expect(state.jiraPosts).toHaveLength(1);
  });

  test('an unversioned snapshot is re-baselined, not diffed', async () => {
    const { adapter, state } = setup();
    adapter.saveSnapshot(FILE_KEY, { document: treeWithLabel('Submit'), _savedAt: '2024-01-01T00:00:00.000Z' });
    const results = await adapter.runAll();
    expect(results[0].status).toBe('rebaselined');
    expect(state.jiraPosts).toHaveLength(0);
  });

  test('runAll with no projects returns an empty list without needing a token', async () => {
    const { adapter } = setup({ projects: [], figmaToken: '' });
    expect(await adapter.runAll()).toEqual([]);
  });

  test('runAll without a Figma token fails with a clear message', async () => {
    const { adapter } = setup({ figmaToken: '' });
    await expect(adapter.runAll()).rejects.toThrow('Figma personal access token is required');
  });

  test('runProject runs only the requested project', async () => {
    const other = { ...project, id: 'p2', figmaFileKey: 'Other99' };
    const { adapter } = setup({ projects: [project, other] });
    const results = await adapter.runProject('p2');
    expect(results).toHaveLength(1);
    expect(results[0].projectId).toBe('p2');
  });

  test('runProject rejects for an unknown project id', async () => {
    const { adapter } = setup();
    await expect(adapter.runProject('missing')).rejects.toThrow('Project not found');
  });

  test('a Figma API failure becomes an error result, not a thrown exception', async () => {
    const { adapter, fetch } = setup();
    fetch.mockImplementation(async () => jsonResponse({ err: 'Forbidden' }, 403));
    const results = await adapter.runAll();
    expect(results[0].status).toBe('error');
    expect(results[0].error).toMatch(/403/);
  });

  test('a network (CORS) failure on Figma names the local-server workaround', async () => {
    const { adapter, fetch } = setup();
    fetch.mockImplementation(async () => { throw new TypeError('Failed to fetch'); });
    const results = await adapter.runAll();
    expect(results[0].status).toBe('error');
    expect(results[0].error).toMatch(/npm start/);
  });

  test('a Jira failure leaves the snapshot unchanged so the change is retried', async () => {
    const { adapter, state, fetch } = setup();
    await adapter.runAll();
    const before = adapter.getSnapshot(FILE_KEY);
    state.tree = treeWithLabel('Continue');
    const original = fetch.getMockImplementation();
    fetch.mockImplementation(async (url, init) =>
      url.includes('/rest/api/3/issue/') ? jsonResponse({ errorMessages: ['nope'] }, 401) : original(url, init));

    const results = await adapter.runAll();

    expect(results[0].status).toBe('error');
    expect(adapter.getSnapshot(FILE_KEY)).toEqual(before);
  });

  test('getWatchers maps Jira watchers and falls back to display name without an email', async () => {
    const { adapter } = setup();
    const watchers = await adapter.getWatchers('PROJ-1');
    expect(watchers).toEqual([
      { accountId: 'a1', displayName: 'Alice Doe', email: 'alice@x.com' },
      { accountId: 'a2', displayName: 'Bob', email: null }
    ]);
  });

  test('getWatchers requires Jira settings', async () => {
    const { adapter } = setup({ jiraApiToken: '' });
    await expect(adapter.getWatchers('PROJ-1')).rejects.toThrow('Jira settings');
  });
});
