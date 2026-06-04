import React, { useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, ChevronRight, RefreshCw, Search } from "lucide-react";
import { requestJson } from "../../api";
import { DOC_GROUPS, DOC_PAGES, SYSTEM_STATUS_DOC_LINKS } from "./docs-content";
import { DocsDiagram } from "./DocsDiagram";
import "./docs.css";

const DEFAULT_DOC = "system-status-home";

export function DocsView() {
  const [selectedSlug, setSelectedSlug] = useState(() => docSlugFromLocation());
  const [pendingAnchor, setPendingAnchor] = useState("");
  const [query, setQuery] = useState("");
  const activeNavButtonRef = useRef(null);
  const contentRef = useRef(null);
  const selectedPage = DOC_PAGES.find((page) => page.slug === selectedSlug) || DOC_PAGES[0];
  const filteredGroups = useMemo(() => filterGroups(DOC_GROUPS, query), [query]);

  function openDocsPage(slug, anchor = "") {
    const nextSlug = DOC_PAGES.some((page) => page.slug === slug) ? slug : DEFAULT_DOC;
    setSelectedSlug(nextSlug);
    setPendingAnchor(anchor);
    setQuery("");
    writeDocsLocation(nextSlug);
  }

  useEffect(() => {
    if (!pendingAnchor || typeof window === "undefined") return;
    const anchor = pendingAnchor;
    window.requestAnimationFrame(() => {
      document.getElementById(anchor)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    setPendingAnchor("");
  }, [pendingAnchor]);

  useEffect(() => {
    if (pendingAnchor) return;
    contentRef.current?.scrollTo({ top: 0, left: 0, behavior: "auto" });
    activeNavButtonRef.current?.scrollIntoView({ block: "nearest" });
  }, [pendingAnchor, selectedSlug]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;

    function syncDocsSlug() {
      setSelectedSlug(docSlugFromLocation());
    }

    window.addEventListener("popstate", syncDocsSlug);
    window.addEventListener("hashchange", syncDocsSlug);
    return () => {
      window.removeEventListener("popstate", syncDocsSlug);
      window.removeEventListener("hashchange", syncDocsSlug);
    };
  }, []);

  return (
    <div className="docs-view">
      <aside className="docs-sidebar" aria-label="Docs navigation">
        <div className="docs-brand">
          <span>
            <BookOpen size={18} strokeWidth={1.75} />
          </span>
          <div>
            <strong>Task Node Docs</strong>
            <small>Product and architecture wiki</small>
          </div>
        </div>
        <label className="docs-search">
          <Search size={15} strokeWidth={1.75} />
          <input
            aria-label="Search docs"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search docs"
            type="search"
            value={query}
          />
        </label>
        <nav className="docs-nav">
          {filteredGroups.map((group) => (
            <section key={group.title}>
              <h2>{group.title}</h2>
              {group.pages.map((page) => (
                <button
                  className={page.slug === selectedPage.slug ? "active" : ""}
                  key={page.slug}
                  onClick={() => openDocsPage(page.slug)}
                  ref={page.slug === selectedPage.slug ? activeNavButtonRef : null}
                  type="button"
                >
                  <span>
                    <strong>{page.title}</strong>
                    <small>{page.summary}</small>
                  </span>
                  <ChevronRight size={14} strokeWidth={1.75} />
                </button>
              ))}
            </section>
          ))}
        </nav>
      </aside>
      <article className="docs-content" aria-labelledby="docs-page-title" ref={contentRef}>
        <header className="docs-header">
          <span>{selectedPage.group}</span>
          <h1 id="docs-page-title">{selectedPage.title}</h1>
          <p>{selectedPage.summary}</p>
        </header>
        <MarkdownArticle markdown={selectedPage.markdown} />
        {selectedPage.component === "system-status" && <SystemStatusPage onOpenDocPage={openDocsPage} />}
      </article>
    </div>
  );
}

function filterGroups(groups, query) {
  const needle = query.trim().toLowerCase();
  if (!needle) return groups;

  return groups
    .map((group) => ({
      ...group,
      pages: group.pages.filter((page) =>
        `${page.title} ${page.summary} ${page.markdown}`.toLowerCase().includes(needle)
      ),
    }))
    .filter((group) => group.pages.length > 0);
}

function docSlugFromLocation() {
  if (typeof window === "undefined") return DEFAULT_DOC;
  const hashPath = window.location.hash.replace(/^#\/?/, "").trim();
  const parts = hashPath.split("?")[0].split("/").filter(Boolean);
  const slug = parts[0] === "docs" ? parts[1] || DEFAULT_DOC : DEFAULT_DOC;
  return DOC_PAGES.some((page) => page.slug === slug) ? slug : DEFAULT_DOC;
}

function writeDocsLocation(slug) {
  if (typeof window === "undefined") return;
  const normalizedSlug = DOC_PAGES.some((page) => page.slug === slug) ? slug : DEFAULT_DOC;
  const url = new URL(window.location.href);
  url.hash = normalizedSlug === DEFAULT_DOC ? "docs" : `docs/${normalizedSlug}`;

  const currentPath = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const nextPath = `${url.pathname}${url.search}${url.hash}`;
  if (currentPath === nextPath) return;
  window.history.pushState({ tasknodeView: "docs", docsSlug: normalizedSlug }, "", nextPath);
}

function MarkdownArticle({ markdown }) {
  return (
    <div className="docs-markdown">
      {parseMarkdown(markdown).map((block, index) => (
        <MarkdownBlock block={block} key={index} />
      ))}
    </div>
  );
}

function SystemStatusPage({ onOpenDocPage }) {
  const [state, setState] = useState({ loading: true, status: null, error: "" });

  async function loadStatus() {
    setState((current) => ({ ...current, loading: true, error: "" }));
    const result = await requestJson("/api/system/status");
    if (!result.ok || !result.body?.ok) {
      setState({
        loading: false,
        status: null,
        error: result.body?.error || `system_status_http_${result.status}`,
      });
      return;
    }
    setState({ loading: false, status: result.body, error: "" });
  }

  useEffect(() => {
    loadStatus();
  }, []);

  const status = state.status;
  const summary = status?.summary || {};
  return (
    <section className="system-status-panel" aria-label="Live system status">
      <div className="system-status-toolbar">
        <div>
          <h2>Live Status</h2>
          <p>{status?.generatedAt ? `Generated ${formatDateTime(status.generatedAt)}` : "Reading scheduler state"}</p>
        </div>
        <button className="system-status-refresh" disabled={state.loading} onClick={loadStatus} type="button">
          <RefreshCw size={15} strokeWidth={1.8} />
          <span>{state.loading ? "Refreshing" : "Refresh"}</span>
        </button>
      </div>
      {state.error && <p className="system-status-error">{state.error}</p>}
      {status && (
        <>
          <div className="system-status-summary" aria-label="Status summary">
            {["critical", "warning", "ok", "unknown", "disabled"].map((key) => (
              <div className={`system-status-summary-cell is-${key}`} key={key}>
                <strong>{Number(summary[key] || 0)}</strong>
                <span>{statusLabel(key)}</span>
              </div>
            ))}
          </div>
          <p className="system-status-db">
            Database: {status.database?.enabled ? "enabled" : "not enabled"} · durable: {status.database?.durable ? "yes" : "no"}
          </p>
          {status.chatPricing && <SystemPricingPanel pricing={status.chatPricing} />}
          <div className="system-status-categories">
            {status.categories?.map((category) => (
              <section className="system-status-category" key={category.id}>
                <h2>{category.title}</h2>
                <p>{category.summary}</p>
                <div className="system-status-jobs">
                  {category.items?.map((entry) => (
                    <SystemStatusRow entry={entry} key={entry.id} onOpenDocPage={onOpenDocPage} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function SystemPricingPanel({ pricing }) {
  const modes = Array.isArray(pricing?.modes) ? pricing.modes : [];
  const references = Array.isArray(pricing?.references) ? pricing.references : [];
  const live = pricing?.live || {};
  return (
    <section className="system-pricing-panel" aria-label="Chat model pricing">
      <div className="system-pricing-heading">
        <div>
          <h2>Chat Model Pricing</h2>
          <p>
            Configured estimates, live OpenRouter metadata, and direct-provider reference prices for the current chat modes.
          </p>
        </div>
        <span className={`system-pricing-source is-${live.status || "unknown"}`}>
          {live.status === "ok"
            ? `Live ${formatDateTime(live.fetchedAt)}`
            : live.status === "disabled"
              ? "Live pricing off"
              : live.status === "error"
                ? "Live pricing error"
                : "Live pricing pending"}
        </span>
      </div>
      {live.error && <p className="system-status-error">{live.error}</p>}
      <div className="system-pricing-grid">
        {modes.map((mode) => (
          <SystemPricingCard key={mode.mode} mode={mode} />
        ))}
      </div>
      {references.length > 0 && (
        <div className="system-pricing-references">
          {references.map((reference) => (
            <div key={reference.id}>
              <strong>{reference.title}</strong>
              <span>{reference.provider} · {reference.model}</span>
              <span>
                {formatUsdPerMillion(reference.inputUsdPerMillion)} in ·{" "}
                {formatUsdPerMillion(reference.outputUsdPerMillion)} out
              </span>
              <p>{reference.privacyPolicy}</p>
            </div>
          ))}
        </div>
      )}
      {pricing.notes?.length > 0 && (
        <ul className="system-pricing-notes">
          {pricing.notes.map((note, index) => (
            <li key={index}>{note}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SystemPricingCard({ mode }) {
  const liveModel = mode.liveModel || {};
  const endpoints = pricingEndpointsForDisplay(mode);
  const maxOutputLabel = liveModel.maxCompletionTokens || mode.maxOutputTokens
    ? formatCompactNumber(liveModel.maxCompletionTokens || mode.maxOutputTokens)
    : "provider default";
  return (
    <article className="system-pricing-card">
      <div className="system-pricing-card-title">
        <h3>{mode.mode}</h3>
        <span>{mode.providerLabel || mode.provider}</span>
      </div>
      <p>{mode.description}</p>
      <dl>
        <div>
          <dt>Model</dt>
          <dd>{mode.model}</dd>
        </div>
        <div>
          <dt>Configured estimate</dt>
          <dd>
            {formatUsdPerMillion(mode.configuredPricing?.inputUsdPerMillion)} in ·{" "}
            {formatUsdPerMillion(mode.configuredPricing?.outputUsdPerMillion)} out
            {mode.configuredPricing?.inputCacheHitUsdPerMillion
              ? ` · ${formatUsdPerMillion(mode.configuredPricing.inputCacheHitUsdPerMillion)} cache hit`
              : ""}
          </dd>
        </div>
        <div>
          <dt>Live headline</dt>
          <dd>
            {liveModel.inputUsdPerMillion === undefined
              ? "n/a"
              : `${formatUsdPerMillion(liveModel.inputUsdPerMillion)} in · ${formatUsdPerMillion(liveModel.outputUsdPerMillion)} out${
                  liveModel.cacheReadUsdPerMillion
                    ? ` · ${formatUsdPerMillion(liveModel.cacheReadUsdPerMillion)} cache hit`
                    : ""
                }`}
          </dd>
        </div>
        <div>
          <dt>Context / max output</dt>
          <dd>
            {formatCompactNumber(liveModel.contextLength)} /{" "}
            {maxOutputLabel}
          </dd>
        </div>
        <div>
          <dt>Reasoning</dt>
          <dd>{mode.reasoning || "none"}</dd>
        </div>
        <div>
          <dt>Privacy</dt>
          <dd>{mode.privacyPolicy}</dd>
        </div>
      </dl>
      {liveModel.description && <p className="system-pricing-description">{liveModel.description}</p>}
      {endpoints.length > 0 && (
        <div className="system-pricing-endpoints">
          {endpoints.map((endpoint) => (
            <span className={endpoint.allowed ? "is-allowed" : "is-reference"} key={`${mode.mode}-${endpoint.providerSlug}`}>
              {endpoint.provider} · {formatUsdPerMillion(endpoint.outputUsdPerMillion)} out{" "}
              {endpoint.allowed ? "allowed" : "reference"}
            </span>
          ))}
        </div>
      )}
    </article>
  );
}

function pricingEndpointsForDisplay(mode = {}) {
  const endpoints = Array.isArray(mode.liveEndpoints) ? mode.liveEndpoints : [];
  const allowed = endpoints.filter((endpoint) => endpoint.allowed).slice(0, 4);
  const deepseek = endpoints.find((endpoint) => endpoint.providerSlug === "deepseek" && !endpoint.allowed);
  return [deepseek, ...allowed].filter(Boolean).slice(0, 5);
}

function SystemStatusRow({ entry, onOpenDocPage }) {
  const docLink = SYSTEM_STATUS_DOC_LINKS[entry.id];
  return (
    <article className={`system-status-row is-${entry.status || "unknown"}`}>
      <div className="system-status-row-main">
        <span className="system-status-dot" aria-hidden="true" />
        <div>
          <h3>{entry.title}</h3>
          <p>{entry.description}</p>
        </div>
      </div>
      <div className="system-status-row-meta">
        <span>{entry.statusLabel || statusLabel(entry.status)}</span>
        <span>{entry.owner}</span>
        <span>{entry.cadence}</span>
      </div>
      <dl>
        <div>
          <dt>Last run</dt>
          <dd>{formatDateTime(entry.lastRunAt)}</dd>
        </div>
        <div>
          <dt>Last success</dt>
          <dd>{formatDateTime(entry.lastSuccessAt)}</dd>
        </div>
        <div>
          <dt>Next run</dt>
          <dd>{formatDateTime(entry.nextRunAt)}</dd>
        </div>
        <div>
          <dt>Trigger</dt>
          <dd>{entry.trigger || "n/a"}</dd>
        </div>
      </dl>
      {entry.counts && Object.keys(entry.counts).length > 0 && (
        <div className="system-status-counts">
          {Object.entries(entry.counts).map(([key, value]) => (
            <span key={key}>
              {compactLabel(key)} <strong>{String(value)}</strong>
            </span>
          ))}
        </div>
      )}
      {entry.lastError && <p className="system-status-last-error">{entry.lastError}</p>}
      {entry.details?.length > 0 && (
        <ul className="system-status-details">
          {entry.details.map((detail, index) => (
            <li key={`${entry.id}-${index}`}>{detail}</li>
          ))}
        </ul>
      )}
      {docLink && (
        <a
          className="system-status-doc-link"
          href={`#docs/${docLink.slug}`}
          onClick={(event) => {
            event.preventDefault();
            onOpenDocPage?.(docLink.slug);
          }}
        >
          <BookOpen size={14} strokeWidth={1.8} />
          <span>{docLink.label}</span>
        </a>
      )}
    </article>
  );
}

function statusLabel(status = "unknown") {
  return {
    critical: "Red",
    warning: "Amber",
    ok: "Green",
    unknown: "Unknown",
    disabled: "Disabled",
  }[status] || "Unknown";
}

function compactLabel(value = "") {
  return String(value || "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatUsdPerMillion(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "n/a";
  return `$${numeric.toLocaleString(undefined, {
    minimumFractionDigits: numeric < 1 ? 3 : 2,
    maximumFractionDigits: numeric < 1 ? 6 : 3,
  })}/M`;
}

function formatCompactNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return "n/a";
  return numeric.toLocaleString();
}

function formatDateTime(value) {
  if (!value) return "n/a";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "n/a";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function MarkdownBlock({ block }) {
  if (block.type === "h1") return null;
  if (block.type === "h2") return <h2 id={slugifyHeading(block.text)}>{block.text}</h2>;
  if (block.type === "h3") return <h3 id={slugifyHeading(block.text)}>{block.text}</h3>;
  if (block.type === "p") return <p>{renderInline(block.text)}</p>;
  if (block.type === "ul") {
    return (
      <ul>
        {block.items.map((item, index) => (
          <li key={index}>{renderInline(item)}</li>
        ))}
      </ul>
    );
  }
  if (block.type === "ol") {
    return (
      <ol>
        {block.items.map((item, index) => (
          <li key={index}>{renderInline(item)}</li>
        ))}
      </ol>
    );
  }
  if (block.type === "code") {
    if (block.lang === "mermaid") return <DocsDiagram source={block.text} />;
    return (
      <pre>
        <code>{block.text}</code>
      </pre>
    );
  }
  if (block.type === "table") {
    return (
      <div className="docs-table-wrap">
        <table>
          <thead>
            <tr>
              {block.headers.map((header, index) => (
                <th key={index}>{renderInline(header)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex}>{renderInline(cell)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return null;
}

function slugifyHeading(value = "") {
  return (
    String(value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "section"
  );
}

function parseMarkdown(markdown) {
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let paragraph = [];
  let list = null;
  let code = null;

  function flushParagraph() {
    if (paragraph.length === 0) return;
    blocks.push({ type: "p", text: paragraph.join(" ") });
    paragraph = [];
  }

  function flushList() {
    if (!list) return;
    blocks.push(list);
    list = null;
  }

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const raw = line.trimEnd();
    const trimmed = raw.trim();
    const fence = trimmed.match(/^```(\w+)?/);

    if (fence) {
      if (code) {
        blocks.push({ type: "code", lang: code.lang, text: code.lines.join("\n") });
        code = null;
      } else {
        flushParagraph();
        flushList();
        code = { lang: fence[1] || "", lines: [] };
      }
      continue;
    }

    if (code) {
      code.lines.push(raw);
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    const nextLine = lines[lineIndex + 1]?.trim() || "";
    if (isMarkdownTableRow(trimmed) && isMarkdownTableSeparator(nextLine)) {
      flushParagraph();
      flushList();
      const headers = splitMarkdownTableRow(trimmed);
      const rows = [];
      let cursor = lineIndex + 2;
      while (cursor < lines.length && isMarkdownTableRow(lines[cursor]?.trim() || "")) {
        rows.push(normalizeTableRow(splitMarkdownTableRow(lines[cursor]), headers.length));
        cursor += 1;
      }
      blocks.push({ type: "table", headers, rows });
      lineIndex = cursor - 1;
      continue;
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ type: `h${heading[1].length}`, text: heading[2] });
      continue;
    }

    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    const ordered = trimmed.match(/^\d+\.\s+(.+)$/);
    if (bullet || ordered) {
      flushParagraph();
      const type = bullet ? "ul" : "ol";
      if (!list || list.type !== type) {
        flushList();
        list = { type, items: [] };
      }
      list.items.push((bullet || ordered)[1]);
      continue;
    }

    paragraph.push(trimmed);
  }

  flushParagraph();
  flushList();
  if (code) blocks.push({ type: "code", lang: code.lang, text: code.lines.join("\n") });
  return blocks;
}

function isMarkdownTableRow(line) {
  const text = String(line || "").trim();
  return text.startsWith("|") && text.endsWith("|") && text.split("|").length > 3;
}

function isMarkdownTableSeparator(line) {
  if (!isMarkdownTableRow(line)) return false;
  return splitMarkdownTableRow(line).every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

function splitMarkdownTableRow(line) {
  return String(line || "")
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function normalizeTableRow(row, count) {
  return Array.from({ length: count }, (_, index) => row[index] || "");
}

function renderInline(text) {
  const tokens = [];
  const pattern = /(\[[^\]]+\]\((?:https?:\/\/|#)[^)\s]+\)|`[^`]+`|\*\*[^*]+\*\*)/g;
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) tokens.push(text.slice(lastIndex, match.index));
    const token = match[0];
    if (token.startsWith("[")) {
      const link = token.match(/^\[([^\]]+)\]\(((?:https?:\/\/|#)[^)\s]+)\)$/);
      tokens.push(
        link && link[2].startsWith("#") ? (
          <a href={link[2]} key={tokens.length}>
            {link[1]}
          </a>
        ) : link ? (
          <a href={link[2]} key={tokens.length} rel="noreferrer" target="_blank">
            {link[1]}
          </a>
        ) : (
          token
        )
      );
    } else if (token.startsWith("`")) {
      tokens.push(<code key={tokens.length}>{token.slice(1, -1)}</code>);
    } else {
      tokens.push(<strong key={tokens.length}>{token.slice(2, -2)}</strong>);
    }
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) tokens.push(text.slice(lastIndex));
  return tokens;
}
