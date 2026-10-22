'use strict';

/**
 * Webhook notification senders for Slack and Microsoft Teams.
 *
 * Both functions post a plain-text/markdown message to an incoming webhook URL.
 * They are the only functions in this codebase that import axios — kept here
 * so the pure pipeline and message-builder modules stay I/O-free.
 */

const axios = require('axios');

/**
 * Posts a markdown message to a Slack incoming webhook.
 *
 * Slack accepts `{ text: "..." }` for plain mrkdwn; links render as-is.
 *
 * @param {string} webhookUrl  Slack incoming webhook URL
 * @param {string} text        Markdown/mrkdwn message text
 * @returns {Promise<void>}
 */
async function notifySlack(webhookUrl, text) {
  if (!webhookUrl) throw new Error('Slack webhook URL is required');
  try {
    const res = await axios.post(webhookUrl, { text }, {
      headers: { 'Content-Type': 'application/json' }
    });
    if (res.status !== 200) {
      throw new Error(`Slack webhook returned ${res.status}: ${res.data}`);
    }
  } catch (err) {
    const status = err.response ? err.response.status : 'network error';
    throw new Error(`Slack notification failed (${status}): ${err.message}`);
  }
}

/**
 * Posts a markdown message to a Microsoft Teams incoming webhook.
 *
 * Teams accepts `{ text: "..." }` for plain text. For v2 we use plain markdown
 * to avoid Adaptive Card complexity (per spec constraint).
 *
 * @param {string} webhookUrl  Teams incoming webhook URL
 * @param {string} text        Markdown message text
 * @returns {Promise<void>}
 */
async function notifyTeams(webhookUrl, text) {
  if (!webhookUrl) throw new Error('Teams webhook URL is required');
  try {
    const res = await axios.post(webhookUrl, { text }, {
      headers: { 'Content-Type': 'application/json' }
    });
    // Teams webhooks return 200 with body "1" on success
    if (res.status !== 200) {
      throw new Error(`Teams webhook returned ${res.status}: ${res.data}`);
    }
  } catch (err) {
    const status = err.response ? err.response.status : 'network error';
    throw new Error(`Teams notification failed (${status}): ${err.message}`);
  }
}

module.exports = { notifySlack, notifyTeams };
