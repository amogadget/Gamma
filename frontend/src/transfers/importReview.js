export const IMPORT_FILTERS = [
  ["all", "All"], ["missing", "Missing"], ["warnings", "Warnings"], ["selected", "Selected"],
];

export const itemIds = page => page.selection_ids || [];
export const itemSelected = (page, selected) => itemIds(page).every(id => selected.has(id));
export const allItemIds = pages => [...new Set(pages.flatMap(itemIds))];
export function filterImportPages(pages, filter, selected) {
  return pages.filter(page => filter === "all" || (filter === "missing" && page.missing)
    || (filter === "warnings" && page.warnings?.length) || (filter === "selected" && itemSelected(page, selected)));
}
export function selectItems(selected, ids, checked) {
  const next = new Set(selected);
  for (const id of ids) { if (checked) next.add(id); else next.delete(id); }
  return next;
}
export function buildImportTree(items, library = false) {
  const root = { folders: new Map(), files: [] };
  const at = path => {
    let node = root;
    for (const part of path.split("/").filter(Boolean)) {
      if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), files: [] });
      node = node.folders.get(part);
    }
    return node;
  };
  for (const item of items) {
    if (library) {
      for (const folder of item.folders?.length ? item.folders : [""]) at(folder).files.push({ ...item, name: item.title });
    } else if (item.directory) at(item.path);
    else {
      const parts = item.path.split("/");
      const name = parts.pop();
      at(parts.join("/")).files.push({ ...item, name });
    }
  }
  return root;
}
export function treeItemIds(node) {
  return [...new Set([...node.files.flatMap(itemIds), ...[...node.folders.values()].flatMap(treeItemIds)])];
}
export function resultPages(data) {
  const unique = new Map();
  for (const page of data.pages || []) {
    const key = `${page.kind || "page"}:${page.id}`;
    const prior = unique.get(key);
    unique.set(key, { ...page, folders: page.folders || (page.folder ? [page.folder] : []),
      action: page.created || prior?.action === "create" ? "create" : page.action || "merge" });
  }
  return [...unique.values()];
}
export const importWarnings = data => [...(data.skipped || []), ...(data.warnings || [])];
export function importSummary(data) {
  const created = data.pages_created ?? data.pages_added ?? (data.block_id ? 1 : 0);
  return [
    `${created} new page${created === 1 ? "" : "s"}`,
    data.pages_merged ? `${data.pages_merged} updated` : "",
    data.pages_skipped ? `${data.pages_skipped} already in library` : "",
    (data.pdfs_stored || data.assets_stored || data.uploads_added) ? `${data.pdfs_stored || data.assets_stored || data.uploads_added} files stored` : "",
    data.annotations_imported ? `${data.annotations_imported} annotations` : "",
    data.notes_imported ? `${data.notes_imported} notes` : "",
    data.chats_added ? `${data.chats_added} chats` : "",
    importWarnings(data).length ? `${importWarnings(data).length} warnings` : "",
  ].filter(Boolean).join(" · ");
}
