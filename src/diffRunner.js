'use strict';

/**
 * Server-side runner. Wires the Node I/O (axios clients, fs-backed stores) into
 * the shared pipeline in ./pipeline, which also runs in the browser.
 */

const { getConfig } = require('./configStore');
const { fetchFileTree, fetchComments, postCommentToFigma } = require('./figmaClient');
const { getSnapshot, saveSnapshot, archiveSnapshot } = require('./snapshotStore');
const { postComment } = require('./jiraClient');
const { saveExport } = require('./exportStore');
const { appendRunEntry } = require('./runLog');
const { notifySlack, notifyTeams } = require('./notifier');
const pipeline = require('./pipeline');

const deps = {
  fetchFileTree: (...args) => fetchFileTree(...args),
  fetchComments: (...args) => fetchComments(...args),
  postCommentToFigma: (...args) => postCommentToFigma(...args),
  postJiraComment: (config, issueKey, adfList) =>
    postComment(config.jiraBaseUrl, config.jiraEmail, config.jiraApiToken, issueKey, adfList),
  getSnapshot: fileKey => getSnapshot(fileKey),
  saveSnapshot: (fileKey, snapshot) => {
    // Archive the outgoing baseline before overwriting (Item 3).
    // Retention limit comes from config; fall back to default (7) if not set.
    const cfg = getConfig();
    const retention = (cfg && typeof cfg.snapshotRetention === 'number' && cfg.snapshotRetention > 0)
      ? cfg.snapshotRetention : 7;
    const existing = getSnapshot(fileKey);
    if (existing) {
      try { archiveSnapshot(fileKey, existing, retention); } catch { /* best-effort */ }
    }
    saveSnapshot(fileKey, snapshot);
  },
  saveExport: (projectId, issueKey, content, ext) => saveExport(projectId, issueKey, content, ext),
  appendRunEntry: entry => appendRunEntry(entry),
  notifySlack: (url, msg) => notifySlack(url, msg),
  notifyTeams: (url, msg) => notifyTeams(url, msg)
};

/**
 * Runs the full diff pipeline for a single project config entry.
 * @param {object} project   A single entry from config.projects
 * @param {object} config    The full config object (for tokens/credentials)
 */
function runProject(project, config) {
  return pipeline.runProjectPipeline(project, config, deps);
}

/** Posts the consolidated changelog comment back to Figma. */
function syncChangesToFigma(fileKey, token, diffResult, runAt, jiraIssueKey, jiraBaseUrl = '', enabled = true) {
  return pipeline.syncChangesToFigma(deps.postCommentToFigma, fileKey, token, diffResult, runAt, jiraIssueKey, jiraBaseUrl, enabled);
}

/**
 * Runs the diff pipeline for all configured projects.
 * A failure in one project does not abort the others.
 *
 * @returns {Promise<Array>} Results array — one entry per project
 */
async function runAllProjects() {
  const config = getConfig();

  if (!config.projects || config.projects.length === 0) {
    console.log('[Runner] No projects configured — nothing to do.');
    return [];
  }

  console.log(`[Runner] Run started at ${new Date().toISOString()} — ${config.projects.length} project(s)`);

  const results = [];
  for (const project of config.projects) {
    const result = await runProject(project, config);
    results.push(result);
  }

  console.log(`[Runner] Run complete. Results: ${JSON.stringify(results.map(r => ({ name: r.figmaFileName, status: r.status, changes: r.changesCount })))}`);
  return results;
}

module.exports = {
  runProject,
  runAllProjects,
  syncChangesToFigma,
  extractDocTree: pipeline.extractDocTree,
  extractKnownCommentIds: pipeline.extractKnownCommentIds,
  extractKnownResolvedCommentIds: pipeline.extractKnownResolvedCommentIds
};
