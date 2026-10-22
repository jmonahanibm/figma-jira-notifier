'use strict';

/**
 * stores.test.js
 *
 * Tests configStore and snapshotStore using a real temporary directory.
 * Rather than mocking the modules, we override the runtimeDir by
 * temporarily pointing process.execPath at the temp dir via a helper,
 * then require the modules fresh for each test suite.
 *
 * Strategy: set process.pkg = true and override process.execPath so that
 * runtimeDir() in configStore returns our temp dir. Reset after each suite.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a fresh temp directory, hijacks process.execPath so runtimeDir()
 * returns it, and returns freshly-required module instances.
 */
function setupTestDir() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-notifier-test-'));
  // Simulate pkg binary environment: runtimeDir() = path.dirname(process.execPath)
  const origExecPath = process.execPath;
  const origPkg = process.pkg;
  process.pkg = true;
  // Place a fake executable file path inside tmpDir so dirname resolves correctly
  process.execPath = path.join(tmpDir, 'figma-jira-notifier');

  jest.resetModules();
  const configStore   = require('../src/configStore');
  const snapshotStore = require('../src/snapshotStore');

  function teardown() {
    process.execPath = origExecPath;
    process.pkg = origPkg;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    jest.resetModules();
  }

  return { tmpDir, configStore, snapshotStore, teardown };
}

// ---------------------------------------------------------------------------
// configStore
// ---------------------------------------------------------------------------
describe('configStore.getConfig', () => {
  let ctx;
  beforeEach(() => { ctx = setupTestDir(); });
  afterEach(() => ctx.teardown());

  test('creates config.json with defaults when file does not exist', () => {
    const config = ctx.configStore.getConfig();
    expect(config.schedule).toBe('0 8 * * *');
    expect(config.projects).toEqual([]);
    expect(fs.existsSync(path.join(ctx.tmpDir, 'config.json'))).toBe(true);
  });

  test('returns existing config when file already exists', () => {
    ctx.configStore.getConfig(); // creates file
    const updated = ctx.configStore.getConfig();
    updated.schedule = '0 12 * * *';
    ctx.configStore.saveConfig(updated);
    const loaded = ctx.configStore.getConfig();
    expect(loaded.schedule).toBe('0 12 * * *');
  });

  test('returned config has all expected default keys', () => {
    const config = ctx.configStore.getConfig();
    ['schedule', 'figmaToken', 'jiraBaseUrl', 'jiraEmail', 'jiraApiToken', 'projects'].forEach(key => {
      expect(config).toHaveProperty(key);
    });
  });
});

describe('configStore.saveConfig', () => {
  let ctx;
  beforeEach(() => { ctx = setupTestDir(); });
  afterEach(() => ctx.teardown());

  test('persists changes to disk', () => {
    ctx.configStore.getConfig(); // init
    ctx.configStore.saveConfig({ schedule: '0 6 * * 1', projects: [{ id: 'abc' }] });
    const loaded = ctx.configStore.getConfig();
    expect(loaded.schedule).toBe('0 6 * * 1');
    expect(loaded.projects[0].id).toBe('abc');
  });

  test('overwrites previous values', () => {
    ctx.configStore.saveConfig({ jiraEmail: 'first@example.com', projects: [] });
    ctx.configStore.saveConfig({ jiraEmail: 'second@example.com', projects: [] });
    const loaded = ctx.configStore.getConfig();
    expect(loaded.jiraEmail).toBe('second@example.com');
  });

  test('written file is valid JSON', () => {
    ctx.configStore.saveConfig({ schedule: '* * * * *', projects: [] });
    const raw = fs.readFileSync(path.join(ctx.tmpDir, 'config.json'), 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// snapshotStore
// ---------------------------------------------------------------------------
describe('snapshotStore.getSnapshot', () => {
  let ctx;
  beforeEach(() => { ctx = setupTestDir(); });
  afterEach(() => ctx.teardown());

  test('returns null when no snapshot exists for a file key', () => {
    expect(ctx.snapshotStore.getSnapshot('nonexistent-key')).toBeNull();
  });

  test('returns the saved tree after a saveSnapshot call', () => {
    const tree = { id: '0:0', type: 'DOCUMENT', name: 'Doc', children: [] };
    ctx.snapshotStore.saveSnapshot('file-abc', tree);
    const loaded = ctx.snapshotStore.getSnapshot('file-abc');
    expect(loaded).toEqual(tree);
  });

  test('different file keys are stored independently', () => {
    ctx.snapshotStore.saveSnapshot('key-1', { id: '1' });
    ctx.snapshotStore.saveSnapshot('key-2', { id: '2' });
    expect(ctx.snapshotStore.getSnapshot('key-1').id).toBe('1');
    expect(ctx.snapshotStore.getSnapshot('key-2').id).toBe('2');
  });
});

describe('snapshotStore.saveSnapshot', () => {
  let ctx;
  beforeEach(() => { ctx = setupTestDir(); });
  afterEach(() => ctx.teardown());

  test('creates the snapshots/ directory if absent', () => {
    const snapshotsDir = path.join(ctx.tmpDir, 'snapshots');
    expect(fs.existsSync(snapshotsDir)).toBe(false);
    ctx.snapshotStore.saveSnapshot('abc', { id: '0:0' });
    expect(fs.existsSync(snapshotsDir)).toBe(true);
  });

  test('overwrites an existing snapshot', () => {
    ctx.snapshotStore.saveSnapshot('file-x', { version: 1 });
    ctx.snapshotStore.saveSnapshot('file-x', { version: 2 });
    expect(ctx.snapshotStore.getSnapshot('file-x').version).toBe(2);
  });

  test('written snapshot file is valid JSON', () => {
    ctx.snapshotStore.saveSnapshot('file-y', { children: [] });
    const filePath = path.join(ctx.tmpDir, 'snapshots', 'file-y.json');
    const raw = fs.readFileSync(filePath, 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  test('snapshot filename uses the file key directly', () => {
    ctx.snapshotStore.saveSnapshot('C03gFAqd4DfgSLN06KrUIt', { id: '0:0' });
    const expectedPath = path.join(ctx.tmpDir, 'snapshots', 'C03gFAqd4DfgSLN06KrUIt.json');
    expect(fs.existsSync(expectedPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// snapshotStore.archiveSnapshot / listSnapshots / restoreSnapshot (Item 3)
// ---------------------------------------------------------------------------

describe('snapshotStore.archiveSnapshot', () => {
  let ctx;
  beforeEach(() => { ctx = setupTestDir(); });
  afterEach(() => ctx.teardown());

  test('creates an archive directory for the file key', () => {
    const snap = { _snapshotVersion: 2, document: { id: '0:0' }, knownCommentIds: [], knownResolvedCommentIds: [], _savedAt: '2025-01-01T08:00:00.000Z' };
    ctx.snapshotStore.archiveSnapshot('fileA', snap);
    expect(fs.existsSync(path.join(ctx.tmpDir, 'snapshots', 'fileA'))).toBe(true);
  });

  test('writes a .json file named after the snapshot _savedAt', () => {
    const snap = { _snapshotVersion: 2, document: {}, knownCommentIds: [], knownResolvedCommentIds: [], _savedAt: '2025-06-01T09:00:00.000Z' };
    ctx.snapshotStore.archiveSnapshot('fileB', snap);
    const dir = path.join(ctx.tmpDir, 'snapshots', 'fileB');
    const files = fs.readdirSync(dir);
    expect(files.length).toBe(1);
    expect(files[0]).toContain('2025-06-01T09');
  });

  test('prunes oldest archives when retention limit is exceeded', () => {
    for (let i = 1; i <= 5; i++) {
      const savedAt = `2025-01-0${i}T00:00:00.000Z`;
      ctx.snapshotStore.archiveSnapshot('fileC', { _savedAt: savedAt }, 3);
    }
    const dir = path.join(ctx.tmpDir, 'snapshots', 'fileC');
    const files = fs.readdirSync(dir);
    expect(files.length).toBe(3);
    // Oldest (Jan 01, Jan 02) should be gone; Jan 03-05 remain
    expect(files.some(f => f.includes('2025-01-01'))).toBe(false);
    expect(files.some(f => f.includes('2025-01-02'))).toBe(false);
    expect(files.some(f => f.includes('2025-01-05'))).toBe(true);
  });

  test('uses current timestamp as filename when snapshot has no _savedAt', () => {
    ctx.snapshotStore.archiveSnapshot('fileD', { document: {} }); // no _savedAt
    const dir = path.join(ctx.tmpDir, 'snapshots', 'fileD');
    expect(fs.readdirSync(dir).length).toBe(1);
  });
});

describe('snapshotStore.listSnapshots', () => {
  let ctx;
  beforeEach(() => { ctx = setupTestDir(); });
  afterEach(() => ctx.teardown());

  test('returns empty array when no archives exist', () => {
    expect(ctx.snapshotStore.listSnapshots('noSuchKey')).toEqual([]);
  });

  test('returns entries newest first', () => {
    ctx.snapshotStore.archiveSnapshot('fileE', { _savedAt: '2025-01-01T00:00:00.000Z' });
    ctx.snapshotStore.archiveSnapshot('fileE', { _savedAt: '2025-01-03T00:00:00.000Z' });
    ctx.snapshotStore.archiveSnapshot('fileE', { _savedAt: '2025-01-02T00:00:00.000Z' });
    const list = ctx.snapshotStore.listSnapshots('fileE');
    expect(list.length).toBe(3);
    // All have savedAt strings; order is newest first
    const dates = list.map(e => new Date(e.savedAt).getTime());
    expect(dates[0]).toBeGreaterThan(dates[1]);
    expect(dates[1]).toBeGreaterThan(dates[2]);
  });

  test('each entry has timestamp and savedAt fields', () => {
    ctx.snapshotStore.archiveSnapshot('fileF', { _savedAt: '2025-06-15T12:00:00.000Z' });
    const list = ctx.snapshotStore.listSnapshots('fileF');
    expect(list[0]).toHaveProperty('timestamp');
    expect(list[0]).toHaveProperty('savedAt');
    expect(list[0].savedAt).toBe('2025-06-15T12:00:00.000Z');
  });
});

describe('snapshotStore.restoreSnapshot', () => {
  let ctx;
  beforeEach(() => { ctx = setupTestDir(); });
  afterEach(() => ctx.teardown());

  test('promotes an archived snapshot to the current baseline', () => {
    const original = { _snapshotVersion: 2, document: { id: 'old' }, knownCommentIds: [], knownResolvedCommentIds: [], _savedAt: '2025-01-01T00:00:00.000Z' };
    ctx.snapshotStore.archiveSnapshot('fileG', original);
    // Save a different current baseline
    ctx.snapshotStore.saveSnapshot('fileG', { _snapshotVersion: 2, document: { id: 'new' }, knownCommentIds: [], knownResolvedCommentIds: [], _savedAt: '2025-01-02T00:00:00.000Z' });

    const list = ctx.snapshotStore.listSnapshots('fileG');
    expect(list.length).toBe(1);
    ctx.snapshotStore.restoreSnapshot('fileG', list[0].timestamp);

    const restored = ctx.snapshotStore.getSnapshot('fileG');
    expect(restored.document.id).toBe('old');
  });

  test('throws when the archive file does not exist', () => {
    expect(() => ctx.snapshotStore.restoreSnapshot('fileH', 'no-such-timestamp'))
      .toThrow('Archived snapshot not found');
  });
});
