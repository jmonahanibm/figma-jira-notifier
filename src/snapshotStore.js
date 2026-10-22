'use strict';

const fs = require('fs');
const path = require('path');
const { runtimeDir } = require('./configStore');

const DEFAULT_RETENTION = 7;

/**
 * Directory where per-file snapshots are stored.
 * Created on first use if absent.
 */
function snapshotsDir() {
  const dir = path.join(runtimeDir(), 'snapshots');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Directory where archived snapshots for a specific file key are stored.
 * Path: snapshots/<fileKey>/
 * Created on first use if absent.
 */
function archiveDir(fileKey) {
  const dir = path.join(snapshotsDir(), fileKey);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Returns the previously saved Figma document tree for a given file key,
 * or null if no snapshot exists yet.
 * @param {string} fileKey
 * @returns {object|null}
 */
function getSnapshot(fileKey) {
  const filePath = path.join(snapshotsDir(), `${fileKey}.json`);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

/**
 * Saves the current Figma document tree as the new snapshot for a file key.
 * @param {string} fileKey
 * @param {object} tree  The snapshot object (includes document, knownCommentIds, etc.)
 */
function saveSnapshot(fileKey, tree) {
  const filePath = path.join(snapshotsDir(), `${fileKey}.json`);
  fs.writeFileSync(filePath, JSON.stringify(tree), 'utf8');
}

/**
 * Archives the given snapshot to snapshots/<fileKey>/<timestamp>.json, then
 * prunes old archives so at most `retention` files are kept (oldest removed first).
 *
 * Call this before overwriting the current baseline with saveSnapshot.
 *
 * @param {string} fileKey
 * @param {object} snapshot   The outgoing snapshot to archive
 * @param {number} [retention=7]
 */
function archiveSnapshot(fileKey, snapshot, retention = DEFAULT_RETENTION) {
  const dir = archiveDir(fileKey);

  // Use the snapshot's own _savedAt if available, otherwise now
  const ts = (snapshot && snapshot._savedAt)
    ? snapshot._savedAt.replace(/[:.]/g, '-')
    : new Date().toISOString().replace(/[:.]/g, '-');

  const filePath = path.join(dir, `${ts}.json`);
  fs.writeFileSync(filePath, JSON.stringify(snapshot), 'utf8');

  // Prune: keep only the newest `retention` files
  const retentionN = (typeof retention === 'number' && retention > 0) ? retention : DEFAULT_RETENTION;
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .sort(); // lexicographic = chronological for ISO timestamps
  if (files.length > retentionN) {
    const toDelete = files.slice(0, files.length - retentionN);
    for (const f of toDelete) {
      try { fs.unlinkSync(path.join(dir, f)); } catch { /* best-effort */ }
    }
  }
}

/**
 * Returns metadata for all archived snapshots of a file key, newest first.
 * Each entry: { timestamp: string, savedAt: string }
 *
 * @param {string} fileKey
 * @returns {Array<{ timestamp: string, savedAt: string }>}
 */
function listSnapshots(fileKey) {
  const dir = path.join(snapshotsDir(), fileKey);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse(); // newest first
  return files.map(f => {
    const timestamp = f.slice(0, -5); // strip .json
    // Reconstruct the ISO string from the filename (dashes back to colons/dots)
    // filename: 2025-06-01T09-00-00-000Z -> 2025-06-01T09:00:00.000Z
    const savedAt = timestamp
      .replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2:$3.$4Z');
    return { timestamp, savedAt };
  });
}

/**
 * Promotes an archived snapshot to become the current baseline by overwriting
 * `snapshots/<fileKey>.json` with the archived file content.
 *
 * Throws if the archive file does not exist.
 *
 * @param {string} fileKey
 * @param {string} timestamp  The timestamp string from listSnapshots (filename without .json)
 */
function restoreSnapshot(fileKey, timestamp) {
  const archivePath = path.join(snapshotsDir(), fileKey, `${timestamp}.json`);
  if (!fs.existsSync(archivePath)) {
    throw new Error(`Archived snapshot not found: ${timestamp}`);
  }
  const raw = fs.readFileSync(archivePath, 'utf8');
  const filePath = path.join(snapshotsDir(), `${fileKey}.json`);
  fs.writeFileSync(filePath, raw, 'utf8');
}

module.exports = { getSnapshot, saveSnapshot, archiveSnapshot, listSnapshots, restoreSnapshot };
