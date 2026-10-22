'use strict';

const { getLatestExport } = require('../exportStore');

/**
 * GET /api/export/:projectId
 *
 * Serves the most recent export file for a project as a download.
 * Returns 404 when no export exists.
 */
function getExportRoute(req, res) {
  const { projectId } = req.params;
  if (!projectId) {
    return res.status(400).json({ error: 'projectId is required' });
  }

  const latest = getLatestExport(projectId);
  if (!latest) {
    return res.status(404).json({ error: 'No export found for this project' });
  }

  const contentType = latest.ext === 'html' ? 'text/html' : 'text/markdown';
  const baseName = latest.filePath.split(/[/\\]/).pop();
  res.setHeader('Content-Disposition', `attachment; filename="${baseName}"`);
  res.setHeader('Content-Type', contentType);
  res.send(latest.content);
}

module.exports = { getExportRoute };
