'use strict';

const axios = require('axios');

const BASE_URL = 'https://api.figma.com';

/**
 * Fetches the full document tree for a Figma file.
 * @param {string} fileKey
 * @param {string} token  Figma personal access token
 * @returns {Promise<object>} The `document` node
 */
async function fetchFileTree(fileKey, token) {
  try {
    const response = await axios.get(`${BASE_URL}/v1/files/${fileKey}`, {
      headers: { 'X-Figma-Token': token },
      params: { geometry: 'omit' }
    });
    return response.data.document;
  } catch (err) {
    const status = err.response ? err.response.status : 'network error';
    throw new Error(`Figma fetchFileTree failed for key "${fileKey}" — ${status}: ${err.message}`);
  }
}

/**
 * Fetches the version history for a Figma file.
 * @param {string} fileKey
 * @param {string} token  Figma personal access token
 * @returns {Promise<Array>} Array of version objects
 */
async function fetchVersions(fileKey, token) {
  try {
    const response = await axios.get(`${BASE_URL}/v1/files/${fileKey}/versions`, {
      headers: { 'X-Figma-Token': token }
    });
    return response.data.versions;
  } catch (err) {
    const status = err.response ? err.response.status : 'network error';
    throw new Error(`Figma fetchVersions failed for key "${fileKey}" — ${status}: ${err.message}`);
  }
}

/**
 * Fetches all comments on a Figma file.
 * @param {string} fileKey
 * @param {string} token  Figma personal access token
 * @returns {Promise<Array>} Array of comment objects
 */
async function fetchComments(fileKey, token) {
  try {
    const response = await axios.get(`${BASE_URL}/v1/files/${fileKey}/comments`, {
      headers: { 'X-Figma-Token': token }
    });
    return (response.data && response.data.comments) || [];
  } catch (err) {
    const status = err.response ? err.response.status : 'network error';
    throw new Error(`Figma fetchComments failed for key "${fileKey}" — ${status}: ${err.message}`);
  }
}

/**
 * Posts a comment to a Figma file, optionally pinned to a node / canvas location.
 * @param {string} fileKey
 * @param {string} token  Figma personal access token
 * @param {string} message Comment text
 * @param {object} [clientMeta] Optional client_meta e.g. { node_id, node_offset: { x: 0, y: 0 } }
 * @returns {Promise<object>} Created comment object
 */
async function postCommentToFigma(fileKey, token, message, clientMeta = null) {
  try {
    const payload = { message };
    if (clientMeta) {
      payload.client_meta = clientMeta;
    }
    const response = await axios.post(`${BASE_URL}/v1/files/${fileKey}/comments`, payload, {
      headers: {
        'X-Figma-Token': token,
        'Content-Type': 'application/json'
      }
    });
    return response.data;
  } catch (err) {
    const status = err.response ? err.response.status : 'network error';
    throw new Error(`Figma postComment failed for key "${fileKey}" — ${status}: ${err.message}`);
  }
}

module.exports = { fetchFileTree, fetchVersions, fetchComments, postCommentToFigma };
