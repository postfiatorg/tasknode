import React from "react";

export function stripContextHtml(value = "") {
  return String(value || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function contextWordCount(value = "") {
  const text = stripContextHtml(value);
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

export function truncateCid(cid = "") {
  const text = String(cid || "");
  if (text.length <= 18) return text;
  return `${text.slice(0, 10)}...${text.slice(-6)}`;
}

export function ContextToolButton({ active, children, disabled = false, onMouseDown, title }) {
  return (
    <button
      aria-pressed={active ? "true" : "false"}
      className={`ctx-tool-btn${active ? " is-active" : ""}`}
      disabled={disabled}
      onMouseDown={(event) => {
        event.preventDefault();
        if (!disabled) onMouseDown?.(event);
      }}
      title={title}
      type="button"
    >
      {children}
    </button>
  );
}
