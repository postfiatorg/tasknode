import { useEffect, useState } from "react";
import { Check, Copy, Pencil, Share, Trash2, X } from "lucide-react";
import { BlockRenderer, copyText } from "./ChatMessages.jsx";
import { transcriptTextFromThread } from "./chat-turns";
import { isSignedInSession } from "../../session";

export function ChatItemActionMenu({ chat, menuRef, onRename, onDelete, style }) {
  const isHive = chat?.kind === "hive";
  return (
    <div className="chat-action-menu" ref={menuRef} role="menu" style={style}>
      {!isHive && (
        <>
          <button
            aria-disabled="true"
            className="chat-action-menu-item is-muted"
            onClick={(event) => event.preventDefault()}
            role="menuitem"
            type="button"
          >
            <Share size={17} strokeWidth={1.75} />
            <span>Share</span>
            <small>Coming soon</small>
          </button>
          <button className="chat-action-menu-item" onClick={onRename} role="menuitem" type="button">
            <Pencil size={17} strokeWidth={1.75} />
            <span>Rename</span>
          </button>
          <div className="chat-action-menu-divider" />
        </>
      )}
      <button className="chat-action-menu-item danger" onClick={onDelete} role="menuitem" type="button">
        <Trash2 size={17} strokeWidth={1.75} />
        <span>{isHive ? "Disable Hive Chat" : "Delete"}</span>
      </button>
    </div>
  );
}

export function RenameChatModal({ chat, onClose, onSave }) {
  const [title, setTitle] = useState(chat?.title || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function submitRename(event) {
    event.preventDefault();
    const nextTitle = title.trim().replace(/\s+/g, " ");
    if (!nextTitle) {
      setError("Name the chat before saving.");
      return;
    }

    setSaving(true);
    setError("");
    try {
      await onSave(nextTitle);
    } catch (saveError) {
      setError(saveError?.message || "Could not rename this chat.");
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop chat-edit-backdrop" onClick={onClose} role="presentation">
      <form
        aria-labelledby="rename-chat-title"
        aria-modal="true"
        className="chat-edit-modal"
        onClick={(event) => event.stopPropagation()}
        onSubmit={submitRename}
        role="dialog"
      >
        <header>
          <h2 id="rename-chat-title">Rename chat</h2>
          <button aria-label="Close rename" className="chat-edit-close" onClick={onClose} type="button">
            <X size={18} strokeWidth={1.75} />
          </button>
        </header>
        <input
          aria-label="Chat name"
          autoFocus
          maxLength={80}
          onChange={(event) => setTitle(event.target.value)}
          value={title}
        />
        {error && <p className="chat-edit-error">{error}</p>}
        <footer>
          <button className="ghost-button" disabled={saving} onClick={onClose} type="button">
            Cancel
          </button>
          <button className="solid-button" disabled={saving} type="submit">
            <Check size={16} strokeWidth={2} />
            Save
          </button>
        </footer>
      </form>
    </div>
  );
}

export function DeleteChatModal({ chat, onClose, onDelete }) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const isHive = chat?.kind === "hive";

  async function submitDelete() {
    setDeleting(true);
    setError("");
    try {
      await onDelete();
    } catch (deleteError) {
      setError(deleteError?.message || "Could not delete this chat.");
      setDeleting(false);
    }
  }

  return (
    <div className="modal-backdrop chat-edit-backdrop" onClick={onClose} role="presentation">
      <section
        aria-labelledby="delete-chat-title"
        aria-modal="true"
        className="chat-edit-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header>
          <h2 id="delete-chat-title">{isHive ? "Disable Hive Chat?" : "Delete chat?"}</h2>
          <button aria-label="Close delete" className="chat-edit-close" onClick={onClose} type="button">
            <X size={18} strokeWidth={1.75} />
          </button>
        </header>
        <p className="chat-delete-copy">
          {isHive ? (
            <>
              This permanently removes your ability to talk to <strong>Hive Chat</strong> from the sidebar
              unless you re-enable it in Settings. Existing Hive Context entries stay saved.
            </>
          ) : (
            <>
              This removes <strong>{chat?.title || "this chat"}</strong> from your chat history.
            </>
          )}
        </p>
        {error && <p className="chat-edit-error">{error}</p>}
        <footer>
          <button className="ghost-button" disabled={deleting} onClick={onClose} type="button">
            Cancel
          </button>
          <button className="danger-button" disabled={deleting} onClick={submitDelete} type="button">
            <Trash2 size={16} strokeWidth={2} />
            {isHive ? "Disable Hive Chat" : "Delete"}
          </button>
        </footer>
      </section>
    </div>
  );
}

export function ShareModal({ onClose, thread, title }) {
  const [copied, setCopied] = useState(false);
  const previewThread = (thread || []).slice(0, 4);
  const transcript = transcriptTextFromThread(thread, title);

  async function copyTranscript() {
    const ok = await copyText(transcript);
    if (!ok) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  return (
    <div className="modal-backdrop share-backdrop" onClick={onClose} role="presentation">
      <section
        aria-labelledby="share-title"
        aria-modal="true"
        className="share-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header>
          <h2 id="share-title">{title || "Untitled chat"}</h2>
          <button
            aria-label="Close share"
            className="share-modal-close"
            onClick={onClose}
            type="button"
          >
            <X size={18} strokeWidth={1.75} />
          </button>
        </header>
        <div className="share-preview">
          <strong>Task Node</strong>
          <div>
            {previewThread.map((message, index) =>
              message.role === "user" ? (
                <div className="share-preview-user" key={index}>
                  <span>{message.text}</span>
                </div>
              ) : message.role === "agent" ? (
                <div className="share-preview-agent" key={index}>
                  <strong>{message.agentLabel || "Orc agent"}</strong>
                  <span>{message.text}</span>
                </div>
              ) : (
                <div className="share-preview-assistant" key={index}>
                  {(message.blocks || []).slice(0, 2).map((block, blockIndex) => (
                    <BlockRenderer block={block} key={blockIndex} />
                  ))}
                </div>
              )
            )}
          </div>
        </div>
        <div className="share-targets">
          <button className="share-target" onClick={copyTranscript} type="button">
            <span><Copy size={20} strokeWidth={1.75} /></span>
            {copied ? "Copied" : "Copy transcript"}
          </button>
        </div>
        <p>Only visible messages are included.</p>
      </section>
    </div>
  );
}

export function ModelOption({ disabled = false, mode, onClick, selected }) {
  return (
    <button
      className={`model-option${selected ? " selected" : ""}`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <span>
        <strong>{formatModeLabel(mode.label)}</strong>
        <small>{modeDescription(mode)}</small>
      </span>
      {selected && <Check size={15} strokeWidth={2} />}
    </button>
  );
}

export function formatModeLabel(label) {
  return String(label || "").trim();
}

export function modeDescription(mode = {}) {
  const label = String(mode.label || "");
  if (label === "Instant") return "DeepSeek Flash 7/31. Fast.";
  if (label === "Thinking") return "GLM 5.2. More reasoning.";
  if (label === "Help") return "Plain-English app guide";
  return mode.latency || mode.privacy || "";
}

export function profileDisplayName(session) {
  if (session?.identityProfile?.displayName) return session.identityProfile.displayName;
  if (session?.hiveHandle) return `@${session.hiveHandle}`;
  if (session?.displayName) return session.displayName;
  return "Log in or sign up";
}

export function profileAvatarText(session) {
  const displayName = profileDisplayName(session);
  if (!displayName || displayName === "Log in or sign up") return "TN";
  return displayName
    .replace(/^@+/, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

export function profileSessionText(session) {
  if (!isSignedInSession(session)) return "Account";
  if (session?.hiveHandle) return `@${session.hiveHandle}`;
  const provider = sessionProviderLabel(session);
  return provider ? `Signed in with ${provider}` : "Signed in";
}

export function sessionProviderLabel(session) {
  const providerId = session?.primaryProvider;
  const linked = (session?.linkedProviders || []).find((item) => item?.id === providerId);
  if (linked?.label) return linked.label;
  if (providerId === "github") return "GitHub";
  if (providerId === "email") return "Email";
  if (providerId === "dev") return "Dev";
  if (providerId === "x") return "X";
  if (providerId === "telegram") return "Telegram";
  if (providerId === "discord") return "Discord";
  return "";
}

export function ProfileAvatar({ imageCandidates = [], initials, signedIn }) {
  const [imageIndex, setImageIndex] = useState(0);
  const imageSrc = signedIn ? imageCandidates[imageIndex] || "" : "";
  const imageKey = imageCandidates.join("|");

  useEffect(() => {
    setImageIndex(0);
  }, [imageKey]);

  return (
    <span className={`profile-avatar ${signedIn ? "signed-in" : "signed-out"} ${imageSrc ? "has-image" : ""}`}>
      {imageSrc ? (
        <img
          alt="Profile NFT"
          onError={() => setImageIndex((index) => index + 1)}
          src={imageSrc}
        />
      ) : (
        initials
      )}
      {signedIn && !imageSrc && (
        <span className="profile-check" aria-hidden="true">
          <Check size={9} strokeWidth={2.5} />
        </span>
      )}
    </span>
  );
}

export function EmptyState({ icon: Icon, title, desc }) {
  return (
    <div className="empty-state">
      <span>
        <Icon size={18} strokeWidth={1.75} />
      </span>
      <strong>{title}</strong>
      <p>{desc}</p>
    </div>
  );
}
