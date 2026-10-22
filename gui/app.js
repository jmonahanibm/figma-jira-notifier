/* ============================================================
   Design Change Log — GUI application logic

   One GUI for both modes. All data access goes through an adapter
   (./adapters) chosen at startup by probing GET /api/config:
     server — Express API (binary / npm start)
     hosted — localStorage + direct Figma/Jira calls (GitHub Pages)
   Bundled by esbuild into dist/app.bundle.js (npm run bundle).
   ============================================================ */

'use strict';

const { createAdapter } = require('./adapters');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let adapter = null;
let config = {};
let lastRunResults = null;
let lastRunTime = null;
let editingProjectId = null;
let scheduleTimer = null;

const $ = id => document.getElementById(id);

// ---------------------------------------------------------------------------
// Timberwolves theme — unlocked by pressing W 10 times consecutively
// ---------------------------------------------------------------------------
(function initWolvesTheme() {
  const REQUIRED = 10;
  const STORAGE_UNLOCKED = 'wolves-unlocked';
  const STORAGE_ACTIVE   = 'wolves-active';
  let streak = 0;

  function applyTheme(active) {
    document.documentElement.setAttribute('data-theme', active ? 'wolves' : '');
    const btn = document.getElementById('btnWolvesTheme');
    if (btn) btn.classList.toggle('active', active);
    localStorage.setItem(STORAGE_ACTIVE, active ? '1' : '');
  }

  function revealButton() {
    const btn = document.getElementById('btnWolvesTheme');
    if (!btn) return;
    btn.style.display = '';
    localStorage.setItem(STORAGE_UNLOCKED, '1');
  }

  // Restore state from previous session
  if (localStorage.getItem(STORAGE_UNLOCKED) === '1') {
    revealButton();
  }
  if (localStorage.getItem(STORAGE_ACTIVE) === '1') {
    applyTheme(true);
  }

  // Listen for 10 consecutive W key presses
  document.addEventListener('keydown', function(e) {
    if (e.key === 'w' || e.key === 'W') {
      streak++;
      if (streak >= REQUIRED) {
        streak = 0;
        revealButton();
      }
    } else {
      streak = 0;
    }
  });

  // Wire toggle button
  document.addEventListener('click', function(e) {
    if (e.target && e.target.id === 'btnWolvesTheme') {
      const isActive = document.documentElement.getAttribute('data-theme') === 'wolves';
      applyTheme(!isActive);
    }
  });
})();

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------
/**
 * Extracts the Figma file key and a human-readable name from a Figma URL
 * or returns the raw value unchanged if it doesn't look like a URL.
 *
 * Handles formats:
 *   https://www.figma.com/design/<key>/<name-slug>?...
 *   https://www.figma.com/file/<key>/<name-slug>?...
 *
 * @param {string} input
 * @returns {{ fileKey: string, figmaUrl: string, displayName: string }}
 */
function parseFigmaInput(input) {
  const trimmed = input.trim();
  const match = trimmed.match(/figma\.com\/(?:design|file)\/([A-Za-z0-9]+)(?:\/([^?#]*))?/);
  if (!match) return { fileKey: trimmed, figmaUrl: '', displayName: '' };
  const fileKey = match[1];
  const displayName = match[2]
    ? decodeURIComponent(match[2]).replace(/-/g, ' ').trim()
    : '';
  // Normalise to a clean URL (drop query params)
  const figmaUrl = `https://www.figma.com/design/${fileKey}/${match[2] || ''}`.replace(/\/$/, '');
  return { fileKey, figmaUrl: trimmed.startsWith('http') ? trimmed.split('?')[0] : figmaUrl, displayName };
}

/**
 * Extracts the Jira issue key from a full Jira URL or returns the raw value
 * if it's already just a key like "PROJ-123".
 *
 * @param {string} input
 * @returns {{ issueKey: string }}
 */
function parseJiraInput(input) {
  const trimmed = input.trim();
  const match = trimmed.match(/\/browse\/([A-Z][A-Z0-9_]+-\d+)/);
  if (match) return { issueKey: match[1] };
  return { issueKey: trimmed };
}

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const hours = String(d.getUTCHours()).padStart(2, '0');
  const minutes = String(d.getUTCMinutes()).padStart(2, '0');
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} at ${hours}:${minutes} UTC`;
}

/** Shows the schedule string with a human hint rather than a full cron parser. */
function describeSchedule(cron) {
  if (!cron) return '—';
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [min, hour, dom, , dow] = parts;
  if (dom === '*' && dow === '*') return `Daily at ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
  return cron;
}

// ---------------------------------------------------------------------------
// Alerts (dismissible; success alerts clear themselves)
// ---------------------------------------------------------------------------
function dismissAlert(elId) {
  const el = $(elId);
  if (el) el.className = 'alert';
}

function showAlert(elId, type, message) {
  const el = $(elId);
  el.className = `alert alert-${type} show`;
  el.innerHTML = `<span>${escHtml(message)}</span><button type="button" class="alert-dismiss" data-dismiss="${elId}" aria-label="Dismiss">✕</button>`;
  if (type === 'success') setTimeout(() => dismissAlert(elId), 3500);
}

// ---------------------------------------------------------------------------
// Load & render config
// ---------------------------------------------------------------------------
async function loadConfig() {
  config = await adapter.getConfig();
  renderSettings();
  renderProjects();
  updateStatusBar();
}

function renderSettings() {
  // Workspace directory
  $('dataDir').value = config.dataDir || '';
  $('dataDirStatus').textContent = '';

  // Secret fields come back masked ('***') when stored
  $('jiraBaseUrl').value = config.jiraBaseUrl || '';
  $('jiraEmail').value = config.jiraEmail || '';
  $('schedule').value = config.schedule || '0 8 * * *';
  $('figmaToken').placeholder = config.figmaToken ? '(stored locally — leave blank to keep)' : 'figd_…';
  $('figmaToken').value = '';
  $('jiraApiToken').placeholder = config.jiraApiToken ? '(stored locally — leave blank to keep)' : 'Your Jira API token';
  $('jiraApiToken').value = '';

  // Notification channels
  const ch = config.channels || {};
  $('channelJira').checked = ch.jira !== false;
  $('channelSlackUrl').value = ch.slackWebhookUrl || '';
  $('channelTeamsUrl').value = ch.teamsWebhookUrl || '';

  // Show CORS warning in hosted mode when webhook URLs are configured
  const corsEl = $('channelsCorsBanner');
  if (corsEl) {
    const hasWebhook = !!(ch.slackWebhookUrl || ch.teamsWebhookUrl);
    corsEl.style.display = (adapter && adapter.mode === 'hosted' && hasWebhook) ? 'block' : 'none';
  }

  // Snapshot retention
  $('snapshotRetention').value = config.snapshotRetention || 7;
}

function updateStatusBar() {
  $('lastRun').textContent = lastRunTime ? formatDate(lastRunTime) : '—';
  $('scheduleDisplay').textContent = config.schedule || '—';
  $('nextRun').textContent = describeSchedule(config.schedule);

  const wsDisplay = $('workspaceDisplay');
  if (wsDisplay) {
    if (config.isSharedWorkspace) {
      const folderName = config.dataDir ? (config.dataDir.split(/[/\\]/).filter(Boolean).pop() || config.dataDir) : 'Shared';
      wsDisplay.textContent = `Shared (${folderName})`;
      wsDisplay.title = config.dataDir || 'Shared workspace';
    } else {
      wsDisplay.textContent = 'Local default';
      wsDisplay.title = 'Using local application data directory';
    }
  }
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    const targetPane = $(btn.getAttribute('data-tab'));
    if (targetPane) targetPane.classList.add('active');
  });
});

// ---------------------------------------------------------------------------
// Project list rendering (Tabs: Connected & Recent Changes / Activity)
// ---------------------------------------------------------------------------
function renderProjects() {
  const connectedEl = $('connectedList');
  const changesEl = $('changesList');
  const projects = config.projects || [];
  $('connectedCount').textContent = projects.length;
  $('connectedCountBadge').textContent = `${projects.length} configured`;

  if (projects.length === 0) {
    connectedEl.innerHTML = '<div class="empty-state">No connected projects configured yet. Add one to get started.</div>';
    changesEl.innerHTML = '<div class="empty-state">No monitored projects.</div>';
    $('changesCount').textContent = '0';
    $('changesCountBadge').textContent = '0';
    return;
  }

  connectedEl.innerHTML = '';
  for (const project of projects) {
    const mentions = (project.mentionedUsers || []).map(u => (typeof u === 'string' ? u : (u.email || u.displayName || u.jiraAccountId))).join(', ') || 'None';
    const commentsEnabled = project.syncComments !== false;
    const label = escHtml(project.figmaFileName || project.figmaFileKey);
    const nameHtml = project.figmaUrl
      ? `<a href="${escHtml(project.figmaUrl)}" target="_blank" rel="noopener noreferrer" class="name-link">${label}</a>`
      : label;
    const card = document.createElement('div');
    card.className = 'project-card';
    card.innerHTML = `
      <div class="project-card-info">
        <div class="name">${nameHtml}</div>
        <div class="meta">Figma: <code>${escHtml(project.figmaFileKey)}</code> -> Jira: <strong>${escHtml(project.jiraIssueKey)}</strong></div>
        ${project.schedule ? `<div class="meta" style="color:#0969da;">Custom schedule: <code>${escHtml(project.schedule)}</code> (${describeSchedule(project.schedule)})</div>` : ''}
        <div class="mentions">Mentions: ${escHtml(mentions)}</div>
        <div><span class="comments-tag ${commentsEnabled ? '' : 'disabled'}">Comments: ${commentsEnabled ? 'Enabled' : 'Disabled'}</span></div>
        <details class="snapshot-history" style="margin-top:8px; font-size:12px; color:#57606a;">
          <summary style="cursor:pointer; user-select:none;">Snapshot history</summary>
          <div class="snapshot-list" data-file-key="${escHtml(project.figmaFileKey)}"
               style="margin-top:6px; display:flex; flex-direction:column; gap:4px;">
            <span style="color:#57606a;">Loading…</span>
          </div>
        </details>
      </div>
      <div class="project-card-actions">
        <button class="btn-run-single" id="btnRun-${escHtml(project.id)}" data-action="run" data-id="${escHtml(project.id)}">Run now</button>
        <button class="btn-secondary" data-action="edit" data-id="${escHtml(project.id)}">Edit</button>
        <button class="btn-danger" data-action="delete" data-id="${escHtml(project.id)}" aria-label="Remove project">✕</button>
      </div>
    `;
    connectedEl.appendChild(card);
  }

  renderChangesColumn();
}

// Card buttons are rendered as HTML strings; one delegated listener handles them
$('connectedList').addEventListener('click', async e => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const id = btn.getAttribute('data-id');
  if (btn.dataset.action === 'run') runSingleProject(id);
  else if (btn.dataset.action === 'edit') openEditModal(id);
  else if (btn.dataset.action === 'delete') deleteProject(id);
  else if (btn.dataset.action === 'restore-snapshot') {
    const fileKey = btn.getAttribute('data-file-key');
    const timestamp = btn.getAttribute('data-timestamp');
    if (!fileKey || !timestamp) return;
    btn.disabled = true;
    btn.textContent = 'Restoring…';
    try {
      await adapter.restoreSnapshot(fileKey, timestamp);
      // Reload snapshot list for this card
      const listEl = document.querySelector(`.snapshot-list[data-file-key="${fileKey}"]`);
      if (listEl) await loadSnapshotList(listEl, fileKey);
      showAlert('settingsAlert', 'success', `Snapshot restored for ${fileKey}. The next run will diff against this baseline.`);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Restore';
      alert(`Failed to restore snapshot: ${err.message}`);
    }
  }
});

// When a snapshot history <details> is first opened, fetch and render its list.
$('connectedList').addEventListener('toggle', async e => {
  const details = e.target.closest('details.snapshot-history');
  if (!details || !details.open) return;
  const listEl = details.querySelector('.snapshot-list[data-file-key]');
  if (!listEl) return;
  const fileKey = listEl.getAttribute('data-file-key');
  // Only load once (guard against re-opening)
  if (listEl.dataset.loaded === 'true') return;
  await loadSnapshotList(listEl, fileKey);
}, true); // capture phase so `toggle` bubbles up

async function loadSnapshotList(listEl, fileKey) {
  listEl.dataset.loaded = 'true';
  try {
    const snapshots = await adapter.listSnapshots(fileKey);
    if (snapshots.length === 0) {
      listEl.innerHTML = '<span style="color:#57606a;">No archived snapshots yet.</span>';
      return;
    }
    listEl.innerHTML = snapshots.map(s => {
      const label = s.savedAt ? escHtml(new Date(s.savedAt).toLocaleString()) : escHtml(s.timestamp);
      return `
        <div style="display:flex; align-items:center; gap:8px;">
          <span>${label}</span>
          <button class="btn-secondary" style="font-size:11px; padding:2px 8px;"
                  data-action="restore-snapshot"
                  data-file-key="${escHtml(fileKey)}"
                  data-timestamp="${escHtml(s.timestamp)}">Restore</button>
        </div>`;
    }).join('');
  } catch {
    listEl.innerHTML = '<span style="color:#c00;">Failed to load snapshot history.</span>';
  }
}

// Dismiss buttons inside any alert
document.addEventListener('click', e => {
  const btn = e.target.closest('button[data-dismiss]');
  if (btn) dismissAlert(btn.getAttribute('data-dismiss'));
});

async function renderChangesColumn() {
  const changesEl = $('changesList');
  const projects = config.projects || [];

  // Fetch persistent run log; merge with current-session results (in-memory)
  let runLog = [];
  if (adapter && typeof adapter.getRunLog === 'function') {
    try { runLog = await adapter.getRunLog(); } catch { /* fallback to in-memory */ }
  }

  // Merge: current-session results replace the log entry for the same projectId if more recent
  const merged = [...runLog];
  if (lastRunResults && lastRunResults.length > 0) {
    for (const r of lastRunResults) {
      const idx = merged.findIndex(e => e.projectId === r.projectId);
      if (idx >= 0) merged[idx] = { ...merged[idx], ...r };
      else merged.unshift(r);
    }
  }

  if (merged.length === 0) {
    $('changesCount').textContent = projects.length;
    $('changesCountBadge').textContent = `${projects.length} pending`;
    changesEl.innerHTML = projects.map(p => `
      <div class="project-card">
        <div class="project-card-info">
          <div class="name">${escHtml(p.figmaFileName || p.figmaFileKey)}</div>
          <div class="meta">Jira: <strong>${escHtml(p.jiraIssueKey)}</strong></div>
          <span class="change-status no-changes">Ready - pending next diff run</span>
        </div>
      </div>
    `).join('');
    return;
  }

  const badgeClasses = {
    posted: 'has-changes', partial: 'has-changes',
    no_changes: 'no-changes', first_run: 'baseline', rebaselined: 'baseline', error: 'has-changes'
  };
  const statusLabel = r => {
    if (r.status === 'posted') return `${r.changesCount} change${r.changesCount !== 1 ? 's' : ''} posted`;
    if (r.status === 'partial') return `${r.changesCount} change${r.changesCount !== 1 ? 's' : ''} — some channels failed`;
    if (r.status === 'no_changes') return 'No changes detected';
    if (r.status === 'first_run') return 'Baseline snapshot established';
    if (r.status === 'rebaselined') return 'Snapshot format upgraded — baseline saved';
    return `Error: ${r.error || 'Failed'}`;
  };

  const postedCount = merged.filter(r => r.status === 'posted' || r.status === 'partial').length;
  $('changesCount').textContent = postedCount;
  $('changesCountBadge').textContent = `${postedCount} posted / ${merged.length} total`;

  changesEl.innerHTML = merged.map(r => {
    const ts = r.runAt ? `<span class="meta">${escHtml(new Date(r.runAt).toLocaleString())}</span>` : '';
    const channels = r.channels || {};
    const channelBadges = Object.entries(channels).map(([ch, res]) => {
      const ok = res.status === 'sent';
      const badge = `<span class="change-status ${ok ? 'no-changes' : 'has-changes'}" style="margin-right:4px;">${escHtml(ch)}: ${ok ? '✓' : '✗'}</span>`;
      const resendBtn = (!ok && r.id)
        ? `<button class="btn-secondary" style="font-size:11px; padding:2px 8px; margin-left:4px;" data-action="resend" data-run-id="${escHtml(r.id)}" data-channel="${escHtml(ch)}">Resend</button>`
        : '';
      return badge + resendBtn;
    }).join('');
    return `
      <div class="project-card">
        <div class="project-card-info">
          <div class="name">${escHtml(r.figmaFileName || r.projectId || 'Unknown project')}</div>
          ${ts}
          <span class="change-status ${badgeClasses[r.status] || 'no-changes'}">${escHtml(statusLabel(r))}</span>
          ${channelBadges ? `<div style="margin-top:4px;">${channelBadges}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');

  // Export download buttons for projects that posted and have exportFormat enabled
  const exportActionsEl = $('exportActions');
  if (exportActionsEl) {
    const exportEntries = merged.filter(r => {
      const proj = projects.find(p => p.id === r.projectId);
      return (r.status === 'posted' || r.status === 'partial') && proj && proj.exportFormat && proj.exportFormat !== 'none';
    });
    if (exportEntries.length > 0) {
      exportActionsEl.style.display = '';
      exportActionsEl.innerHTML = exportEntries.map(r => {
        const url = adapter && typeof adapter.getLatestExportUrl === 'function'
          ? adapter.getLatestExportUrl(r.projectId) : null;
        if (!url) return '';
        return `<a class="btn-secondary" href="${escHtml(url)}" download style="display:inline-block; margin-right:8px; text-decoration:none;">⬇ Download changelog — ${escHtml(r.figmaFileName || r.projectId)}</a>`;
      }).filter(Boolean).join('');
    } else {
      exportActionsEl.style.display = 'none';
    }
  }
}

// ---------------------------------------------------------------------------
// Settings form
// ---------------------------------------------------------------------------
function openSettingsModal() {
  $('settingsAlert').className = 'alert';
  $('settingsModal').classList.add('open');
}

function closeSettingsModal() {
  $('settingsModal').classList.remove('open');
}

$('btnOpenSettings').addEventListener('click', openSettingsModal);
$('settingsModalClose').addEventListener('click', closeSettingsModal);
$('settingsModalCancel').addEventListener('click', closeSettingsModal);
$('settingsModal').addEventListener('click', e => {
  if (e.target === $('settingsModal')) closeSettingsModal();
});

// ---- Test workspace folder button ----
$('btnTestDataDir').addEventListener('click', async () => {
  const dirVal = $('dataDir').value.trim();
  const statusEl = $('dataDirStatus');
  if (!dirVal) {
    statusEl.style.color = '#57606a';
    statusEl.textContent = 'Using default local application folder.';
    return;
  }
  statusEl.style.color = '#57606a';
  statusEl.textContent = 'Testing folder access…';
  try {
    const res = await adapter.testDataDir(dirVal);
    if (res.ok) {
      statusEl.style.color = '#1a7f37';
      statusEl.textContent = `✓ Folder accessible and writable (${res.path || dirVal})`;
    } else {
      statusEl.style.color = '#cf222e';
      statusEl.textContent = `✗ Error: ${res.error}`;
    }
  } catch (err) {
    statusEl.style.color = '#cf222e';
    statusEl.textContent = `✗ Error: ${err.message}`;
  }
});

$('btnSaveSettings').addEventListener('click', async () => {
  // Start from the loaded config so projects and untouched (masked) secrets are preserved
  const payload = {
    ...config,
    dataDir: $('dataDir').value.trim(),
    jiraBaseUrl: $('jiraBaseUrl').value.trim(),
    jiraEmail: $('jiraEmail').value.trim(),
    schedule: $('schedule').value.trim() || '0 8 * * *'
  };

  // Only replace secret fields if the user actually typed something
  const figmaToken = $('figmaToken').value;
  const jiraApiToken = $('jiraApiToken').value;
  if (figmaToken) payload.figmaToken = figmaToken;
  if (jiraApiToken) payload.jiraApiToken = jiraApiToken;

  // Notification channels — at least one must be enabled
  const jiraOn = $('channelJira').checked;
  const slackUrl = $('channelSlackUrl').value.trim();
  const teamsUrl = $('channelTeamsUrl').value.trim();
  if (!jiraOn && !slackUrl && !teamsUrl) {
    const validEl = $('channelsValidationMsg');
    if (validEl) {
      validEl.className = 'alert alert-error show';
      validEl.innerHTML = '<span>At least one notification channel must be enabled (Jira, Slack, or Teams).</span>';
      setTimeout(() => { validEl.className = 'alert'; }, 4000);
    }
    return;
  }
  payload.channels = {
    jira: jiraOn,
    slackWebhookUrl: slackUrl,
    teamsWebhookUrl: teamsUrl
  };

  // Snapshot retention
  const retentionVal = parseInt($('snapshotRetention').value, 10);
  payload.snapshotRetention = (retentionVal > 0 && retentionVal <= 50) ? retentionVal : 7;

  // Show CORS warning when hosted and webhook URLs are set
  const corsEl = $('channelsCorsBanner');
  if (corsEl && adapter && adapter.mode === 'hosted' && (slackUrl || teamsUrl)) {
    corsEl.style.display = 'block';
  }

  try {
    await adapter.saveConfig(payload);
    await loadConfig();
    setupScheduleTimer();
    showAlert('settingsAlert', 'success', 'Settings saved.');
    setTimeout(closeSettingsModal, 1000);
  } catch (err) {
    showAlert('settingsAlert', 'error', err.message);
  }
});

$('settingsForm').addEventListener('submit', e => {
  e.preventDefault();
  $('btnSaveSettings').click();
});

// ---------------------------------------------------------------------------
// Run now
// ---------------------------------------------------------------------------
function recordRun(results, { replaceAll }) {
  lastRunTime = new Date().toISOString();
  adapter.setLastRun(lastRunTime);
  if (replaceAll) {
    lastRunResults = results;
  } else {
    if (!lastRunResults) lastRunResults = [];
    for (const r of results) {
      const idx = lastRunResults.findIndex(existing => existing.projectId === r.projectId);
      if (idx >= 0) lastRunResults[idx] = r; else lastRunResults.push(r);
    }
  }
}

function showRunError(message) {
  const el = $('runResults');
  el.style.display = 'flex';
  el.innerHTML = `<div class="result-row error"><span>${escHtml(message)}</span></div>`;
}

async function executeRun(isAutomatic = false) {
  const btn = $('btnRunNow');
  btn.disabled = true;
  btn.classList.add('running');
  btn.textContent = isAutomatic ? 'Auto-running...' : 'Running...';

  const resultsEl = $('runResults');
  resultsEl.style.display = 'none';
  resultsEl.innerHTML = '';

  try {
    const results = await adapter.runAll();
    recordRun(results, { replaceAll: true });
    renderRunResults(results);
    renderProjects();
    updateStatusBar();
  } catch (err) {
    showRunError(err.message);
  } finally {
    btn.disabled = false;
    btn.classList.remove('running');
    btn.textContent = 'Run now';
  }
}

async function runSingleProject(projectId) {
  const btn = $(`btnRun-${projectId}`);
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Running...';
  }
  $('runResults').style.display = 'none';

  try {
    const results = await adapter.runProject(projectId);
    recordRun(results, { replaceAll: false });
    renderRunResults(results);
    renderProjects();
    updateStatusBar();
  } catch (err) {
    showRunError(err.message);
  } finally {
    // renderProjects() rebuilds the card on success; re-query in case the button still exists
    const current = $(`btnRun-${projectId}`);
    if (current) {
      current.disabled = false;
      current.textContent = 'Run now';
    }
  }
}

$('btnRunNow').addEventListener('click', () => executeRun(false));

function renderRunResults(results) {
  const el = $('runResults');
  if (!results || results.length === 0) {
    el.style.display = 'flex';
    el.innerHTML = '<div class="result-row no_changes"><span>No projects configured.</span></div>';
    return;
  }

  const labels = {
    posted: r => `${r.changesCount} change${r.changesCount !== 1 ? 's' : ''} posted to Jira`,
    no_changes: () => 'No changes detected',
    first_run: () => 'First run — baseline saved',
    rebaselined: () => 'Snapshot format upgraded — new baseline saved, nothing posted',
    error: r => r.error || 'Unknown error'
  };

  el.innerHTML = results.map(r => `
    <div class="result-row ${r.status}">
      <div>
        <strong>${escHtml(r.figmaFileName || r.projectId)}</strong>
        <div class="result-detail">${escHtml((labels[r.status] || (() => r.status))(r))}</div>
      </div>
    </div>
  `).join('');
  el.style.display = 'flex';
}

// ---------------------------------------------------------------------------
// Scheduled runs — hosted mode only. In server mode node-cron runs them.
// ---------------------------------------------------------------------------
function setupScheduleTimer() {
  if (scheduleTimer) clearTimeout(scheduleTimer);
  if (!adapter || adapter.mode !== 'hosted') return;

  const parts = (config.schedule || '0 8 * * *').trim().split(/\s+/);
  const targetMinute = parseInt(parts[0] || '0', 10);
  const targetHour = parseInt(parts[1] || '8', 10);

  const now = new Date();
  const nextTarget = new Date();
  nextTarget.setHours(targetHour, targetMinute, 0, 0);
  if (nextTarget <= now) nextTarget.setDate(nextTarget.getDate() + 1);

  scheduleTimer = setTimeout(async () => {
    await executeRun(true);
    setupScheduleTimer();
  }, nextTarget.getTime() - now.getTime());
}

// ---------------------------------------------------------------------------
// Project modal
// ---------------------------------------------------------------------------
function _resetChannelOverrideFields() {
  $('overrideJiraEnabled').checked = false;
  $('overrideJiraRow').style.display = 'none';
  $('overrideJira').checked = true;
  $('overrideSlackUrl').value = '';
  $('overrideTeamsUrl').value = '';
}

function _populateChannelOverrideFields(channelOverride) {
  if (!channelOverride) { _resetChannelOverrideFields(); return; }
  const hasJiraOverride = 'jira' in channelOverride;
  $('overrideJiraEnabled').checked = hasJiraOverride;
  $('overrideJiraRow').style.display = hasJiraOverride ? 'block' : 'none';
  $('overrideJira').checked = channelOverride.jira !== false;
  $('overrideSlackUrl').value = channelOverride.slackWebhookUrl || '';
  $('overrideTeamsUrl').value = channelOverride.teamsWebhookUrl || '';
}

function openAddModal() {
  editingProjectId = null;
  $('modalTitle').textContent = 'Add project';
  $('modalProjectId').value = uuid();
  $('modalFileKey').value = '';
  $('modalFileName').value = '';
  $('modalJiraKey').value = '';
  $('modalSyncComments').checked = true;
  $('modalPostFigmaComment').checked = true;
  $('modalExportFormat').value = 'none';
  $('modalSchedule').value = '';
  $('modalExcludePages').value = '';
  $('modalExcludeFrames').value = '';
  _resetChannelOverrideFields();
  renderMentionRows([]);
  $('modalAlert').className = 'alert';
  $('projectModal').classList.add('open');
}

function openEditModal(projectId) {
  const project = (config.projects || []).find(p => p.id === projectId);
  if (!project) return;
  editingProjectId = projectId;
  $('modalTitle').textContent = 'Edit project';
  $('modalProjectId').value = project.id;
  $('modalFileKey').value = project.figmaUrl || project.figmaFileKey || '';
  $('modalFileName').value = project.figmaFileName || '';
  $('modalJiraKey').value = project.jiraIssueKey || '';
  $('modalSyncComments').checked = project.syncComments !== false;
  $('modalPostFigmaComment').checked = project.postFigmaComment !== false;
  $('modalExportFormat').value = project.exportFormat || 'none';
  $('modalSchedule').value = project.schedule || '';
  $('modalExcludePages').value = ((project.exclusions && project.exclusions.pages) || []).join('\n');
  $('modalExcludeFrames').value = ((project.exclusions && project.exclusions.frames) || []).join('\n');
  _populateChannelOverrideFields(project.channelOverride || null);
  renderMentionRows(project.mentionedUsers || []);
  $('modalAlert').className = 'alert';
  $('projectModal').classList.add('open');
}

function closeModal() {
  $('projectModal').classList.remove('open');
}

// Auto-fill the display name from the Figma URL, without overwriting a name the user typed
$('modalFileKey').addEventListener('input', () => {
  const raw = $('modalFileKey').value;
  if (!raw.includes('figma.com')) return;
  const { displayName } = parseFigmaInput(raw);
  if (displayName && !$('modalFileName').value) {
    $('modalFileName').value = displayName;
  }
});

$('btnAddProject').addEventListener('click', openAddModal);

// ---- Clear history ----
const btnClearHistory = $('btnClearHistory');
if (btnClearHistory) {
  btnClearHistory.addEventListener('click', async () => {
    if (!confirm('Clear all run history?')) return;
    if (adapter && typeof adapter.clearRunLog === 'function') {
      await adapter.clearRunLog();
    }
    lastRunResults = null;
    await renderChangesColumn();
  });
}

// ---- Resend button (delegated listener on changesList) ----
$('changesList').addEventListener('click', async e => {
  const btn = e.target.closest('button[data-action="resend"]');
  if (!btn) return;
  const runId = btn.getAttribute('data-run-id');
  const channel = btn.getAttribute('data-channel');
  if (!runId || !channel) return;
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    await adapter.resendChannel(runId, channel);
    await renderChangesColumn();
  } catch (err) {
    showAlert('runAlert', 'error', `Resend failed: ${err.message}`);
    btn.disabled = false;
    btn.textContent = 'Resend';
  }
});
$('modalClose').addEventListener('click', closeModal);
$('modalCancel').addEventListener('click', closeModal);
$('projectModal').addEventListener('click', e => {
  if (e.target === $('projectModal')) closeModal();
});

// ---- Mention rows ----
// ---------------------------------------------------------------------------
// Migration: normalise legacy mentionedUsers entries to the v2 user record
// format: { displayName, jiraAccountId, email }.
// An entry whose jiraAccountId contains '@' was saved by v1 as an email.
// A plain-string entry is also upgraded.
// The migration is best-effort: it does not call the Jira API (to avoid
// requiring credentials at load time). The GUI flags unresolved entries so
// the user can search for the real accountId in the modal.
// ---------------------------------------------------------------------------
function migrateMentionedUsers(users) {
  if (!Array.isArray(users)) return [];
  return users.map(u => {
    if (typeof u === 'string') {
      // Old plain-string format
      const isEmail = u.includes('@');
      return {
        displayName: isEmail ? u.split('@')[0] : u,
        email: isEmail ? u : null,
        jiraAccountId: isEmail ? null : null, // no accountId — needs resolution
        _unresolved: true
      };
    }
    // Object format: migrate if jiraAccountId looks like an email
    if (u.jiraAccountId && u.jiraAccountId.includes('@')) {
      return {
        displayName: u.displayName || u.jiraAccountId.split('@')[0],
        email: u.jiraAccountId,          // move email-as-accountId to email
        jiraAccountId: null,             // no real accountId yet
        _unresolved: true
      };
    }
    return u;
  });
}

function renderMentionRows(users) {
  const container = $('mentionRows');
  container.innerHTML = '';
  const normalised = migrateMentionedUsers(users);
  if (!normalised || normalised.length === 0) {
    addMentionRow(container);
  } else {
    for (const u of normalised) {
      addMentionRow(container, u);
    }
  }
}

/**
 * Adds one mention row to the container.
 *
 * @param {HTMLElement} container
 * @param {object|null} user  Stored user record ({ displayName, jiraAccountId, email }) or null for a blank row
 */
function addMentionRow(container, user = null) {
  const row = document.createElement('div');
  row.className = 'mention-row';
  // Store the resolved user record as a data attribute (JSON) so modalSave can read it.
  if (user && user.jiraAccountId) {
    row.dataset.user = JSON.stringify({
      displayName: user.displayName || '',
      jiraAccountId: user.jiraAccountId,
      email: user.email || null
    });
  }

  const label = user
    ? (user.displayName || user.email || '')
    : '';
  const unresolved = user && user._unresolved;
  const unresolvedHint = unresolved
    ? ` <span class="mention-unresolved" title="No Jira account ID found — search to resolve">⚠ unresolved</span>`
    : '';

  row.innerHTML = `
    <div class="mention-search-wrap">
      <input type="text" placeholder="Search by name or email…" value="${escHtml(label)}"
             class="mention-search" autocomplete="off" />
      <ul class="mention-dropdown" style="display:none;"></ul>
    </div>
    ${unresolvedHint}
    <button type="button" class="btn-danger" title="Remove">✕</button>
  `;

  const input = row.querySelector('.mention-search');
  const dropdown = row.querySelector('.mention-dropdown');

  // ---- Debounced typeahead ----
  let debounceTimer = null;
  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const q = input.value.trim();
    // Clear stored user when the field is edited manually
    delete row.dataset.user;
    dropdown.innerHTML = '';
    dropdown.style.display = 'none';
    if (q.length < 2) return;

    debounceTimer = setTimeout(async () => {
      try {
        const results = await adapter.searchUsers(q);
        dropdown.innerHTML = '';
        if (results.length === 0) {
          const li = document.createElement('li');
          li.className = 'mention-dropdown-empty';
          li.textContent = 'No users found';
          dropdown.appendChild(li);
        } else {
          for (const u of results) {
            const li = document.createElement('li');
            li.className = 'mention-dropdown-item';
            const sub = u.email ? ` <span class="mention-dropdown-email">${escHtml(u.email)}</span>` : '';
            li.innerHTML = `${escHtml(u.displayName)}${sub}`;
            li.addEventListener('mousedown', e => {
              e.preventDefault(); // don't blur the input before click registers
              input.value = u.displayName;
              row.dataset.user = JSON.stringify({
                displayName: u.displayName,
                jiraAccountId: u.accountId,
                email: u.email || null
              });
              // Remove unresolved indicator if present
              const warn = row.querySelector('.mention-unresolved');
              if (warn) warn.remove();
              dropdown.style.display = 'none';
            });
            dropdown.appendChild(li);
          }
        }
        dropdown.style.display = 'block';
      } catch {
        dropdown.style.display = 'none';
      }
    }, 300);
  });

  input.addEventListener('blur', () => {
    // Small delay so mousedown on a dropdown item fires first
    setTimeout(() => { dropdown.style.display = 'none'; }, 150);
  });
  input.addEventListener('focus', () => {
    if (dropdown.children.length > 0) dropdown.style.display = 'block';
  });

  row.querySelector('button').addEventListener('click', () => row.remove());
  container.appendChild(row);
}

$('btnAddMention').addEventListener('click', () => addMentionRow($('mentionRows')));

// Toggle "Override Jira" sub-row visibility
$('overrideJiraEnabled').addEventListener('change', () => {
  $('overrideJiraRow').style.display = $('overrideJiraEnabled').checked ? 'block' : 'none';
});

// ---- Fetch watchers from Jira ----
$('btnSyncWatchers').addEventListener('click', async () => {
  const { issueKey } = parseJiraInput($('modalJiraKey').value);

  if (!issueKey) {
    showAlert('modalAlert', 'error', 'Enter a Jira ticket URL or key first.');
    return;
  }

  const btn = $('btnSyncWatchers');
  btn.disabled = true;
  btn.textContent = 'Fetching...';

  try {
    const watchers = await adapter.getWatchers(issueKey);
    if (watchers.length === 0) {
      showAlert('modalAlert', 'error', `No watchers found on ${issueKey}.`);
      return;
    }

    const container = $('mentionRows');
    // Collect accountIds already in the list to avoid duplicates
    const existing = new Set(
      [...container.querySelectorAll('.mention-row')]
        .map(r => { try { return JSON.parse(r.dataset.user || '{}').jiraAccountId; } catch { return null; } })
        .filter(Boolean)
    );

    let addedCount = 0;
    for (const w of watchers) {
      // Skip watchers already listed or without any identifier
      if (!w.accountId && !w.displayName) continue;
      if (w.accountId && existing.has(w.accountId)) continue;

      // If the container only has one empty row, clear it first
      if (container.children.length === 1) {
        const firstInput = container.querySelector('.mention-search');
        if (firstInput && !firstInput.value.trim()) container.innerHTML = '';
      }
      addMentionRow(container, {
        displayName: w.displayName || w.accountId,
        jiraAccountId: w.accountId || null,
        email: w.email || null,
        _unresolved: !w.accountId
      });
      if (w.accountId) existing.add(w.accountId);
      addedCount++;
    }

    showAlert('modalAlert', 'success', addedCount > 0
      ? `Added ${addedCount} watcher(s) from ${issueKey}.`
      : `All watchers from ${issueKey} are already added.`);
  } catch (err) {
    showAlert('modalAlert', 'error', `Failed to fetch watchers: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Fetch watchers';
  }
});

// ---- Save project ----
$('modalSave').addEventListener('click', async () => {
  const { fileKey, figmaUrl } = parseFigmaInput($('modalFileKey').value);
  const fileName = $('modalFileName').value.trim();
  const { issueKey: jiraKey } = parseJiraInput($('modalJiraKey').value);
  const syncComments = $('modalSyncComments').checked;
  const postFigmaComment = $('modalPostFigmaComment').checked;
  const exportFormat = $('modalExportFormat').value || 'none';
  const customSchedule = $('modalSchedule').value.trim();
  const excludePages = ($('modalExcludePages').value || '').split('\n').map(s => s.trim()).filter(Boolean);
  const excludeFrames = ($('modalExcludeFrames').value || '').split('\n').map(s => s.trim()).filter(Boolean);
  const exclusions = (excludePages.length > 0 || excludeFrames.length > 0)
    ? { pages: excludePages, frames: excludeFrames }
    : null;

  if (!fileKey || !jiraKey) {
    showAlert('modalAlert', 'error', 'Figma URL and Jira ticket URL are required.');
    return;
  }

  // Collect mention rows. Each resolved row has a data-user JSON attribute.
  // Unresolved rows (typed text without selecting from the dropdown) are saved
  // without a jiraAccountId — they will show the ⚠ indicator next time the modal opens.
  const mentionedUsers = [...document.querySelectorAll('#mentionRows .mention-row')]
    .map(row => {
      if (row.dataset.user) {
        try { return JSON.parse(row.dataset.user); } catch { /* fall through */ }
      }
      // No resolved user — save what we have as an unresolved entry
      const text = (row.querySelector('.mention-search') || {}).value || '';
      const trimmed = text.trim();
      if (!trimmed) return null;
      const isEmail = trimmed.includes('@');
      return {
        displayName: isEmail ? trimmed.split('@')[0] : trimmed,
        email: isEmail ? trimmed : null,
        jiraAccountId: null
      };
    })
    .filter(Boolean);

  const projectId = $('modalProjectId').value;

  // Duplicate project validation
  const existingProjects = config.projects || [];
  const duplicate = existingProjects.find(p =>
    p.id !== projectId &&
    p.figmaFileKey.toLowerCase() === fileKey.toLowerCase() &&
    p.jiraIssueKey.toLowerCase() === jiraKey.toLowerCase()
  );
  if (duplicate) {
    showAlert('modalAlert', 'error', 'Project already exists');
    return;
  }

  // Collect per-project channel overrides (null = use global settings)
  const overrideJiraEnabled = $('overrideJiraEnabled').checked;
  const overrideSlackUrl = $('overrideSlackUrl').value.trim();
  const overrideTeamsUrl = $('overrideTeamsUrl').value.trim();
  const hasChannelOverride = overrideJiraEnabled || overrideSlackUrl || overrideTeamsUrl;
  let channelOverride = null;
  if (hasChannelOverride) {
    channelOverride = {};
    if (overrideJiraEnabled) channelOverride.jira = $('overrideJira').checked;
    if (overrideSlackUrl) channelOverride.slackWebhookUrl = overrideSlackUrl;
    if (overrideTeamsUrl) channelOverride.teamsWebhookUrl = overrideTeamsUrl;
  }

  const newProject = {
    id: projectId,
    figmaFileKey: fileKey,
    figmaUrl: figmaUrl || '',
    figmaFileName: fileName || fileKey,
    jiraIssueKey: jiraKey,
    syncComments,
    postFigmaComment,
    exportFormat,
    ...(customSchedule ? { schedule: customSchedule } : {}),
    ...(exclusions ? { exclusions } : {}),
    ...(channelOverride ? { channelOverride } : {}),
    mentionedUsers
  };

  const projects = [...existingProjects];
  const idx = projects.findIndex(p => p.id === projectId);
  if (idx >= 0) projects[idx] = newProject; else projects.push(newProject);

  try {
    await adapter.saveConfig({ ...config, projects });
    await loadConfig();
    closeModal();
  } catch (err) {
    showAlert('modalAlert', 'error', err.message);
  }
});

// ---------------------------------------------------------------------------
// Delete project
// ---------------------------------------------------------------------------
async function deleteProject(projectId) {
  if (!confirm('Remove this project? Its saved Figma snapshot is kept.')) return;
  const projects = (config.projects || []).filter(p => p.id !== projectId);
  try {
    await adapter.saveConfig({ ...config, projects });
    await loadConfig();
  } catch (err) {
    alert('Failed to remove project: ' + err.message);
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function init() {
  adapter = await createAdapter();
  lastRunTime = adapter.getLastRun();
  if (adapter.mode === 'hosted') $('hostedNotice').style.display = 'block';
  await loadConfig();
  setupScheduleTimer();
}

init().catch(err => {
  console.error('Failed to start:', err);
  showRunError(`Failed to start: ${err.message}`);
});
