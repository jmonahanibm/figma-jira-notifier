'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULTS = {
  schedule: '0 8 * * *',
  figmaToken: '',
  jiraBaseUrl: '',
  jiraEmail: '',
  jiraApiToken: '',
  projects: [],
  maxNodesInNotification: 50,
  deepLinkTarget: 'both',
  snapshotRetention: 7,
  channels: {
    jira: true,
    slackWebhookUrl: '',
    teamsWebhookUrl: ''
  }
};

/**
 * Directory for local machine settings and credentials (~/.figma-jira-notifier/).
 * Never shared between users or synced to cloud repositories.
 */
function localDir() {
  if (process.env.FIGMA_NOTIFIER_HOME) {
    const dir = path.resolve(process.env.FIGMA_NOTIFIER_HOME);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  const dir = path.join(os.homedir(), '.figma-jira-notifier');
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // fallback to runtime dir if home is not writable
      return runtimeDir();
    }
  }
  return dir;
}

function localSettingsPath() {
  return path.join(localDir(), 'localSettings.json');
}

function secretsPath() {
  return path.join(localDir(), 'secrets.json');
}

/**
 * Reads local settings from ~/.figma-jira-notifier/localSettings.json
 * @returns {{ dataDir?: string }}
 */
function getLocalSettings() {
  try {
    const p = localSettingsPath();
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  } catch { /* ignore */ }
  return {};
}

/**
 * Saves local settings to ~/.figma-jira-notifier/localSettings.json
 * @param {object} settings
 */
function saveLocalSettings(settings) {
  try {
    const current = getLocalSettings();
    const merged = { ...current, ...settings };
    fs.writeFileSync(localSettingsPath(), JSON.stringify(merged, null, 2), 'utf8');
  } catch (err) {
    console.warn(`[ConfigStore] Could not save local settings: ${err.message}`);
  }
}

/**
 * Reads personal credentials from ~/.figma-jira-notifier/secrets.json
 * @returns {object}
 */
function getLocalSecrets() {
  try {
    const p = secretsPath();
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  } catch { /* ignore */ }
  return {};
}

/**
 * Saves personal credentials to ~/.figma-jira-notifier/secrets.json
 * @param {object} secrets
 */
function saveLocalSecrets(secrets) {
  try {
    const current = getLocalSecrets();
    const merged = { ...current, ...secrets };
    fs.writeFileSync(secretsPath(), JSON.stringify(merged, null, 2), 'utf8');
  } catch (err) {
    console.warn(`[ConfigStore] Could not save local secrets: ${err.message}`);
  }
}

/**
 * Resolve the directory where runtime files (config.json, projects/, snapshots/) live.
 * Precedence:
 * 1. GUI local setting (localSettings.json -> dataDir)
 * 2. Environment variable FIGMA_NOTIFIER_DATA_DIR
 * 3. CLI argument --data-dir <path>
 * 4. Executable folder (if pkg binary) or repository root
 */
function runtimeDir() {
  // 1. Local settings (configured via GUI)
  try {
    const local = getLocalSettings();
    if (local.dataDir && typeof local.dataDir === 'string' && local.dataDir.trim()) {
      const resolved = path.resolve(local.dataDir.trim());
      if (!fs.existsSync(resolved)) {
        fs.mkdirSync(resolved, { recursive: true });
      }
      return resolved;
    }
  } catch { /* ignore */ }

  // 2. Environment variable
  if (process.env.FIGMA_NOTIFIER_DATA_DIR) {
    const envDir = path.resolve(process.env.FIGMA_NOTIFIER_DATA_DIR);
    if (!fs.existsSync(envDir)) {
      fs.mkdirSync(envDir, { recursive: true });
    }
    return envDir;
  }

  // 3. CLI flag --data-dir
  if (Array.isArray(process.argv)) {
    for (let i = 0; i < process.argv.length; i++) {
      const arg = process.argv[i];
      if (arg === '--data-dir' && process.argv[i + 1]) {
        const cliDir = path.resolve(process.argv[i + 1]);
        if (!fs.existsSync(cliDir)) fs.mkdirSync(cliDir, { recursive: true });
        return cliDir;
      }
      if (arg.startsWith('--data-dir=')) {
        const cliDir = path.resolve(arg.split('=')[1]);
        if (!fs.existsSync(cliDir)) fs.mkdirSync(cliDir, { recursive: true });
        return cliDir;
      }
    }
  }

  // 4. Default: pkg executable directory or project root
  if (process.pkg) {
    return path.dirname(process.execPath);
  }
  return path.join(__dirname, '..');
}

function configPath() {
  return path.join(runtimeDir(), 'config.json');
}

function projectsDir() {
  const dir = path.join(runtimeDir(), 'projects');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Loads all project files from projects/<id>.json in runtimeDir.
 * If projects/ is empty, falls back to legacy projects array in config.json.
 * @param {object} [fallbackConfig]
 * @returns {Array<object>}
 */
function loadProjects(fallbackConfig = null) {
  const dir = path.join(runtimeDir(), 'projects');
  if (fs.existsSync(dir)) {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    if (files.length > 0) {
      const list = [];
      for (const f of files) {
        try {
          const content = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          if (content && typeof content === 'object') {
            list.push(content);
          }
        } catch { /* skip corrupted file */ }
      }
      return list;
    }
  }

  // Fallback to legacy projects array in config.json
  if (fallbackConfig && Array.isArray(fallbackConfig.projects)) {
    return fallbackConfig.projects;
  }
  return [];
}

/**
 * Persists an array of projects to per-project files in projects/<id>.json.
 * Also cleans up files for removed projects.
 * @param {Array<object>} projects
 */
function saveProjects(projects) {
  if (!Array.isArray(projects)) return;
  const dir = projectsDir();

  const currentIds = new Set();
  for (const proj of projects) {
    if (!proj || !proj.id) continue;
    currentIds.add(proj.id);
    const filePath = path.join(dir, `${proj.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(proj, null, 2), 'utf8');
  }

  // Delete files for projects no longer in the list
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    for (const f of files) {
      const id = f.slice(0, -5);
      if (!currentIds.has(id)) {
        try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

/**
 * Tests whether a directory path is accessible and writable.
 * @param {string} dirPath
 * @returns {{ ok: boolean, path?: string, error?: string }}
 */
function testDataDir(dirPath) {
  if (!dirPath || typeof dirPath !== 'string' || !dirPath.trim()) {
    return { ok: false, error: 'Directory path is empty.' };
  }
  try {
    const resolved = path.resolve(dirPath.trim());
    if (!fs.existsSync(resolved)) {
      fs.mkdirSync(resolved, { recursive: true });
    }
    const testFile = path.join(resolved, `.test_write_${Date.now()}`);
    fs.writeFileSync(testFile, 'test', 'utf8');
    fs.unlinkSync(testFile);
    return { ok: true, path: resolved };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Returns the current merged config:
 * - Shared configuration from config.json / projects/*.json
 * - Local personal secrets from ~/.figma-jira-notifier/secrets.json
 * - Local directory setting from ~/.figma-jira-notifier/localSettings.json
 * @returns {object}
 */
function getConfig() {
  const cPath = configPath();
  let shared = {};

  if (!fs.existsSync(cPath)) {
    shared = { ...DEFAULTS };
    try {
      fs.writeFileSync(cPath, JSON.stringify(DEFAULTS, null, 2), 'utf8');
    } catch { /* best-effort */ }
  } else {
    try {
      const raw = fs.readFileSync(cPath, 'utf8');
      shared = JSON.parse(raw);
    } catch {
      shared = { ...DEFAULTS };
    }
  }

  // Projects from per-project files or config.json
  const projects = loadProjects(shared);

  // Local secrets overlay
  const localSecrets = getLocalSecrets();
  const localSettings = getLocalSettings();

  // Extract merged credentials (local secrets take priority; fallback to shared for legacy setups)
  const figmaToken = localSecrets.figmaToken !== undefined ? localSecrets.figmaToken : (shared.figmaToken || '');
  const jiraBaseUrl = localSecrets.jiraBaseUrl !== undefined ? localSecrets.jiraBaseUrl : (shared.jiraBaseUrl || '');
  const jiraEmail = localSecrets.jiraEmail !== undefined ? localSecrets.jiraEmail : (shared.jiraEmail || '');
  const jiraApiToken = localSecrets.jiraApiToken !== undefined ? localSecrets.jiraApiToken : (shared.jiraApiToken || '');

  const channels = {
    ...(DEFAULTS.channels),
    ...(shared.channels || {})
  };
  if (localSecrets.slackWebhookUrl !== undefined) channels.slackWebhookUrl = localSecrets.slackWebhookUrl;
  if (localSecrets.teamsWebhookUrl !== undefined) channels.teamsWebhookUrl = localSecrets.teamsWebhookUrl;

  const currentDir = runtimeDir();
  const isSharedWorkspace = Boolean(
    localSettings.dataDir || process.env.FIGMA_NOTIFIER_DATA_DIR
  );

  return {
    ...DEFAULTS,
    ...shared,
    figmaToken,
    jiraBaseUrl,
    jiraEmail,
    jiraApiToken,
    channels,
    projects,
    dataDir: localSettings.dataDir || '',
    runtimeDir: currentDir,
    isSharedWorkspace
  };
}

/**
 * Writes config data:
 * - Local secrets saved to ~/.figma-jira-notifier/secrets.json
 * - Local dataDir setting saved to ~/.figma-jira-notifier/localSettings.json
 * - Projects saved to projects/<id>.json in runtimeDir
 * - Shared settings saved to config.json in runtimeDir
 * @param {object} data
 */
function saveConfig(data) {
  if (!data || typeof data !== 'object') return;

  // 1. Save local settings if dataDir is provided
  if (data.dataDir !== undefined) {
    saveLocalSettings({ dataDir: data.dataDir });
  }

  // 2. Save local secrets
  const secretsToSave = {};
  if (data.figmaToken !== undefined) secretsToSave.figmaToken = data.figmaToken;
  if (data.jiraBaseUrl !== undefined) secretsToSave.jiraBaseUrl = data.jiraBaseUrl;
  if (data.jiraEmail !== undefined) secretsToSave.jiraEmail = data.jiraEmail;
  if (data.jiraApiToken !== undefined) secretsToSave.jiraApiToken = data.jiraApiToken;
  if (data.channels) {
    if (data.channels.slackWebhookUrl !== undefined) secretsToSave.slackWebhookUrl = data.channels.slackWebhookUrl;
    if (data.channels.teamsWebhookUrl !== undefined) secretsToSave.teamsWebhookUrl = data.channels.teamsWebhookUrl;
  }
  if (Object.keys(secretsToSave).length > 0) {
    saveLocalSecrets(secretsToSave);
  }

  // 3. Save per-project files
  if (Array.isArray(data.projects)) {
    saveProjects(data.projects);
  }

  // 4. Save shared settings to config.json (stripped of personal secrets)
  const sharedToSave = {
    schedule: data.schedule || DEFAULTS.schedule,
    maxNodesInNotification: data.maxNodesInNotification || DEFAULTS.maxNodesInNotification,
    deepLinkTarget: data.deepLinkTarget || DEFAULTS.deepLinkTarget,
    snapshotRetention: data.snapshotRetention || DEFAULTS.snapshotRetention,
    channels: {
      jira: data.channels && data.channels.jira !== undefined ? data.channels.jira : true
    },
    projects: data.projects || []
  };

  const cPath = configPath();
  fs.writeFileSync(cPath, JSON.stringify(sharedToSave, null, 2), 'utf8');
}

module.exports = {
  getConfig,
  saveConfig,
  runtimeDir,
  localDir,
  getLocalSettings,
  saveLocalSettings,
  getLocalSecrets,
  saveLocalSecrets,
  testDataDir,
  DEFAULTS
};
