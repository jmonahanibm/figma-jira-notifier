'use strict';

const cron = require('node-cron');
const { getConfig } = require('./configStore');
const { runAllProjects, runProject } = require('./diffRunner');

let activeTasks = [];

/**
 * Destroys all active cron tasks.
 */
function stopAll() {
  for (const task of activeTasks) {
    try { task.destroy(); } catch { /* ignore */ }
  }
  activeTasks = [];
}

/**
 * Starts the cron scheduler using schedules from config.
 * Supports global schedule and per-project schedule overrides (Item 8).
 * If tasks are already running, they are stopped and re-initialized.
 */
function start() {
  stopAll();

  const config = getConfig();
  const globalSchedule = config.schedule || '0 8 * * *';
  const projects = config.projects || [];

  if (projects.length === 0) {
    if (!cron.validate(globalSchedule)) {
      console.warn(`[Scheduler] Invalid global cron expression "${globalSchedule}" — scheduler not started.`);
      return;
    }
    const task = cron.schedule(globalSchedule, async () => {
      console.log(`[Scheduler] Global cron triggered at ${new Date().toISOString()}`);
      await runAllProjects();
    });
    activeTasks.push(task);
    console.log(`[Scheduler] Started with global schedule: "${globalSchedule}" (0 projects)`);
    return;
  }

  // Group projects by their effective schedule (custom project schedule or global schedule)
  const scheduleGroups = new Map();

  for (const project of projects) {
    let effectiveSchedule = globalSchedule;
    if (project.schedule && typeof project.schedule === 'string' && project.schedule.trim()) {
      const custom = project.schedule.trim();
      if (cron.validate(custom)) {
        effectiveSchedule = custom;
      } else {
        console.warn(`[Scheduler] Invalid custom cron expression "${custom}" for project "${project.fileName || project.id}" — falling back to global schedule.`);
      }
    }

    if (!scheduleGroups.has(effectiveSchedule)) {
      scheduleGroups.set(effectiveSchedule, []);
    }
    scheduleGroups.get(effectiveSchedule).push(project);
  }

  // Create cron task for each unique schedule
  for (const [schedExpr, group] of scheduleGroups.entries()) {
    if (!cron.validate(schedExpr)) {
      console.warn(`[Scheduler] Skipping invalid cron expression: "${schedExpr}"`);
      continue;
    }

    const task = cron.schedule(schedExpr, async () => {
      console.log(`[Scheduler] Cron triggered for schedule "${schedExpr}" (${group.length} project(s)) at ${new Date().toISOString()}`);
      const currentConfig = getConfig();
      for (const proj of group) {
        try {
          await runProject(proj, currentConfig);
        } catch (err) {
          console.error(`[Scheduler] Error running project "${proj.fileName || proj.id}": ${err.message}`);
        }
      }
    });

    activeTasks.push(task);
    console.log(`[Scheduler] Scheduled ${group.length} project(s) on cadence: "${schedExpr}"`);
  }
}

/**
 * Replaces running cron tasks with updated schedules.
 * Called when config or schedules are modified.
 * @param {string} [newGlobalSchedule]
 */
function reschedule(newGlobalSchedule) {
  if (newGlobalSchedule && !cron.validate(newGlobalSchedule)) {
    throw new Error(`Invalid cron expression: "${newGlobalSchedule}"`);
  }
  start();
  console.log(`[Scheduler] Rescheduled all tasks.`);
}

module.exports = { start, reschedule, stopAll };
