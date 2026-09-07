import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, AtSign, Bot, ExternalLink, Globe, MessageCircle, Reply, Users, X } from "lucide-react";
import { SimplePool } from "nostr-tools/pool";
import { neventEncode, npubEncode } from "nostr-tools/nip19";
import { requestJson } from "../../api";
import { deriveNostrMessagingIdentity } from "../messages/nostr-messages";
import { ComposerSendButton } from "../chat/ComposerSendButton.jsx";
import { ProfilePortrait } from "../profile/ProfilePortrait.jsx";
import { createHiveGroupEvent, hiveEventReplyId, hiveMentions, HIVE_MESSAGE_MAX, mergeHiveGroupMessages, validateHiveGroupEvent } from "../../../shared/hive-group.js";
import "./hive-navigation.css";
import "./hive-group.css";

const post = (path, body) => requestJson(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
const profileLink = (member) => member?.accountId ? `#/profile?account=${encodeURIComponent(member.accountId)}` : `https://njump.me/${npubEncode(member.pubkey)}`;
const eventLink = (event, relays) => `https://njump.me/${neventEncode({ id: event.id, author: event.pubkey, relays })}`;

function MessageText({ content, members }) {
  const pieces = [];
  let position = 0;
  for (const mention of hiveMentions(content, members)) {
    pieces.push(content.slice(position, mention.start));
    pieces.push(<a className="hgc-mention" href={profileLink(mention.member)} key={mention.start}>{content.slice(mention.start, mention.end)}</a>);
    position = mention.end;
  }
  pieces.push(content.slice(position));
  return pieces;
}

function LegacyArchive({ onClose }) {
  const [state, setState] = useState({ loading: true, messages: [] });
  useEffect(() => {
    let active = true;
    const read = async () => {
      try {
        const conversation = await requestJson("/api/hive/chat");
        if (!conversation.ok) throw new Error("Could not load your archive.");
        const id = conversation.body?.conversation?.id;
        const history = id ? await requestJson(`/api/chat/history?conversationId=${encodeURIComponent(id)}`) : { ok: true, body: { messages: [] } };
        if (!history.ok) throw new Error("Could not load your archive.");
        if (active) setState({ messages: history.body?.messages || [] });
      } catch (error) { if (active) setState({ messages: [], error: error.message }); }
    };
    void read();
    return () => { active = false; };
  }, []);
  return <section className="hgc-archive"><button className="hgc-button" onClick={onClose} type="button"><ArrowLeft size={15} />Back to group chat</button>
    <h2>Previous private Hive chat</h2><p>This archive is private to your account. It has not been shared with the group.</p>
    {state.loading && <p>Loading your archive…</p>}{state.error && <p role="alert">{state.error}</p>}
    {!state.loading && !state.messages.length && !state.error && <p>No previous messages.</p>}
    {state.messages.map((message, index) => <article key={message.id || index}><strong>{message.role === "user" ? "You" : "Hive"}</strong><p>{message.content || message.text || ""}</p></article>)}
  </section>;
}

export function HiveGroupChat(props) {
  return <HiveGroupRoom key={props.accountId || "guest"} {...props} />;
}

function HiveGroupRoom({ accountId, walletSecret, onWalletUnlock, onOpenMessages, onLoginRequired, onUnreadChange }) {
  const [data, setData] = useState(null);
  const [messages, setMessages] = useState([]);
  const [error, setError] = useState("");
  const [syncError, setSyncError] = useState("");
  const [draft, setDraft] = useState(() => { try { return sessionStorage.getItem(`hive.draft.${accountId}`) || ""; } catch { return ""; } });
  const [replyTo, setReplyTo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [archive, setArchive] = useState(false);
  const [mention, setMention] = useState(null);
  const [selectedMention, setSelectedMention] = useState(0);
  const [relayLive, setRelayLive] = useState(false);
  const scroll = useRef(null), input = useRef(null), nearBottom = useRef(true), alive = useRef(true);
  const membersRef = useRef([]), readThrough = useRef(0), unreadCallback = useRef(onUnreadChange);
  const pendingEvent = useRef(undefined);
  if (pendingEvent.current === undefined) {
    try { pendingEvent.current = JSON.parse(sessionStorage.getItem(`hive.pending.${accountId}`) || "null"); } catch { pendingEvent.current = null; }
  }
  const members = useMemo(() => data?.members || [], [data?.members]);
  membersRef.current = members;
  unreadCallback.current = onUnreadChange;
  const self = members.find(member => member.accountId === accountId && !member.bot);
  const rootId = data?.channel?.rootEvent?.id;
  const relayKey = JSON.stringify(data?.channel?.relays || []);
  const suggestions = useMemo(() => mention ? members.filter(member => member.handle.toLowerCase().startsWith(mention.query.toLowerCase())).slice(0, 6) : [], [mention, members]);

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { try { sessionStorage.setItem(`hive.draft.${accountId}`, draft); } catch { /* Drafts remain in memory if storage is unavailable. */ } }, [accountId, draft]);
  useEffect(() => {
    let active = true, fetching = false;
    const refresh = async () => {
      if (fetching || document.hidden) return;
      fetching = true;
      try {
        const result = await requestJson("/api/hive/group", { signal: AbortSignal.timeout(15_000) });
        if (!result.ok || !result.body?.ok) throw new Error("Reconnecting to Hive. Your messages will stay here.");
        if (!active) return;
        setData(result.body); setSyncError("");
        setMessages(current => mergeHiveGroupMessages(current, result.body.messages || []));
        const through = Math.max(0, ...(result.body.messages || []).map(message => message.sequence));
        if (accountId && through > readThrough.current) {
          const read = await post("/api/hive/group/read", { sequence: through });
          if (active && read.ok) { readThrough.current = through; unreadCallback.current?.(0); }
        }
      } catch (error) { if (active) setSyncError(error.message); }
      finally { fetching = false; }
    };
    void refresh(); const timer = setInterval(refresh, 5000);
    document.addEventListener("visibilitychange", refresh);
    return () => { active = false; clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [accountId]);

  useEffect(() => {
    if (!rootId) return;
    const relays = JSON.parse(relayKey);
    const pool = new SimplePool({ enableReconnect: true });
    const subscription = pool.subscribeMany(relays, { kinds: [1], "#e": [rootId], since: Math.floor(Date.now() / 1000) - 600, limit: 200 }, {
      onevent: event => {
        const author = membersRef.current.find(member => member.pubkey === event.pubkey);
        if (!author) return;
        try { validateHiveGroupEvent(event, { rootId, authorPubkey: author.pubkey }); } catch { return; }
        setRelayLive(true);
        setMessages(current => mergeHiveGroupMessages(current, [{ id: event.id, sequence: 0, event, author, actor: author.bot ? "board" : "member", delivery: "delivered" }]));
      }, oneose: () => setRelayLive(true), onclose: () => setRelayLive(false),
    });
    return () => { subscription.close(); pool.destroy(); };
  }, [rootId, relayKey]);
  useEffect(() => { if (nearBottom.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [messages]);

  function updateDraft(value, caret = value.length) {
    setDraft(value); pendingEvent.current = null; setError("");
    try { sessionStorage.removeItem(`hive.pending.${accountId}`); } catch { /* Optional browser persistence. */ }
    let start = caret - 1;
    while (start >= 0 && ![" ", "\n", "\t"].includes(value[start])) start--;
    const word = value.slice(start + 1, caret);
    setMention(word.startsWith("@") ? { start: start + 1, end: caret, query: word.slice(1) } : null);
    setSelectedMention(0);
  }
  function chooseMention(member) {
    const value = `${draft.slice(0, mention.start)}@${member.handle} ${draft.slice(mention.end)}`;
    const caret = mention.start + member.handle.length + 2;
    setDraft(value); setMention(null); pendingEvent.current = null;
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(caret, caret); });
  }
  async function send(event) {
    event?.preventDefault();
    if (busy || !draft.trim() || !self || !data?.channel?.ready) return;
    if (!walletSecret?.mnemonic) return onWalletUnlock?.();
    setBusy(true); setError("");
    const content = draft;
    try {
      const identity = await deriveNostrMessagingIdentity({ accountId, walletSecret });
      if (!alive.current) return;
      if (identity.publicKeyHex !== self.pubkey) throw new Error("This wallet does not match your Messages identity. Open Messages to reconnect it.");
      const previous = pendingEvent.current;
      const reusable = previous && previous.content === content.trim() && previous.pubkey === self.pubkey && previous.tags.some(tag => tag[0] === "e" && tag[1] === rootId && tag[3] === "root");
      const signed = (reusable ? previous : null) || createHiveGroupEvent({ privateKey: identity.privateKey, rootId,
        relay: data.channel.relays[0], content, replyTo: replyTo?.id || "", mentions: hiveMentions(content, members).map(item => item.member.pubkey) });
      pendingEvent.current = signed;
      try { sessionStorage.setItem(`hive.pending.${accountId}`, JSON.stringify(signed)); } catch { /* Same-id retry remains available in memory. */ }
      const result = await post("/api/hive/group/messages", { event: signed });
      if (!result.ok || !result.body?.ok) throw new Error(result.body?.message || "Could not send. Your draft is saved; retry when connected.");
      if (!alive.current) return;
      nearBottom.current = true;
      setMessages(current => mergeHiveGroupMessages(current, [result.body.message]));
      setDraft(current => current === content ? "" : current); setReplyTo(null); setMention(null); pendingEvent.current = null;
      try { sessionStorage.removeItem(`hive.pending.${accountId}`); } catch { /* Optional browser persistence. */ }
    } catch (error) { if (alive.current) setError(error.message); }
    finally { if (alive.current) setBusy(false); }
  }
  function onKeyDown(event) {
    if (event.nativeEvent.isComposing) return;
    if (suggestions.length && ["ArrowDown", "ArrowUp", "Enter", "Tab"].includes(event.key)) {
      event.preventDefault();
      if (event.key === "ArrowDown") setSelectedMention(index => (index + 1) % suggestions.length);
      else if (event.key === "ArrowUp") setSelectedMention(index => (index + suggestions.length - 1) % suggestions.length);
      else chooseMention(suggestions[selectedMention] || suggestions[0]);
    } else if (event.key === "Escape") setMention(null);
    else if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); }
  }

  if (archive) return <LegacyArchive onClose={() => setArchive(false)} />;
  return <div className={`hgc-page ${showMembers ? "hgc-members-open" : ""}`}>
    <header className="hgc-header"><div className="hgc-room-icon"><MessageCircle size={22} /></div><div><h1>Hive chat</h1><p><Globe size={12} />Public group · Nostr<span className={relayLive ? "hgc-live" : ""}>{relayLive ? "Live" : data ? "Synced feed" : "Connecting…"}</span></p></div>
      <button className="hgc-button" aria-expanded={showMembers} onClick={() => setShowMembers(value => !value)} type="button"><Users size={16} /><span>{members.filter(member => !member.bot).length} members</span></button>
    </header>
    <section className="hgc-conversation" aria-label="Hive group chat">
      <div className="hgc-transcript" ref={scroll} onScroll={() => { const node = scroll.current; nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100; }} role="log" aria-label="Group messages" aria-live="polite" aria-relevant="additions">
        {!data && !syncError && <p className="hgc-muted">Connecting to Hive…</p>}
        {messages.map(message => {
          const author = members.find(member => member.pubkey === message.event.pubkey) || message.author;
          const parent = messages.find(item => item.id === hiveEventReplyId(message.event));
          const board = message.actor !== "member";
          return <article className={`hgc-message ${board ? "hgc-bot-message" : ""}`} id={`hive-${message.id}`} key={message.id}>
            <a href={profileLink(author)} className="hgc-avatar-link" aria-label={`View @${author.handle}`}><ProfilePortrait nft={author.heroNft} seed={author.pubkey} label={`@${author.handle} profile picture`} size={38} /></a>
            <div className="hgc-message-main"><div className="hgc-message-meta"><a href={profileLink(author)} title={author.nip05}>@{author.handle}</a>{board && <span className="hgc-bot-label"><Bot size={11} />{message.actor === "board_manager" ? "Kimi board manager" : "Bot"}</span>}<a className="hgc-event-time" href={eventLink(message.event, data?.channel?.relays || [])} target="_blank" rel="noreferrer" title="Open signed Nostr message"><time dateTime={new Date(message.event.created_at * 1000).toISOString()}>{new Date(message.event.created_at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time><ExternalLink size={10} /></a></div>
              {parent && <a className="hgc-reply-preview" href={`#hive-${parent.id}`} onClick={event => { event.preventDefault(); document.getElementById(`hive-${parent.id}`)?.scrollIntoView({ block: "center", behavior: "smooth" }); }}><Reply size={12} />@{parent.author.handle} · {parent.event.content.slice(0, 100)}</a>}
              <p className="hgc-message-text"><MessageText content={message.event.content} members={members} /></p>
              {message.delivery === "pending" && <small className="hgc-pending">Saved · waiting for a relay. Retrying automatically.</small>}
              {message.escalation && <small className="hgc-escalation"><Bot size={12} />{message.escalation.state === "pending" ? "Queued for the Kimi board manager" : "Board manager replied"}</small>}
            </div>
            {self && <button className="hgc-reply-button" aria-label={`Reply to @${author.handle}`} onClick={() => { setReplyTo(message); pendingEvent.current = null; input.current?.focus(); }} type="button"><Reply size={14} /></button>}
          </article>;
        })}
      </div>
      {syncError && <div className="hgc-notice" role="status">{syncError}</div>}
      <footer className="hgc-footer">
        {!accountId ? <div className="hgc-join"><div><strong>Join the conversation</strong><p>Sign in to chat with your Task Node handle.</p></div><button className="hgc-primary" onClick={onLoginRequired} type="button">Sign in</button></div>
          : !data ? null : !self ? <div className="hgc-join"><div><strong>Your handle. Your picture. Your people.</strong><p>Activate your Nostr identity in Messages to join Hive.</p></div><button className="hgc-primary" onClick={onOpenMessages} type="button">Set up Messages</button></div>
          : !walletSecret?.mnemonic ? <div className="hgc-join"><div><strong>You’re here as @{self.handle}</strong><p>Unlock your wallet to send a message.</p></div><button className="hgc-primary" onClick={onWalletUnlock} type="button">Unlock to chat</button></div>
          : <form onSubmit={send} className="hgc-composer">
            {replyTo && <div className="hgc-composer-reply"><Reply size={14} /><span>Replying to @{replyTo.author.handle}</span><button aria-label="Cancel reply" onClick={() => { setReplyTo(null); pendingEvent.current = null; }} type="button"><X size={14} /></button></div>}
            {error && <p className="hgc-error" role="alert">{error}</p>}
            {suggestions.length > 0 && <div className="hgc-suggestions" role="listbox" aria-label="Mention a member">{suggestions.map((member, index) => <button key={member.pubkey} id={`mention-${index}`} role="option" aria-selected={selectedMention === index} onMouseDown={event => event.preventDefault()} onClick={() => chooseMention(member)} type="button"><ProfilePortrait nft={member.heroNft} seed={member.pubkey} size={28} /><strong>@{member.handle}</strong><small>{member.bot ? "Board bot" : member.displayName}</small></button>)}</div>}
            <div className="hgc-input-row"><ProfilePortrait nft={self.heroNft} seed={self.pubkey} size={30} /><textarea ref={input} aria-label="Message Hive" aria-autocomplete="list" aria-activedescendant={suggestions.length ? `mention-${selectedMention}` : undefined} rows={2} maxLength={HIVE_MESSAGE_MAX} value={draft} disabled={busy} onChange={event => updateDraft(event.target.value, event.target.selectionStart)} onKeyDown={onKeyDown} placeholder="Message the Hive… use @ to tag someone" /><ComposerSendButton ariaLabel="Send to Hive" disabled={busy || !draft.trim() || !data.channel?.ready} /></div>
            <small><Globe size={11} />Public on Nostr · sent as @{self.handle}<span>{busy ? "Sending…" : "Enter to send · Shift + Enter for a new line"}</span></small>
          </form>}
      </footer>
    </section>
    <aside className="hgc-members" aria-label="Hive members"><div className="hgc-members-heading"><h2>People in Hive</h2><button aria-label="Close members" onClick={() => setShowMembers(false)} type="button"><X size={15} /></button></div><p className="hgc-muted">Shared handles. Familiar faces.</p>
      <div className="hgc-member-list">{members.map(member => <a href={profileLink(member)} key={member.pubkey}><ProfilePortrait nft={member.heroNft} seed={member.pubkey} size={33} /><span><strong>@{member.handle}</strong><small>{member.bot ? "Automated participant" : member.displayName || member.nip05}</small></span></a>)}</div>
      <div className="hgc-about"><AtSign size={17} /><strong>One identity across Task Node</strong><p>Your Messages address and profile picture follow you here.</p><button className="hgc-button" onClick={onOpenMessages} type="button">Open Messages</button></div>
      {accountId && <button className="hgc-archive-link" onClick={() => setArchive(true)} type="button">Previous private Hive chat</button>}
    </aside>
  </div>;
}
