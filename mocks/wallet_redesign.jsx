import React, { useState } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Download,
  Send,
  ShieldCheck,
  Link2,
  Unlink,
  Copy,
  Check,
  ChevronRight,
  Eye,
  EyeOff,
  Plus,
} from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// Data
// ─────────────────────────────────────────────────────────────────────────────

const transactions = [
  { id: 1, group: "Today",     type: "in",  label: "Daily airdrop",    counterparty: "Task Verifier", note: null,                                       amount:  8400, time: "11:15 AM" },
  { id: 2, group: "Today",     type: "in",  label: "Task reward",       counterparty: "Task Verifier", note: "Ship A 90 Percent Task Node Surface Cut",  amount:  3600, time: "10:42 AM" },
  { id: 3, group: "Today",     type: "out", label: "Verification fee",  counterparty: "Task Verifier", note: null,                                       amount:    -0, time: "11:15 AM" },
  { id: 4, group: "Today",     type: "out", label: "Verification fee",  counterparty: "Task Verifier", note: null,                                       amount:    -0, time: "11:03 AM" },
  { id: 5, group: "Yesterday", type: "in",  label: "Daily airdrop",    counterparty: "Task Verifier", note: null,                                       amount:  6200, time:  "9:18 AM" },
  { id: 6, group: "Yesterday", type: "in",  label: "Task reward",       counterparty: "Task Verifier", note: "Verify 8-K extractor output",              amount:  3000, time:  "5:09 PM" },
  { id: 7, group: "May 13",    type: "in",  label: "Daily airdrop",    counterparty: "Task Verifier", note: null,                                       amount:  7800, time:  "9:24 AM" },
  { id: 8, group: "May 13",    type: "in",  label: "Task reward",       counterparty: "Task Verifier", note: "Wire post-fiat heartbeat composer",        amount:  5400, time:  "2:18 PM" },
];

const fmt = (n) => {
  const abs = Math.abs(n);
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}${abs.toLocaleString("en-US")}`;
};

// ─────────────────────────────────────────────────────────────────────────────
// ChatGPT-flavored palette
// bg page:    #ffffff
// bg subtle:  #f4f4f4  (same gray as the system-prompt block in the screenshot)
// border:     #ececec
// text:       #0d0d0d
// muted:      #5d5d5d
// muted+:     #8e8e8e
// black btn:  #0d0d0d
// green:      #19a463
// green tint: #e7f4ec
// ─────────────────────────────────────────────────────────────────────────────

export default function WalletPage() {
  const [copied, setCopied] = useState(false);
  const [hideBalance, setHideBalance] = useState(false);
  const [hoveredRow, setHoveredRow] = useState(null);

  // ChatGPT uses Söhne (proprietary). The best public match is the system
  // font stack, which is what ChatGPT itself falls back to.
  const sans =
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Helvetica, Arial, sans-serif";
  const mono =
    "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";

  const copyAddress = () => {
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  const grouped = transactions.reduce((acc, t) => {
    (acc[t.group] = acc[t.group] || []).push(t);
    return acc;
  }, {});

  return (
    <div
      className="min-h-screen w-full"
      style={{
        fontFamily: sans,
        backgroundColor: "#ffffff",
        color: "#0d0d0d",
        WebkitFontSmoothing: "antialiased",
      }}
    >
      <div className="mx-auto max-w-3xl px-6 pt-8 pb-24 sm:px-8">
        {/* ── Header ───────────────────────────────────────────────────── */}
        <div className="mb-6 flex items-end justify-between">
          <div>
            <div className="text-[13px]" style={{ color: "#8e8e8e" }}>
              Task Node
            </div>
            <h1
              className="mt-0.5 text-[26px] font-semibold leading-tight"
              style={{ letterSpacing: "-0.01em" }}
            >
              Wallet
            </h1>
          </div>
          <button
            onClick={() => setHideBalance((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-full border bg-white px-3 py-1.5 text-[12.5px] transition hover:bg-neutral-50"
            style={{ borderColor: "#ececec", color: "#0d0d0d" }}
          >
            {hideBalance ? (
              <Eye className="h-3.5 w-3.5" />
            ) : (
              <EyeOff className="h-3.5 w-3.5" />
            )}
            {hideBalance ? "Show" : "Hide"} balance
          </button>
        </div>

        {/* ── Balance card ─────────────────────────────────────────────── */}
        <section
          className="rounded-2xl border bg-white"
          style={{ borderColor: "#ececec" }}
        >
          <div className="px-6 pt-6 pb-6 sm:px-8 sm:pt-7">
            <div className="flex items-center justify-between">
              <span
                className="text-[12px] font-medium uppercase tracking-[0.06em]"
                style={{ color: "#8e8e8e" }}
              >
                Available balance
              </span>
              <span
                className="inline-flex items-center gap-1.5 text-[12px]"
                style={{ color: "#5d5d5d" }}
              >
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: "#19a463" }}
                />
                Network live
              </span>
            </div>

            {/* The number — sans, large, tight tracking */}
            <div className="mt-3 flex items-baseline gap-3">
              <div
                className="font-semibold leading-none"
                style={{
                  fontSize: "clamp(56px, 9vw, 84px)",
                  letterSpacing: "-0.035em",
                }}
              >
                {hideBalance ? (
                  <span style={{ letterSpacing: "0.05em" }}>••••</span>
                ) : (
                  "0"
                )}
              </div>
              <div
                className="text-[18px] font-medium"
                style={{ color: "#8e8e8e", letterSpacing: "-0.01em" }}
              >
                PFT
              </div>
            </div>

            {/* Status row */}
            <div className="mt-5 flex flex-wrap items-center gap-2">
              <button
                onClick={copyAddress}
                className="group inline-flex items-center gap-2 rounded-full border bg-white px-3 py-1.5 text-[12px] transition hover:border-neutral-400"
                style={{
                  borderColor: "#ececec",
                  fontFamily: mono,
                  color: "#5d5d5d",
                }}
              >
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ background: "#cfcfcf" }}
                />
                No wallet linked
                {copied ? (
                  <Check className="h-3.5 w-3.5" style={{ color: "#19a463" }} />
                ) : (
                  <Copy className="h-3.5 w-3.5 opacity-50 transition group-hover:opacity-100" />
                )}
              </button>
              <span
                className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px]"
                style={{ background: "#f4f4f4", color: "#5d5d5d" }}
              >
                <ShieldCheck className="h-3.5 w-3.5" />
                Seed not linked
              </span>
            </div>

            <p
              className="mt-4 max-w-md text-[14px] leading-relaxed"
              style={{ color: "#5d5d5d" }}
            >
              Link a 24-word recovery phrase locally. Your seed never leaves
              your device.
            </p>

            {/* Actions */}
            <div className="mt-5 flex flex-wrap gap-2">
              <button
                className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-[14px] font-medium text-white transition hover:opacity-90 active:scale-[0.985]"
                style={{ background: "#0d0d0d" }}
              >
                <Link2 className="h-4 w-4" />
                Link wallet
              </button>
              <button
                className="inline-flex items-center gap-2 rounded-full border bg-white px-4 py-2 text-[14px] font-medium transition hover:bg-neutral-50"
                style={{ borderColor: "#ececec", color: "#0d0d0d" }}
              >
                <Download className="h-4 w-4" />
                Receive
              </button>
              <button
                className="inline-flex items-center gap-2 rounded-full border bg-white px-4 py-2 text-[14px] font-medium transition hover:bg-neutral-50 disabled:opacity-50"
                style={{ borderColor: "#ececec", color: "#0d0d0d" }}
                disabled
              >
                <Send className="h-4 w-4" />
                Send
              </button>
            </div>
          </div>
        </section>

        {/* ── Wallet management ────────────────────────────────────────── */}
        <section className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <ManagementCard
            label="Local seed vault"
            status="Not saved"
            icon={<ShieldCheck className="h-4 w-4" strokeWidth={1.75} />}
            mono={mono}
          />
          <ManagementCard
            label="Delink wallet"
            status="No wallet"
            icon={<Unlink className="h-4 w-4" strokeWidth={1.75} />}
            mono={mono}
          />
          <ManagementCard
            label="Relink wallet"
            status="Ready"
            active
            icon={<Link2 className="h-4 w-4" strokeWidth={1.75} />}
            mono={mono}
          />
        </section>

        {/* ── Chat credit notice ───────────────────────────────────────── */}
        <div
          className="mt-3 flex items-center justify-between rounded-2xl px-4 py-3 text-[13px]"
          style={{ background: "#f4f4f4", color: "#5d5d5d" }}
        >
          <span>
            Chat credit{" "}
            <span style={{ color: "#0d0d0d", fontFamily: mono }}>$5.00</span>.
            Billing is usage-based.
          </span>
          <button
            className="inline-flex items-center gap-1 rounded-full border bg-white px-3 py-1 text-[12px] transition hover:bg-neutral-50"
            style={{ borderColor: "#ececec", color: "#0d0d0d" }}
          >
            <Plus className="h-3 w-3" />
            Top up
          </button>
        </div>

        {/* ── Activity ─────────────────────────────────────────────────── */}
        <section className="mt-10">
          <div className="mb-4 flex items-end justify-between">
            <div>
              <div
                className="text-[12px] font-medium uppercase tracking-[0.06em]"
                style={{ color: "#8e8e8e" }}
              >
                Activity
              </div>
              <h2
                className="mt-0.5 text-[20px] font-semibold"
                style={{ letterSpacing: "-0.01em" }}
              >
                Your latest transactions
              </h2>
            </div>
            <button
              className="inline-flex items-center gap-0.5 text-[13px] transition hover:underline"
              style={{ color: "#0d0d0d" }}
            >
              View all <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>

          <div
            className="overflow-hidden rounded-2xl border bg-white"
            style={{ borderColor: "#ececec" }}
          >
            {Object.entries(grouped).map(([group, items]) => (
              <div key={group}>
                <div
                  className="flex items-center gap-3 px-5 pt-4 pb-2"
                  style={{ color: "#8e8e8e" }}
                >
                  <span className="text-[11px] font-medium uppercase tracking-[0.08em]">
                    {group}
                  </span>
                  <span
                    className="h-px flex-1"
                    style={{ background: "#f0f0f0" }}
                  />
                </div>

                <ul>
                  {items.map((t, i) => {
                    const isIn = t.type === "in";
                    const isHovered = hoveredRow === t.id;
                    return (
                      <li
                        key={t.id}
                        onMouseEnter={() => setHoveredRow(t.id)}
                        onMouseLeave={() => setHoveredRow(null)}
                        className="relative flex items-center gap-3.5 px-5 py-3.5 transition"
                        style={{
                          borderTop: i === 0 ? "none" : "1px solid #f4f4f4",
                          background: isHovered ? "#fafafa" : "transparent",
                        }}
                      >
                        {/* Icon */}
                        <div
                          className="flex h-9 w-9 flex-none items-center justify-center rounded-full"
                          style={{
                            background: isIn ? "#e7f4ec" : "#f4f4f4",
                            color: isIn ? "#19a463" : "#5d5d5d",
                          }}
                        >
                          {isIn ? (
                            <ArrowDownLeft className="h-4 w-4" strokeWidth={2} />
                          ) : (
                            <ArrowUpRight className="h-4 w-4" strokeWidth={2} />
                          )}
                        </div>

                        {/* Label */}
                        <div className="min-w-0 flex-1">
                          <div
                            className="text-[14.5px] font-medium"
                            style={{ color: "#0d0d0d" }}
                          >
                            {t.label}
                          </div>
                          <div
                            className="mt-0.5 truncate text-[13px]"
                            style={{ color: "#8e8e8e" }}
                          >
                            {isIn ? "From" : "To"} Task Verifier
                            {t.note && (
                              <>
                                <span
                                  className="mx-1.5"
                                  style={{ color: "#cfcfcf" }}
                                >
                                  ·
                                </span>
                                <span style={{ color: "#5d5d5d" }}>
                                  {t.note}
                                </span>
                              </>
                            )}
                          </div>
                        </div>

                        {/* Amount */}
                        <div className="flex-none text-right">
                          <div
                            className="text-[14.5px] tabular-nums"
                            style={{
                              color: isIn ? "#19a463" : "#8e8e8e",
                              fontWeight: 500,
                            }}
                          >
                            {fmt(t.amount)} PFT
                          </div>
                          <div
                            className="mt-0.5 text-[12px] tabular-nums"
                            style={{ color: "#8e8e8e" }}
                          >
                            {t.time}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}

            {/* Footer */}
            <div
              className="flex items-center justify-between border-t px-5 py-3 text-[12.5px]"
              style={{ borderColor: "#f4f4f4", color: "#8e8e8e" }}
            >
              <span>Showing 8 of 142 transactions</span>
              <button
                className="inline-flex items-center gap-0.5 transition hover:underline"
                style={{ color: "#0d0d0d" }}
              >
                Load more <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Subcomponents
// ─────────────────────────────────────────────────────────────────────────────

function ManagementCard({ label, status, icon, mono, active = false }) {
  return (
    <button
      className="group flex items-center justify-between rounded-2xl border bg-white px-4 py-3.5 text-left transition hover:bg-neutral-50"
      style={{ borderColor: "#ececec" }}
    >
      <div>
        <div
          className="flex items-center gap-2 text-[14px] font-medium"
          style={{ color: "#0d0d0d" }}
        >
          {icon}
          {label}
        </div>
        <div
          className="mt-0.5 pl-6 text-[12.5px]"
          style={{
            color: active ? "#19a463" : "#8e8e8e",
            fontFamily: mono,
          }}
        >
          {status}
        </div>
      </div>
      <ChevronRight
        className="h-4 w-4 opacity-30 transition group-hover:translate-x-0.5 group-hover:opacity-70"
        style={{ color: "#0d0d0d" }}
      />
    </button>
  );
}