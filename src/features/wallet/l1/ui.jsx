// Shared presentational primitives for the L1 wallet. No chain access here.
import { useEffect, useRef, useState } from "react";
import { Check, CircleAlert, CircleCheck, Copy, Info, LoaderCircle, TriangleAlert } from "lucide-react";
import { amountParts, isLongId } from "./format.js";
import "./l1-wallet.css";

export function Amount({ atoms, unit, precision = 6, min = 2, max, sign = false, className = "", testId }) {
  const [whole, fraction] = amountParts(atoms, { precision, min, max: max ?? precision, sign });
  // Unit is drawn by CSS from data-unit so the digits stay one readable text run.
  return <span className={`l1-amt ${className}`} data-unit={unit || undefined} data-testid={testId}>{whole}<span className="l1-amt-frac">{fraction}</span></span>;
}

// Shows a shortened identifier while the element text stays the full value
// (copy, search and tests read the full value; the middle is visually hidden).
export function Mono({ value, head = 6, tail = 4, testId, className = "" }) {
  const text = String(value ?? "");
  if (!isLongId(text)) return <span className={`l1-mono ${className}`} data-testid={testId}>{text}</span>;
  const prefix = text.startsWith("pf") || text.startsWith("0x") ? 2 : 0;
  const start = text.slice(0, prefix + head), end = text.slice(-tail), middle = text.slice(prefix + head, text.length - tail);
  return <span className={`l1-mono l1-mono-short ${className}`} data-testid={testId} title={text}>{start}<span className="l1-mono-mid">{middle}</span>{end}</span>;
}

export function CopyButton({ value, label = "value", className = "" }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    try { await navigator.clipboard.writeText(String(value)); setCopied(true); clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 1600); }
    catch { /* clipboard unavailable: the value stays selectable in the title */ }
  }
  return <button type="button" className={`l1-icon-btn ${className}`} onClick={copy} aria-label={copied ? `${label} copied` : `Copy ${label}`} title={copied ? "Copied" : `Copy ${label}`}>
    {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
  </button>;
}

export function IdChip({ value, label = "address", testId, href, tone }) {
  return <span className={`l1-chip ${tone ? `is-${tone}` : ""}`}>
    {href ? <a href={href} target="_blank" rel="noreferrer"><Mono value={value} testId={testId} /></a> : <Mono value={value} testId={testId} />}
    <CopyButton value={value} label={label} />
  </span>;
}

export function Badge({ tone = "neutral", children, dot = false }) {
  return <span className={`l1-badge is-${tone}`}>{dot && <span className="l1-dot" aria-hidden />}{children}</span>;
}

export function Spinner({ size = 16, label }) {
  return <LoaderCircle className="l1-spin" size={size} aria-hidden={!label} aria-label={label} />;
}

export function ViewHeader({ eyebrow, title, subtitle, children }) {
  return <header className="l1-view-head">
    <div>
      {eyebrow && <div className="l1-eyebrow">{eyebrow}</div>}
      <h2>{title}</h2>
      {subtitle && <p>{subtitle}</p>}
    </div>
    {children && <div className="l1-view-head-side">{children}</div>}
  </header>;
}

export function Card({ as: Tag = "section", className = "", children, ...rest }) {
  return <Tag className={`l1-card ${className}`} {...rest}>{children}</Tag>;
}

export function CardHead({ eyebrow, title, children, as: H = "h3" }) {
  return <div className="l1-card-head">
    <div>{eyebrow && <div className="l1-eyebrow">{eyebrow}</div>}{title && <H>{title}</H>}</div>
    {children && <div className="l1-card-head-side">{children}</div>}
  </div>;
}

export function Details({ summary = "Details", children, className = "" }) {
  return <details className={`l1-details ${className}`}><summary>{summary}</summary><div className="l1-details-body">{children}</div></details>;
}

export function Notice({ tone = "info", title, children, role, action }) {
  const Icon = tone === "danger" ? CircleAlert : tone === "warning" ? TriangleAlert : tone === "success" ? CircleCheck : Info;
  return <div className={`l1-notice is-${tone}`} role={role}>
    <Icon size={16} aria-hidden className="l1-notice-icon" />
    <div className="l1-notice-body">{title && <strong>{title}</strong>}{children && <div>{children}</div>}</div>
    {action && <div className="l1-notice-action">{action}</div>}
  </div>;
}

export function KV({ rows, className = "" }) {
  return <dl className={`l1-kv ${className}`}>{rows.filter(Boolean).map(([label, value, hint], index) => <div key={index}>
    <dt>{label}</dt><dd>{value}{hint && <small>{hint}</small>}</dd>
  </div>)}</dl>;
}

export function JsonBlock({ value }) {
  return <pre className="l1-json">{JSON.stringify(value, (_key, item) => typeof item === "bigint" ? String(item) : item, 2)}</pre>;
}

const AVATAR = { PFT: "PF", PFUSDC: "$", B23: "B23", USDC: "$" };
export function AssetAvatar({ code, size = "md" }) {
  const key = String(code || "?");
  return <span className={`l1-avatar is-${key.toLowerCase()} is-${size}`} aria-hidden>{AVATAR[key] || key.slice(0, 3).toUpperCase()}</span>;
}

export function Empty({ icon: Icon, title, children, action }) {
  return <div className="l1-empty">
    {Icon && <span className="l1-empty-icon"><Icon size={20} aria-hidden /></span>}
    <strong>{title}</strong>
    {children && <p>{children}</p>}
    {action}
  </div>;
}

export function Skeleton({ width = "100%", height = 14 }) {
  return <span className="l1-skeleton" style={{ width, height }} aria-hidden />;
}
