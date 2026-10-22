'use strict';

const { getConfig } = require('../configStore');
const { fetchWatchers, searchUsers } = require('../jiraClient');

/**
 * GET /api/jira/watchers?issueKey=PROJ-123
 * Fetches watchers for a Jira ticket using configured Jira credentials.
 */
async function getWatchersRoute(req, res) {
  const issueKey = (req.query.issueKey || '').trim();

  if (!issueKey) {
    return res.status(400).json({ error: 'Missing required query parameter: issueKey' });
  }

  const config = getConfig();

  if (!config.jiraBaseUrl || !config.jiraEmail || !config.jiraApiToken) {
    return res.status(400).json({ error: 'Jira configuration (base URL, email, API token) is incomplete.' });
  }

  try {
    const watchers = await fetchWatchers(
      config.jiraBaseUrl,
      config.jiraEmail,
      config.jiraApiToken,
      issueKey
    );
    res.json({ issueKey, watchers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * GET /api/jira/users/search?query=<term>
 * Searches for Jira users by display name, username, or email.
 * Requires "Browse users and groups" permission on the Jira instance.
 */
async function searchUsersRoute(req, res) {
  const query = (req.query.query || '').trim();

  if (!query) {
    return res.status(400).json({ error: 'Missing required query parameter: query' });
  }

  const config = getConfig();

  if (!config.jiraBaseUrl || !config.jiraEmail || !config.jiraApiToken) {
    return res.status(400).json({ error: 'Jira configuration (base URL, email, API token) is incomplete.' });
  }

  try {
    const users = await searchUsers(
      config.jiraBaseUrl,
      config.jiraEmail,
      config.jiraApiToken,
      query
    );
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = { getWatchersRoute, searchUsersRoute };
