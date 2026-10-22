'use strict';

/**
 * Jira REST calls (Node only — uses axios).
 *
 * The pure ADF builders live in ./adf so they can also be bundled for the
 * browser. They are re-exported here so existing imports keep working.
 */

const axios = require('axios');
const adf = require('./adf');

/**
 * Posts an ADF comment to a Jira issue.
 *
 * @param {string} jiraBaseUrl  e.g. "https://your-org.atlassian.net"
 * @param {string} email        Jira account email
 * @param {string} apiToken     Jira API token
 * @param {string} issueKey     e.g. "PROJ-123"
 * @param {object} commentAdf   ADF document object (or array of them)
 * @returns {Promise<void>}
 */
async function postComment(jiraBaseUrl, email, apiToken, issueKey, commentAdf) {
  const url = `${jiraBaseUrl}/rest/api/3/issue/${issueKey}/comment`;
  const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');
  const adfList = Array.isArray(commentAdf) ? commentAdf : [commentAdf];

  for (const doc of adfList) {
    try {
      await axios.post(
        url,
        { body: doc },
        {
          headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          }
        }
      );
    } catch (err) {
      const status = err.response ? err.response.status : 'network error';
      const detail = err.response ? JSON.stringify(err.response.data) : err.message;
      throw new Error(`Jira postComment failed for issue "${issueKey}" — ${status}: ${detail}`);
    }
  }
}

/**
 * Fetches watchers for a Jira issue.
 *
 * @param {string} jiraBaseUrl  e.g. "https://your-org.atlassian.net"
 * @param {string} email        Jira account email
 * @param {string} apiToken     Jira API token
 * @param {string} issueKey     e.g. "PROJ-123"
 * @returns {Promise<Array<{accountId: string, displayName: string, email: string}>>}
 */
async function fetchWatchers(jiraBaseUrl, email, apiToken, issueKey) {
  const url = `${jiraBaseUrl.replace(/\/$/, '')}/rest/api/3/issue/${issueKey}/watchers`;
  const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');

  try {
    const res = await axios.get(url, {
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/json'
      }
    });
    const watchers = (res.data && res.data.watchers) || [];
    return watchers.map(w => ({
      accountId: w.accountId,
      displayName: w.displayName,
      // Return null when Jira hides the email — never invent a fake address.
      email: w.emailAddress || null
    }));
  } catch (err) {
    const status = err.response ? err.response.status : 'network error';
    const detail = err.response ? JSON.stringify(err.response.data) : err.message;
    throw new Error(`Jira fetchWatchers failed for issue "${issueKey}" — ${status}: ${detail}`);
  }
}

/**
 * Searches for Jira users by display name, username, or email.
 *
 * Requires "Browse users and groups" permission on the Jira instance.
 * Returns an empty array (never throws) when the permission is missing (403).
 *
 * @param {string} jiraBaseUrl  e.g. "https://your-org.atlassian.net"
 * @param {string} email        Jira account email (for Basic Auth)
 * @param {string} apiToken     Jira API token
 * @param {string} query        Search term — display name, username, or email fragment
 * @returns {Promise<Array<{accountId: string, displayName: string, email: string|null}>>}
 */
async function searchUsers(jiraBaseUrl, email, apiToken, query) {
  if (!query || !query.trim()) return [];
  const url = `${jiraBaseUrl.replace(/\/$/, '')}/rest/api/3/user/search?query=${encodeURIComponent(query.trim())}`;
  const auth = Buffer.from(`${email}:${apiToken}`).toString('base64');

  try {
    const res = await axios.get(url, {
      headers: {
        'Authorization': `Basic ${auth}`,
        'Accept': 'application/json'
      }
    });
    const users = Array.isArray(res.data) ? res.data : [];
    return users.map(u => ({
      accountId: u.accountId,
      displayName: u.displayName,
      email: u.emailAddress || null
    }));
  } catch (err) {
    // 403 means "Browse users and groups" permission is missing — return empty
    // rather than crashing the GUI typeahead.
    if (err.response && err.response.status === 403) return [];
    const status = err.response ? err.response.status : 'network error';
    const detail = err.response ? JSON.stringify(err.response.data) : err.message;
    throw new Error(`Jira searchUsers failed — ${status}: ${detail}`);
  }
}

module.exports = {
  postComment,
  fetchWatchers,
  searchUsers,
  buildCommentAdf: adf.buildCommentAdf,
  buildCommentAdfList: adf.buildCommentAdfList,
  chunkAdfDocument: adf.chunkAdfDocument,
  buildCommentsSection: adf.buildCommentsSection
};
