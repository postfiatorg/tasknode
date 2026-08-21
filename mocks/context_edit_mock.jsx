import React, { useState, useEffect } from "react";

// ---- palette (matches the chat UI: warm cream + ink) ----
const C = {
  paper:      "#F4EFE6",
  paper2:     "#FBF7EE",
  paper3:     "#FFFCF5",
  ink:        "#1F1B16",
  ink2:       "#3D362C",
  ink3:       "#6B6052",
  ink4:       "#9B9081",
  rule:       "#E5DCC8",
  ruleSoft:   "#EFE7D6",
  beforeBg:   "#F6EAE5",
  beforeBg2:  "#EFD8D0",
  beforeInk:  "#8C3A28",
  afterBg:    "#EAF0DD",
  afterBg2:   "#D8E0C0",
  afterInk:   "#4F5E27",
};

const SANS = "'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif";
const MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

// ---- diff data ----
const BEFORE_LINES = [
  { n: 1, text: "I am fixing the Task node" },
  { n: 2, text: "if we do not have 1 working product nobody" },
  { n: 3, text: "will take us fucking seriously" },
  { n: 4, text: "— I am fixing all ", hl: "P0s" },
  { n: 5, text: "— I am building an entirely new app surface" },
  { n: 6, text: "  product that is usable and will get more" },
  { n: 7, text: "  than fucking ", hl: "30 DAUs" },
  { n: null, text: "" },
  { n: 9, text: "I am completely rebuilding the task node" },
  { n: 10, text: "from scratch" },
];

const AFTER_LINES = [
  { n: 1, hlAdd: "Task Node is the current product priority." },
  { n: null, text: "" },
  { n: 3, hlAdd: "Core belief:" },
  { n: 4, text: "If we do not have one working product," },
  { n: 5, text: "nobody will take us seriously. The rebuilt" },
  { n: 6, text: "Task Node must become a usable app surface" },
  { n: 7, text: "that can earn ", hlAdd: "30+ DAUs", suffix: "." },
  { n: null, text: "" },
  { n: 9, hlAdd: "Current direction:" },
  { n: 10, text: "— Completely rebuild the Task Node from" },
  { n: 11, text: "  scratch around one trustworthy loop." },
];

// ---- subcomponents ----
function DiffLine({ side, line }) {
  const isEmpty = line.n === null;
  const palette = side === "before"
    ? { bg: C.beforeBg, ink: C.beforeInk, sign: "−" }
    : { bg: C.afterBg,  ink: C.afterInk,  sign: "+" };

  return (
    <div className="grid" style={{ gridTemplateColumns: "32px 1fr" }}>
      <div
        className="text-right pr-2.5 select-none pt-px"
        style={{ color: C.ink4, fontSize: 10.5, fontFamily: MONO }}
      >
        {line.n ?? ""}
      </div>
      <div
        className="relative whitespace-pre-wrap break-words"
        style={{
          padding: "0 22px 0 12px",
          background: isEmpty ? "transparent" : palette.bg,
          color: isEmpty ? "transparent" : palette.ink,
          minHeight: "1.75em",
        }}
      >
        {!isEmpty && (
          <span
            className="absolute"
            style={{ left: 2, color: palette.ink, opacity: 0.5 }}
          >
            {palette.sign}
          </span>
        )}
        {line.text}
        {side === "before" && line.hl && (
          <span
            style={{
              background: C.beforeBg2,
              padding: "0 3px",
              borderRadius: 2,
              textDecoration: "line-through",
              textDecorationColor: "rgba(140, 58, 40, 0.5)",
              textDecorationThickness: 1,
            }}
          >
            {line.hl}
          </span>
        )}
        {side === "after" && line.hlAdd && (
          <span
            style={{
              background: C.afterBg2,
              padding: "0 3px",
              borderRadius: 2,
              fontWeight: 500,
            }}
          >
            {line.hlAdd}
          </span>
        )}
        {side === "after" && line.suffix}
      </div>
    </div>
  );
}

function SideLabel({ side, count }) {
  const isBefore = side === "before";
  return (
    <div
      className="flex items-center gap-2"
      style={{
        padding: "12px 22px 8px",
        fontSize: 10.5,
        fontWeight: 600,
        letterSpacing: "0.16em",
        textTransform: "uppercase",
        color: C.ink4,
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: 2,
          background: isBefore ? C.beforeBg2 : C.afterBg2,
        }}
      />
      {isBefore ? "Before — Current" : "After — Suggested"}
      <span
        className="ml-auto"
        style={{
          fontFamily: MONO,
          fontSize: 10.5,
          fontWeight: 400,
          letterSpacing: 0,
          textTransform: "none",
          color: C.ink4,
        }}
      >
        {count} lines
      </span>
    </div>
  );
}

function Chip({ tone = "neutral", children }) {
  const dotColor = {
    added:   C.afterInk,
    removed: C.beforeInk,
    neutral: C.ink4,
  }[tone];

  return (
    <span
      className="inline-flex items-center gap-1.5"
      style={{
        padding: "3px 10px",
        borderRadius: 999,
        fontSize: 12,
        background: C.paper3,
        border: `1px solid ${C.rule}`,
        color: C.ink2,
        letterSpacing: "-0.005em",
      }}
    >
      <span
        style={{ width: 6, height: 6, borderRadius: "50%", background: dotColor }}
      />
      {children}
    </span>
  );
}

function ModeTab({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: active ? C.paper : "transparent",
        border: "none",
        padding: "3px 11px",
        borderRadius: 999,
        fontFamily: SANS,
        fontSize: 11.5,
        color: active ? C.ink : C.ink4,
        cursor: "pointer",
        transition: "all .15s ease",
        boxShadow: active ? "0 1px 0 rgba(31,27,22,.04)" : "none",
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.color = C.ink2;
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.color = C.ink4;
      }}
    >
      {children}
    </button>
  );
}

function Btn({ variant = "default", children, kbd }) {
  const styles = {
    default: { bg: C.paper3, border: C.rule, color: C.ink2 },
    ghost:   { bg: "transparent", border: "transparent", color: C.ink3 },
    primary: { bg: C.ink, border: C.ink, color: C.paper },
  }[variant];

  return (
    <button
      type="button"
      className="inline-flex items-center gap-1.5"
      style={{
        fontFamily: SANS,
        fontSize: 13,
        fontWeight: 500,
        padding: "7px 14px",
        borderRadius: 8,
        border: `1px solid ${styles.border}`,
        background: styles.bg,
        color: styles.color,
        cursor: "pointer",
        letterSpacing: "-0.005em",
        transition: "all .15s ease",
      }}
      onMouseEnter={(e) => {
        if (variant === "primary") e.currentTarget.style.background = "#000";
        else if (variant === "ghost") {
          e.currentTarget.style.background = C.paper2;
          e.currentTarget.style.color = C.ink;
        } else {
          e.currentTarget.style.background = C.paper2;
          e.currentTarget.style.borderColor = C.ink4;
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = styles.bg;
        e.currentTarget.style.borderColor = styles.border;
        e.currentTarget.style.color = styles.color;
      }}
    >
      {children}
      {kbd && (
        <span
          style={{
            fontFamily: MONO,
            fontSize: 10.5,
            padding: "1px 5px",
            borderRadius: 3,
            opacity: 0.7,
            background: variant === "primary" ? "rgba(255,255,255,.12)" : C.paper,
            border: variant === "primary" ? "none" : `1px solid ${C.rule}`,
            color: variant === "primary" ? C.paper : C.ink4,
          }}
        >
          {kbd}
        </span>
      )}
    </button>
  );
}

// ---- main card ----
function ContextEditCard() {
  const [mode, setMode] = useState("side");

  return (
    <article
      style={{
        background: C.paper3,
        border: `1px solid ${C.rule}`,
        borderRadius: 14,
        boxShadow: "0 1px 0 rgba(31,27,22,.04), 0 12px 28px -16px rgba(31,27,22,.14)",
        overflow: "hidden",
        margin: "18px 0",
        fontFamily: SANS,
      }}
    >
      {/* header */}
      <header
        className="flex items-start justify-between gap-5"
        style={{
          padding: "20px 24px 16px",
          borderBottom: `1px solid ${C.ruleSoft}`,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 10.5,
              fontWeight: 600,
              letterSpacing: "0.16em",
              textTransform: "uppercase",
              color: C.ink4,
              marginBottom: 6,
            }}
          >
            Context Edit · Replace Block
          </div>
          <h2
            style={{
              fontSize: 16,
              fontWeight: 600,
              lineHeight: 1.35,
              color: C.ink,
              margin: "0 0 6px",
              letterSpacing: "-0.005em",
            }}
          >
            Sharpening the Task Node focus section
          </h2>
          <p
            style={{
              fontSize: 13.5,
              color: C.ink3,
              lineHeight: 1.5,
              maxWidth: 560,
              margin: 0,
            }}
          >
            Turns the incomplete notes into a clearer operating context with current
            priorities, foundation, P0s, and a defined win condition.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          <span
            style={{
              fontSize: 12,
              fontWeight: 500,
              color: C.ink2,
              background: C.paper2,
              border: `1px solid ${C.rule}`,
              padding: "4px 10px",
              borderRadius: 999,
              letterSpacing: "-0.005em",
            }}
          >
            Revision 41
          </span>
          <span
            className="flex items-center gap-1.5"
            style={{ fontSize: 11.5, color: C.ink4 }}
          >
            <span
              style={{ width: 5, height: 5, background: "#6FA463", borderRadius: "50%" }}
            />
            Saved · just now
          </span>
        </div>
      </header>

      {/* lines bar */}
      <div
        className="flex items-center gap-2.5"
        style={{
          padding: "10px 24px",
          background: C.paper2,
          borderBottom: `1px solid ${C.ruleSoft}`,
          fontFamily: MONO,
          fontSize: 11,
          color: C.ink3,
        }}
      >
        <span
          style={{
            background: C.paper3,
            border: `1px solid ${C.rule}`,
            padding: "2px 8px",
            borderRadius: 4,
            color: C.ink2,
          }}
        >
          context.md
        </span>
        <span style={{ color: C.ink4 }}>
          /{" "}
          <strong style={{ color: C.ink2, fontWeight: 500 }}>Task Node</strong> /
          focus · lines 1–10
        </span>
        <div
          className="ml-auto flex gap-0.5"
          style={{
            background: C.paper3,
            border: `1px solid ${C.rule}`,
            borderRadius: 999,
            padding: 2,
          }}
        >
          <ModeTab active={mode === "side"} onClick={() => setMode("side")}>
            Side-by-side
          </ModeTab>
          <ModeTab active={mode === "inline"} onClick={() => setMode("inline")}>
            Inline
          </ModeTab>
          <ModeTab active={mode === "after"} onClick={() => setMode("after")}>
            After only
          </ModeTab>
        </div>
      </div>

      {/* diff body */}
      <div
        className="grid"
        style={{
          gridTemplateColumns:
            mode === "side" ? "1fr 1px 1fr" : "1fr",
          background: C.paper3,
        }}
      >
        {(mode === "side" || mode === "inline") && (
          <section className="flex flex-col min-w-0">
            <SideLabel side="before" count={10} />
            <div
              className="flex-1"
              style={{
                padding: "4px 0 16px",
                fontFamily: MONO,
                fontSize: 12.5,
                lineHeight: 1.75,
                color: C.ink2,
              }}
            >
              {BEFORE_LINES.map((l, i) => (
                <DiffLine key={`b-${i}`} side="before" line={l} />
              ))}
            </div>
          </section>
        )}

        {mode === "side" && (
          <div aria-hidden="true" style={{ background: C.ruleSoft }} />
        )}

        <section className="flex flex-col min-w-0">
          <SideLabel side="after" count={11} />
          <div
            className="flex-1"
            style={{
              padding: "4px 0 16px",
              fontFamily: MONO,
              fontSize: 12.5,
              lineHeight: 1.75,
              color: C.ink2,
            }}
          >
            {AFTER_LINES.map((l, i) => (
              <DiffLine key={`a-${i}`} side="after" line={l} />
            ))}
          </div>
        </section>
      </div>

      {/* summary */}
      <div
        className="flex items-center gap-2 flex-wrap"
        style={{
          padding: "12px 24px 14px",
          background: C.paper2,
          borderTop: `1px solid ${C.ruleSoft}`,
        }}
      >
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 600,
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            color: C.ink4,
            marginRight: 4,
          }}
        >
          What changed
        </span>
        <Chip tone="removed">10 lines removed</Chip>
        <Chip tone="added">11 lines added</Chip>
        <Chip>Tone: declarative → operational</Chip>
        <Chip>Adds: core belief, current direction</Chip>
      </div>

      {/* actions */}
      <footer
        className="flex items-center gap-2"
        style={{
          padding: "14px 22px",
          background: C.paper3,
          borderTop: `1px solid ${C.ruleSoft}`,
        }}
      >
        <span style={{ fontSize: 12.5, color: C.ink4 }}>Awaiting your call.</span>
        <div className="ml-auto flex gap-1.5">
          <Btn variant="ghost">Discard</Btn>
          <Btn kbd="⌘R">Refine</Btn>
          <Btn variant="primary" kbd="⌘↵">Accept &amp; save</Btn>
        </div>
      </footer>
    </article>
  );
}

// ---- wrapper that includes the chat context for demo ----
export default function App() {
  // load Inter + JetBrains Mono once
  useEffect(() => {
    const id = "ctx-edit-fonts";
    if (document.getElementById(id)) return;
    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href =
      "https://fonts.googleapis.com/css2?family=Inter:wght@400;450;500;600&family=JetBrains+Mono:wght@400;500&display=swap";
    document.head.appendChild(link);
  }, []);

  return (
    <div
      style={{
        background: C.paper,
        minHeight: "100vh",
        fontFamily: SANS,
        color: C.ink,
        WebkitFontSmoothing: "antialiased",
      }}
    >
      <div style={{ maxWidth: 880, margin: "0 auto", padding: "56px 28px 120px" }}>
        {/* user bubble */}
        <div className="flex justify-end mb-4">
          <div
            style={{
              background: "#1F1B16",
              color: C.paper,
              padding: "10px 18px",
              borderRadius: 999,
              fontSize: 14.5,
              letterSpacing: "-0.005em",
            }}
          >
            I want to change my context document
          </div>
        </div>

        <p
          style={{
            color: C.ink2,
            margin: "22px 0 14px",
            fontSize: 15,
            lineHeight: 1.55,
            letterSpacing: "-0.005em",
          }}
        >
          What specific change do you want to make—rewrite the Task Node focus
          section, remove something, or add a new priority/constraint?
        </p>

        <div className="flex justify-end mb-4">
          <div
            style={{
              background: "#1F1B16",
              color: C.paper,
              padding: "10px 18px",
              borderRadius: 999,
              fontSize: 14.5,
              letterSpacing: "-0.005em",
            }}
          >
            yea I think it is just not complete
          </div>
        </div>

        <p
          style={{
            color: C.ink2,
            margin: "22px 0 14px",
            fontSize: 15,
            lineHeight: 1.55,
            letterSpacing: "-0.005em",
          }}
        >
          I'll make the existing Task Node notes more complete and structured while
          preserving the core urgency and current priorities.
        </p>

        <ContextEditCard />
      </div>
    </div>
  );
}