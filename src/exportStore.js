'use strict';

/**
 * Server-side export storage.
 *
 * Writes export files to <runtimeDir>/exports/<projectId>/<issueKey>_<timestamp>.<ext>
 * Enforces a rolling retention limit (default 30 exports per project).
 * getLatestExport returns the path and content of the most recent file for a project.
 */

const fs = require('fs');
const path = require('path');
const { runtimeDir } = require('./configStore');

const RETENTION = 30;

function exportsDir(projectId) {
  return path.join(runtimeDir(), 'exports', projectId);
}

/**
 * Saves an export file and enforces the retention limit.
 *
 * @param {string} projectId
 * @param {string} issueKey   Used in the file name (may be empty)
 * @param {string} content
 * @param {'md'|'html'} ext
 * @returns {string} Path to the written file
 */
function saveExport(projectId, issueKey, content, ext) {
  const dir = exportsDir(projectId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const ts = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
  const prefix = issueKey ? `${issueKey}_` : '';
  const fileName = `${prefix}${ts}.${ext}`;
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, content, 'utf8');

  // Enforce retention limit: remove oldest files when over RETENTION
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith(`.${ext}`))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime); // oldest first

  while (files.length > RETENTION) {
    const oldest = files.shift();
    try { fs.unlinkSync(path.join(dir, oldest.name)); } catch { /* best-effort */ }
  }

  return filePath;
}

/**
 * Returns { filePath, content, ext } for the most recent export file for a project,
 * or null when no export exists.
 *
 * @param {string} projectId
 * @returns {{ filePath: string, content: string, ext: string } | null}
 */
function getLatestExport(projectId) {
  const dir = exportsDir(projectId);
  if (!fs.existsSync(dir)) return null;

  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.md') || f.endsWith('.html'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime); // newest first

  if (files.length === 0) return null;

  const newest = files[0];
  const filePath = path.join(dir, newest.name);
  const content = fs.readFileSync(filePath, 'utf8');
  const ext = newest.name.endsWith('.html') ? 'html' : 'md';
  return { filePath, content, ext };
}

module.exports = { saveExport, getLatestExport };
