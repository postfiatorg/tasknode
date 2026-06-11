import React, { useEffect, useMemo, useRef, useState } from "react";
import { MessageSquare, Network, Search, X } from "lucide-react";
import { requestJson } from "../../api";
import "./chat-search.css";

const searchDebounceMs = 250;
const minQueryLength = 2;

function highlightMatch(text, queryText) {
  const source = String(text || "");
  const needle = String(queryText || "").trim();
  if (!needle) return source;
  const matchIndex = source.toLowerCase().indexOf(needle.toLowerCase());
  if (matchIndex < 0) return source;
  return (
    <>
      {source.slice(0, matchIndex)}
      <mark className="chat-search-match">{source.slice(matchIndex, matchIndex + needle.length)}</mark>
      {source.slice(matchIndex + needle.length)}
    </>
  );
}

function localTitleMatches(recentChats, queryText) {
  const needle = String(queryText || "").trim().toLowerCase();
  if (!needle) return [];
  return (recentChats || []).filter((item) => String(item?.title || "").toLowerCase().includes(needle));
}

export function ChatSearchModal({ onClose, onOpenChat, recentChats, signedIn }) {
  const [query, setQuery] = useState("");
  const [serverResults, setServerResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const requestSequenceRef = useRef(0);

  const trimmedQuery = query.trim();
  const searchable = signedIn && trimmedQuery.length >= minQueryLength;

  useEffect(() => {
    if (!searchable) {
      requestSequenceRef.current += 1;
      setServerResults([]);
      setLoading(false);
      setMessage("");
      return undefined;
    }

    const requestId = requestSequenceRef.current + 1;
    requestSequenceRef.current = requestId;
    setLoading(true);
    setMessage("");
    const timer = window.setTimeout(async () => {
      try {
        const result = await requestJson(`/api/chat/search?q=${encodeURIComponent(trimmedQuery)}`);
        if (requestSequenceRef.current !== requestId) return;
        if (!result.ok) {
          setServerResults([]);
          setMessage(result.body?.message || "Chat search is unavailable right now.");
        } else {
          setServerResults(Array.isArray(result.body?.results) ? result.body.results : []);
        }
      } catch {
        if (requestSequenceRef.current !== requestId) return;
        setServerResults([]);
        setMessage("Chat search is unavailable right now.");
      } finally {
        if (requestSequenceRef.current === requestId) setLoading(false);
      }
    }, searchDebounceMs);

    return () => window.clearTimeout(timer);
  }, [searchable, trimmedQuery]);

  const results = useMemo(() => {
    if (!trimmedQuery) return [];
    const merged = new Map();
    for (const item of serverResults) {
      const conversationId = item?.conversationId || item?.id || "";
      if (!conversationId) continue;
      merged.set(conversationId, { ...item, id: conversationId, conversationId });
    }
    for (const item of localTitleMatches(recentChats, trimmedQuery)) {
      const conversationId = item?.conversationId || item?.id || "";
      if (!conversationId || merged.has(conversationId)) continue;
      merged.set(conversationId, {
        id: conversationId,
        conversationId,
        kind: item.kind || undefined,
        title: item.title,
        snippet: item.lastMessagePreview || "",
        matchSource: "title",
        updatedAt: item.updatedAt || "",
      });
    }
    return [...merged.values()];
  }, [recentChats, serverResults, trimmedQuery]);

  function openResult(item) {
    if (!item?.conversationId) return;
    onOpenChat({
      id: item.conversationId,
      conversationId: item.conversationId,
      kind: item.kind || "",
      source: "server",
      title: item.title || "New chat",
      lastMessagePreview: item.snippet || "",
      updatedAt: item.updatedAt || "",
    });
  }

  function handleInputKeyDown(event) {
    if (event.key === "Escape") {
      onClose();
      return;
    }
    if (event.key === "Enter" && results.length > 0) {
      openResult(results[0]);
    }
  }

  const showEmptyState =
    signedIn && trimmedQuery.length >= minQueryLength && !loading && results.length === 0 && !message;

  return (
    <div className="modal-backdrop chat-search-backdrop" onClick={onClose} role="presentation">
      <div
        aria-label="Search chats"
        aria-modal="true"
        className="chat-search-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header className="chat-search-header">
          <Search size={16} strokeWidth={1.75} />
          <input
            aria-label="Search chats"
            autoFocus
            className="chat-search-input"
            disabled={!signedIn}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder={signedIn ? "Search chats by title or message" : "Search chats"}
            type="text"
            value={query}
          />
          <button aria-label="Close chat search" className="chat-search-close" onClick={onClose} type="button">
            <X size={16} strokeWidth={1.75} />
          </button>
        </header>
        <div className="chat-search-body">
          {!signedIn ? (
            <div className="chat-search-note">Sign in to search your chats.</div>
          ) : trimmedQuery.length < minQueryLength ? (
            <div className="chat-search-note">Type at least two characters to search titles and messages.</div>
          ) : (
            <>
              {results.length > 0 && (
                <div className="chat-search-results" role="listbox" aria-label="Chat search results">
                  {results.map((item) => (
                    <button
                      className="chat-search-result"
                      key={item.id}
                      onClick={() => openResult(item)}
                      type="button"
                    >
                      <span className="chat-search-result-title">
                        {item.kind === "hive" ? (
                          <Network size={13} strokeWidth={1.8} />
                        ) : (
                          <MessageSquare size={13} strokeWidth={1.8} />
                        )}
                        <span>{highlightMatch(item.title, trimmedQuery)}</span>
                      </span>
                      {item.snippet ? (
                        <small className="chat-search-result-snippet">
                          {highlightMatch(item.snippet, trimmedQuery)}
                        </small>
                      ) : null}
                    </button>
                  ))}
                </div>
              )}
              {loading && <div className="chat-search-note">Searching…</div>}
              {message && <div className="chat-search-note chat-search-error">{message}</div>}
              {showEmptyState && <div className="chat-search-note">No matching chats.</div>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
