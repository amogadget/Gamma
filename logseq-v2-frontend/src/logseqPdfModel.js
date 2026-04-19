// Logseq-style block model: each block has id, content, properties, children.
// Highlights are blocks with properties.highlight_id set.
// Free notes are blocks without properties.highlight_id.

const DEFAULT_COLOR = "rgba(255, 226, 143, 0.65)";

export function makeBlockId() {
  return Math.random().toString(36).slice(2, 10);
}

// --- shape helpers ---

export function isHighlightBlock(b) {
  return Boolean(b && b.properties && b.properties.highlight_id);
}

export function blockColor(b) {
  return (b?.properties?.color) || DEFAULT_COLOR;
}

export function blockPage(b) {
  return b?.properties?.pdf_page ?? null;
}

export function blockQuote(b) {
  return b?.properties?.quote || "";
}

export function blockHighlightId(b) {
  return b?.properties?.highlight_id || null;
}

export function blockPosition(b) {
  return b?.properties?.pdf_position || null;
}

// Backwards-compat accessor view: let old code that reads b.color, b.quote, b.page, b.highlightId, b.position
// keep working without changes. Attaches convenience getters.
export function withLegacyAccessors(b) {
  return {
    ...b,
    color: blockColor(b),
    quote: blockQuote(b),
    page: blockPage(b),
    highlightId: blockHighlightId(b),
    position: blockPosition(b),
  };
}

// --- tree operations (same API as before) ---

export function cloneBlocks(blocks) {
  return JSON.parse(JSON.stringify(blocks || []));
}

export function findBlock(blocks, id) {
  for (const b of blocks) {
    if (b.id === id) return b;
    const x = findBlock(b.children || [], id);
    if (x) return x;
  }
  return null;
}

export function updateBlockTree(blocks, id, fn) {
  return (blocks || []).map((b) => {
    if (b.id === id) {
      return fn({ ...b, children: cloneBlocks(b.children || []) });
    }
    return {
      ...b,
      children: updateBlockTree(b.children || [], id, fn)
    };
  });
}

export function removeBlockTree(blocks, id) {
  const out = [];
  for (const b of blocks || []) {
    if (b.id === id) continue;
    out.push({
      ...b,
      children: removeBlockTree(b.children || [], id)
    });
  }
  return out;
}

export function insertSiblingAfter(blocks, id, newBlock) {
  const out = [];
  for (const b of blocks || []) {
    if (b.id === id) {
      out.push(b);
      out.push(newBlock);
    } else {
      out.push({
        ...b,
        children: insertSiblingAfter(b.children || [], id, newBlock)
      });
    }
  }
  return out;
}

export function appendChild(blocks, id, newBlock) {
  return (blocks || []).map((b) => {
    if (b.id === id) {
      return {
        ...b,
        children: [...(b.children || []), newBlock],
        collapsed: false
      };
    }
    return {
      ...b,
      children: appendChild(b.children || [], id, newBlock)
    };
  });
}

export function flattenBlocks(blocks, depth = 0, parentId = null) {
  const out = [];
  for (const b of blocks || []) {
    out.push(withLegacyAccessors({ ...b, depth, parentId }));
    if (!b.collapsed) {
      out.push(...flattenBlocks(b.children || [], depth + 1, b.id));
    }
  }
  return out;
}

export function getParentInfo(blocks, id, parent = null) {
  for (let i = 0; i < (blocks || []).length; i++) {
    const b = blocks[i];
    if (b.id === id) {
      return { parent, index: i, block: b, siblings: blocks };
    }
    const x = getParentInfo(b.children || [], id, b);
    if (x) return x;
  }
  return null;
}

export function indentBlock(blocks, id) {
  const info = getParentInfo(blocks, id);
  if (!info) return blocks;
  const { siblings, index, block } = info;
  if (index <= 0) return blocks;

  const prev = siblings[index - 1];
  const without = removeBlockTree(blocks, id);

  return appendChild(without, prev.id, block);
}

export function outdentBlock(blocks, id) {
  const info = getParentInfo(blocks, id);
  if (!info || !info.parent) return blocks;

  const parentInfo = getParentInfo(blocks, info.parent.id);
  const without = removeBlockTree(blocks, id);

  if (!parentInfo) {
    return [...without, info.block];
  }

  if (!parentInfo.parent) {
    // Parent is at root. Insert the outdented block as a root sibling after parent.
    const out = [];
    for (const b of without) {
      out.push(b);
      if (b.id === info.parent.id) out.push(info.block);
    }
    return out;
  }

  // Parent is nested. Insert outdented block as sibling of parent inside grandparent.
  return updateBlockTree(without, parentInfo.parent.id, (gp) => {
    const children = [];
    for (const child of gp.children || []) {
      children.push(child);
      if (child.id === info.parent.id) children.push(info.block);
    }
    return { ...gp, children };
  });
}

export function setBlockText(blocks, id, text) {
  return updateBlockTree(blocks, id, (b) => ({ ...b, content: text }));
}

export function setBlockEditMode(blocks, id, editMode) {
  return updateBlockTree(blocks, id, (b) => ({ ...b, editMode }));
}

export function toggleCollapsed(blocks, id) {
  return updateBlockTree(blocks, id, (b) => ({ ...b, collapsed: !b.collapsed }));
}

function makeNewBlock({ parentId = null, properties = {} } = {}) {
  return {
    id: makeBlockId(),
    parentId,
    children: [],
    collapsed: false,
    editMode: true,
    content: "",
    properties: { ...properties },
  };
}

export function addSiblingBlock(blocks, id) {
  const info = getParentInfo(blocks, id);
  const newBlock = makeNewBlock({ parentId: info?.parent?.id || null });
  return {
    blocks: insertSiblingAfter(blocks, id, newBlock),
    newId: newBlock.id
  };
}

export function addChildBlock(blocks, id) {
  const newBlock = makeNewBlock({ parentId: id });
  return {
    blocks: appendChild(blocks, id, newBlock),
    newId: newBlock.id
  };
}

// --- highlight integration: instead of rebuilding the tree from highlights,
//     just append a new highlight-backed block without disturbing existing tree ---

export function addHighlightAsBlock(blocks, highlight) {
  const id = highlight.id || makeBlockId();
  const block = {
    id,
    parentId: null,
    children: [],
    collapsed: false,
    editMode: false,
    content: highlight.comment?.text || "",
    properties: {
      highlight_id: id,
      color: highlight.color || DEFAULT_COLOR,
      quote: highlight.content?.text || "",
      pdf_page: highlight.position?.pageNumber || null,
      pdf_position: highlight.position || null,
    },
  };
  return [...(blocks || []), block];
}

// --- derive highlights (for react-pdf-highlighter) from blocks ---

export function blocksToHighlights(blocks) {
  const out = [];
  function walk(list) {
    for (const b of list || []) {
      if (isHighlightBlock(b) && blockPosition(b)) {
        out.push({
          id: blockHighlightId(b),
          content: { text: blockQuote(b) },
          comment: { text: b.content || "" },
          color: blockColor(b),
          position: blockPosition(b),
        });
      }
      if (b.children?.length) walk(b.children);
    }
  }
  walk(blocks);
  return out;
}

// --- normalize blocks from server (server doesn't send editMode/collapsed) ---

export function normalizeBlocks(blocks) {
  return (blocks || []).map((b) => ({
    ...b,
    collapsed: b.collapsed ?? false,
    editMode: false,
    children: normalizeBlocks(b.children || []),
  }));
}

// --- markdown export (kept for syncPdfPage → pages.content) ---

export function blocksToPageMarkdown(title, sourceUrl, docId, blocks) {
  const lines = [
    `# ${title}`,
    "",
    `Source: ${sourceUrl || ""}`,
    `Doc ID: ${docId || ""}`,
    "",
  ];
  lines.push(...blocksToMarkdownLines(blocks, 0));
  return lines.join("\n");
}

function blocksToMarkdownLines(blocks, depth) {
  const lines = [];
  for (const b of blocks || []) {
    const indent = "  ".repeat(depth);
    const page = blockPage(b);
    const label = page ? `page ${page}` : "note";
    const first = (b.content || "").trim() || `(${label})`;
    lines.push(`${indent}- ${first}`);
    const quote = blockQuote(b);
    if (quote.trim()) {
      for (const line of quote.split("\n")) {
        lines.push(`${indent}  > ${line}`);
      }
    }
    if (b.children?.length) {
      lines.push(...blocksToMarkdownLines(b.children, depth + 1));
    }
  }
  return lines;
}


// --- Phase B3 tree helpers ---

// True if `descendantId` is inside the subtree rooted at `ancestorId`
export function isDescendant(blocks, ancestorId, descendantId) {
  if (ancestorId === descendantId) return true;
  for (const b of blocks || []) {
    if (b.id === ancestorId) {
      return containsId(b.children || [], descendantId);
    }
    const hit = isDescendant(b.children || [], ancestorId, descendantId);
    if (hit) return true;
  }
  return false;
}

function containsId(blocks, id) {
  for (const b of blocks || []) {
    if (b.id === id) return true;
    if (containsId(b.children || [], id)) return true;
  }
  return false;
}

// Find a block by id along with its parent chain and position
// Returns { block, parentId, index, depth, ancestors: [id, ...] } or null
export function findBlockContext(blocks, id, depth = 0, ancestors = []) {
  const list = blocks || [];
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (b.id === id) {
      return {
        block: b,
        parentId: ancestors[ancestors.length - 1] ?? null,
        index: i,
        depth,
        ancestors,
      };
    }
    const found = findBlockContext(b.children || [], id, depth + 1, [...ancestors, b.id]);
    if (found) return found;
  }
  return null;
}

// Extract a block (with subtree) from the tree, returning both the extracted block and the remaining tree.
export function extractBlock(blocks, id) {
  const list = blocks || [];
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (b.id === id) {
      const extracted = b;
      const remaining = [...list.slice(0, i), ...list.slice(i + 1)];
      return { extracted, remaining };
    }
    const sub = extractBlock(b.children || [], id);
    if (sub) {
      const newChildren = sub.remaining;
      const newBlock = { ...b, children: newChildren };
      const newList = [...list.slice(0, i), newBlock, ...list.slice(i + 1)];
      return { extracted: sub.extracted, remaining: newList };
    }
  }
  return null;
}

// Insert `newBlock` as a sibling of `siblingId` (after=true means after, else before)
export function insertSibling(blocks, siblingId, newBlock, after) {
  const list = blocks || [];
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (b.id === siblingId) {
      const insertAt = after ? i + 1 : i;
      return [...list.slice(0, insertAt), newBlock, ...list.slice(insertAt)];
    }
    const childResult = insertSibling(b.children || [], siblingId, newBlock, after);
    if (childResult !== b.children) {
      return [...list.slice(0, i), { ...b, children: childResult }, ...list.slice(i + 1)];
    }
  }
  return list;
}

// Insert `newBlock` as a child of `parentId` (atEnd=true for last child, else first)
export function insertChild(blocks, parentId, newBlock, atEnd = false) {
  const list = blocks || [];
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (b.id === parentId) {
      const existing = b.children || [];
      const newChildren = atEnd ? [...existing, newBlock] : [newBlock, ...existing];
      return [...list.slice(0, i), { ...b, children: newChildren }, ...list.slice(i + 1)];
    }
    const childResult = insertChild(b.children || [], parentId, newBlock, atEnd);
    if (childResult !== b.children) {
      return [...list.slice(0, i), { ...b, children: childResult }, ...list.slice(i + 1)];
    }
  }
  return list;
}
