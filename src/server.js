'use strict';

const express = require('express');
const path = require('path');
const {
  getConfigRoute,
  saveConfigRoute,
  getLocalSettingsRoute,
  saveLocalSettingsRoute,
  testDataDirRoute
} = require('./routes/config');
const { runNow } = require('./routes/run');
const { getWatchersRoute, searchUsersRoute } = require('./routes/jira');
const { getExportRoute } = require('./routes/export');
const { getRunsRoute, deleteRunsRoute, resendChannelRoute } = require('./routes/runs');
const { listSnapshotsRoute, restoreSnapshotRoute } = require('./routes/snapshots');
const scheduler = require('./scheduler');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Resolve GUI directory — the bundled GUI built by `npm run bundle`.
// Under pkg, __dirname points into the embedded snapshot filesystem, which is
// where the gui/** assets live. (process.execPath is the folder beside the
// binary on disk, which does not contain them.)
// ---------------------------------------------------------------------------
function guiDir() {
  return path.join(__dirname, '..', 'gui', 'dist');
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(express.json());
app.use(express.static(guiDir()));

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------
app.get('/api/config', getConfigRoute);
app.post('/api/config', saveConfigRoute);
app.get('/api/local-settings', getLocalSettingsRoute);
app.post('/api/local-settings', saveLocalSettingsRoute);
app.post('/api/test-data-dir', testDataDirRoute);
app.post('/api/run', runNow);
app.get('/api/jira/watchers', getWatchersRoute);
app.get('/api/jira/users/search', searchUsersRoute);
app.get('/api/export/:projectId', getExportRoute);
app.get('/api/runs', getRunsRoute);
app.delete('/api/runs', deleteRunsRoute);
app.post('/api/runs/:runId/resend/:channel', resendChannelRoute);
app.get('/api/snapshots/:fileKey', listSnapshotsRoute);
app.post('/api/snapshots/:fileKey/restore/:timestamp', restoreSnapshotRoute);

// Fallback: serve index.html for any non-API route (SPA support)
app.get('*', (req, res) => {
  res.sendFile(path.join(guiDir(), 'index.html'));
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`\nDesign Change Log running at http://localhost:${PORT}\n`);
  scheduler.start();
});

module.exports = app;
