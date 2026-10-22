'use strict';

const { getRunLog, clearRunLog, updateChannelResult } = require('../runLog');
const { getConfig } = require('../configStore');
const { postComment } = require('../jiraClient');

/**
 * GET /api/runs
 * Returns the stored run log (newest first).
 */
function getRunsRoute(req, res) {
  res.json({ runs: getRunLog() });
}

/**
 * DELETE /api/runs
 * Clears all stored run log entries.
 */
function deleteRunsRoute(req, res) {
  clearRunLog();
  res.json({ ok: true });
}

/**
 * POST /api/runs/:runId/resend/:channel
 * Re-posts a stored ADF/message for a single failed channel without touching
 * the snapshot. Supported channels: 'jira' (others coming with Item 7).
 */
async function resendChannelRoute(req, res) {
  const { runId, channel } = req.params;

  if (!runId || !channel) {
    return res.status(400).json({ error: 'runId and channel are required' });
  }

  const runs = getRunLog();
  const entry = runs.find(e => e.id === runId);
  if (!entry) {
    return res.status(404).json({ error: 'Run entry not found' });
  }

  const stored = entry.channels && entry.channels[channel];
  const adfList = entry.adfList;

  if (channel === 'jira') {
    if (!adfList) {
      return res.status(400).json({ error: 'No stored ADF for this run entry' });
    }
    try {
      const config = getConfig();
      await postComment(config.jiraBaseUrl, config.jiraEmail, config.jiraApiToken, entry.jiraIssueKey, adfList);
      updateChannelResult(runId, 'jira', { status: 'sent' });
      return res.json({ ok: true, channel: 'jira', status: 'sent' });
    } catch (err) {
      updateChannelResult(runId, 'jira', { status: 'failed', error: err.message });
      return res.status(502).json({ error: err.message });
    }
  }

  return res.status(400).json({ error: `Unsupported channel: ${channel}` });
}

module.exports = { getRunsRoute, deleteRunsRoute, resendChannelRoute };
