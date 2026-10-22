'use strict';

/**
 * Builds desktop-app and browser links to a node in a Figma file.
 *
 *   app:     figma://file/<fileKey>/<fileName>?node-id=<a>-<b>
 *   browser: https://www.figma.com/design/<fileKey>/<fileName>?node-id=<a>-<b>
 *
 * The API's colon node id (`1:86`) is converted to the hyphen form (`1-86`).
 * The file name has whitespace replaced by hyphens and is URL-encoded.
 * Pure function — safe to use from the server, the browser and every channel.
 *
 * @param {string} fileKey
 * @param {string} fileName
 * @param {string} nodeId
 * @returns {{ app: string, browser: string }}
 */
function buildNodeLinks(fileKey, fileName, nodeId) {
  if (!fileKey) return { app: '', browser: '' };

  const namePart = fileName && fileName.trim()
    ? `/${encodeURIComponent(fileName.trim().replace(/\s+/g, '-'))}`
    : '';
  const query = nodeId ? `?node-id=${encodeURIComponent(nodeId.replace(/:/g, '-'))}` : '';

  return {
    app: `figma://file/${fileKey}${namePart}${query}`,
    browser: `https://www.figma.com/design/${fileKey}${namePart}${query}`
  };
}

module.exports = { buildNodeLinks };
