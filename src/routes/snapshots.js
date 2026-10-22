'use strict';

const { listSnapshots, restoreSnapshot } = require('../snapshotStore');

/**
 * GET /api/snapshots/:fileKey
 * Returns metadata for all archived snapshots of a Figma file key, newest first.
 * Each entry: { timestamp, savedAt }
 */
function listSnapshotsRoute(req, res) {
  const { fileKey } = req.params;
  if (!fileKey) {
    return res.status(400).json({ error: 'fileKey is required' });
  }
  try {
    const snapshots = listSnapshots(fileKey);
    res.json({ snapshots });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * POST /api/snapshots/:fileKey/restore/:timestamp
 * Promotes an archived snapshot to become the current baseline.
 * The next diff run for this file will diff against the restored snapshot.
 */
function restoreSnapshotRoute(req, res) {
  const { fileKey, timestamp } = req.params;
  if (!fileKey || !timestamp) {
    return res.status(400).json({ error: 'fileKey and timestamp are required' });
  }
  try {
    restoreSnapshot(fileKey, timestamp);
    res.json({ ok: true, fileKey, timestamp });
  } catch (err) {
    const status = err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
}

module.exports = { listSnapshotsRoute, restoreSnapshotRoute };
