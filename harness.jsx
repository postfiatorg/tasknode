import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { DocsLibraryBrowser } from "/mnt/HC_Volume_101713660/pfrpc/scratch/tasknode-memory-schema/src/features/docs-library/DocsLibraryBrowser.jsx";
import "/mnt/HC_Volume_101713660/pfrpc/scratch/tasknode-memory-schema/src/features/docs-library/docs-library.css";
const documents = [
  { documentId: "d1", status: "active", owned: true, shares: [], collaboratorCount: 0, updatedAt: "2026-11-16T00:00:00Z" },
  { documentId: "p1", status: "active", owned: true, shares: [], collaboratorCount: 0, updatedAt: "2026-11-16T00:00:00Z" },
  { documentId: "p2", status: "active", owned: true, shares: [], collaboratorCount: 0, updatedAt: "2026-11-16T00:00:00Z" },
];
const decrypted = { d1: { title: "Plan doc", documentType: "pad" }, p1: { title: "hive_chat_and_hive_board", documentType: "prompt" }, p2: { title: "second prompt", documentType: "prompt" } };
function App() {
  const [library, setLibrary] = useState({ version: 1, folders: [{ id: "g1", name: "General folder", parentId: "" }], placements: { p2: "g1" } });
  const [folderId, setFolderId] = useState("");
  window.__library = library;
  return <DocsLibraryBrowser documents={documents} decrypted={decrypted} library={library} folderId={folderId} onFolderChange={setFolderId}
    onLibraryChange={async (next) => setLibrary(next)} promptEvents={[]} busy="" editorReady onCreate={(t, f) => { window.__created = [t, f]; }} onOpen={() => {}} onRename={async () => {}}
    onArchive={() => {}} onShare={() => {}} onTaskLink={() => {}} onRefresh={() => {}} onExport={() => {}} agentAccess={null} onPromptView={() => {}} />;
}
createRoot(document.getElementById("root")).render(<App />);
