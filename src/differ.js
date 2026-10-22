'use strict';

/**
 * Matches a value against a glob pattern.
 * Supports `*` wildcards (any sequence of characters, including none).
 * Case-insensitive.
 *
 * @param {string} pattern  e.g. "WIP*", "Archive", "*graveyard*", "*Archive*"
 * @param {string} value
 * @returns {boolean}
 */
function matchesGlob(pattern, value) {
  if (!pattern || !value) return false;
  // Escape regex metacharacters except *, then replace * with .*
  const regexStr = pattern
    .toLowerCase()
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${regexStr}$`).test(value.toLowerCase());
}

/**
 * Returns true if any pattern in the list matches the value.
 * @param {string[]} patterns
 * @param {string}   value
 * @returns {boolean}
 */
function matchesAny(patterns, value) {
  if (!Array.isArray(patterns) || patterns.length === 0) return false;
  return patterns.some(p => matchesGlob(p, value));
}

/**
 * Node types worth tracking in the diff.
 * DOCUMENT and CANVAS are structural wrappers — skip them.
 */
const TRACKED_TYPES = new Set([
  'FRAME', 'GROUP', 'COMPONENT', 'COMPONENT_SET',
  'INSTANCE', 'TEXT', 'RECTANGLE', 'ELLIPSE',
  'VECTOR', 'BOOLEAN_OPERATION', 'SECTION'
]);

/** Node fields the differ reads. `children` is handled separately by trimTree. */
const TRIMMED_FIELDS = ['id', 'name', 'type', 'characters', 'fills', 'styles', 'visible'];

/**
 * Recursively flattens a Figma document tree into a Map keyed by node id.
 * Each entry carries the node, its containing page name, and the name and id
 * of its top-level screen (the outermost FRAME/SECTION on the page; a FRAME
 * directly inside a top-level SECTION is its own screen).
 *
 * @param {object}  node        Current Figma node
 * @param {string}  pageName    Name of the top-level CANVAS ancestor
 * @param {string}  frameName   Name of the screen the node sits in
 * @param {string}  frameId     Id of the screen the node sits in
 * @param {Map}     result      Accumulator map
 * @param {boolean} parentIsScreenSection  True when the parent is a top-level SECTION
 * @param {object}  [exclusions]  Optional { pages: string[], frames: string[] } from project config
 * @returns {Map<string, {node: object, pageName: string, frameName: string, frameId: string}>}
 */
function flattenTree(node, pageName = '', frameName = '', frameId = '', result = new Map(), parentIsScreenSection = false, exclusions = null) {
  const currentPage = node.type === 'CANVAS' ? node.name : pageName;

  // Exclusion: skip entire pages matching a pattern
  if (node.type === 'CANVAS' && exclusions && matchesAny(exclusions.pages, node.name)) {
    return result;
  }

  // Screen rule (G6 / Item 15): the screen is the outermost FRAME/SECTION on a page.
  // All descendants inherit it; inner FRAMEs/SECTIONs do NOT reset it.
  // Exception: a FRAME that is a direct child of a top-level SECTION is its own
  // screen (a section is a container of screens).
  const isTopLevelScreen =
    (node.type === 'FRAME' || node.type === 'SECTION') &&
    pageName !== '' &&
    frameName === '';
  const isFrameInSection = node.type === 'FRAME' && parentIsScreenSection;
  const becomesScreen = isTopLevelScreen || isFrameInSection;
  const currentFrame = becomesScreen ? node.name : frameName;
  const currentFrameId = becomesScreen ? node.id : frameId;

  // Exclusion: skip top-level frames matching a pattern
  if (becomesScreen && exclusions && matchesAny(exclusions.frames, node.name)) {
    return result;
  }

  if (TRACKED_TYPES.has(node.type)) {
    result.set(node.id, { node, pageName: currentPage, frameName: currentFrame, frameId: currentFrameId });
  }

  if (Array.isArray(node.children)) {
    const childrenOfScreenSection = isTopLevelScreen && node.type === 'SECTION';
    for (const child of node.children) {
      flattenTree(child, currentPage, currentFrame, currentFrameId, result, childrenOfScreenSection, exclusions);
    }
  }

  return result;
}

/**
 * Reduces a Figma document tree to the fields the differ reads, so stored
 * snapshots stay small. Applies recursively; fields that are absent on a
 * node are omitted (not set to undefined).
 *
 * @param {object} node
 * @returns {object}
 */
function trimTree(node) {
  const trimmed = {};
  for (const key of TRIMMED_FIELDS) {
    if (node[key] !== undefined) trimmed[key] = node[key];
  }
  if (Array.isArray(node.children)) {
    trimmed.children = node.children.map(trimTree);
  }
  return trimmed;
}

/**
 * Compares two fill arrays and returns true if they differ meaningfully.
 * @param {Array} a
 * @param {Array} b
 * @returns {boolean}
 */
function fillsChanged(a, b) {
  return JSON.stringify(a) !== JSON.stringify(b);
}

/**
 * Compares two style reference objects and returns true if they differ.
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
function stylesChanged(a, b) {
  return JSON.stringify(a) !== JSON.stringify(b);
}

/**
 * Produces a structured array of change descriptions for a node that exists
 * in both old and new trees.
 *
 * Each entry: { type: string, label: string, emoji: string, oldValue?, newValue? }
 *
 * type values:
 *   text_change | rename | visibility | fill_colour | fill_token_removed |
 *   token_added | token_removed | token_changed
 *
 * @param {object} oldNode
 * @param {object} newNode
 * @returns {Array<{type: string, label: string, emoji: string, oldValue?: string, newValue?: string}>}
 */
function describeChanges(oldNode, newNode) {
  const changes = [];

  // Text content
  if (oldNode.characters !== newNode.characters) {
    changes.push({
      type: 'text_change',
      emoji: '✏️',
      label: `Copy changed from "${oldNode.characters || '(empty)'}" to "${newNode.characters || '(empty)'}"`,
      oldValue: oldNode.characters || '(empty)',
      newValue: newNode.characters || '(empty)'
    });
  }

  // Name
  if (oldNode.name !== newNode.name) {
    changes.push({
      type: 'rename',
      emoji: '🔄',
      label: `Renamed from "${oldNode.name}" to "${newNode.name}"`,
      oldValue: oldNode.name,
      newValue: newNode.name
    });
  }

  // Visibility
  if (oldNode.visible !== newNode.visible) {
    const hidden = newNode.visible === false;
    changes.push({
      type: 'visibility',
      emoji: '👁️',
      label: hidden ? 'Hidden' : 'Made visible'
    });
  }

  // Fill colour
  if (fillsChanged(oldNode.fills, newNode.fills)) {
    const hadStyle = oldNode.styles && oldNode.styles.fill;
    const hasStyle = newNode.styles && newNode.styles.fill;
    if (hadStyle && !hasStyle) {
      changes.push({
        type: 'fill_token_removed',
        emoji: '🎨',
        label: 'Colour updated and design token link removed (colour is now hardcoded)'
      });
    } else {
      changes.push({
        type: 'fill_colour',
        emoji: '🎨',
        label: 'Background / fill colour updated'
      });
    }
  }

  // Style references (excluding fill already handled above)
  if (stylesChanged(oldNode.styles, newNode.styles)) {
    const hadFillStyle = oldNode.styles && oldNode.styles.fill;
    const hasFillStyle = newNode.styles && newNode.styles.fill;
    // Only report if this is about non-fill styles, or fill style changed independently
    if (!fillsChanged(oldNode.fills, newNode.fills)) {
      if (hadFillStyle && !hasFillStyle) {
        changes.push({ type: 'token_removed', emoji: '🎨', label: 'Design token link removed' });
      } else if (!hadFillStyle && hasFillStyle) {
        changes.push({ type: 'token_added', emoji: '🎨', label: 'Design token applied' });
      } else if (JSON.stringify(oldNode.styles) !== JSON.stringify(newNode.styles)) {
        changes.push({ type: 'token_changed', emoji: '🎨', label: 'Design token changed' });
      }
    }
  }

  return changes;
}

/**
 * Diffs two Figma document trees and comments, returning a structured changelog.
 *
 * @param {object|null} oldTree  Previous snapshot's document node (null = first run)
 * @param {object}      newTree  Current document node from Figma API
 * @param {object|Array} [commentsDiff={}] Object with { newComments, resolvedComments, openComments } or Array of comments
 * @returns {{
 *   added: Array,
 *   removed: Array,
 *   updated: Array,
 *   commentsDiff: { newComments: Array, resolvedComments: Array, openComments: Array },
 *   commentsCount: number,
 *   totalChanges: number,
 *   pages: string[]
 * }}
 */
/**
 * @param {object|null} oldTree
 * @param {object}      newTree
 * @param {object|Array} [commentsDiff={}]
 * @param {object}       [options={}]  Optional { exclusions: { pages, frames } }
 */
function diffTrees(oldTree, newTree, commentsDiff = {}, options = {}) {
  const exclusions = options.exclusions || null;
  const newMap = flattenTree(newTree, '', '', '', new Map(), false, exclusions);
  const oldMap = oldTree ? flattenTree(oldTree, '', '', '', new Map(), false, exclusions) : new Map();

  const added = [];
  const removed = [];
  const updated = [];
  const pageSet = new Set();

  // Find added and updated nodes
  for (const [id, { node: newNode, pageName, frameName, frameId }] of newMap) {
    if (!oldMap.has(id)) {
      added.push({ id, name: newNode.name, type: newNode.type, pageName, frameName, frameId });
      pageSet.add(pageName);
    } else {
      const { node: oldNode } = oldMap.get(id);
      const changes = describeChanges(oldNode, newNode);
      if (changes.length > 0) {
        updated.push({ id, name: newNode.name, type: newNode.type, pageName, frameName, frameId, changes });
        pageSet.add(pageName);
      }
    }
  }

  // Find removed nodes
  for (const [id, { node: oldNode, pageName, frameName, frameId }] of oldMap) {
    if (!newMap.has(id)) {
      removed.push({ id, name: oldNode.name, type: oldNode.type, pageName, frameName, frameId });
      pageSet.add(pageName);
    }
  }

  let formattedCommentsDiff = { newComments: [], resolvedComments: [], openComments: [] };
  if (Array.isArray(commentsDiff)) {
    formattedCommentsDiff.newComments = commentsDiff;
  } else if (commentsDiff && typeof commentsDiff === 'object') {
    formattedCommentsDiff = {
      newComments: Array.isArray(commentsDiff.newComments) ? commentsDiff.newComments : [],
      resolvedComments: Array.isArray(commentsDiff.resolvedComments) ? commentsDiff.resolvedComments : [],
      openComments: Array.isArray(commentsDiff.openComments) ? commentsDiff.openComments : []
    };
  }

  // Count new comments and newly resolved comments towards changes
  const commentsCount = formattedCommentsDiff.newComments.length + formattedCommentsDiff.resolvedComments.length;
  const totalChanges = added.length + removed.length + updated.length + commentsCount;

  return {
    added,
    removed,
    updated,
    commentsDiff: formattedCommentsDiff,
    // Keep backwards-compatible comments array pointing to newComments
    comments: formattedCommentsDiff.newComments,
    commentsCount,
    totalChanges,
    pages: [...pageSet].filter(Boolean)
  };
}

module.exports = { diffTrees, flattenTree, trimTree, matchesGlob };
