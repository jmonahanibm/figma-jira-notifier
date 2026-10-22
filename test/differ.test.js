'use strict';

const { diffTrees, flattenTree, trimTree, matchesGlob } = require('../src/differ');
const { syncChangesToFigma } = require('../src/diffRunner');
const treeBefore = require('./fixtures/tree-before.json');
const treeAfter  = require('./fixtures/tree-after.json');

// ---------------------------------------------------------------------------
// flattenTree
// ---------------------------------------------------------------------------
describe('flattenTree', () => {
  test('returns a Map', () => {
    const result = flattenTree(treeBefore);
    expect(result).toBeInstanceOf(Map);
  });

  test('skips DOCUMENT and CANVAS wrapper nodes', () => {
    const result = flattenTree(treeBefore);
    for (const [, { node }] of result) {
      expect(node.type).not.toBe('DOCUMENT');
      expect(node.type).not.toBe('CANVAS');
    }
  });

  test('assigns the correct page name to leaf nodes', () => {
    const result = flattenTree(treeBefore);
    // Node 8:11 lives under the "Final" page
    expect(result.get('8:11').pageName).toBe('Final');
  });

  test('includes frames, instances and text nodes', () => {
    const result = flattenTree(treeBefore);
    const types = new Set([...result.values()].map(v => v.node.type));
    expect(types.has('FRAME')).toBe(true);
    expect(types.has('INSTANCE')).toBe(true);
    expect(types.has('TEXT')).toBe(true);
  });

  test('empty tree returns empty map', () => {
    const emptyDoc = { id: '0:0', type: 'DOCUMENT', name: 'Document', children: [] };
    expect(flattenTree(emptyDoc).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// diffTrees — structural counts
// ---------------------------------------------------------------------------
describe('diffTrees — structural counts', () => {
  let result;

  beforeAll(() => {
    result = diffTrees(treeBefore, treeAfter);
  });

  test('returns added, removed, updated arrays and pages', () => {
    expect(result).toHaveProperty('added');
    expect(result).toHaveProperty('removed');
    expect(result).toHaveProperty('updated');
    expect(result).toHaveProperty('comments');
    expect(result).toHaveProperty('totalChanges');
    expect(result).toHaveProperty('pages');
    expect(Array.isArray(result.added)).toBe(true);
    expect(Array.isArray(result.removed)).toBe(true);
    expect(Array.isArray(result.updated)).toBe(true);
    expect(Array.isArray(result.comments)).toBe(true);
    expect(Array.isArray(result.pages)).toBe(true);
  });

  test('totalChanges equals sum of added + removed + updated + comments', () => {
    const { added, removed, updated, comments, totalChanges } = result;
    expect(totalChanges).toBe(added.length + removed.length + updated.length + comments.length);
  });

  test('pages array contains only non-empty strings', () => {
    for (const page of result.pages) {
      expect(typeof page).toBe('string');
      expect(page.length).toBeGreaterThan(0);
    }
  });

  test('detects the "Final" page as changed', () => {
    expect(result.pages).toContain('Final');
  });

  test('includes comments in totalChanges when provided', () => {
    const mockComments = [
      { id: 'c1', message: 'First comment', user: { handle: 'alice' } },
      { id: 'c2', message: 'Second comment', user: { handle: 'bob' } }
    ];
    const res = diffTrees(treeBefore, treeBefore, mockComments);
    expect(res.comments.length).toBe(2);
    expect(res.totalChanges).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// diffTrees — added nodes
// ---------------------------------------------------------------------------
describe('diffTrees — added nodes', () => {
  let result;

  beforeAll(() => {
    result = diffTrees(treeBefore, treeAfter);
  });

  test('detects nodes present in after but not before as added', () => {
    // IDs 7:30, 7:31, 7:32, 7:33 are new in tree-after
    const addedIds = result.added.map(n => n.id);
    expect(addedIds).toContain('7:30');
    expect(addedIds).toContain('7:31');
    expect(addedIds).toContain('7:32');
    expect(addedIds).toContain('7:33');
  });

  test('added entries include id, name, type, pageName', () => {
    for (const entry of result.added) {
      expect(entry).toHaveProperty('id');
      expect(entry).toHaveProperty('name');
      expect(entry).toHaveProperty('type');
      expect(entry).toHaveProperty('pageName');
    }
  });

  test('added entries do not appear in removed', () => {
    const addedIds = new Set(result.added.map(n => n.id));
    for (const r of result.removed) {
      expect(addedIds.has(r.id)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// diffTrees — removed nodes
// ---------------------------------------------------------------------------
describe('diffTrees — removed nodes', () => {
  let result;

  beforeAll(() => {
    result = diffTrees(treeBefore, treeAfter);
  });

  test('detects nodes in before but not after as removed', () => {
    // IDs 7:23, 7:24, 7:25, 7:26 are gone in tree-after
    const removedIds = result.removed.map(n => n.id);
    expect(removedIds).toContain('7:23');
    expect(removedIds).toContain('7:24');
    expect(removedIds).toContain('7:25');
    expect(removedIds).toContain('7:26');
  });

  test('the Tag content frames (9:14, 9:15, 9:16) are removed', () => {
    const removedIds = result.removed.map(n => n.id);
    expect(removedIds).toContain('9:14');
    expect(removedIds).toContain('9:15');
    expect(removedIds).toContain('9:16');
  });

  test('removed entries include id, name, type, pageName', () => {
    for (const entry of result.removed) {
      expect(entry).toHaveProperty('id');
      expect(entry).toHaveProperty('name');
      expect(entry).toHaveProperty('type');
      expect(entry).toHaveProperty('pageName');
    }
  });
});

// ---------------------------------------------------------------------------
// diffTrees — updated nodes
// ---------------------------------------------------------------------------
describe('diffTrees — updated nodes', () => {
  let result;

  beforeAll(() => {
    result = diffTrees(treeBefore, treeAfter);
  });

  test('detects fill colour change on UI shell nodes (7:27, 7:28)', () => {
    const updated = result.updated;
    const shellNodes = updated.filter(n => n.id === '7:27' || n.id === '7:28');
    expect(shellNodes.length).toBe(2);
    for (const node of shellNodes) {
      const hasFillChange = node.changes.some(c =>
        c.type === 'fill_colour' || c.type === 'fill_token_removed'
      );
      expect(hasFillChange).toBe(true);
    }
  });

  test('detects style reference removed on UI shell nodes (7:27, 7:28)', () => {
    const updated = result.updated;
    const shellNodes = updated.filter(n => n.id === '7:27' || n.id === '7:28');
    for (const node of shellNodes) {
      // fill_token_removed covers "fill colour changed; style reference removed"
      const hasStyleRemoved = node.changes.some(c =>
        c.type === 'fill_token_removed' || c.type === 'fill_colour'
      );
      expect(hasStyleRemoved).toBe(true);
    }
  });

  test('detects text change on Label nodes in Flow with story (Low)', () => {
    const textUpdates = result.updated.filter(n => n.type === 'TEXT');
    expect(textUpdates.length).toBeGreaterThan(0);
    for (const node of textUpdates) {
      const hasTextChange = node.changes.some(c => c.type === 'text_change');
      expect(hasTextChange).toBe(true);
    }
  });

  test('detects Tag - Read-only fill change in Flow with story (Medium)', () => {
    const tagUpdates = result.updated.filter(n => n.name === 'Tag - Read-only');
    expect(tagUpdates.length).toBe(3);
    for (const node of tagUpdates) {
      const hasFill = node.changes.some(c =>
        c.type === 'fill_colour' || c.type === 'fill_token_removed'
      );
      expect(hasFill).toBe(true);
    }
  });

  test('updated entries include id, name, type, pageName, changes array of structured objects', () => {
    for (const entry of result.updated) {
      expect(entry).toHaveProperty('id');
      expect(entry).toHaveProperty('name');
      expect(entry).toHaveProperty('type');
      expect(entry).toHaveProperty('pageName');
      expect(Array.isArray(entry.changes)).toBe(true);
      expect(entry.changes.length).toBeGreaterThan(0);
      // Each change is a structured object with type, label, emoji
      for (const c of entry.changes) {
        expect(c).toHaveProperty('type');
        expect(c).toHaveProperty('label');
        expect(c).toHaveProperty('emoji');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// diffTrees — first run (null old tree)
// ---------------------------------------------------------------------------
describe('diffTrees — first run', () => {
  test('treats all nodes as added when oldTree is null', () => {
    const result = diffTrees(null, treeAfter);
    expect(result.removed.length).toBe(0);
    expect(result.updated.length).toBe(0);
    expect(result.added.length).toBeGreaterThan(0);
    expect(result.totalChanges).toBe(result.added.length);
  });
});

// ---------------------------------------------------------------------------
// diffTrees — identical trees
// ---------------------------------------------------------------------------
describe('diffTrees — no changes', () => {
  test('returns zero totalChanges when both trees are identical and no comments', () => {
    const result = diffTrees(treeBefore, treeBefore);
    expect(result.totalChanges).toBe(0);
    expect(result.added.length).toBe(0);
    expect(result.removed.length).toBe(0);
    expect(result.updated.length).toBe(0);
    expect(result.comments.length).toBe(0);
  });

  test('includes frameId for nodes inside top-level screens', () => {
    const result = diffTrees(treeBefore, treeAfter);
    const withFrameId = result.updated.filter(n => Boolean(n.frameId));
    expect(withFrameId.length).toBeGreaterThan(0);
  });

  test('every frameId in a fixture diff is a top-level screen (direct child of a page, or of a section on a page)', () => {
    const topLevelIds = new Set();
    for (const page of treeAfter.children) {
      for (const child of page.children || []) {
        if (child.type === 'FRAME' || child.type === 'SECTION') topLevelIds.add(child.id);
        if (child.type === 'SECTION') {
          for (const inner of child.children || []) {
            if (inner.type === 'FRAME') topLevelIds.add(inner.id);
          }
        }
      }
    }
    const result = diffTrees(treeBefore, treeAfter);
    for (const entry of [...result.updated, ...result.added]) {
      if (entry.frameId) expect(topLevelIds.has(entry.frameId)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// flattenTree — top-level screen rule (Item 15 / G6)
// ---------------------------------------------------------------------------
function doc(...pages) {
  return { id: '0:0', name: 'Document', type: 'DOCUMENT', children: pages };
}
function page(name, ...children) {
  return { id: `p-${name}`, name, type: 'CANVAS', children };
}

describe('flattenTree — top-level screen rule', () => {
  const nested = doc(page('Final', {
    id: '1:1', name: 'Screen', type: 'FRAME', children: [
      { id: '1:2', name: 'Inner', type: 'FRAME', children: [
        { id: '1:3', name: 'Deep group', type: 'GROUP', children: [
          { id: '1:4', name: 'Label', type: 'TEXT', characters: 'Hi' }
        ] }
      ] }
    ]
  }));

  test('a top-level frame is its own screen', () => {
    const e = flattenTree(nested).get('1:1');
    expect(e.frameName).toBe('Screen');
    expect(e.frameId).toBe('1:1');
  });

  test('a frame nested inside a screen keeps the top-level screen', () => {
    const e = flattenTree(nested).get('1:2');
    expect(e.frameName).toBe('Screen');
    expect(e.frameId).toBe('1:1');
  });

  test('a node nested several levels deep keeps the top-level screen', () => {
    const map = flattenTree(nested);
    expect(map.get('1:3').frameId).toBe('1:1');
    expect(map.get('1:4').frameName).toBe('Screen');
    expect(map.get('1:4').frameId).toBe('1:1');
  });

  const withSection = doc(page('Final', {
    id: '2:1', name: 'Flow section', type: 'SECTION', children: [
      { id: '2:2', name: 'Step one', type: 'FRAME', children: [
        { id: '2:3', name: 'Inner', type: 'FRAME', children: [
          { id: '2:4', name: 'Title', type: 'TEXT', characters: 'One' }
        ] }
      ] },
      { id: '2:5', name: 'Sticky note', type: 'RECTANGLE' }
    ]
  }));

  test('a frame inside a section is a screen', () => {
    const e = flattenTree(withSection).get('2:2');
    expect(e.frameName).toBe('Step one');
    expect(e.frameId).toBe('2:2');
  });

  test('a node nested inside a frame in a section uses that frame, not the section', () => {
    const e = flattenTree(withSection).get('2:4');
    expect(e.frameName).toBe('Step one');
    expect(e.frameId).toBe('2:2');
  });

  test('a node directly in a section (outside any frame) uses the section as its screen', () => {
    const e = flattenTree(withSection).get('2:5');
    expect(e.frameName).toBe('Flow section');
    expect(e.frameId).toBe('2:1');
  });

  test('a node directly on a page has no screen', () => {
    const map = flattenTree(doc(page('Final', { id: '3:1', name: 'Loose', type: 'RECTANGLE' })));
    expect(map.get('3:1').frameName).toBe('');
    expect(map.get('3:1').frameId).toBe('');
  });

  test('screens do not leak between pages or siblings', () => {
    const map = flattenTree(doc(
      page('A', { id: 'a1', name: 'Screen A', type: 'FRAME', children: [{ id: 'a2', name: 'T', type: 'TEXT' }] }),
      page('B', { id: 'b1', name: 'Screen B', type: 'FRAME', children: [{ id: 'b2', name: 'T', type: 'TEXT' }] })
    ));
    expect(map.get('a2').frameId).toBe('a1');
    expect(map.get('b2').frameId).toBe('b1');
    expect(map.get('b2').pageName).toBe('B');
  });
});

describe('diffTrees — nested changes use the top-level screen', () => {
  const before = doc(page('Final', {
    id: '1:1', name: 'Screen', type: 'FRAME', children: [
      { id: '1:2', name: 'Inner', type: 'FRAME', children: [
        { id: '1:4', name: 'Label', type: 'TEXT', characters: 'Submit' }
      ] }
    ]
  }));
  const after = doc(page('Final', {
    id: '1:1', name: 'Screen', type: 'FRAME', children: [
      { id: '1:2', name: 'Inner', type: 'FRAME', children: [
        { id: '1:4', name: 'Label', type: 'TEXT', characters: 'Continue' },
        { id: '1:5', name: 'New icon', type: 'VECTOR' }
      ] }
    ]
  }));

  test('updated and added entries carry the top-level screen name and id', () => {
    const result = diffTrees(before, after);
    const updated = result.updated.find(n => n.id === '1:4');
    const added = result.added.find(n => n.id === '1:5');
    expect(updated.frameName).toBe('Screen');
    expect(updated.frameId).toBe('1:1');
    expect(added.frameName).toBe('Screen');
    expect(added.frameId).toBe('1:1');
  });

  test('a removed entry takes its screen from the old tree', () => {
    const result = diffTrees(after, before);
    const removed = result.removed.find(n => n.id === '1:5');
    expect(removed.frameName).toBe('Screen');
    expect(removed.frameId).toBe('1:1');
  });
});


// ---------------------------------------------------------------------------
// Item 15 � snapshot trimming and full-depth detection
// ---------------------------------------------------------------------------

describe('trimTree', () => {
  const full = {
    id: '0:0', name: 'Doc', type: 'DOCUMENT',
    children: [{
      id: '0:1', name: 'Page', type: 'CANVAS',
      backgroundColor: { r: 1, g: 1, b: 1, a: 1 },
      children: [{
        id: '1:1', name: 'Screen', type: 'FRAME',
        absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
        constraints: { vertical: 'TOP', horizontal: 'LEFT' },
        fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } }],
        children: [{
          id: '1:2', name: 'Label', type: 'TEXT', characters: 'Hello',
          style: { fontFamily: 'Inter', fontSize: 14 },
          styles: { fill: '9:9' }, visible: false
        }]
      }]
    }]
  };

  test('keeps only the fields the differ reads', () => {
    const text = trimTree(full).children[0].children[0].children[0];
    expect(text).toEqual({
      id: '1:2', name: 'Label', type: 'TEXT', characters: 'Hello',
      styles: { fill: '9:9' }, visible: false
    });
  });

  test('drops layout and other fields at every level', () => {
    const page = trimTree(full).children[0];
    const frame = page.children[0];
    expect(page.backgroundColor).toBeUndefined();
    expect(frame.absoluteBoundingBox).toBeUndefined();
    expect(frame.constraints).toBeUndefined();
    expect(frame.fills).toEqual(full.children[0].children[0].fills);
  });

  test('does not add keys for absent fields', () => {
    const frame = trimTree(full).children[0].children[0];
    expect(Object.keys(frame).sort()).toEqual(['children', 'fills', 'id', 'name', 'type']);
  });

  test('does not mutate the input tree', () => {
    const before = JSON.stringify(full);
    trimTree(full);
    expect(JSON.stringify(full)).toBe(before);
  });

  test('diffing trimmed trees gives the same result as diffing full trees', () => {
    const changed = JSON.parse(JSON.stringify(full));
    changed.children[0].children[0].children[0].characters = 'Goodbye';
    const fromFull = diffTrees(full, changed);
    const fromTrimmed = diffTrees(trimTree(full), trimTree(changed));
    expect(fromTrimmed).toEqual(fromFull);
    expect(fromTrimmed.updated).toHaveLength(1);
  });
});

describe('diffTrees � deeply nested nodes', () => {
  function nest(depth, leaf) {
    let node = leaf;
    for (let i = depth; i >= 1; i--) {
      node = { id: `f:${i}`, name: `Level ${i}`, type: 'FRAME', children: [node] };
    }
    return {
      id: '0:0', type: 'DOCUMENT', name: 'Doc',
      children: [{ id: '0:1', type: 'CANVAS', name: 'Page', children: [node] }]
    };
  }

  test('detects a text change nested 8 levels deep', () => {
    const before = nest(8, { id: 'leaf', name: 'Deep', type: 'TEXT', characters: 'a' });
    const after = nest(8, { id: 'leaf', name: 'Deep', type: 'TEXT', characters: 'b' });
    const result = diffTrees(before, after);
    expect(result.updated).toHaveLength(1);
    expect(result.updated[0]).toMatchObject({ id: 'leaf', frameName: 'Level 1', frameId: 'f:1' });
  });

  test('detects an added node nested 8 levels deep', () => {
    const before = nest(8, { id: 'a', name: 'A', type: 'TEXT', characters: 'x' });
    const after = nest(8, { id: 'a', name: 'A', type: 'TEXT', characters: 'x' });
    after.children[0].children[0].children[0].children[0].children[0].children[0].children[0].children[0].children.push(
      { id: 'b', name: 'B', type: 'TEXT', characters: 'y' }
    );
    const result = diffTrees(before, after);
    expect(result.added.map(e => e.id)).toEqual(['b']);
    expect(result.added[0].frameId).toBe('f:1');
  });

  test('every diff entry carries id, name, type, pageName, frameName and frameId', () => {
    const before = nest(4, { id: 'gone', name: 'Gone', type: 'TEXT', characters: 'x' });
    const after = nest(4, { id: 'new', name: 'New', type: 'TEXT', characters: 'x' });
    const result = diffTrees(before, after);
    for (const entry of [...result.added, ...result.removed]) {
      expect(entry).toEqual(expect.objectContaining({
        id: expect.any(String), name: expect.any(String), type: expect.any(String),
        pageName: 'Page', frameName: 'Level 1', frameId: 'f:1'
      }));
    }
  });
});

// ---------------------------------------------------------------------------
// Item 5 — matchesGlob and exclusion rules
// ---------------------------------------------------------------------------

describe('matchesGlob', () => {
  test('exact match (no wildcard)', () => {
    expect(matchesGlob('Archive', 'Archive')).toBe(true);
    expect(matchesGlob('Archive', 'archive')).toBe(true); // case-insensitive
    expect(matchesGlob('Archive', 'Archivex')).toBe(false);
  });

  test('prefix wildcard: WIP*', () => {
    expect(matchesGlob('WIP*', 'WIP exploration')).toBe(true);
    expect(matchesGlob('WIP*', 'wip2')).toBe(true);
    expect(matchesGlob('WIP*', 'Production')).toBe(false);
    expect(matchesGlob('WIP*', 'WIP')).toBe(true); // empty suffix allowed
  });

  test('suffix wildcard: *graveyard', () => {
    expect(matchesGlob('*graveyard', 'Component graveyard')).toBe(true);
    expect(matchesGlob('*graveyard', 'graveyard')).toBe(true);
    expect(matchesGlob('*graveyard', 'Final')).toBe(false);
  });

  test('surrounding wildcard: *Archive*', () => {
    expect(matchesGlob('*Archive*', 'Old Archive stuff')).toBe(true);
    expect(matchesGlob('*Archive*', 'Archive')).toBe(true);
    expect(matchesGlob('*Archive*', 'Final')).toBe(false);
  });

  test('returns false for empty pattern or value', () => {
    expect(matchesGlob('', 'anything')).toBe(false);
    expect(matchesGlob('WIP*', '')).toBe(false);
  });
});

describe('flattenTree — exclusion rules', () => {
  function makeDoc() {
    return {
      id: '0:0', name: 'Document', type: 'DOCUMENT',
      children: [
        {
          id: 'p1', name: 'Final', type: 'CANVAS',
          children: [{ id: '1:1', name: 'Login Flow', type: 'FRAME', children: [
            { id: '1:2', name: 'Button', type: 'TEXT', characters: 'Submit' }
          ]}]
        },
        {
          id: 'p2', name: 'WIP exploration', type: 'CANVAS',
          children: [{ id: '2:1', name: 'Draft screen', type: 'FRAME', children: [] }]
        },
        {
          id: 'p3', name: 'Archive', type: 'CANVAS',
          children: [{ id: '3:1', name: 'Old stuff', type: 'FRAME', children: [] }]
        }
      ]
    };
  }

  test('no exclusions: all pages and frames are included', () => {
    const result = flattenTree(makeDoc());
    const pages = new Set([...result.values()].map(v => v.pageName));
    expect(pages.has('Final')).toBe(true);
    expect(pages.has('WIP exploration')).toBe(true);
    expect(pages.has('Archive')).toBe(true);
  });

  test('excludes an exact page name', () => {
    const result = flattenTree(makeDoc(), '', '', '', new Map(), false, { pages: ['Archive'], frames: [] });
    const pages = new Set([...result.values()].map(v => v.pageName));
    expect(pages.has('Archive')).toBe(false);
    expect(pages.has('Final')).toBe(true);
  });

  test('excludes pages matching a glob pattern', () => {
    const result = flattenTree(makeDoc(), '', '', '', new Map(), false, { pages: ['WIP*'], frames: [] });
    const pages = new Set([...result.values()].map(v => v.pageName));
    expect(pages.has('WIP exploration')).toBe(false);
    expect(pages.has('Final')).toBe(true);
  });

  test('excludes a top-level frame by name', () => {
    const tree = {
      id: '0:0', name: 'Document', type: 'DOCUMENT',
      children: [{
        id: 'p1', name: 'Final', type: 'CANVAS',
        children: [
          { id: '1:1', name: 'Login Flow', type: 'FRAME', children: [{ id: '1:2', name: 'Btn', type: 'TEXT', characters: 'Go' }] },
          { id: '1:3', name: '_annotations', type: 'FRAME', children: [{ id: '1:4', name: 'Note', type: 'TEXT', characters: 'ignore' }] }
        ]
      }]
    };
    const result = flattenTree(tree, '', '', '', new Map(), false, { pages: [], frames: ['_annotations'] });
    const frameNames = new Set([...result.values()].map(v => v.frameName));
    expect(frameNames.has('_annotations')).toBe(false);
    expect(frameNames.has('Login Flow')).toBe(true);
    // _annotations' children must also be excluded
    const ids = [...result.keys()];
    expect(ids).not.toContain('1:3');
    expect(ids).not.toContain('1:4');
  });

  test('excludes frames matching a glob pattern', () => {
    const tree = {
      id: '0:0', name: 'Document', type: 'DOCUMENT',
      children: [{
        id: 'p1', name: 'Final', type: 'CANVAS',
        children: [
          { id: '1:1', name: 'Login Flow', type: 'FRAME', children: [] },
          { id: '1:2', name: 'DO NOT SHIP draft', type: 'FRAME', children: [] }
        ]
      }]
    };
    const result = flattenTree(tree, '', '', '', new Map(), false, { pages: [], frames: ['DO NOT SHIP*'] });
    const ids = [...result.keys()];
    expect(ids).not.toContain('1:2');
    expect(ids).toContain('1:1');
  });
});

describe('diffTrees — exclusions option', () => {
  function makeTree(pageNames) {
    return {
      id: '0:0', name: 'Document', type: 'DOCUMENT',
      children: pageNames.map((name, i) => ({
        id: `p${i}`, name, type: 'CANVAS',
        children: [{ id: `${i}:1`, name: 'Frame', type: 'FRAME', children: [
          { id: `${i}:2`, name: 'Text', type: 'TEXT', characters: 'hello' }
        ]}]
      }))
    };
  }

  test('excluded pages do not appear in diff results', () => {
    const old = makeTree(['Final', 'WIP']);
    const cur = makeTree(['Final', 'WIP']); // change a node on WIP by altering it directly
    cur.children[1].children[0].children[0].characters = 'changed';

    const result = diffTrees(old, cur, {}, { exclusions: { pages: ['WIP'], frames: [] } });
    const pages = new Set([...result.updated, ...result.added, ...result.removed].map(e => e.pageName));
    expect(pages.has('WIP')).toBe(false);
    expect(result.totalChanges).toBe(0); // no non-excluded changes
  });
});
