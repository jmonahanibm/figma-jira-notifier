'use strict';

/**
 * Unit tests for src/figmaClient.js
 *
 * All axios calls are mocked so no network traffic is made.
 */

jest.mock('axios');
const axios = require('axios');

const { fetchFileTree, fetchVersions, fetchComments, postCommentToFigma } = require('../src/figmaClient');

const FILE_KEY = 'AbC123';
const TOKEN = 'figd_test';

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// postCommentToFigma
// ---------------------------------------------------------------------------

describe('postCommentToFigma', () => {
  test('posts to the correct endpoint with the message and token', async () => {
    const created = { id: 'c1', message: 'hello' };
    axios.post.mockResolvedValueOnce({ data: created });

    const result = await postCommentToFigma(FILE_KEY, TOKEN, 'hello');

    expect(axios.post).toHaveBeenCalledWith(
      `https://api.figma.com/v1/files/${FILE_KEY}/comments`,
      { message: 'hello' },
      { headers: { 'X-Figma-Token': TOKEN, 'Content-Type': 'application/json' } }
    );
    expect(result).toEqual(created);
  });

  test('includes client_meta in the payload when provided', async () => {
    axios.post.mockResolvedValueOnce({ data: { id: 'c2' } });
    const meta = { node_id: '1:2', node_offset: { x: 0, y: 0 } };

    await postCommentToFigma(FILE_KEY, TOKEN, 'pinned', meta);

    expect(axios.post).toHaveBeenCalledWith(
      expect.any(String),
      { message: 'pinned', client_meta: meta },
      expect.any(Object)
    );
  });

  test('throws a descriptive error when the API returns a 403', async () => {
    axios.post.mockRejectedValueOnce(Object.assign(new Error('Request failed'), { response: { status: 403 } }));

    await expect(postCommentToFigma(FILE_KEY, TOKEN, 'hi')).rejects.toThrow(
      `Figma postComment failed for key "${FILE_KEY}" — 403`
    );
  });
});

// ---------------------------------------------------------------------------
// fetchFileTree
// ---------------------------------------------------------------------------

describe('fetchFileTree', () => {
  test('returns the document node from the API response', async () => {
    const doc = { id: '0:0', name: 'Document', type: 'DOCUMENT', children: [] };
    axios.get.mockResolvedValueOnce({ data: { document: doc } });

    const result = await fetchFileTree(FILE_KEY, TOKEN);

    expect(axios.get).toHaveBeenCalledWith(
      `https://api.figma.com/v1/files/${FILE_KEY}`,
      expect.objectContaining({ params: { geometry: 'omit' } })
    );
    expect(result).toEqual(doc);
  });

  test('throws a descriptive error on network failure', async () => {
    axios.get.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    await expect(fetchFileTree(FILE_KEY, TOKEN)).rejects.toThrow(
      `Figma fetchFileTree failed for key "${FILE_KEY}"`
    );
  });
});
