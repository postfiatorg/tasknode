import React, { useState } from "react";
import {
  Search,
  RefreshCw,
  Trash2,
  ChevronDown,
  ChevronRight,
  Sparkles,
  Database,
  X,
} from "lucide-react";

/**
 * MemoryTab — Memory and Deep Memory are two separate blobs.
 *
 *  ┌───────────────────────────────────────┐
 *  │  Memory                               │
 *  │  ────────────────────                 │
 *  │  [ Memory ] [ Deep Memory ]           │ ← top-level tabs
 *  │                                       │
 *  │  Memory tab:                          │
 *  │    • Network Diagnostic Report        │
 *  │    • Network Context Inputs           │
 *  │                                       │
 *  │  Deep Memory tab:                     │
 *  │    • List of conversation summaries   │
 *  └───────────────────────────────────────┘
 *
 * Search + delete scope to whichever tab is active.
 */
export default function MemoryTab() {
  // ── mock data ──────────────────────────────────────────────────────────────
  const initialDiagnostic = {
    role: "Financial Protocol Quality Engineer",
    updated: "May 26, 2028 · 1:59 PM",
    packet: "ea88346d104a",
    summary:
      "Hands-on engineer strengthening reliability of financial protocol software through deterministic testing frameworks and replay tooling.",
    currentFocus: [
      "Rebuilding the Task Node product around a deterministic task loop with clear state transitions",
      "Defining beta consolidation boundaries to establish a stable minimum viable surface",
      "Implementing a profile-aware internal task routing prototype",
      "Documenting resettable signup testing workflows and full deletion lifecycle integrity",
    ],
    primaryAbility: [
      "Build deterministic testing frameworks and replay fixtures that prove system state transitions are reliable",
      "Audit and harden financial protocol workflows to reduce risk of ambiguous transaction states",
      "Design and implement state recovery loops that maintain deterministic behavior after process restarts",
      "Develop routing and prioritization logic matching tasks to users based on trust signals",
    ],
    companies: [
      { name: "Coinbase", note: "Deterministic testing + state recovery for crypto exchange ops" },
      { name: "Circle", note: "Replayable verification for stablecoin settlement accuracy" },
      { name: "Ripple", note: "Deterministic state machines for cross-border payment integrity" },
      { name: "Chainlink", note: "Trust surfaces and replay fixtures for oracle reliability" },
      { name: "Stripe", note: "Frontend workflow auditing for payment flow reliability" },
      { name: "Plaid", note: "Account lifecycle testing for financial data aggregation" },
      { name: "Gemini", note: "Trust loops supporting regulated exchange infrastructure" },
      { name: "Kraken", note: "Stress testing for platform stability" },
    ],
  };

  const initialContext = `Profile
Account:           acct_oauth_3c70e69ab7b8ef1fad3df508
Primary wallet:    rNwIJxkiTxxTC6SMrmLG7Wiukbicyw2TaE
Public role:       Financial Protocol Quality Engineer

Skills:            Deterministic State Machine Design,
                   Protocol Replay & Integrity Testing,
                   Frontend & Workflow Auditing,
                   Latency Profiling & Optimization

Lifetime rewards:  100030.1 PFT
Trailing 30d:      31 tasks · 100030.1 PFT
Alignment score:   73/100
Contribution tier: T4

Task State
Proposed (0)
None`;

  const initialMemories = [
    {
      id: 4,
      date: "May 26, 2028 · 12:06 AM",
      summary:
        "User reframed the product from life-redemption to a proof-of-agency tool, accepting personal worth as separate from token success.",
      user: [
        "Compares XRP to a cult and expresses personal failure tied to the project",
        "Asserts coins are speculative bubbles, dismisses utility/transparency framing",
        "Wants a directive-based tool that avoids vague AI responses and rejects safety guardrails",
        "Cynical about user motivation — token price and growth don't follow honest work",
      ],
      assistant: [
        "Reframed the product as proof-of-agency rather than life redemption",
        "Recommended a 30-day expansion freeze to build proof of usefulness",
        "Distinguished meme vs thesis coins as belief assets, not utility products",
        "Proposed a voice-gate harness to enforce authored tone and rejection of generic responses",
      ],
      synthesis:
        "User is exploring launch of two crypto assets while grappling with legal risk and desire for quick profit. System advises verifiable proof, honest narratives, and clear separation of vision from coin.",
    },
    {
      id: 3,
      date: "May 25, 2028 · 11:09 PM",
      summary:
        "User pushed for narrower scope and a calm, mission-control interface. Repeated theme: agency over speculation.",
      user: [
        "Repeatedly sought strategic focus advice and expressed frustration about DAU and hiring",
        "Described product as a speculative hive mind or contribution market, not a trading tool",
        "Concerns about adoption, frontier thinking, and project viability after two years of struggle",
        "Engaged in naming and design decisions (Task Node, Unleash) and considered Telegram vs AI-driven dev",
      ],
      assistant: [
        "Advised focusing on a single, undeniable core loop — state clarity, trust, deterministic behavior",
        "Warned against using DAU or token speculation as primary metrics before proving product value",
        "Proposed design directives: a calm, mission-control-like surface that reveals state and next actions in five seconds",
        "Reframed challenges as emotional shame from past failures, urging humans-by-using-AI-as-trap mindset",
      ],
      synthesis:
        "User is exploring a coordination/productivity platform combining trust, focus, and product–market fit after two years and a failed prior project. System recommends narrowing to a single undeniable loop.",
    },
    {
      id: 2,
      date: "May 20, 2028 · 11:11 AM",
      summary:
        "User framed trading performance as the foundation of the system and acknowledged personal struggles affecting execution.",
      user: [
        "Emphasizes that trading performance is the foundation of the system",
        "Asserts trades must work to avoid network churn",
        "Admits to personal struggles — weight gain, depression, sleep disruption, periodic addictions",
      ],
      assistant: [
        "Centered the conversation on system integrity over personal narrative",
        "Suggested treating execution health as a prerequisite to product decisions",
      ],
      synthesis:
        "User views trading reliability as load-bearing for the wider system, while acknowledging that personal execution health is a precondition for sustained product progress.",
    },
  ];

  // ── state ──────────────────────────────────────────────────────────────────
  const [tab, setTab] = useState("memory"); // "memory" | "deep"
  const [query, setQuery] = useState("");
  const [openDiagnostic, setOpenDiagnostic] = useState(true);
  const [openContext, setOpenContext] = useState(false);
  const [openCompanies, setOpenCompanies] = useState(false);
  const [memories, setMemories] = useState(initialMemories);
  const [expandedMemory, setExpandedMemory] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null); // id | "all-deep" | "memory" | null

  const filteredMemories = memories.filter((m) => {
    const q = query.toLowerCase().trim();
    if (!q) return true;
    return (
      m.summary.toLowerCase().includes(q) ||
      m.synthesis.toLowerCase().includes(q) ||
      m.user.some((u) => u.toLowerCase().includes(q)) ||
      m.assistant.some((a) => a.toLowerCase().includes(q))
    );
  });

  const doDelete = () => {
    if (confirmDelete === "all-deep") setMemories([]);
    else if (typeof confirmDelete === "number") {
      setMemories((prev) => prev.filter((m) => m.id !== confirmDelete));
    }
    // "memory" reset would clear the diagnostic — handled by parent in production
    setConfirmDelete(null);
    setExpandedMemory(null);
  };

  // ── render ─────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-white text-neutral-900 antialiased">
      <style>{`
        :root { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
        .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
      `}</style>

      <div className="max-w-3xl mx-auto px-6 py-10">
        {/* Header */}
        <header className="mb-6">
          <div className="flex items-baseline justify-between">
            <div>
              <h1 className="text-[28px] font-semibold tracking-tight">Memory</h1>
              <p className="mt-1 text-sm text-neutral-500">
                What the system remembers about you.
              </p>
            </div>
            <button className="inline-flex items-center gap-1.5 text-sm text-neutral-500 hover:text-neutral-900 transition">
              <RefreshCw size={14} />
              Refresh
            </button>
          </div>
        </header>

        {/* Tabs */}
        <div className="border-b border-neutral-200">
          <nav className="flex gap-6" role="tablist">
            <TabButton active={tab === "memory"} onClick={() => setTab("memory")}>
              Memory
            </TabButton>
            <TabButton active={tab === "deep"} onClick={() => setTab("deep")}>
              Deep Memory
              <span
                className={`ml-1.5 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[11px] font-medium ${
                  tab === "deep"
                    ? "bg-neutral-900 text-white"
                    : "bg-neutral-100 text-neutral-500"
                }`}
              >
                {memories.length}
              </span>
            </TabButton>
          </nav>
        </div>

        {/* Search */}
        <div className="mt-5 relative">
          <Search
            size={15}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={
              tab === "memory" ? "Search memory" : "Search deep memory"
            }
            className="w-full pl-9 pr-3 py-2.5 text-sm bg-neutral-50 border border-neutral-200 rounded-lg outline-none focus:bg-white focus:border-neutral-400 transition placeholder:text-neutral-400"
          />
        </div>

        {/* ──────────────────────────────────────────────────────────────── */}
        {/* MEMORY TAB                                                       */}
        {/* ──────────────────────────────────────────────────────────────── */}
        {tab === "memory" && (
          <div className="mt-2">
            <Section
              icon={<Sparkles size={15} className="text-neutral-500" />}
              title="Network Diagnostic Report"
              meta={initialDiagnostic.updated}
              open={openDiagnostic}
              onToggle={() => setOpenDiagnostic((v) => !v)}
            >
              <div className="space-y-5">
                <div>
                  <div className="text-[15px] font-medium">
                    {initialDiagnostic.role}
                  </div>
                  <p className="mt-1.5 text-[14px] leading-relaxed text-neutral-600">
                    {initialDiagnostic.summary}
                  </p>
                </div>

                <Divider />

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <Column label="Current focus" items={initialDiagnostic.currentFocus} />
                  <Column
                    label="Primary contribution"
                    items={initialDiagnostic.primaryAbility}
                  />
                </div>

                <Divider />

                <button
                  onClick={() => setOpenCompanies((v) => !v)}
                  className="flex items-center gap-1.5 text-[13px] font-medium text-neutral-500 hover:text-neutral-900 transition"
                >
                  {openCompanies ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  Companies where this profile applies
                  <span className="text-neutral-400 font-normal">
                    · {initialDiagnostic.companies.length}
                  </span>
                </button>
                {openCompanies && (
                  <ul className="mt-2 space-y-2 pl-5">
                    {initialDiagnostic.companies.map((c) => (
                      <li key={c.name} className="text-[13.5px] leading-relaxed">
                        <span className="font-medium">{c.name}</span>
                        <span className="text-neutral-500"> — {c.note}</span>
                      </li>
                    ))}
                  </ul>
                )}

                <div className="pt-1">
                  <span className="mono text-[11px] text-neutral-400">
                    packet · {initialDiagnostic.packet}
                  </span>
                </div>
              </div>
            </Section>

            <Section
              icon={<Database size={15} className="text-neutral-500" />}
              title="Network Context Inputs"
              meta="17 inputs"
              open={openContext}
              onToggle={() => setOpenContext((v) => !v)}
            >
              <p className="text-[13.5px] text-neutral-500 mb-3">
                Live profile facts the diagnostic was built from. Not model output.
              </p>
              <pre className="mono text-[12.5px] leading-relaxed bg-neutral-50 border border-neutral-200 rounded-lg p-4 text-neutral-700 overflow-x-auto whitespace-pre">
{initialContext}
              </pre>
            </Section>

            {/* Footer action: reset memory blob */}
            <div className="mt-8 pt-5 border-t border-neutral-200 flex items-center justify-between">
              <div>
                <div className="text-[13.5px] font-medium text-neutral-900">
                  Reset memory
                </div>
                <p className="text-[12.5px] text-neutral-500 mt-0.5">
                  Clears your diagnostic and context inputs. Deep Memory is not affected.
                </p>
              </div>
              <button
                onClick={() => setConfirmDelete("memory")}
                className="text-[12.5px] text-neutral-500 hover:text-red-600 transition px-2.5 py-1.5 hover:bg-red-50 rounded-md"
              >
                Reset
              </button>
            </div>
          </div>
        )}

        {/* ──────────────────────────────────────────────────────────────── */}
        {/* DEEP MEMORY TAB                                                  */}
        {/* ──────────────────────────────────────────────────────────────── */}
        {tab === "deep" && (
          <div className="mt-6">
            <div className="flex items-end justify-between mb-3">
              <p className="text-[13px] text-neutral-500">
                Summaries pulled from past conversations.
              </p>
              {memories.length > 0 && (
                <button
                  onClick={() => setConfirmDelete("all-deep")}
                  className="text-[12.5px] text-neutral-400 hover:text-red-600 transition"
                >
                  Clear all
                </button>
              )}
            </div>

            {filteredMemories.length === 0 ? (
              <div className="border border-dashed border-neutral-200 rounded-lg p-10 text-center">
                <p className="text-sm text-neutral-500">
                  {memories.length === 0
                    ? "No deep memories stored yet."
                    : "No memories match this search."}
                </p>
              </div>
            ) : (
              <ul className="space-y-2">
                {filteredMemories.map((m) => (
                  <MemoryCard
                    key={m.id}
                    memory={m}
                    expanded={expandedMemory === m.id}
                    onToggle={() =>
                      setExpandedMemory(expandedMemory === m.id ? null : m.id)
                    }
                    onDelete={() => setConfirmDelete(m.id)}
                  />
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* ── Confirmation modal ──────────────────────────────────────────── */}
      {confirmDelete !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm"
          onClick={() => setConfirmDelete(null)}
        >
          <div
            className="bg-white rounded-xl border border-neutral-200 shadow-xl w-full max-w-sm p-5 mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-[15px] font-semibold">
                  {confirmDelete === "all-deep"
                    ? "Clear all deep memories?"
                    : confirmDelete === "memory"
                    ? "Reset memory?"
                    : "Delete this memory?"}
                </h3>
                <p className="mt-1.5 text-[13.5px] text-neutral-500 leading-relaxed">
                  {confirmDelete === "all-deep"
                    ? "All deep memory summaries will be permanently removed. Your Memory tab is not affected."
                    : confirmDelete === "memory"
                    ? "Your diagnostic and context inputs will be cleared. Deep Memory is not affected."
                    : "This memory will be permanently removed. This action can't be undone."}
                </p>
              </div>
              <button
                onClick={() => setConfirmDelete(null)}
                className="text-neutral-400 hover:text-neutral-700 -mt-1 -mr-1"
              >
                <X size={16} />
              </button>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setConfirmDelete(null)}
                className="px-3 py-1.5 text-[13px] font-medium text-neutral-700 hover:bg-neutral-100 rounded-md transition"
              >
                Cancel
              </button>
              <button
                onClick={doDelete}
                className="px-3 py-1.5 text-[13px] font-medium text-white bg-neutral-900 hover:bg-black rounded-md transition"
              >
                {confirmDelete === "all-deep"
                  ? "Clear all"
                  : confirmDelete === "memory"
                  ? "Reset"
                  : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── small composable pieces ─────────────────────────────────────────────── */

function TabButton({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      role="tab"
      aria-selected={active}
      className={`relative pb-3 -mb-px text-[14px] font-medium transition inline-flex items-center ${
        active
          ? "text-neutral-900 border-b-2 border-neutral-900"
          : "text-neutral-500 hover:text-neutral-900 border-b-2 border-transparent"
      }`}
    >
      {children}
    </button>
  );
}

function Section({ icon, title, meta, open, onToggle, children }) {
  return (
    <section className="mt-6 border-b border-neutral-200 pb-6 first:border-t first:border-neutral-200 first:pt-6">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between group"
      >
        <div className="flex items-center gap-2">
          {icon}
          <span className="text-[15px] font-semibold">{title}</span>
          {meta && (
            <span className="text-[12px] text-neutral-400 font-normal ml-1">
              · {meta}
            </span>
          )}
        </div>
        <ChevronDown
          size={15}
          className={`text-neutral-400 group-hover:text-neutral-700 transition ${
            open ? "rotate-0" : "-rotate-90"
          }`}
        />
      </button>
      {open && <div className="mt-5">{children}</div>}
    </section>
  );
}

function Column({ label, items }) {
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-wider text-neutral-400 mb-2.5">
        {label}
      </div>
      <ul className="space-y-1.5">
        {items.map((item, i) => (
          <li
            key={i}
            className="text-[13.5px] leading-relaxed text-neutral-700 pl-3 relative before:content-[''] before:absolute before:left-0 before:top-[0.7em] before:w-1 before:h-1 before:rounded-full before:bg-neutral-300"
          >
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Divider() {
  return <div className="h-px bg-neutral-100" />;
}

function MemoryCard({ memory, expanded, onToggle, onDelete }) {
  return (
    <li className="group border border-neutral-200 rounded-lg hover:border-neutral-300 transition bg-white">
      <div className="flex items-start justify-between p-4 gap-3">
        <button onClick={onToggle} className="flex-1 text-left">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-[11px] font-medium uppercase tracking-wider text-neutral-400">
              Memory #{memory.id}
            </span>
            <span className="text-[11px] text-neutral-400">· {memory.date}</span>
          </div>
          <p className="text-[14px] leading-relaxed text-neutral-800">
            {memory.summary}
          </p>
        </button>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition">
          <button
            onClick={onDelete}
            title="Delete memory"
            className="p-1.5 text-neutral-400 hover:text-red-600 hover:bg-red-50 rounded-md transition"
          >
            <Trash2 size={14} />
          </button>
          <button
            onClick={onToggle}
            title={expanded ? "Collapse" : "Expand"}
            className="p-1.5 text-neutral-400 hover:text-neutral-700 hover:bg-neutral-100 rounded-md transition"
          >
            <ChevronDown
              size={14}
              className={`transition ${expanded ? "rotate-180" : ""}`}
            />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="px-4 pb-4 pt-1 space-y-4 border-t border-neutral-100">
          <DetailGroup label="User" items={memory.user} />
          <DetailGroup label="Assistant" items={memory.assistant} />
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wider text-neutral-400 mb-1.5 mt-3">
              Synthesis
            </div>
            <p className="text-[13.5px] leading-relaxed text-neutral-700 italic">
              {memory.synthesis}
            </p>
          </div>
        </div>
      )}
    </li>
  );
}

function DetailGroup({ label, items }) {
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-wider text-neutral-400 mb-1.5 mt-3">
        {label}
      </div>
      <ul className="space-y-1">
        {items.map((item, i) => (
          <li
            key={i}
            className="text-[13px] leading-relaxed text-neutral-700 pl-3 relative before:content-[''] before:absolute before:left-0 before:top-[0.7em] before:w-1 before:h-1 before:rounded-full before:bg-neutral-300"
          >
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}