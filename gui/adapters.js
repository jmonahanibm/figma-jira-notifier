'use strict';

/**
 * Data-access layer for the GUI (Item 10).
 *
 * The GUI talks only to an "adapter", never to fetch('/api/...') or
 * localStorage directly, so it does not know which mode it is running in.
 *
 *   server adapter  — the Express API (the binary / `npm start`)
 *   browser adapter — localStorage + direct Figma/Jira calls (GitHub Pages)
 *
 * Shared adapter interface:
 *   getConfig()               -> config, with secret fields masked as '***'
 *   saveConfig(config)        -> void; a '***' secret keeps the stored value
 *   runAll()                  -> result[]
 *   runProject(projectId)     -> result[]  (one entry)
 *   getWatchers(issueKey)     -> { accountId, displayName, email }[]
 *   getLastRun() / setLastRun(iso)
 *   saveExport(projectId, issueKey, content, ext) -> void  (browser: triggers download)
 *   getLatestExportUrl(projectId) -> string | null  (server: /api/export/:id; browser: null)
 *
 * Browser adapter only (the server keeps snapshots on disk and has no API for
 * them yet; Item 3 adds routes and server-side methods):
 *   getSnapshot(fileKey) / saveSnapshot(fileKey, snapshot)
 *
 * Storage rule (G8): any new stored data added by later items goes through
 * this layer, never through direct fs / localStorage calls in feature code.
 */

const { runProjectPipeline } = require('../src/pipeline');

const MASK = '***';
const CONFIG_KEY = 'figma-changelog-config';
const SNAPSHOT_KEY_PREFIX = 'figma-snapshot-';
const SNAPSHOT_ARCHIVE_KEY_PREFIX = 'figma-snapshot-archive-';
const LAST_RUN_KEY = 'figma-last-run';
const RUN_LOG_KEY = 'figma-run-log';
const MAX_LOG_ENTRIES = 50;
const MAX_ARCHIVE_ENTRIES = 5; // lower cap for localStorage
const FIGMA_BASE = 'https://api.figma.com';

function defaultConfig() {
  return { projects: [], schedule: '0 8 * * *', jiraBaseUrl: '', jiraEmail: '', figmaToken: '', jiraApiToken: '' };
}

// ---------------------------------------------------------------------------
// Mode detection
// ---------------------------------------------------------------------------

/**
 * Probes GET /api/config. A JSON object response means the Express server is
 * behind this page; anything else (404, network error, an HTML page) means the
 * page is hosted statically.
 * @returns {Promise<'server'|'hosted'>}
 */
async function detectMode(fetchFn = globalThis.fetch) {
  try {
    const res = await fetchFn('/api/config');
    if (!res.ok) return 'hosted';
    const body = await res.json();
    return body && typeof body === 'object' ? 'server' : 'hosted';
  } catch {
    return 'hosted';
  }
}

// ---------------------------------------------------------------------------
// Last-run time (UI state; kept in localStorage in both modes when available)
// ---------------------------------------------------------------------------

function lastRunAccessors(storage) {
  return {
    getLastRun: () => (storage ? storage.getItem(LAST_RUN_KEY) : null),
    setLastRun: iso => { if (storage) storage.setItem(LAST_RUN_KEY, iso); }
  };
}

// ---------------------------------------------------------------------------
// Server adapter
// ---------------------------------------------------------------------------

function createServerAdapter({ fetch: fetchFn = globalThis.fetch, storage = null } = {}) {
  async function request(method, path, body) {
    const init = { method };
    if (body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const res = await fetchFn(path, init);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${method} ${path} failed: ${res.status}`);
    return data;
  }

  return {
    mode: 'server',
    getConfig: () => request('GET', '/api/config'),
    saveConfig: async config => { await request('POST', '/api/config', config); },
    runAll: async () => (await request('POST', '/api/run', {})).results || [],
    runProject: async projectId => (await request('POST', '/api/run', { projectId })).results || [],
    getWatchers: async issueKey =>
      (await request('GET', `/api/jira/watchers?issueKey=${encodeURIComponent(issueKey)}`)).watchers || [],
    searchUsers: async query =>
      (await request('GET', `/api/jira/users/search?query=${encodeURIComponent(query)}`)).users || [],
    // Export: the server writes the file; the GUI downloads via the API route.
    saveExport: async () => { /* server-side only; pipeline.js calls exportStore.saveExport directly */ },
    getLatestExportUrl: projectId => `/api/export/${encodeURIComponent(projectId)}`,
    // Run log
    getRunLog: async () => (await request('GET', '/api/runs')).runs || [],
    clearRunLog: async () => { await request('DELETE', '/api/runs'); },
    resendChannel: async (runId, channel) => request('POST', `/api/runs/${encodeURIComponent(runId)}/resend/${encodeURIComponent(channel)}`),
    // Snapshot history (Item 3)
    listSnapshots: async fileKey =>
      (await request('GET', `/api/snapshots/${encodeURIComponent(fileKey)}`)).snapshots || [],
    restoreSnapshot: async (fileKey, timestamp) =>
      request('POST', `/api/snapshots/${encodeURIComponent(fileKey)}/restore/${encodeURIComponent(timestamp)}`),
    getLocalSettings: async () => (await request('GET', '/api/local-settings')).settings || {},
    saveLocalSettings: async settings => (await request('POST', '/api/local-settings', settings)).settings || {},
    testDataDir: async path => request('POST', '/api/test-data-dir', { path }),
    ...lastRunAccessors(storage)
  };
}

// ---------------------------------------------------------------------------
// Browser adapter
// ---------------------------------------------------------------------------

function createBrowserAdapter({ fetch: fetchFn = globalThis.fetch, storage, btoa: btoaFn = globalThis.btoa } = {}) {
  function loadConfig() {
    try {
      const raw = storage.getItem(CONFIG_KEY);
      return raw ? { ...defaultConfig(), ...JSON.parse(raw) } : defaultConfig();
    } catch {
      return defaultConfig();
    }
  }

  function getSnapshot(fileKey) {
    try {
      const raw = storage.getItem(SNAPSHOT_KEY_PREFIX + fileKey);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function saveSnapshot(fileKey, snapshot) {
    storage.setItem(SNAPSHOT_KEY_PREFIX + fileKey, JSON.stringify(snapshot));
  }

  function jiraAuthHeaders(config) {
    return {
      'Authorization': 'Basic ' + btoaFn(`${config.jiraEmail}:${config.jiraApiToken}`),
      'Accept': 'application/json'
    };
  }

  function requireJira(config) {
    if (!config.jiraBaseUrl || !config.jiraEmail || !config.jiraApiToken) {
      throw new Error('Jira settings (base URL, email, API token) are required.');
    }
  }

  async function figmaRequest(method, path, token, body) {
    const init = { method, headers: { 'X-Figma-Token': token } };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetchFn(`${FIGMA_BASE}${path}`, init);
    } catch (err) {
      throw new Error(`Network/CORS error accessing Figma API from browser. Please run locally via npm start: ${err.message}`);
    }
    if (!res.ok) throw new Error(`Figma API error (${res.status}): ${await res.text()}`);
    return res.json();
  }

  // I/O handed to the shared pipeline (src/pipeline.js)
  const deps = {
    fetchFileTree: async (fileKey, token) =>
      (await figmaRequest('GET', `/v1/files/${fileKey}?geometry=omit`, token)).document,
    fetchComments: async (fileKey, token) =>
      (await figmaRequest('GET', `/v1/files/${fileKey}/comments`, token)).comments || [],
    postCommentToFigma: (fileKey, token, message, clientMeta) =>
      figmaRequest('POST', `/v1/files/${fileKey}/comments`, token,
        clientMeta ? { message, client_meta: clientMeta } : { message }),
    postJiraComment: async (config, issueKey, adfList) => {
      requireJira(config);
      const url = `${config.jiraBaseUrl.replace(/\/$/, '')}/rest/api/3/issue/${issueKey}/comment`;
      for (const doc of Array.isArray(adfList) ? adfList : [adfList]) {
        let res;
        try {
          res = await fetchFn(url, {
            method: 'POST',
            headers: { ...jiraAuthHeaders(config), 'Content-Type': 'application/json' },
            body: JSON.stringify({ body: doc })
          });
        } catch (err) {
          throw new Error(`Jira request failed (browser CORS blocks direct Jira API calls; please use http://localhost:3000): ${err.message}`);
        }
        if (!res.ok) throw new Error(`Jira API error (${res.status}): ${await res.text()}`);
      }
    },
    getSnapshot,
    saveSnapshot,
    saveExport: async (projectId, issueKey, content, ext) => {
      // In hosted mode, trigger a browser download instead of writing to disk.
      const prefix = issueKey ? `${issueKey}_` : '';
      const ts = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
      const fileName = `${prefix}${ts}.${ext}`;
      const mime = ext === 'html' ? 'text/html' : 'text/markdown';
      const blob = new Blob([content], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = fileName; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    },
    appendRunEntry: entry => {
      try {
        const raw = storage.getItem(RUN_LOG_KEY);
        const entries = raw ? JSON.parse(raw) : [];
        const id = `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        entries.unshift({ id, ...entry });
        if (entries.length > MAX_LOG_ENTRIES) entries.splice(MAX_LOG_ENTRIES);
        storage.setItem(RUN_LOG_KEY, JSON.stringify(entries));
        return { id, ...entry };
      } catch { /* storage full or unavailable — silently skip */ }
    },
    // Slack/Teams webhooks are cross-origin POST requests — browsers block them.
    // Surface a clear error directing the user to run locally instead of a
    // silent failure or an opaque CORS error.
    notifySlack: async () => {
      throw new Error('Slack notifications require running locally via npm start — browser CORS policy blocks direct webhook POST requests.');
    },
    notifyTeams: async () => {
      throw new Error('Teams notifications require running locally via npm start — browser CORS policy blocks direct webhook POST requests.');
    }
  };

  function requireFigmaToken(config) {
    if (!config.figmaToken) throw new Error('Figma personal access token is required to run.');
  }

  return {
    mode: 'hosted',

    getConfig: async () => {
      const config = loadConfig();
      return {
        ...config,
        figmaToken: config.figmaToken ? MASK : '',
        jiraApiToken: config.jiraApiToken ? MASK : ''
      };
    },

    saveConfig: async incoming => {
      const current = loadConfig();
      const merged = { ...current, ...incoming };
      if (incoming.figmaToken === MASK) merged.figmaToken = current.figmaToken;
      if (incoming.jiraApiToken === MASK) merged.jiraApiToken = current.jiraApiToken;
      storage.setItem(CONFIG_KEY, JSON.stringify(merged));
    },

    runAll: async () => {
      const config = loadConfig();
      if (config.projects.length === 0) return [];
      requireFigmaToken(config);
      const results = [];
      for (const project of config.projects) {
        results.push(await runProjectPipeline(project, config, deps));
      }
      return results;
    },

    runProject: async projectId => {
      const config = loadConfig();
      const project = config.projects.find(p => p.id === projectId);
      if (!project) throw new Error(`Project not found with ID "${projectId}"`);
      requireFigmaToken(config);
      return [await runProjectPipeline(project, config, deps)];
    },

    getWatchers: async issueKey => {
      const config = loadConfig();
      requireJira(config);
      const url = `${config.jiraBaseUrl.replace(/\/$/, '')}/rest/api/3/issue/${issueKey}/watchers`;
      const res = await fetchFn(url, { headers: jiraAuthHeaders(config) });
      if (!res.ok) throw new Error(`Jira API error (${res.status})`);
      const data = await res.json();
      return (data.watchers || []).map(w => ({
        accountId: w.accountId,
        displayName: w.displayName,
        email: w.emailAddress || null
      }));
    },

    searchUsers: async query => {
      if (!query || !query.trim()) return [];
      const config = loadConfig();
      requireJira(config);
      const url = `${config.jiraBaseUrl.replace(/\/$/, '')}/rest/api/3/user/search?query=${encodeURIComponent(query.trim())}`;
      const res = await fetchFn(url, { headers: jiraAuthHeaders(config) });
      if (res.status === 403) return []; // missing "Browse users and groups" permission
      if (!res.ok) throw new Error(`Jira API error (${res.status})`);
      const data = await res.json();
      return (Array.isArray(data) ? data : []).map(u => ({
        accountId: u.accountId,
        displayName: u.displayName,
        email: u.emailAddress || null
      }));
    },

    getLocalSettings: async () => ({ dataDir: '' }),
    saveLocalSettings: async () => ({}),
    testDataDir: async () => ({ ok: false, error: 'Custom workspace paths require running locally via npm start.' }),

    getSnapshot,
    saveSnapshot,
    // Snapshot history — localStorage-backed (Item 3)
    // Archive is stored as a JSON array under SNAPSHOT_ARCHIVE_KEY_PREFIX + fileKey.
    archiveSnapshot: (fileKey, snapshot) => {
      try {
        const raw = storage.getItem(SNAPSHOT_ARCHIVE_KEY_PREFIX + fileKey);
        const entries = raw ? JSON.parse(raw) : [];
        entries.unshift(snapshot);
        if (entries.length > MAX_ARCHIVE_ENTRIES) entries.splice(MAX_ARCHIVE_ENTRIES);
        storage.setItem(SNAPSHOT_ARCHIVE_KEY_PREFIX + fileKey, JSON.stringify(entries));
      } catch { /* storage full — silently skip */ }
    },
    saveExport: async (projectId, issueKey, content, ext) => {
      // Trigger a browser download for the export content.
      const prefix = issueKey ? `${issueKey}_` : '';
      const ts = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
      const fileName = `${prefix}${ts}.${ext}`;
      const mime = ext === 'html' ? 'text/html' : 'text/markdown';
      const blob = new Blob([content], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = fileName; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    },
    // Browser adapter has no server-side download URL; export happens via saveExport above.
    getLatestExportUrl: () => null,
    // Run log (localStorage)
    getRunLog: async () => {
      try {
        const raw = storage.getItem(RUN_LOG_KEY);
        return raw ? JSON.parse(raw) : [];
      } catch { return []; }
    },
    clearRunLog: async () => {
      try { storage.removeItem(RUN_LOG_KEY); } catch { /* best-effort */ }
    },
    resendChannel: async () => {
      throw new Error('Resend is not supported in hosted mode — run locally via npm start.');
    },
    // Snapshot history (Item 3) — localStorage-backed
    listSnapshots: async fileKey => {
      try {
        const raw = storage.getItem(SNAPSHOT_ARCHIVE_KEY_PREFIX + fileKey);
        const entries = raw ? JSON.parse(raw) : [];
        return entries.map((snap, i) => ({
          timestamp: `local-${i}`,
          savedAt: snap._savedAt || null
        }));
      } catch { return []; }
    },
    restoreSnapshot: async (fileKey, timestamp) => {
      // In hosted mode, timestamp is "local-<index>" (from listSnapshots above)
      const idx = parseInt(timestamp.replace('local-', ''), 10);
      if (isNaN(idx)) throw new Error('Invalid snapshot reference');
      try {
        const raw = storage.getItem(SNAPSHOT_ARCHIVE_KEY_PREFIX + fileKey);
        const entries = raw ? JSON.parse(raw) : [];
        if (idx < 0 || idx >= entries.length) throw new Error('Snapshot not found');
        storage.setItem(SNAPSHOT_KEY_PREFIX + fileKey, JSON.stringify(entries[idx]));
      } catch (err) {
        throw new Error(`Could not restore snapshot: ${err.message}`);
      }
    },
    ...lastRunAccessors(storage)
  };
}

/** Picks and builds the adapter for the current environment. */
async function createAdapter({ fetch: fetchFn = globalThis.fetch, storage = globalThis.localStorage } = {}) {
  const mode = await detectMode(fetchFn);
  return mode === 'server'
    ? createServerAdapter({ fetch: fetchFn, storage })
    : createBrowserAdapter({ fetch: fetchFn, storage });
}

module.exports = { detectMode, createServerAdapter, createBrowserAdapter, createAdapter, MASK };
