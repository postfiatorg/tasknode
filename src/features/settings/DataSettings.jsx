import { useState } from "react";
import { ExternalLink } from "lucide-react";
import { requestJson } from "../../api";
import { isSignedInSession } from "../../session";
import { SettingsLine, SmallPill, ToggleSwitch } from "./SettingsControls.jsx";

export function DataSettings({ onAccountDeleted, onAppStateChange, onOpenHiveChat, session }) {
  const [exportPending, setExportPending] = useState(false);
  const [exportMessage, setExportMessage] = useState("");
  const [deletePending, setDeletePending] = useState(false);
  const [deleteMessage, setDeleteMessage] = useState("");

  async function exportAccountData() {
    if (!isSignedInSession(session)) {
      setExportMessage("Sign in before exporting account data.");
      return;
    }
    setExportPending(true);
    setExportMessage("");
    try {
      const response = await fetch("/api/account/export", { credentials: "same-origin" });
      if (!response.ok) {
        const failure = await response.json().catch(() => ({}));
        throw new Error(failure?.message || failure?.error || "Account export failed.");
      }
      const downloadUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.download = `tasknode-export-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(downloadUrl);
      setExportMessage("Your account export was downloaded.");
    } catch (error) {
      setExportMessage(error?.message || "Account export failed.");
    } finally {
      setExportPending(false);
    }
  }

  async function deleteAccount() {
    if (!isSignedInSession(session)) {
      setDeleteMessage("Sign in before deleting an account.");
      return;
    }
    const confirmed = window.confirm("Delete this Task Node account and its stored content? This cannot be undone.");
    if (!confirmed) return;
    setDeletePending(true);
    setDeleteMessage("");
    try {
      const result = await requestJson("/api/account/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      });
      if (!result.ok || !result.body?.ok) {
        throw new Error(result.body?.message || result.body?.error || "Account deletion failed.");
      }
      await onAppStateChange?.();
      onAccountDeleted?.();
    } catch (error) {
      setDeleteMessage(error?.message || "Account deletion failed.");
    } finally {
      setDeletePending(false);
    }
  }

  return (
    <>
      <SettingsLine desc="Allow your content to be used to improve Task Node." label="Improve the model for everyone" right={<ToggleSwitch initial />} />
      <SettingsLine
        desc="Public group chat over Nostr, using your Messages identity. Previous private Hive conversations remain in your archive."
        label="Hive Chat"
        right={<SmallPill onClick={onOpenHiveChat}>Open</SmallPill>}
      />
      <SettingsLine desc="Manage links you've shared from chats." label="Shared links" right={<SmallPill>Manage</SmallPill>} />
      <SettingsLine desc="Download your account, conversations, attachments, context, memory, activity, and billing history." label="Export data" right={<SmallPill disabled={exportPending} onClick={exportAccountData}>{exportPending ? "Preparing" : "Export"}</SmallPill>} />
      {exportMessage && <div className="inline-message">{exportMessage}</div>}
      <SettingsLine desc="How Task Node handles your data." label="Privacy Policy" right={<SmallPill>View <ExternalLink size={11} /></SmallPill>} />
      <SettingsLine danger desc="Permanently remove your account content. Narrow fraud and financial records are retained in pseudonymous form." label="Delete account" right={<SmallPill danger disabled={deletePending} onClick={deleteAccount}>{deletePending ? "Deleting" : "Delete"}</SmallPill>} />
      {deleteMessage && <div className="inline-message">{deleteMessage}</div>}
    </>
  );
}
