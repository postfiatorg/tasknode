// Pillar 9: every Library item may narrow its publication's `allowed_bases`.
// An absent item list inherits the publication; a present list that is empty or
// malformed admits nobody. The same rule filters summaries and gates direct files.

export const LIBRARY_MANIFEST_PATH = "hub/library.json";
export const TODAY_MANIFEST_PATH = "hub/today.json";

/** null when the item inherits the publication's bases, else the explicit list (possibly empty). */
export function itemAllowedBases(item = {}) {
  const raw = item?.allowed_bases ?? item?.allowedBases;
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) return [];
  return raw.map((value) => (typeof value === "string" ? value.trim() : "")).filter(Boolean);
}

export function libraryItemAllowed(item, basis = "") {
  const bases = itemAllowedBases(item);
  return bases === null || (Boolean(basis) && bases.includes(basis));
}

export function filterLibraryItems(items, basis = "") {
  return Array.isArray(items) ? items.filter((item) => libraryItemAllowed(item, basis)) : [];
}

function itemFilePaths(item, indexId) {
  const paths = [];
  const prefix = `/api/research/bundles/${indexId}/`;
  const url = typeof item?.url === "string" ? item.url.trim() : "";
  if (url) {
    try {
      const parsed = new URL(url, "https://finance-hub.invalid");
      if (parsed.origin === "https://finance-hub.invalid" && parsed.pathname.startsWith(prefix)) {
        paths.push(parsed.pathname.slice(prefix.length).split("/").map(decodeURIComponent).join("/"));
      }
    } catch {
      // A malformed URL names no bundle file.
    }
  }
  for (const key of ["path", "file", "file_path"]) {
    if (typeof item?.[key] === "string" && item[key].trim()) paths.push(item[key].trim().replace(/^\/+/, ""));
  }
  return paths;
}

/**
 * Map of bundle file path -> bases allowed to read it, from every restricted
 * Library item that references the file. Several restrictions intersect.
 */
export function libraryFileRestrictions(docs = [], indexId = "") {
  const restrictions = new Map();
  for (const item of docs.flatMap((doc) => (Array.isArray(doc) ? doc : []))) {
    const bases = itemAllowedBases(item);
    if (bases === null) continue;
    for (const filePath of itemFilePaths(item, indexId)) {
      const previous = restrictions.get(filePath);
      restrictions.set(filePath, previous ? previous.filter((basis) => bases.includes(basis)) : bases);
    }
  }
  return restrictions;
}

/** Library lists found in the manifests a publication may carry. */
export function libraryListsOf({ libraryDoc = null, todayDoc = null } = {}) {
  return [libraryDoc?.items, todayDoc?.library].filter(Array.isArray);
}

/**
 * Trusted publication metadata: `{ [filePath]: bases[] }` derived at publish time
 * from the bundle's own manifests, so the per-file route can refuse a restricted
 * file before reading it. A manifest that is present but unreadable fails the publish.
 */
export function libraryRestrictionsFromFiles(files = [], indexId = "") {
  const docs = {};
  for (const { path: filePath, bytes } of files) {
    if (filePath !== LIBRARY_MANIFEST_PATH && filePath !== TODAY_MANIFEST_PATH) continue;
    try {
      docs[filePath === LIBRARY_MANIFEST_PATH ? "libraryDoc" : "todayDoc"] = JSON.parse(Buffer.from(bytes).toString("utf8"));
    } catch {
      throw Object.assign(new Error("library_manifest_invalid"), { status: 400 });
    }
  }
  return Object.fromEntries(libraryFileRestrictions(libraryListsOf(docs), indexId));
}

/** null when the publication carries no restriction map (published before it existed). */
export function fileRestriction(index, filePath) {
  const map = index?.metadata?.libraryRestrictions;
  if (!map || typeof map !== "object" || Array.isArray(map)) return null;
  if (!Object.hasOwn(map, filePath)) return null;
  return Array.isArray(map[filePath]) ? map[filePath] : [];
}

/** The manifest JSON as a reader with `basis` may see it. */
export function filterLibraryManifest(filePath, doc, basis = "") {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return doc;
  if (filePath === LIBRARY_MANIFEST_PATH && Array.isArray(doc.items)) return { ...doc, items: filterLibraryItems(doc.items, basis) };
  if (filePath === TODAY_MANIFEST_PATH && Array.isArray(doc.library)) return { ...doc, library: filterLibraryItems(doc.library, basis) };
  return doc;
}
