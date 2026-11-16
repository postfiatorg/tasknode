export function emptyDocsLibrary() {
  return { version: 1, folders: [], placements: {} };
}

// Folders live in one of two spaces: the general library ("docs") or the
// Prompts view ("prompts"). A folder without a scope belongs to the general library.
export function folderScope(folder) {
  return folder?.scope === "prompts" ? "prompts" : "docs";
}

export function readDocsLibrary(value) {
  if (value?.version !== 1 || !Array.isArray(value.folders) || value.folders.length > 500 ||
      !value.placements || typeof value.placements !== "object" || Array.isArray(value.placements)) {
    throw new Error("Your folder organization could not be read. Refresh to try again.");
  }
  const ids = new Set();
  for (const folder of value.folders) {
    if (!folder || typeof folder.id !== "string" || !folder.id || ids.has(folder.id) ||
        typeof folder.name !== "string" || !folder.name.trim() || folder.name.length > 100 ||
        typeof folder.parentId !== "string" ||
        (folder.scope !== undefined && folder.scope !== "prompts")) throw new Error("Invalid folder organization.");
    ids.add(folder.id);
  }
  for (const folder of value.folders) {
    const seen = new Set([folder.id]);
    let parentId = folder.parentId;
    while (parentId) {
      if (!ids.has(parentId) || seen.has(parentId)) throw new Error("Invalid folder hierarchy.");
      seen.add(parentId);
      const parent = value.folders.find((entry) => entry.id === parentId);
      if (folderScope(parent) !== folderScope(folder)) throw new Error("Invalid folder hierarchy.");
      parentId = parent.parentId;
    }
  }
  for (const folderId of Object.values(value.placements)) {
    if (typeof folderId !== "string" || (folderId && !ids.has(folderId))) throw new Error("Invalid document folder.");
  }
  return value;
}

export function folderTrail(library, folderId) {
  const trail = [];
  const seen = new Set();
  while (folderId && !seen.has(folderId)) {
    seen.add(folderId);
    const folder = library.folders.find((entry) => entry.id === folderId);
    if (!folder) break;
    trail.unshift(folder);
    folderId = folder.parentId;
  }
  return trail;
}

export function changeDocsLibrary(library, change) {
  const next = structuredClone(readDocsLibrary(library));
  const folder = next.folders.find((entry) => entry.id === change.id);
  if (["create", "rename"].includes(change.action)) {
    const name = String(change.name || "").trim();
    if (!name || name.length > 100) throw new Error("Use a folder name between 1 and 100 characters.");
    const parentId = change.action === "create" ? change.parentId || "" : folder?.parentId;
    if (parentId === undefined) throw new Error("That folder no longer exists.");
    const parent = parentId ? next.folders.find((entry) => entry.id === parentId) : null;
    if (parentId && !parent) throw new Error("That folder no longer exists.");
    // A new folder joins its parent's space; at the top level the caller chooses.
    const scope = change.action === "create"
      ? parent ? folderScope(parent) : change.scope === "prompts" ? "prompts" : "docs"
      : folderScope(folder);
    if (next.folders.some((entry) => entry.id !== change.id && entry.parentId === parentId && folderScope(entry) === scope &&
        entry.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      throw new Error("A folder with that name already exists here.");
    }
    if (change.action === "create") next.folders.push({ id: change.id, name, parentId, ...(scope === "prompts" ? { scope } : {}) });
    else folder.name = name;
  } else if (change.action === "move") {
    const parentId = change.parentId || "";
    if (change.kind === "folder") {
      if (!folder) throw new Error("That folder no longer exists.");
      const target = parentId ? next.folders.find((entry) => entry.id === parentId) : null;
      if (target && folderScope(target) !== folderScope(folder)) throw new Error("Folders cannot move between My docs and Prompts.");
      if (next.folders.some((entry) => entry.id !== folder.id && entry.parentId === parentId && folderScope(entry) === folderScope(folder) &&
          entry.name.toLocaleLowerCase() === folder.name.toLocaleLowerCase())) {
        throw new Error("A folder with that name already exists there.");
      }
      folder.parentId = parentId;
    } else {
      Object.defineProperty(next.placements, change.id, { value: parentId, enumerable: true, configurable: true, writable: true });
    }
  } else if (change.action === "remove") {
    if (!folder) throw new Error("That folder no longer exists.");
    for (const child of next.folders.filter((entry) => entry.parentId === folder.id)) {
      if (next.folders.some((entry) => entry.id !== folder.id && entry.parentId === folder.parentId && folderScope(entry) === folderScope(folder) && entry.name.toLocaleLowerCase() === child.name.toLocaleLowerCase())) {
        throw new Error(`Move or rename “${child.name}” first; a folder with that name already exists one level up.`);
      }
    }
    // Removing a folder preserves every document and subfolder at its parent.
    next.folders = next.folders.filter((entry) => entry.id !== folder.id);
    for (const entry of next.folders) if (entry.parentId === folder.id) entry.parentId = folder.parentId;
    for (const [documentId, folderId] of Object.entries(next.placements)) {
      if (folderId === folder.id) next.placements[documentId] = folder.parentId;
    }
  } else throw new Error("Unknown folder action.");
  return readDocsLibrary(next);
}
