'use strict';

/**
 * Item 7 — Slack / Teams Notification
 *
 * Tests for:
 *   src/notifier.js           — notifySlack, notifyTeams
 *   src/messageFormatter.js   — buildSlackMessage, buildTeamsMessage, buildMentionsLine
 */

const { notifySlack, notifyTeams } = require('../src/notifier');
const { buildSlackMessage, buildTeamsMessage, buildMentionsLine } = require('../src/messageFormatter');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DIFF_RESULT = {
  totalChanges: 2,
  updated: [
    {
      id: '1:2', name: 'Button', type: 'RECTANGLE',
      pageName: 'Final', frameName: 'Screen',
      frameId: '1:1',
      changes: [{ type: 'fill', emoji: '🎨', label: 'Fill changed' }]
    }
  ],
  added: [
    { id: '1:3', name: 'Icon', type: 'VECTOR', pageName: 'Final', frameName: 'Screen', frameId: '1:1', changes: [] }
  ],
  removed: [],
  newComments: [],
  resolvedComments: [],
  openComments: []
};

const FILE_KEY = 'ABC123';
const FILE_NAME = 'My Design';
const RUN_AT = '2025-06-01T09:00:00.000Z';
const JIRA_KEY = 'PROJ-42';

// ---------------------------------------------------------------------------
// buildMentionsLine
// ---------------------------------------------------------------------------

describe('buildMentionsLine', () => {
  test('returns empty string for empty array', () => {
    expect(buildMentionsLine([])).toBe('');
  });

  test('returns empty string for null/undefined', () => {
    expect(buildMentionsLine(null)).toBe('');
    expect(buildMentionsLine(undefined)).toBe('');
  });

  test('handles object users with displayName', () => {
    const result = buildMentionsLine([
      { displayName: 'Alice Dev', jiraAccountId: 'abc123', email: 'alice@example.com' },
      { displayName: 'Bob', jiraAccountId: 'def456', email: null }
    ]);
    expect(result).toBe('Notifying: @Alice Dev, @Bob');
  });

  test('falls back to email local part when no displayName', () => {
    const result = buildMentionsLine([{ email: 'carol@example.com', jiraAccountId: 'xyz' }]);
    expect(result).toBe('Notifying: @carol');
  });

  test('handles plain-string users (email)', () => {
    const result = buildMentionsLine(['alice@example.com']);
    expect(result).toBe('Notifying: @alice');
  });

  test('handles plain-string users (non-email)', () => {
    const result = buildMentionsLine(['AliceD']);
    expect(result).toBe('Notifying: @AliceD');
  });
});

// ---------------------------------------------------------------------------
// buildSlackMessage / buildTeamsMessage
// ---------------------------------------------------------------------------

describe('buildSlackMessage', () => {
  test('returns a non-empty string', () => {
    const msg = buildSlackMessage(DIFF_RESULT, FILE_KEY, FILE_NAME, RUN_AT, JIRA_KEY, []);
    expect(typeof msg).toBe('string');
    expect(msg.length).toBeGreaterThan(0);
  });

  test('includes the Jira issue key', () => {
    const msg = buildSlackMessage(DIFF_RESULT, FILE_KEY, FILE_NAME, RUN_AT, JIRA_KEY, []);
    expect(msg).toContain(JIRA_KEY);
  });

  test('includes the file name', () => {
    const msg = buildSlackMessage(DIFF_RESULT, FILE_KEY, FILE_NAME, RUN_AT, JIRA_KEY, []);
    expect(msg).toContain(FILE_NAME);
  });

  test('appends mentions footer when users provided', () => {
    const users = [{ displayName: 'Alice', jiraAccountId: 'abc', email: null }];
    const msg = buildSlackMessage(DIFF_RESULT, FILE_KEY, FILE_NAME, RUN_AT, JIRA_KEY, users);
    expect(msg).toContain('Notifying: @Alice');
  });

  test('no mentions footer when no users', () => {
    const msg = buildSlackMessage(DIFF_RESULT, FILE_KEY, FILE_NAME, RUN_AT, JIRA_KEY, []);
    expect(msg).not.toContain('Notifying:');
  });

  test('deepLinkTarget=browser omits figma:// links', () => {
    const msg = buildSlackMessage(DIFF_RESULT, FILE_KEY, FILE_NAME, RUN_AT, JIRA_KEY, [], 'browser');
    expect(msg).not.toContain('figma://');
  });

  test('deepLinkTarget=app includes figma:// links', () => {
    const msg = buildSlackMessage(DIFF_RESULT, FILE_KEY, FILE_NAME, RUN_AT, JIRA_KEY, [], 'app');
    expect(msg).toContain('figma://');
  });
});

describe('buildTeamsMessage', () => {
  test('returns same content as buildSlackMessage for same inputs', () => {
    const users = [{ displayName: 'Bob', jiraAccountId: 'bbb', email: null }];
    const slack = buildSlackMessage(DIFF_RESULT, FILE_KEY, FILE_NAME, RUN_AT, JIRA_KEY, users, 'both');
    const teams = buildTeamsMessage(DIFF_RESULT, FILE_KEY, FILE_NAME, RUN_AT, JIRA_KEY, users, 'both');
    expect(slack).toBe(teams);
  });
});

// ---------------------------------------------------------------------------
// notifySlack
// ---------------------------------------------------------------------------

describe('notifySlack', () => {
  test('throws when webhookUrl is empty', async () => {
    await expect(notifySlack('', 'hello')).rejects.toThrow('Slack webhook URL is required');
  });

  test('POSTs { text } to the webhook URL', async () => {
    const mockPost = jest.fn().mockResolvedValue({ status: 200, data: 'ok' });
    // Patch axios on the module
    const axios = require('axios');
    const original = axios.post;
    axios.post = mockPost;

    try {
      await notifySlack('https://hooks.slack.com/test', 'hello world');
      expect(mockPost).toHaveBeenCalledWith(
        'https://hooks.slack.com/test',
        { text: 'hello world' },
        expect.objectContaining({ headers: expect.objectContaining({ 'Content-Type': 'application/json' }) })
      );
    } finally {
      axios.post = original;
    }
  });

  test('throws a descriptive error on non-200 response', async () => {
    const axios = require('axios');
    const original = axios.post;
    axios.post = jest.fn().mockResolvedValue({ status: 400, data: 'bad_payload' });
    try {
      await expect(notifySlack('https://hooks.slack.com/test', 'x')).rejects.toThrow(/Slack webhook returned 400/);
    } finally {
      axios.post = original;
    }
  });

  test('wraps network errors with descriptive message', async () => {
    const axios = require('axios');
    const original = axios.post;
    axios.post = jest.fn().mockRejectedValue(Object.assign(new Error('ECONNREFUSED'), { response: undefined }));
    try {
      await expect(notifySlack('https://hooks.slack.com/test', 'x')).rejects.toThrow(/Slack notification failed \(network error\)/);
    } finally {
      axios.post = original;
    }
  });
});

// ---------------------------------------------------------------------------
// notifyTeams
// ---------------------------------------------------------------------------

describe('notifyTeams', () => {
  test('throws when webhookUrl is empty', async () => {
    await expect(notifyTeams('', 'hello')).rejects.toThrow('Teams webhook URL is required');
  });

  test('POSTs { text } to the webhook URL', async () => {
    const axios = require('axios');
    const original = axios.post;
    axios.post = jest.fn().mockResolvedValue({ status: 200, data: '1' });
    try {
      await notifyTeams('https://outlook.office.com/webhook/test', 'hello teams');
      expect(axios.post).toHaveBeenCalledWith(
        'https://outlook.office.com/webhook/test',
        { text: 'hello teams' },
        expect.objectContaining({ headers: expect.objectContaining({ 'Content-Type': 'application/json' }) })
      );
    } finally {
      axios.post = original;
    }
  });

  test('wraps network errors with descriptive message', async () => {
    const axios = require('axios');
    const original = axios.post;
    axios.post = jest.fn().mockRejectedValue(Object.assign(new Error('timeout'), { response: undefined }));
    try {
      await expect(notifyTeams('https://outlook.office.com/webhook/test', 'x')).rejects.toThrow(/Teams notification failed \(network error\)/);
    } finally {
      axios.post = original;
    }
  });
});
