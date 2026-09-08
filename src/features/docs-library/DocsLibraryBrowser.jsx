import { useEffect, useRef, useState } from "react";
import { Archive, ChevronDown, ChevronRight, Download, FileText, Folder, FolderInput, FolderPlus, Link2, LockKeyhole, MoreHorizontal, Pencil, Plus, RefreshCw, Search, Share2, Table2, Trash2, Users, X } from "lucide-react";
import { changeDocsLibrary, folderTrail } from "./docs-folders";

function ItemMenu({ label, children }) {
  const ref = useRef(null);
  useEffect(() => {
    const close = (event) => {
      if (event.key === "Escape" || (event.type === "pointerdown" && !ref.current?.contains(event.target))) {
        if (ref.current) ref.current.open = false;
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", close); };
  }, []);
  return <details className="docs-item-menu" ref={ref}>
    <summary aria-label={label}><MoreHorizontal size={18} /></summary>
    <div className="docs-item-popover" onClick={() => { ref.current.open = false; }}>
      {children}
    </div>
  </details>;
}

export function DocsLibraryBrowser({ documents, decrypted, library, folderId, onFolderChange, onLibraryChange,
  busy, editorReady, onCreate, onOpen, onRename, onArchive, onShare, onTaskLink, onRefresh, onExport, children }) {
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [dialog, setDialog] = useState(null);
  const [name, setName] = useState("");
  const [destination, setDestination] = useState("");
  const [error, setError] = useState("");
  const modalRef = useRef(null);
  const openerRef = useRef(null);
  const trail = folderTrail(library, folderId);
  const query = search.trim().toLocaleLowerCase();
  const folders = library.folders.filter((entry) => filter === "all" &&
    (query ? entry.name.toLocaleLowerCase().includes(query) : entry.parentId === folderId))
    .sort((a, b) => a.name.localeCompare(b.name));
  const visible = documents.filter((entry) => {
    if (filter === "archived" ? entry.status !== "archived" : entry.status === "archived") return false;
    if (filter === "shared" && entry.owned && !entry.shares?.length && !entry.collaboratorCount) return false;
    if (query) return String(decrypted[entry.documentId]?.title || "").toLocaleLowerCase().includes(query);
    return filter !== "all" || (library.placements[entry.documentId] || "") === folderId;
  });

  useEffect(() => {
    if (dialog) modalRef.current?.showModal();
    else { modalRef.current?.close(); openerRef.current?.focus(); }
  }, [dialog]);

  function openDialog(next) {
    openerRef.current = document.activeElement?.closest("details")?.querySelector("summary") || document.activeElement;
    setName(next.name || "");
    setDestination(next.kind === "folder" ? library.folders.find((entry) => entry.id === next.id)?.parentId || "" : library.placements[next.id] ?? "");
    setError("");
    setDialog(next);
  }

  async function submit(event) {
    event.preventDefault();
    try {
      const change = { ...dialog, name, parentId: dialog.action === "create" ? folderId : destination };
      if (dialog.kind === "document" && dialog.action === "rename") {
        await onRename(documents.find((entry) => entry.documentId === dialog.id), name);
      } else {
        const next = changeDocsLibrary(library, change);
        await onLibraryChange(next);
      }
      if (change.action === "remove" && change.id === folderId) onFolderChange(trail.at(-1)?.parentId || "");
      setDialog(null);
    } catch (failure) { setError(failure.message); }
  }

  function folderCount(entry) {
    const count = documents.filter((doc) => doc.status !== "archived" && library.placements[doc.documentId] === entry.id).length + library.folders.filter((folder) => folder.parentId === entry.id).length;
    return `${count} ${count === 1 ? "item" : "items"}`;
  }

  function browse(id) { onFolderChange(id); setSearch(""); setFilter("all"); }
  const folderMenu = (entry) => <ItemMenu label={`Actions for ${entry.name}`}>
    <button onClick={() => openDialog({ action: "rename", kind: "folder", ...entry })}><Pencil size={15} />Rename</button>
    <button onClick={() => openDialog({ action: "move", kind: "folder", ...entry })}><FolderInput size={15} />Move folder</button>
    <button onClick={() => openDialog({ action: "remove", kind: "folder", ...entry })}><Trash2 size={15} />Remove folder</button>
  </ItemMenu>;

  return <div className="docs-library-page docs-browser">
    <div className="docs-browser-inner">
      <header className="docs-library-heading">
        <div><h1>Docs</h1><p>A home for your documents, spreadsheets, and shared work.</p></div>
        <details className="docs-new-menu">
          <summary><Plus size={17} />New<ChevronDown size={14} /></summary>
          <div className="docs-item-popover" onClick={(event) => { event.currentTarget.closest("details").open = false; }}>
            <button disabled={Boolean(busy) || !editorReady} onClick={() => onCreate("pad", folderId)}><FileText size={16} />New document</button>
            <button disabled={Boolean(busy) || !editorReady} onClick={() => onCreate("sheet", folderId)}><Table2 size={16} />New spreadsheet</button>
            <button disabled={Boolean(busy)} onClick={() => openDialog({ action: "create", id: crypto.randomUUID() })}><FolderPlus size={16} />New folder</button>
          </div>
        </details>
      </header>
      <div className="docs-library-tools">
        <div className="docs-view-tabs" aria-label="Library view" role="group">
          {[["all", "My docs"], ["shared", "Shared"], ["archived", "Archived"]].map(([id, label]) => <button aria-pressed={filter === id} key={id} onClick={() => { setFilter(id); setSearch(""); }} type="button">{label}</button>)}
        </div>
        <label className="docs-library-search"><Search size={16} /><input aria-label="Search documents and folders" placeholder="Search docs and folders" value={search} onChange={(event) => setSearch(event.target.value)} />{search && <button aria-label="Clear search" onClick={() => setSearch("")}><X size={14} /></button>}</label>
        <button className="docs-refresh-button" aria-label="Refresh library" disabled={Boolean(busy)} onClick={onRefresh}><RefreshCw size={16} /></button>
      </div>
      {children}
      <div className="docs-location-row">
        <nav aria-label="Folder path" className="docs-breadcrumbs">
          <button onClick={() => browse("")}>My docs</button>
          {filter !== "all" ? <><ChevronRight size={13} /><span>{filter === "shared" ? "Shared" : "Archived"}</span></> :
            query ? <><ChevronRight size={13} /><span>Search results</span></> : trail.map((entry) => <span key={entry.id}><ChevronRight size={13} /><button onClick={() => browse(entry.id)}>{entry.name}</button></span>)}
        </nav>
        {filter === "all" && !query && <button className="docs-add-folder" disabled={Boolean(busy)} onClick={() => openDialog({ action: "create", id: crypto.randomUUID() })}><FolderPlus size={15} />New folder</button>}
      </div>
      <section className="docs-file-list" aria-label="Documents and folders">
        <div className="docs-list-columns"><span>Name</span><span>Access</span><span>Updated</span><span /></div>
        {folders.map((entry) => <article className="docs-file-row docs-folder-row" key={entry.id}>
          <button className="docs-file-name" onClick={() => browse(entry.id)}><span className="docs-file-icon folder"><Folder size={20} /></span><span><strong>{entry.name}</strong><small>{query ? folderTrail(library, entry.parentId).map((item) => item.name).join(" / ") || "My docs" : folderCount(entry)}</small></span></button>
          <span className="docs-file-access">Only you</span><span className="docs-file-date">—</span>{folderMenu(entry)}
        </article>)}
        {visible.map((entry) => {
          const metadata = decrypted[entry.documentId];
          const title = metadata?.title || "Document unavailable";
          const isSheet = metadata?.documentType === "sheet" || metadata?.viewHref?.startsWith("/sheet/") || metadata?.editHref?.startsWith("/sheet/");
          const shared = !entry.owned || entry.shares?.length > 0 || entry.collaboratorCount > 0;
          return <article className="docs-file-row" key={entry.documentId}>
            <button className="docs-file-name" disabled={!metadata || !editorReady} onClick={() => onOpen(entry)}>
              <span className={`docs-file-icon ${isSheet ? "sheet" : "document"}`}>{isSheet ? <Table2 size={20} /> : <FileText size={20} />}</span>
              <span><strong>{title}</strong><small>{isSheet ? "Spreadsheet" : "Document"}{entry.taskIds?.length > 0 ? ` · ${entry.taskIds.length} linked ${entry.taskIds.length === 1 ? "task" : "tasks"}` : ""}{query && library.placements[entry.documentId] ? ` · ${folderTrail(library, library.placements[entry.documentId]).map((folder) => folder.name).join(" / ")}` : ""}</small></span>
            </button>
            <span className="docs-file-access" title={entry.owned ? entry.shares?.map((grant) => `${grant.recipient.displayName} · ${grant.accessRole} · ${grant.status}`).join(", ") : `Shared by ${entry.owner.displayName}`}>
              {shared && <Users size={13} />}{entry.owned ? shared ? `Shared${entry.shares?.some((grant) => grant.status === "pending") ? " · pending" : ""}` : "Only you" : entry.owner.displayName}
            </span>
            <time className="docs-file-date" dateTime={entry.updatedAt}>{entry.updatedAt ? new Date(entry.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "—"}</time>
            <ItemMenu label={`Actions for ${title}`}>
              <button disabled={Boolean(busy)} onClick={() => openDialog({ action: "move", kind: "document", id: entry.documentId, name: title })}><FolderInput size={15} />Move to folder</button>
              {entry.owned && <>
                <button disabled={!metadata} onClick={() => openDialog({ action: "rename", kind: "document", id: entry.documentId, name: title })}><Pencil size={15} />Rename</button>
                <button disabled={!metadata} onClick={() => onShare(entry)}><Share2 size={15} />Share</button>
                <button onClick={() => onTaskLink(entry)}><Link2 size={15} />Link task</button>
                <button disabled={Boolean(busy)} onClick={() => onArchive(entry)}><Archive size={15} />{entry.status === "archived" ? "Restore" : "Archive"}</button>
              </>}
            </ItemMenu>
          </article>;
        })}
        {!folders.length && !visible.length && <div className="docs-list-empty"><Folder size={30} /><h2>{query ? "No matches" : filter === "shared" ? "No shared documents yet" : filter === "archived" ? "No archived documents" : folderId ? "This folder is empty" : "Your work starts here"}</h2><p>{query ? "Try another name. Search includes all your folders." : filter === "all" ? "Create a document or spreadsheet, or move existing work here." : filter === "shared" ? "Documents you share or accept will appear here." : "Archived documents will appear here."}</p>{filter === "all" && !query && <button disabled={Boolean(busy) || !editorReady} onClick={() => onCreate("pad", folderId)}><Plus size={15} />New document</button>}</div>}
      </section>
      <footer className="docs-library-footer"><span><LockKeyhole size={13} />End-to-end encrypted</span><button onClick={onExport}><Download size={13} />Export recovery</button></footer>
    </div>
    <dialog ref={modalRef} className="docs-folder-dialog" aria-labelledby="docs-organize-dialog-title" onCancel={(event) => { event.preventDefault(); if (!busy) setDialog(null); }}>
      {dialog && <form onSubmit={submit}>
        <div className="docs-folder-dialog-icon"><Folder size={24} /></div>
        <h2 id="docs-organize-dialog-title">{dialog.action === "create" ? "New folder" : dialog.action === "rename" ? dialog.kind === "document" ? "Rename document" : "Rename folder" : dialog.action === "move" ? "Move to folder" : "Remove folder?"}</h2>
        {dialog.action === "move" ? <><p>Choose a home for “{dialog.name}”.</p><label>Destination<select autoFocus value={destination} onChange={(event) => setDestination(event.target.value)}><option value="">My docs</option>{library.folders.filter((entry) => dialog.kind !== "folder" || !folderTrail(library, entry.id).some((folder) => folder.id === dialog.id)).map((entry) => <option key={entry.id} value={entry.id}>{folderTrail(library, entry.id).map((folder) => folder.name).join(" / ")}</option>)}</select></label></> :
          dialog.action === "remove" ? <p>Remove “{dialog.name}”? Its documents and subfolders move up one level. No documents are deleted.</p> : <><p>{dialog.kind === "document" ? "Give this document a name that is easy to find." : "Keep related work together. Folder names are private to you."}</p><label>{dialog.kind === "document" ? "Document name" : "Folder name"}<input autoFocus required maxLength={dialog.kind === "document" ? 180 : 100} value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Research" /></label></>}
        {error && <p className="docs-folder-error" role="alert">{error}</p>}
        <div className="docs-folder-dialog-actions"><button type="button" disabled={Boolean(busy)} onClick={() => setDialog(null)}>Cancel</button><button className="docs-solid-button" disabled={Boolean(busy)} type="submit">{busy ? "Saving…" : dialog.action === "create" ? "Create folder" : dialog.action === "remove" ? "Remove folder" : dialog.action === "move" ? "Move" : "Save"}</button></div>
      </form>}
    </dialog>
  </div>;
}
