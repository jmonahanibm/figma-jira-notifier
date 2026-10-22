'use strict';

/**
 * scheduler.test.js
 *
 * Tests Item 8:
 * - Scheduler handles global schedule
 * - Scheduler handles per-project schedule overrides
 * - Multiple projects with different schedules create separate cron tasks
 * - Reschedule and stopAll cleanup
 */

const cron = require('node-cron');
const scheduler = require('../src/scheduler');
const configStore = require('../src/configStore');

jest.mock('node-cron', () => ({
  validate: jest.fn(str => typeof str === 'string' && str.trim().split(/\s+/).length === 5),
  schedule: jest.fn((expr, fn) => ({
    expr,
    fn,
    destroy: jest.fn()
  }))
}));

jest.mock('../src/configStore', () => ({
  getConfig: jest.fn()
}));

jest.mock('../src/diffRunner', () => ({
  runAllProjects: jest.fn(),
  runProject: jest.fn()
}));

describe('Item 8 — Scheduler with Per-Project Schedule Overrides', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    scheduler.stopAll();
  });

  test('creates a single task for global schedule when no projects have custom schedules', () => {
    configStore.getConfig.mockReturnValue({
      schedule: '0 8 * * *',
      projects: [
        { id: 'p1', fileName: 'Project 1' },
        { id: 'p2', fileName: 'Project 2' }
      ]
    });

    scheduler.start();

    expect(cron.schedule).toHaveBeenCalledTimes(1);
    expect(cron.schedule).toHaveBeenCalledWith('0 8 * * *', expect.any(Function));
  });

  test('creates multiple tasks when projects have different custom schedules', () => {
    configStore.getConfig.mockReturnValue({
      schedule: '0 8 * * *',
      projects: [
        { id: 'p1', fileName: 'Daily project' }, // uses global 0 8 * * *
        { id: 'p2', fileName: 'Weekly project', schedule: '0 9 * * 1' }, // custom weekly
        { id: 'p3', fileName: 'Hourly project', schedule: '0 * * * *' } // custom hourly
      ]
    });

    scheduler.start();

    // 3 distinct schedules: '0 8 * * *', '0 9 * * 1', '0 * * * *'
    expect(cron.schedule).toHaveBeenCalledTimes(3);
    const scheduledExpressions = cron.schedule.mock.calls.map(c => c[0]);
    expect(scheduledExpressions).toContain('0 8 * * *');
    expect(scheduledExpressions).toContain('0 9 * * 1');
    expect(scheduledExpressions).toContain('0 * * * *');
  });

  test('groups projects with identical custom schedules into one cron task', () => {
    configStore.getConfig.mockReturnValue({
      schedule: '0 8 * * *',
      projects: [
        { id: 'p1', schedule: '0 12 * * *' },
        { id: 'p2', schedule: '0 12 * * *' }
      ]
    });

    scheduler.start();

    expect(cron.schedule).toHaveBeenCalledTimes(1);
    expect(cron.schedule).toHaveBeenCalledWith('0 12 * * *', expect.any(Function));
  });

  test('falls back to global schedule when project custom schedule is invalid', () => {
    configStore.getConfig.mockReturnValue({
      schedule: '0 8 * * *',
      projects: [
        { id: 'p1', schedule: 'invalid cron' }
      ]
    });

    scheduler.start();

    expect(cron.schedule).toHaveBeenCalledTimes(1);
    expect(cron.schedule).toHaveBeenCalledWith('0 8 * * *', expect.any(Function));
  });

  test('reschedule destroys old tasks and restarts with updated config', () => {
    configStore.getConfig.mockReturnValue({
      schedule: '0 8 * * *',
      projects: [{ id: 'p1' }]
    });

    scheduler.start();
    expect(cron.schedule).toHaveBeenCalledTimes(1);

    configStore.getConfig.mockReturnValue({
      schedule: '0 18 * * *',
      projects: [{ id: 'p1' }]
    });

    scheduler.reschedule('0 18 * * *');
    expect(cron.schedule).toHaveBeenCalledTimes(2);
  });
});
