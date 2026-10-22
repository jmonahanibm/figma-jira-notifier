'use strict';

/**
 * Persistent run history log.
 *
 * Stores the last MAX_ENTRIES runs per project in <runtimeDir>/runs/<projectId>.runs.json
 * and aggregates them on getRunLog() (newest-first, capped at MAX_ENTRIES).
 * Also supports legacy single-file runs.json in <runtimeDir>/runs.json.
 */

const fs = require('fs');
const path = require('path');
const { runtimeDir } = require('./configStore');

const MAX_ENTRIES = 50;

function runsDirPath() {
  const dir = path.join(runtimeDir(), 'runs');
  if (!fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  }
  return dir;
}

function legacyRunsPath() {
  return path.join(runtimeDir(), 'runs.json');
}

function projectRunsPath(projectId) {
  return path.join(runsDirPath(), `${projectId}.runs.json`);
}

/**
 * Reads run entries for a single project file.
 * @param {string} filePath
 * @returns {object[]}
 */
function readLogFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Writes run entries to a file.
 * @param {string} filePath
 * @param {object[]} entries
 */
function writeLogFile(filePath, entries) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(entries, null, 2), 'utf8');
  } catch (err) {
    console.warn(`[RunLog] Could not write run log to ${filePath}: ${err.message}`);
  }
}

/**
 * Returns all stored run log entries across all projects, sorted newest first, capped at MAX_ENTRIES.
 * @returns {object[]}
 */
function getRunLog() {
  const allEntries = [];
  const seenIds = new Set();

  // 1. Read from per-project runs directory
  try {
    const dir = path.join(runtimeDir(), 'runs');
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.runs.json'));
      for (const f of files) {
        const entries = readLogFile(path.join(dir, f));
        for (const e of entries) {
          if (e && e.id && !seenIds.has(e.id)) {
            seenIds.add(e.id);
            allEntries.push(e);
          }
        }
      }
    }
  } catch { /* ignore */ }

  // 2. Read from legacy runs.json if present
  try {
    const legacyPath = legacyRunsPath();
    if (fs.existsSync(legacyPath)) {
      const legacyEntries = readLogFile(legacyPath);
      for (const e of legacyEntries) {
        if (e && e.id && !seenIds.has(e.id)) {
          seenIds.add(e.id);
          allEntries.push(e);
        }
      }
    }
  } catch { /* ignore */ }

  // Sort newest first by runAt timestamp
  allEntries.sort((a, b) => {
    const timeA = a.runAt ? new Date(a.runAt).getTime() : 0;
    const timeB = b.runAt ? new Date(b.runAt).getTime() : 0;
    return timeB - timeA;
  });

  return allEntries.slice(0, MAX_ENTRIES);
}

/**
 * Appends a new run entry, enforcing the MAX_ENTRIES cap per project and overall.
 * Returns the entry as stored (with its generated id).
 *
 * @param {object} entry  Must contain at least { projectId, figmaFileName, runAt, status, changesCount }
 * @returns {object}
 */
function appendRunEntry(entry) {
  const id = `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const stored = { id, ...entry };

  if (entry && entry.projectId) {
    const filePath = projectRunsPath(entry.projectId);
    const entries = readLogFile(filePath);
    entries.unshift(stored);
    if (entries.length > MAX_ENTRIES) entries.splice(MAX_ENTRIES);
    writeLogFile(filePath, entries);
  } else {
    // Write to legacy runs.json
    const filePath = legacyRunsPath();
    const entries = readLogFile(filePath);
    entries.unshift(stored);
    if (entries.length > MAX_ENTRIES) entries.splice(MAX_ENTRIES);
    writeLogFile(filePath, entries);
  }

  return stored;
}

/**
 * Updates the result for a specific channel on an existing run entry.
 * Used by "Resend" to record success/failure after a manual resend.
 *
 * @param {string} runId
 * @param {string} channel  'jira' | 'slack' | 'teams'
 * @param {{ status: 'sent'|'failed', error?: string }} result
 * @returns {boolean} true if the entry was found and updated
 */
function updateChannelResult(runId, channel, result) {
  // Search per-project files first
  try {
    const dir = path.join(runtimeDir(), 'runs');
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.runs.json'));
      for (const f of files) {
        const filePath = path.join(dir, f);
        const entries = readLogFile(filePath);
        const entry = entries.find(e => e.id === runId);
        if (entry) {
          if (!entry.channels) entry.channels = {};
          entry.channels[channel] = result;
          writeLogFile(filePath, entries);
          return true;
        }
      }
    }
  } catch { /* ignore */ }

  // Check legacy runs.json
  try {
    const legacyPath = legacyRunsPath();
    if (fs.existsSync(legacyPath)) {
      const entries = readLogFile(legacyPath);
      const entry = entries.find(e => e.id === runId);
      if (entry) {
        if (!entry.channels) entry.channels = {};
        entry.channels[channel] = result;
        writeLogFile(legacyPath, entries);
        return true;
      }
    }
  } catch { /* ignore */ }

  return false;
}

/**
 * Clears all log entries across all project files and legacy file.
 */
function clearRunLog() {
  try {
    const dir = path.join(runtimeDir(), 'runs');
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.runs.json'));
      for (const f of files) {
        try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  try {
    const legacyPath = legacyRunsPath();
    if (fs.existsSync(legacyPath)) {
      writeLogFile(legacyPath, []);
    }
  } catch { /* ignore */ }
}

module.exports = { getRunLog, appendRunEntry, updateChannelResult, clearRunLog, MAX_ENTRIES };
