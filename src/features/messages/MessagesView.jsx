import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  Circle,
  KeyRound,
  LockKeyhole,
  MessageCircleMore,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Wifi,
} from "lucide-react";
import { requestJson } from "../../api";
import { signedCollaborationProof } from "../collaboration/collaboration-client";
import { ComposerSendButton } from "../chat/ComposerSendButton.jsx";
import { profileNftImageCandidates } from "../profile/profile-nft-images.js";
import {
  DEFAULT_MESSAGE_RELAYS,
  createDirectMessageCatchUp,
  deriveNostrMessagingIdentity,
  directMessageCatchUpSince,
  fetchDirectMessages,
  normalizeMessageRelays,
  publishDirectMessage,
  subscribeDirectMessages,
} from "./nostr-messages";
import { compactPublicKey, conversationThreads, formatMessageTime, mergeMessageContact, mergeMessages } from "./messages-state";
import "./messages.css";

function resultError(result, fallback) {
  const code = result?.body?.error || "";
  if (code === "nostr_recipient_not_active") return "That member has not activated Task Node Messages yet.";
  if (code === "collaboration_identity_not_found") return "No discoverable Task Node member has that exact handle.";
  if (code === "nostr_tasknode_handle_required") return "Set a Task Node handle before activating Messages.";
  if (code === "nostr_discoverable_profile_required") return "Make your Task Node profile discoverable before activating Messages.";
  return result?.body?.message || code || fallback;
}

function initials(contact, publicKey) {
  const source = contact?.displayName || contact?.hiveHandle || publicKey || "?";
  return source.replace(/^@/, "").slice(0, 2).toUpperCase();
}

function contactLabel(contact, publicKey) {
  return contact?.displayName || (contact?.hiveHandle ? `@${contact.hiveHandle}` : compactPublicKey(publicKey));
}

function MessagesAvatar({ contact = {}, publicKey = "", size = 37 }) {
  const candidates = useMemo(
    () => profileNftImageCandidates(contact?.heroNft || {}, { avatarCssSize: size }),
    [contact?.heroNft, size]
  );
  const imageKey = candidates.join("|");
  const [imageIndex, setImageIndex] = useState(0);
  const imageSrc = candidates[imageIndex] || "";
  const label = contactLabel(contact, publicKey);

  useEffect(() => { setImageIndex(0); }, [imageKey]);

  return <span
    aria-label={`${label} profile picture`}
    className={`messages-avatar ${imageSrc ? "has-image" : ""}`}
    style={{ "--messages-avatar-size": `${size}px` }}
    title={label}
  >
    {imageSrc
      ? <img alt="" decoding="async" loading="lazy" onError={() => setImageIndex((index) => index + 1)} src={imageSrc} />
      : initials(contact, publicKey)}
  </span>;
}

function contactStorageKey(accountId) {
  return `tasknode.nostr.contacts.v1.${String(accountId || "anonymous")}`;
}

function readContacts(accountId) {
  try {
    const parsed = JSON.parse(localStorage.getItem(contactStorageKey(accountId)) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeContacts(accountId, contacts) {
  try {
    localStorage.setItem(contactStorageKey(accountId), JSON.stringify(contacts));
  } catch {
    // Contact labels are a convenience cache; messaging still works without it.
  }
}

export function MessagesView({ accountId, onOpenProfile, onWalletUnlock, walletSecret }) {
  const [bootstrap, setBootstrap] = useState(null);
  const [privateIdentity, setPrivateIdentity] = useState(null);
  const [messages, setMessages] = useState([]);
  const [contacts, setContacts] = useState(() => readContacts(accountId));
  const [selectedPeer, setSelectedPeer] = useState("");
  const [newMessageOpen, setNewMessageOpen] = useState(false);
  const [target, setTarget] = useState("");
  const [resolvedTarget, setResolvedTarget] = useState(null);
  const [composer, setComposer] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [connectionStatus, setConnectionStatus] = useState("idle");
  const scrollRef = useRef(null);
  const walletUnlockedRef = useRef(Boolean(walletSecret?.mnemonic));

  const loadBootstrap = useCallback(async () => {
    const result = await requestJson("/api/messages/bootstrap");
    if (!result.ok) {
      setError(resultError(result, "Could not load Messages."));
      return null;
    }
    setBootstrap(result.body);
    return result.body;
  }, []);

  useEffect(() => { void loadBootstrap(); }, [loadBootstrap]);
  useEffect(() => {
    const next = readContacts(accountId);
    setContacts(next);
    setMessages([]);
    setSelectedPeer("");
  }, [accountId]);
  useEffect(() => { writeContacts(accountId, contacts); }, [accountId, contacts]);

  const relays = useMemo(() => normalizeMessageRelays([
    ...(bootstrap?.binding?.preferredRelays || []),
    ...(bootstrap?.defaultRelays || DEFAULT_MESSAGE_RELAYS),
  ]), [bootstrap]);

  const hydrateContactLabels = useCallback(async (incoming) => {
    if (!incoming.length) return;
    try {
      const directoryResponse = await fetch("/.well-known/nostr.json", { cache: "no-store" });
      if (!directoryResponse.ok) return;
      const directory = await directoryResponse.json();
      const namesByPubkey = Object.fromEntries(Object.entries(directory.names || {}).map(([name, pubkey]) => [pubkey, name]));
      setContacts((current) => {
        const next = { ...current };
        incoming.forEach((message) => {
          const handle = namesByPubkey[message.peerPublicKey];
          const profile = directory.profiles?.[message.peerPublicKey] || {};
          if (!handle && !Object.keys(profile).length) return;
          next[message.peerPublicKey] = mergeMessageContact(next[message.peerPublicKey], {
            ...profile,
            hiveHandle: profile.hiveHandle || handle,
            displayName: profile.displayName || (handle ? `@${handle}` : ""),
          });
        });
        return next;
      });
    } catch {
      // The encrypted message can still render by public key if the handle directory is temporarily unavailable.
    }
  }, []);

  const syncMessages = useCallback(async (identity = privateIdentity, { silent = false, since } = {}) => {
    if (!identity?.privateKey || !relays.length) return;
    if (!silent) {
      setBusy("sync");
      setError("");
    }
    try {
      const incoming = await fetchDirectMessages({ privateKey: identity.privateKey, relays, since });
      if (!walletUnlockedRef.current) return;
      setMessages((current) => mergeMessages(current, incoming));
      void hydrateContactLabels(incoming);
    } catch (syncError) {
      if (!silent) setError(syncError.message || "Could not reach Nostr relays.");
    } finally {
      if (!silent) setBusy("");
    }
  }, [hydrateContactLabels, privateIdentity, relays]);

  useEffect(() => {
    walletUnlockedRef.current = Boolean(walletSecret?.mnemonic);
    if (!walletSecret?.mnemonic) {
      setMessages([]);
      setComposer("");
      setConnectionStatus("idle");
    }
  }, [walletSecret?.mnemonic]);

  useEffect(() => {
    let cancelled = false;
    async function unlockIdentity() {
      if (!bootstrap?.binding || !walletSecret?.mnemonic) {
        setPrivateIdentity(null);
        return;
      }
      try {
        const identity = await deriveNostrMessagingIdentity({ accountId, walletSecret });
        if (identity.publicKeyHex !== bootstrap.binding.nostrPubkeyHex) {
          throw new Error("This wallet does not match the activated Messages identity.");
        }
        if (!cancelled) {
          setPrivateIdentity(identity);
          void syncMessages(identity);
        }
      } catch (unlockError) {
        if (!cancelled) setError(unlockError.message);
      }
    }
    void unlockIdentity();
    return () => { cancelled = true; };
  }, [accountId, bootstrap?.binding, walletSecret?.mnemonic]);

  useEffect(() => {
    if (!privateIdentity?.privateKey || !relays.length) return undefined;
    const subscription = subscribeDirectMessages({
      privateKey: privateIdentity.privateKey,
      relays,
      onMessage(message) {
        if (!walletUnlockedRef.current) return;
        setMessages((current) => mergeMessages(current, [message]));
        void hydrateContactLabels([message]);
      },
      onStatus({ status }) {
        if (walletUnlockedRef.current) setConnectionStatus(status);
      },
    });
    const catchUp = createDirectMessageCatchUp({
      sync: () => syncMessages(privateIdentity, { silent: true, since: directMessageCatchUpSince() }),
      shouldRun: () => document.visibilityState === "visible" && navigator.onLine !== false,
    });
    const backfillAfterInterruption = () => {
      if (document.visibilityState === "visible" && navigator.onLine !== false) {
        catchUp.runNow();
      }
    };
    window.addEventListener("online", backfillAfterInterruption);
    document.addEventListener("visibilitychange", backfillAfterInterruption);
    return () => {
      window.removeEventListener("online", backfillAfterInterruption);
      document.removeEventListener("visibilitychange", backfillAfterInterruption);
      catchUp.close();
      subscription.close();
      setConnectionStatus("idle");
    };
  }, [hydrateContactLabels, privateIdentity, relays, syncMessages]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, selectedPeer]);

  const threads = useMemo(() => conversationThreads(messages, contacts), [contacts, messages]);
  const selectedThread = threads.find((thread) => thread.publicKey === selectedPeer) || null;
  const selfContact = useMemo(() => ({
    accountId,
    displayName: bootstrap?.identity?.displayName || (bootstrap?.identity?.nostrName ? `@${bootstrap.identity.nostrName}` : "You"),
    hiveHandle: bootstrap?.identity?.hiveHandle || bootstrap?.identity?.nostrName || "",
    heroNft: bootstrap?.identity?.heroNft || null,
  }), [accountId, bootstrap?.identity]);

  async function activateMessages() {
    if (!walletSecret?.mnemonic) return onWalletUnlock?.();
    if (!bootstrap?.identity?.nip05) return onOpenProfile?.();
    setBusy("activate");
    setError("");
    try {
      const identity = await deriveNostrMessagingIdentity({ accountId, walletSecret });
      const preferredRelays = normalizeMessageRelays(bootstrap.defaultRelays || DEFAULT_MESSAGE_RELAYS);
      const payload = {
        nostrPubkeyHex: identity.publicKeyHex,
        npub: identity.npub,
        nip05: bootstrap.identity.nip05,
        preferredRelays,
        visibility: "public",
      };
      const proof = await signedCollaborationProof({
        action: "nostr_bind",
        resourceId: identity.publicKeyHex,
        payload,
        walletSecret,
      });
      const result = await requestJson("/api/messages/identity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, proof }),
      });
      if (!result.ok) throw new Error(resultError(result, "Could not activate Messages."));
      setPrivateIdentity(identity);
      await loadBootstrap();
    } catch (activationError) {
      setError(activationError.message);
    } finally {
      setBusy("");
    }
  }

  async function resolveTarget() {
    const value = target.trim();
    if (!value) return;
    setBusy("resolve");
    setError("");
    setResolvedTarget(null);
    try {
      const result = await requestJson(`/api/messages/resolve?q=${encodeURIComponent(value)}`);
      if (!result.ok) throw new Error(resultError(result, "Could not find that member."));
      setResolvedTarget(result.body);
    } catch (resolveError) {
      setError(resolveError.message);
    } finally {
      setBusy("");
    }
  }

  function startResolvedConversation() {
    if (!resolvedTarget?.nostr?.nostrPubkeyHex) return;
    const pubkey = resolvedTarget.nostr.nostrPubkeyHex;
    setContacts((current) => ({ ...current, [pubkey]: mergeMessageContact(current[pubkey], {
      accountId: resolvedTarget.identity.accountId,
      displayName: resolvedTarget.identity.displayName,
      hiveHandle: resolvedTarget.identity.hiveHandle,
      nip05: resolvedTarget.nostr.nip05,
      preferredRelays: resolvedTarget.nostr.preferredRelays,
      heroNft: resolvedTarget.identity.heroNft,
    }) }));
    setSelectedPeer(pubkey);
    setNewMessageOpen(false);
    setTarget("");
    setResolvedTarget(null);
  }

  async function sendMessage(event) {
    event.preventDefault();
    if (!privateIdentity?.privateKey) return onWalletUnlock?.();
    const content = composer.trim();
    if (!selectedPeer || !content) return;
    setBusy("send");
    setError("");
    try {
      const result = await publishDirectMessage({
        privateKey: privateIdentity.privateKey,
        recipientPublicKey: selectedPeer,
        recipientRelays: contacts[selectedPeer]?.preferredRelays || [],
        relays,
        message: content,
      });
      if (!walletUnlockedRef.current) return;
      setMessages((current) => mergeMessages(current, [result.message]));
      setComposer("");
    } catch (sendError) {
      setError(sendError.message || "Message was not accepted by a relay.");
    } finally {
      setBusy("");
    }
  }

  if (!bootstrap) return <div className="messages-route-state">Loading Messages…</div>;

  if (!bootstrap.identity?.nostrName) return <div className="messages-onboarding">
    <div className="messages-onboarding-icon"><MessageCircleMore size={28} /></div>
    <span>Task Node Messages</span>
    <h1>Choose your Task Node handle first.</h1>
    <p>Your handle becomes the human-readable address people use to find you. No separate Nostr username is required.</p>
    {error && <p className="messages-error">{error}</p>}
    <button className="messages-primary" onClick={onOpenProfile} type="button">Set up my handle</button>
  </div>;

  if (!bootstrap.identity.discoverable && !bootstrap.binding) return <div className="messages-onboarding">
    <div className="messages-onboarding-icon"><ShieldCheck size={28} /></div>
    <span>Task Node Messages</span>
    <h1>Make <strong>@{bootstrap.identity.nostrName}</strong> discoverable.</h1>
    <p>Messaging by handle requires a public Task Node identity so other members can resolve the correct Nostr public key.</p>
    {error && <p className="messages-error">{error}</p>}
    <button className="messages-primary" onClick={onOpenProfile} type="button">Open profile settings</button>
  </div>;

  if (!bootstrap.binding) return <div className="messages-onboarding">
    <div className="messages-onboarding-icon"><LockKeyhole size={28} /></div>
    <span>Private messages over Nostr</span>
    <h1>Activate <strong>@{bootstrap.identity.nostrName}</strong></h1>
    <p>This creates a wallet-bound messaging identity for <code>{bootstrap.identity.nip05}</code>. Your Nostr key is derived only while your wallet is unlocked and is never uploaded.</p>
    <div className="messages-onboarding-points">
      <span><ShieldCheck size={16} /><b>End-to-end encrypted</b><small>NIP-17 gift-wrapped messages</small></span>
      <span><Wifi size={16} /><b>Relay delivered</b><small>No Task Node message database</small></span>
      <span><KeyRound size={16} /><b>Wallet controlled</b><small>Same identity on every device</small></span>
    </div>
    {error && <p className="messages-error">{error}</p>}
    <button className="messages-primary" disabled={busy === "activate"} onClick={activateMessages} type="button">
      {busy === "activate" ? "Activating…" : walletSecret?.mnemonic ? "Activate Messages" : "Unlock wallet to activate"}
    </button>
  </div>;

  if (!privateIdentity) return <div className="messages-onboarding">
    <div className="messages-onboarding-icon"><KeyRound size={28} /></div>
    <span>@{bootstrap.identity.nostrName} · active</span>
    <h1>Unlock your wallet to read Messages.</h1>
    <p>Only your unlocked wallet can reconstruct the local key that decrypts your Nostr inbox.</p>
    {error && <p className="messages-error">{error}</p>}
    <button className="messages-primary" onClick={onWalletUnlock} type="button">Unlock wallet</button>
  </div>;

  return <div className={`messages-page ${selectedPeer ? "has-thread" : ""}`}>
    <aside className="messages-list-panel">
      <header>
        <div><span>Encrypted over Nostr</span><h1>Messages</h1></div>
        <button aria-label="New message" onClick={() => setNewMessageOpen(true)} type="button"><Plus size={19} /></button>
      </header>
      <div className="messages-identity-strip"><span aria-live="polite"><Circle className={connectionStatus === "live" ? "is-live" : ""} fill="currentColor" size={7} />@{bootstrap.identity.nostrName} · {connectionStatus === "live" ? "Live" : connectionStatus === "connecting" ? "Connecting" : "Reconnecting"}</span><button disabled={busy === "sync"} onClick={() => syncMessages()} title="Manually check relays" type="button"><RefreshCw className={busy === "sync" ? "is-spinning" : ""} size={13} />Retry</button></div>
      <div className="messages-thread-list">
        {threads.map((thread) => <button className={thread.publicKey === selectedPeer ? "active" : ""} key={thread.publicKey} onClick={() => setSelectedPeer(thread.publicKey)} type="button">
          <MessagesAvatar contact={thread.contact} publicKey={thread.publicKey} />
          <span><strong>{contactLabel(thread.contact, thread.publicKey)}</strong><small>{thread.latest?.content || "New conversation"}</small></span>
          <time>{thread.latest ? formatMessageTime(thread.latest.createdAt) : ""}</time>
        </button>)}
        {!threads.length && <div className="messages-list-empty"><MessageCircleMore size={21} /><strong>Your inbox is quiet.</strong><span>Start with an exact Task Node handle.</span><button onClick={() => setNewMessageOpen(true)} type="button">New message</button></div>}
      </div>
    </aside>

    <section className="messages-conversation-panel">
      {selectedThread ? <>
        <header>
          <button className="messages-mobile-back" aria-label="Back to conversations" onClick={() => setSelectedPeer("")} type="button"><ArrowLeft size={19} /></button>
          <MessagesAvatar contact={selectedThread.contact} publicKey={selectedPeer} />
          <div><strong>{contactLabel(selectedThread.contact, selectedPeer)}</strong><small>{selectedThread.contact?.nip05 || compactPublicKey(selectedPeer)}</small></div>
          <span className="messages-verified"><Check size={12} />Task Node identity</span>
        </header>
        <div className="messages-transcript" ref={scrollRef}>
          {!selectedThread.messages.length && <div className="messages-conversation-empty"><LockKeyhole size={22} /><strong>Private conversation</strong><span>Messages are encrypted before they leave this browser.</span></div>}
          {selectedThread.messages.map((message) => {
            const author = message.mine ? selfContact : selectedThread.contact;
            const authorKey = message.mine ? privateIdentity.publicKeyHex : selectedPeer;
            return <article className={message.mine ? "mine" : "theirs"} key={message.id}>
              <MessagesAvatar contact={author} publicKey={authorKey} size={24} />
              <div className="messages-message-body"><p>{message.content}</p><time>{formatMessageTime(message.createdAt)}</time></div>
            </article>;
          })}
        </div>
        <form className="messages-composer" onSubmit={sendMessage}>
          {error && <p className="messages-error">{error}</p>}
          <div><textarea aria-label="Message" maxLength={8000} onChange={(event) => setComposer(event.target.value)} placeholder={`Message ${contactLabel(selectedThread.contact, selectedPeer)}`} rows={1} value={composer} /><ComposerSendButton ariaLabel="Send message" disabled={!composer.trim() || busy === "send"} /></div>
          <small><LockKeyhole size={11} />End-to-end encrypted · delivered by {relays.length} Nostr relays</small>
        </form>
      </> : <div className="messages-conversation-placeholder"><div><MessageCircleMore size={27} /></div><h2>Your private line to Task Node.</h2><p>Choose a conversation or start a new one using a Task Node handle.</p><button className="messages-primary" onClick={() => setNewMessageOpen(true)} type="button"><Plus size={16} />New message</button>{error && <p className="messages-error">{error}</p>}</div>}
    </section>

    {newMessageOpen && <div className="messages-dialog-backdrop" onMouseDown={() => setNewMessageOpen(false)}><section className="messages-dialog" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><span>New private message</span><h2>Find a Task Node member</h2></div><button aria-label="Close" onClick={() => setNewMessageOpen(false)} type="button">×</button></header>
      <label>Exact Task Node handle<div><Search size={16} /><input autoFocus onChange={(event) => { setTarget(event.target.value); setResolvedTarget(null); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void resolveTarget(); } }} placeholder="@handle" value={target} /></div></label>
      <button className="messages-primary" disabled={!target.trim() || busy === "resolve"} onClick={resolveTarget} type="button">{busy === "resolve" ? "Looking…" : "Find member"}</button>
      {error && <p className="messages-error">{error}</p>}
      {resolvedTarget && <article className="messages-resolved-contact"><MessagesAvatar contact={resolvedTarget.identity} publicKey={resolvedTarget.nostr.nostrPubkeyHex} /><div><strong>{resolvedTarget.identity.displayName}</strong><small>{resolvedTarget.nostr.nip05}</small></div><button onClick={startResolvedConversation} type="button">Message</button></article>}
    </section></div>}
  </div>;
}
