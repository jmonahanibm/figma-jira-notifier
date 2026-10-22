'use strict';

/**
 * multiUserWorkspace.test.js
 *
 * Tests Item 16 features:
 * - Local secrets store (decoupled from shared config.json)
 * - Per-project files in projects/<id>.json
 * - Configurable runtime data directory (localSettings.json, env var, CLI flag)
 * - Directory access validation via testDataDir()
 * - Per-project run logs in runs/<projectId>.runs.json and aggregation
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function setupWorkspaceTest() {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-home-test-'));
  const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-data-test-'));

  const origHome = process.env.FIGMA_NOTIFIER_HOME;
  const origDataDir = process.env.FIGMA_NOTIFIER_DATA_DIR;
  const origExecPath = process.execPath;
  const origPkg = process.pkg;

  process.env.FIGMA_NOTIFIER_HOME = tmpHome;
  process.env.FIGMA_NOTIFIER_DATA_DIR = tmpData;
  process.pkg = true;
  process.execPath = path.join(tmpData, 'figma-jira-notifier');

  jest.resetModules();
  const configStore = require('../src/configStore');
  const runLog = require('../src/runLog');

  function teardown() {
    if (origHome) process.env.FIGMA_NOTIFIER_HOME = origHome;
    else delete process.env.FIGMA_NOTIFIER_HOME;

    if (origDataDir) process.env.FIGMA_NOTIFIER_DATA_DIR = origDataDir;
    else delete process.env.FIGMA_NOTIFIER_DATA_DIR;

    process.execPath = origExecPath;
    process.pkg = origPkg;

    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpData, { recursive: true, force: true });
    jest.resetModules();
  }

  return { tmpHome, tmpData, configStore, runLog, teardown };
}

describe('Item 16 — Local Secrets Store & Decoupling', () => {
  let ctx;
  beforeEach(() => { ctx = setupWorkspaceTest(); });
  afterEach(() => ctx.teardown());

  test('saves API tokens to local secrets file, not in shared config.json', () => {
    ctx.configStore.saveConfig({
      figmaToken: 'figd_secret123',
      jiraApiToken: 'jira_secret456',
      jiraBaseUrl: 'https://test.atlassian.net',
      jiraEmail: 'dev@example.com',
      schedule: '0 9 * * 1-5',
      projects: [{ id: 'p1', figmaFileKey: 'key1' }]
    });

    // Check secrets.json exists in local home folder
    const secretsPath = path.join(ctx.tmpHome, 'secrets.json');
    expect(fs.existsSync(secretsPath)).toBe(true);
    const savedSecrets = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
    expect(savedSecrets.figmaToken).toBe('figd_secret123');
    expect(savedSecrets.jiraApiToken).toBe('jira_secret456');

    // Check shared config.json does NOT contain the secret values
    const configPath = path.join(ctx.tmpData, 'config.json');
    expect(fs.existsSync(configPath)).toBe(true);
    const sharedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(sharedConfig.figmaToken).toBeUndefined();
    expect(sharedConfig.jiraApiToken).toBeUndefined();
    expect(sharedConfig.schedule).toBe('0 9 * * 1-5');

    // Loaded config merges them in-memory
    const loaded = ctx.configStore.getConfig();
    expect(loaded.figmaToken).toBe('figd_secret123');
    expect(loaded.jiraApiToken).toBe('jira_secret456');
    expect(loaded.schedule).toBe('0 9 * * 1-5');
  });

  test('webhook URLs are stored in local secrets', () => {
    ctx.configStore.saveConfig({
      channels: {
        jira: true,
        slackWebhookUrl: 'https://hooks.slack.com/services/secret',
        teamsWebhookUrl: 'https://outlook.office.com/webhook/secret'
      }
    });

    const secrets = ctx.configStore.getLocalSecrets();
    expect(secrets.slackWebhookUrl).toBe('https://hooks.slack.com/services/secret');
    expect(secrets.teamsWebhookUrl).toBe('https://outlook.office.com/webhook/secret');

    const config = ctx.configStore.getConfig();
    expect(config.channels.slackWebhookUrl).toBe('https://hooks.slack.com/services/secret');
    expect(config.channels.teamsWebhookUrl).toBe('https://outlook.office.com/webhook/secret');
  });
});

describe('Item 16 — Per-Project Storage Isolation', () => {
  let ctx;
  beforeEach(() => { ctx = setupWorkspaceTest(); });
  afterEach(() => ctx.teardown());

  test('saves projects as individual files in projects/<id>.json', () => {
    const projects = [
      { id: 'proj-login', figmaFileKey: 'keyA', jiraIssueKey: 'AUTH-1' },
      { id: 'proj-checkout', figmaFileKey: 'keyB', jiraIssueKey: 'CART-2' }
    ];

    ctx.configStore.saveConfig({ projects });

    const pDir = path.join(ctx.tmpData, 'projects');
    expect(fs.existsSync(pDir)).toBe(true);
    expect(fs.existsSync(path.join(pDir, 'proj-login.json'))).toBe(true);
    expect(fs.existsSync(path.join(pDir, 'proj-checkout.json'))).toBe(true);

    const loaded = ctx.configStore.getConfig();
    expect(loaded.projects.length).toBe(2);
    expect(loaded.projects.find(p => p.id === 'proj-login').jiraIssueKey).toBe('AUTH-1');
  });

  test('removes project file when a project is deleted', () => {
    ctx.configStore.saveConfig({
      projects: [
        { id: 'proj-1', figmaFileKey: 'k1' },
        { id: 'proj-2', figmaFileKey: 'k2' }
      ]
    });

    const pDir = path.join(ctx.tmpData, 'projects');
    expect(fs.existsSync(path.join(pDir, 'proj-1.json'))).toBe(true);
    expect(fs.existsSync(path.join(pDir, 'proj-2.json'))).toBe(true);

    // Save with proj-2 removed
    ctx.configStore.saveConfig({
      projects: [
        { id: 'proj-1', figmaFileKey: 'k1' }
      ]
    });

    expect(fs.existsSync(path.join(pDir, 'proj-1.json'))).toBe(true);
    expect(fs.existsSync(path.join(pDir, 'proj-2.json'))).toBe(false);
  });
});

describe('Item 16 — Runtime Data Directory & testDataDir', () => {
  let ctx;
  beforeEach(() => { ctx = setupWorkspaceTest(); });
  afterEach(() => ctx.teardown());

  test('testDataDir returns ok for valid writable directory', () => {
    const testDir = path.join(ctx.tmpData, 'shared_workspace');
    const res = ctx.configStore.testDataDir(testDir);
    expect(res.ok).toBe(true);
    expect(res.path).toBe(path.resolve(testDir));
    expect(fs.existsSync(testDir)).toBe(true);
  });

  test('testDataDir returns error for empty path', () => {
    const res = ctx.configStore.testDataDir('');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/empty/i);
  });

  test('saves and loads localSettings.json for custom dataDir', () => {
    ctx.configStore.saveLocalSettings({ dataDir: '/custom/path/box' });
    const settings = ctx.configStore.getLocalSettings();
    expect(settings.dataDir).toBe('/custom/path/box');
  });
});

describe('Item 16 — Per-Project Run Logs', () => {
  let ctx;
  beforeEach(() => { ctx = setupWorkspaceTest(); });
  afterEach(() => ctx.teardown());

  test('appends run entries to per-project file runs/<projectId>.runs.json', () => {
    ctx.runLog.appendRunEntry({
      projectId: 'proj-auth',
      figmaFileName: 'Auth file',
      runAt: '2025-07-01T10:00:00.000Z',
      status: 'posted',
      changesCount: 3
    });

    ctx.runLog.appendRunEntry({
      projectId: 'proj-cart',
      figmaFileName: 'Cart file',
      runAt: '2025-07-01T11:00:00.000Z',
      status: 'no_changes',
      changesCount: 0
    });

    const runsDir = path.join(ctx.tmpData, 'runs');
    expect(fs.existsSync(path.join(runsDir, 'proj-auth.runs.json'))).toBe(true);
    expect(fs.existsSync(path.join(runsDir, 'proj-cart.runs.json'))).toBe(true);

    const log = ctx.runLog.getRunLog();
    expect(log.length).toBe(2);
    // Newest first
    expect(log[0].projectId).toBe('proj-cart');
    expect(log[1].projectId).toBe('proj-auth');
  });

  test('updateChannelResult updates entry in project run log', () => {
    const entry = ctx.runLog.appendRunEntry({
      projectId: 'proj-x',
      figmaFileName: 'File X',
      runAt: '2025-07-01T12:00:00.000Z',
      status: 'partial',
      changesCount: 1,
      channels: { jira: { status: 'failed', error: 'timeout' } }
    });

    const ok = ctx.runLog.updateChannelResult(entry.id, 'jira', { status: 'sent' });
    expect(ok).toBe(true);

    const log = ctx.runLog.getRunLog();
    expect(log[0].channels.jira.status).toBe('sent');
  });

  test('clearRunLog clears all project run logs', () => {
    ctx.runLog.appendRunEntry({ projectId: 'p1', figmaFileName: 'F1', runAt: '2025-01-01T00:00:00.000Z' });
    ctx.runLog.appendRunEntry({ projectId: 'p2', figmaFileName: 'F2', runAt: '2025-01-02T00:00:00.000Z' });

    expect(ctx.runLog.getRunLog().length).toBe(2);
    ctx.runLog.clearRunLog();
    expect(ctx.runLog.getRunLog().length).toBe(0);
  });
});
