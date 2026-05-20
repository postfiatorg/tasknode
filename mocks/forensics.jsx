import React, { useState } from "react";
import {
  Copy,
  Link2,
  ShieldCheck,
  X,
  Search,
  SquarePen,
  ListChecks,
  Wallet,
  BookOpen,
  MoreHorizontal,
  Lock,
  Clock,
  Image as ImageIcon,
  Code2,
  ChevronDown,
  ChevronRight,
  ArrowRight,
  FileText,
  Files,
} from "lucide-react";

// ─── Theme tokens (kept colocated so this component is portable) ─────────────
const C = {
  bgPage: "#F5F1EA",
  bgCard: "#FFFFFF",
  bgSoft: "#FAF7F1",
  text1: "#1A1A1A",
  text2: "#6B6760",
  text3: "#A09B92",
  border1: "rgba(0,0,0,0.08)",
  border2: "rgba(0,0,0,0.14)",
  greenDot: "#1D9E75",
  greenBg: "#E1F5EE",
  greenText: "#0F6E56",
  greenTint: "#F2FAF6",
  amberBg: "#FAEEDA",
  amberText: "#854F0B",
  amberDot: "#BA7517",
  blueBg: "#E6F1FB",
  blueText: "#0C447C",
  blueDot: "#378ADD",
  purpleBg: "#EEEDFE",
  purpleText: "#3C3489",
  link: "#3A5BA9",
};

// ─── Small reusable primitives ───────────────────────────────────────────────
const Pill = ({ variant = "green", children }) => {
  const m = {
    green: { bg: C.greenBg, text: C.greenText, dot: C.greenDot },
    amber: { bg: C.amberBg, text: C.amberText, dot: C.amberDot },
    blue: { bg: C.blueBg, text: C.blueText, dot: C.blueDot },
    purple: { bg: C.purpleBg, text: C.purpleText, dot: "#7F77DD" },
  }[variant];
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium align-middle"
      style={{ background: m.bg, color: m.text }}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: m.dot }} />
      {children}
    </span>
  );
};

const Mono = ({ children, style }) => (
  <span
    className="font-mono"
    style={{ fontSize: 11.5, letterSpacing: "-0.01em", ...style }}
  >
    {children}
  </span>
);

const CopyIcon = ({ title = "Copy" }) => (
  <button
    title={title}
    className="inline-flex transition-colors"
    style={{ color: C.text3 }}
    onMouseEnter={(e) => (e.currentTarget.style.color = C.text1)}
    onMouseLeave={(e) => (e.currentTarget.style.color = C.text3)}
  >
    <Copy size={12} strokeWidth={1.5} />
  </button>
);

const Field = ({ label, value, mono, bold }) => (
  <div>
    <div style={{ color: C.text3, fontSize: 11.5, marginBottom: 3 }}>{label}</div>
    <div
      style={{
        fontSize: 13,
        fontWeight: bold ? 500 : 400,
        fontFamily: mono ? "ui-monospace, 'SF Mono', Menlo, Consolas, monospace" : undefined,
      }}
    >
      {value}
    </div>
  </div>
);

const ProofFooter = ({ cid, tx, onToggleRaw, rawOpen }) => (
  <div
    className="flex items-center gap-2.5 flex-wrap"
    style={{ marginTop: 14, fontSize: 11, color: C.text3 }}
  >
    <Link2 size={12} strokeWidth={1.5} />
    <Mono>{cid}</Mono>
    <span>·</span>
    <Mono>{tx}</Mono>
    <button
      onClick={onToggleRaw}
      className="ml-auto inline-flex items-center gap-1 cursor-pointer transition-colors"
      style={{ color: C.text2 }}
      onMouseEnter={(e) => (e.currentTarget.style.color = C.text1)}
      onMouseLeave={(e) => (e.currentTarget.style.color = C.text2)}
    >
      Raw payload{" "}
      {rawOpen ? (
        <ChevronDown size={12} strokeWidth={1.5} />
      ) : (
        <ChevronRight size={12} strokeWidth={1.5} />
      )}
    </button>
  </div>
);

const EventWhen = ({ time, ledger, memo }) => (
  <div
    className="flex items-center gap-2.5"
    style={{ fontSize: 12, color: C.text2, marginBottom: 16 }}
  >
    <span>{time}</span>
    <span style={{ color: C.text3 }}>·</span>
    <span>Ledger {ledger}</span>
    <span style={{ color: C.text3 }}>·</span>
    <span>Memo {memo}</span>
  </div>
);

const Card = ({ children, style, className = "" }) => (
  <div
    className={`rounded-xl ${className}`}
    style={{
      background: C.bgCard,
      border: `0.5px solid ${C.border1}`,
      padding: "20px 24px",
      borderRadius: 12,
      ...style,
    }}
  >
    {children}
  </div>
);

const EventHead = ({ title, schema, tag, tagVariant }) => (
  <div className="flex items-baseline justify-between gap-3" style={{ marginBottom: 4 }}>
    <div className="flex items-center gap-2.5 flex-wrap">
      <span style={{ fontSize: 16, fontWeight: 500 }}>{title}</span>
      {tag && (
        <span
          className="inline-flex items-center px-2 py-0.5 rounded-full font-medium"
          style={{
            fontSize: 10,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            ...(tagVariant === "purple"
              ? { background: C.purpleBg, color: C.purpleText }
              : tagVariant === "green"
              ? { background: C.greenBg, color: C.greenText }
              : { background: C.blueBg, color: C.blueText }),
          }}
        >
          {tag}
        </span>
      )}
    </div>
    <Mono style={{ color: C.text3, whiteSpace: "nowrap" }}>{schema}</Mono>
  </div>
);

const ShowMore = ({ children, onClick }) => (
  <button
    onClick={onClick}
    className="cursor-pointer hover:underline"
    style={{ color: C.link, fontSize: 13, background: "none", border: 0, padding: 0 }}
  >
    {children}
  </button>
);

const TimelineDot = ({ n, variant = "filled" }) => {
  const base = {
    position: "absolute",
    left: -32,
    top: 22,
    width: 22,
    height: 22,
    borderRadius: "50%",
    boxShadow: `0 0 0 3px ${C.bgPage}`,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 10,
    fontWeight: 600,
    color: "white",
    boxSizing: "border-box",
  };
  if (variant === "outline")
    return (
      <div
        style={{
          ...base,
          background: C.bgPage,
          border: `1.5px solid ${C.greenDot}`,
          color: C.greenDot,
        }}
      >
        {n}
      </div>
    );
  if (variant === "purple")
    return <div style={{ ...base, background: "#7F77DD" }}>{n}</div>;
  if (variant === "amber")
    return <div style={{ ...base, background: C.amberDot }}>{n}</div>;
  return <div style={{ ...base, background: C.greenDot }}>{n}</div>;
};

// ─── Lifecycle stepper ───────────────────────────────────────────────────────
const Lifecycle = () => {
  const steps = ["Offered", "Accepted", "Submitted", "V. requested", "V. response", "Decided", "Paid"];
  return (
    <Card style={{ padding: "20px 24px", marginBottom: 28 }}>
      <div className="flex justify-between items-center" style={{ marginBottom: 18 }}>
        <div className="flex items-center gap-2" style={{ fontSize: 13, fontWeight: 500 }}>
          <Clock size={14} strokeWidth={1.5} style={{ opacity: 0.7 }} />
          Lifecycle
        </div>
        <div style={{ fontSize: 12, color: C.text3 }}>
          Completed in 4h 18m · all 7 stages
        </div>
      </div>
      <div className="flex items-start">
        {steps.map((label, i) => (
          <React.Fragment key={i}>
            <div className="flex flex-col items-center" style={{ flex: "0 0 auto", minWidth: 0 }}>
              <div
                style={{
                  width: 11,
                  height: 11,
                  borderRadius: "50%",
                  background: C.greenDot,
                  marginBottom: 8,
                  boxShadow: i === steps.length - 1 ? `0 0 0 4px ${C.greenBg}` : "none",
                }}
              />
              <div
                style={{
                  fontSize: 11,
                  color: C.text2,
                  fontWeight: 500,
                  whiteSpace: "nowrap",
                  textAlign: "center",
                }}
              >
                {label}
              </div>
            </div>
            {i < steps.length - 1 && (
              <div
                style={{
                  flex: 1,
                  height: 1.5,
                  background: C.greenDot,
                  margin: "4.5px 4px 0",
                  alignSelf: "flex-start",
                }}
              />
            )}
          </React.Fragment>
        ))}
      </div>
    </Card>
  );
};

// ─── Sidebar ─────────────────────────────────────────────────────────────────
const Sidebar = () => {
  const NavItem = ({ icon: Icon, children, active, badge, locked }) => (
    <div
      className="flex items-center gap-2.5 px-3 py-2 cursor-pointer rounded-lg"
      style={{
        fontSize: 14,
        color: C.text1,
        background: active ? "rgba(0,0,0,0.05)" : "transparent",
      }}
    >
      <Icon size={16} strokeWidth={1.5} style={{ opacity: 0.7 }} />
      <span className="flex-1">{children}</span>
      {badge && (
        <span
          className="font-medium rounded-full"
          style={{
            background: "#1A1A1A",
            color: "white",
            fontSize: 11,
            padding: "1px 8px",
          }}
        >
          {badge}
        </span>
      )}
      {locked && (
        <span
          className="font-medium rounded-full"
          style={{
            background: C.amberBg,
            color: C.amberText,
            fontSize: 10,
            padding: "2px 7px",
          }}
        >
          Locked
        </span>
      )}
    </div>
  );

  const Recent = ({ children, current }) => (
    <div
      className="rounded-lg cursor-pointer truncate"
      style={{
        padding: "7px 12px",
        fontSize: 13,
        color: current ? C.text1 : C.text2,
        background: current ? "rgba(0,0,0,0.05)" : "transparent",
      }}
    >
      {children}
    </div>
  );

  return (
    <aside
      className="flex flex-col"
      style={{
        background: C.bgPage,
        borderRight: `0.5px solid ${C.border1}`,
        padding: "16px 12px",
      }}
    >
      <div className="flex-1 overflow-y-auto">
        <div
          className="flex items-center gap-2.5"
          style={{ padding: "10px 12px 22px", fontWeight: 500, fontSize: 15 }}
        >
          <X size={16} strokeWidth={1.75} />
          <span>Task Node</span>
        </div>
        <NavItem icon={SquarePen}>New chat</NavItem>
        <NavItem icon={Search}>Search chats</NavItem>
        <NavItem icon={ListChecks} active badge="3">
          Tasks
        </NavItem>
        <NavItem icon={Wallet} locked>
          Wallet
        </NavItem>
        <NavItem icon={BookOpen}>Context</NavItem>
        <NavItem icon={MoreHorizontal}>More</NavItem>

        <div
          className="uppercase font-medium"
          style={{
            fontSize: 11,
            color: C.text3,
            letterSpacing: "0.06em",
            padding: "18px 12px 6px",
          }}
        >
          Recents
        </div>
        <Recent current>Forensics: timestamp fix</Recent>
        <Recent>what should I be focused on?</Recent>
        <Recent>what's going on in iran</Recent>
        <Recent>what am I ignoring</Recent>
        <Recent>what other things can I learn</Recent>
        <Recent>I need to make chat into th…</Recent>
        <Recent>Smoke test task request fro…</Recent>
      </div>

      <div style={{ padding: "14px 12px", borderTop: `0.5px solid ${C.border1}` }}>
        <div className="flex items-center gap-2.5" style={{ fontSize: 13, padding: "4px 0" }}>
          <Wallet size={14} strokeWidth={1.5} />
          <span style={{ fontWeight: 500 }}>47.95</span>
          <span
            style={{
              color: C.text2,
              fontSize: 11,
              textTransform: "uppercase",
            }}
          >
            PFT
          </span>
        </div>
        <div className="flex items-center gap-2.5" style={{ fontSize: 13, padding: "4px 0" }}>
          <span style={{ fontWeight: 500 }}>$19.93</span>
          <span style={{ color: C.text2, fontSize: 12 }}>chat</span>
        </div>
        <div style={{ marginTop: 6 }}>
          <span
            className="inline-flex items-center gap-1 rounded-full font-medium"
            style={{
              background: C.amberBg,
              color: C.amberText,
              fontSize: 10,
              padding: "2px 7px",
            }}
          >
            <Lock size={10} strokeWidth={1.75} />
            Locked
          </span>
        </div>
      </div>
    </aside>
  );
};

// ─── Quote block (verification ask/response) ─────────────────────────────────
const Quote = ({ label, children, accentGreen }) => (
  <div
    style={{
      background: C.bgSoft,
      borderLeft: `2px solid ${accentGreen ? C.greenDot : C.border2}`,
      padding: "12px 16px",
      borderRadius: "0 8px 8px 0",
      fontSize: 13,
      color: C.text2,
      lineHeight: 1.6,
      marginBottom: 14,
    }}
  >
    <div
      style={{
        fontSize: 11,
        color: C.text3,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        marginBottom: 6,
        fontWeight: 500,
      }}
    >
      {label}
    </div>
    {children}
  </div>
);

const InlineMono = ({ children }) => (
  <span
    style={{
      fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
      fontSize: 12,
      background: "rgba(0,0,0,0.04)",
      padding: "1px 4px",
      borderRadius: 3,
    }}
  >
    {children}
  </span>
);

// ─── Main component ─────────────────────────────────────────────────────────
export default function ForensicsPage() {
  const [raw, setRaw] = useState({});
  const [showDesc, setShowDesc] = useState(false);
  const [showFullResponse, setShowFullResponse] = useState(false);
  const [showReason, setShowReason] = useState(false);
  const [appendixOpen, setAppendixOpen] = useState(true);

  const toggleRaw = (n) => setRaw((p) => ({ ...p, [n]: !p[n] }));

  const fullReason =
    "The submission addressed the timestamp formatting issue with a clear root-cause analysis, listed modified files, and provided UI evidence showing corrected relative timestamp rendering instead of default 12 AM values. The follow-up verification included a concrete code excerpt implementing the midnight UTC detection logic and exact example outputs for both date-only and timestamp cases. Evidence was consistent and aligned with the requested task scope.";

  const cids = [
    ["Request bundle", "QmeDGj3Vsi…Lz8MHZ"],
    ["1 · Offered", "QmPyojgZJM…1jqtB8"],
    ["2 · Accepted", "QmU1oEk4wL…qRqHDE"],
    ["3 · Submitted", "QmauRRaxDB…yvmRmx"],
    ["4 · V. requested", "QmSs7hBksx…J1NYjh"],
    ["5 · V. response", "QmPVMnwUbW…5pNnZ5"],
    ["6 · Decided", "Qmd4SsP8x5…JkM5w8"],
    ["7 · Paid", "QmUq9Y4ib4…tS6BfE"],
  ];

  const txs = [
    ["1 · Offered", "BC8EF83AC4…1EB118"],
    ["2 · Accepted", "C30EB73D82…FD65F4"],
    ["3 · Submitted", "446A751A0D…03B996"],
    ["4 · V. requested", "A403F98942…BD06AA"],
    ["5 · V. response", "75BD0A9900…CA5B8B"],
    ["6 · Decided", "A1A8C5A5BF…6A59C8"],
    ["7 · Paid", "FCB3063352…3D142C"],
  ];

  const reducerChain = [
    "Task offered",
    "Task accepted",
    "Evidence submitted",
    "Verification requested",
    "Verification response",
    "Reward decision",
    "Reward paid",
  ];

  return (
    <div
      style={{
        background: C.bgPage,
        minHeight: "100vh",
        color: C.text1,
        fontFamily:
          "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
        fontSize: 14,
        lineHeight: 1.5,
        WebkitFontSmoothing: "antialiased",
      }}
    >
      <div
        className="grid"
        style={{ gridTemplateColumns: "280px 1fr", minHeight: "100vh" }}
      >
        <Sidebar />

        <main style={{ padding: "32px 56px 80px", maxWidth: 920 }}>
          {/* Top close */}
          <div className="flex justify-end items-center" style={{ marginBottom: 16 }}>
            <button
              className="inline-flex items-center gap-1.5 cursor-pointer"
              style={{ fontSize: 13, color: C.text2, background: "none", border: 0 }}
            >
              <X size={14} strokeWidth={1.5} />
              Close
            </button>
          </div>

          {/* Header */}
          <div style={{ marginBottom: 28 }}>
            <div
              className="flex items-center gap-2"
              style={{ marginBottom: 10, fontSize: 12, color: C.text2 }}
            >
              <span
                className="rounded-full"
                style={{ width: 7, height: 7, background: C.greenDot, display: "inline-block" }}
              />
              <span>Engineering</span>
              <span style={{ color: C.text3 }}>·</span>
              <span style={{ color: C.greenText, fontWeight: 500 }}>Rewarded</span>
              <span style={{ color: C.text3 }}>·</span>
              <span>May 19</span>
            </div>
            <h1
              style={{
                fontSize: 26,
                fontWeight: 500,
                margin: "0 0 12px",
                lineHeight: 1.25,
                letterSpacing: "-0.01em",
              }}
            >
              Fix Task Node timestamp rendering across UI
            </h1>
            <div
              className="flex items-center gap-3.5 flex-wrap"
              style={{ fontSize: 13, color: C.text2 }}
            >
              <span>
                <span style={{ color: C.text1, fontWeight: 500 }}>2.5</span> PFT paid
              </span>
              <span style={{ color: C.border2 }}>|</span>
              <span>7 indexed events</span>
              <span style={{ color: C.border2 }}>|</span>
              <span>
                Score <span style={{ color: C.text1, fontWeight: 500 }}>96</span>/100
              </span>
              <span style={{ color: C.border2 }}>|</span>
              <Mono style={{ color: C.text3 }}>task_a89f56…f58e4cef</Mono>
              <CopyIcon title="Copy task ID" />
            </div>
          </div>

          <Lifecycle />

          {/* Tabs */}
          <div
            className="flex gap-7"
            style={{ borderBottom: `0.5px solid ${C.border1}`, marginBottom: 28 }}
          >
            {[
              ["Overview", false],
              ["Submit", false],
              ["Forensics", true],
            ].map(([label, active]) => (
              <div
                key={label}
                className="cursor-pointer"
                style={{
                  padding: "0 0 12px",
                  fontSize: 14,
                  color: active ? C.text1 : C.text2,
                  fontWeight: active ? 500 : 400,
                  borderBottom: active ? `1.5px solid ${C.text1}` : "none",
                  marginBottom: active ? "-0.5px" : 0,
                }}
              >
                {label}
              </div>
            ))}
          </div>

          {/* Proof anchors */}
          <Card style={{ marginBottom: 24, padding: "18px 24px" }}>
            <div className="flex justify-between items-center" style={{ marginBottom: 14 }}>
              <div className="flex items-center gap-2" style={{ fontSize: 13, fontWeight: 500 }}>
                <ShieldCheck size={14} strokeWidth={1.5} style={{ opacity: 0.7 }} />
                Proof anchors
              </div>
              <span style={{ fontSize: 12, color: C.text3 }}>
                7 of 7 events indexed · view full appendix below
              </span>
            </div>
            <div
              className="grid items-center"
              style={{ gridTemplateColumns: "140px 1fr auto", gap: "10px 16px", fontSize: 13 }}
            >
              <span style={{ color: C.text2 }}>Request bundle</span>
              <Mono>QmeDGj3Vsi…Lz8MHZ</Mono>
              <CopyIcon />
              <span style={{ color: C.text2 }}>Last CID</span>
              <Mono>QmUq9Y4ib4…tS6BfE</Mono>
              <CopyIcon />
              <span style={{ color: C.text2 }}>Last transaction</span>
              <Mono>FCB3063352…3D142C</Mono>
              <CopyIcon />
            </div>
          </Card>

          {/* How to read */}
          <div
            style={{
              fontSize: 13,
              color: C.text2,
              lineHeight: 1.65,
              marginBottom: 36,
              paddingLeft: 14,
              borderLeft: `2px solid ${C.border1}`,
            }}
          >
            <p style={{ margin: "0 0 8px" }}>
              Each row below is a PFTL transaction pointer. The CID and transaction are the
              on-chain proof anchors; readable fields come from the decrypted IPFS payload when the
              Task Node service key can read it.
            </p>
            <p style={{ margin: 0 }}>
              <InlineMono>TASK_UPDATE</InlineMono> is a state transition such as accepted, refused,
              or verification requested. <InlineMono>TASK_SUBMISSION</InlineMono> is initial
              evidence or verification evidence.
            </p>
          </div>

          {/* Timeline header */}
          <div className="flex items-baseline justify-between" style={{ marginBottom: 18 }}>
            <span style={{ fontSize: 13, fontWeight: 500 }}>Action timeline</span>
            <span style={{ fontSize: 12, color: C.text3 }}>7 events · May 19</span>
          </div>

          {/* Timeline */}
          <div style={{ position: "relative", paddingLeft: 38 }}>
            <div
              style={{
                position: "absolute",
                left: 10,
                top: 22,
                bottom: 22,
                width: 1,
                background: C.border1,
              }}
            />

            {/* 1. Task offered */}
            <div style={{ position: "relative", marginBottom: 16 }}>
              <TimelineDot n="1" variant="outline" />
              <Card>
                <EventHead title="Task offered" schema="pf.task.offer.v1" />
                <EventWhen time="2:01 PM AST" ledger="2927300" memo="0" />
                <p style={{ fontSize: 14, margin: "0 0 14px", lineHeight: 1.6 }}>
                  The task authority offered this task to the user wallet. Transition:{" "}
                  <Pill variant="amber">proposed</Pill>
                </p>
                <p
                  style={{
                    fontSize: 13,
                    color: C.text2,
                    margin: "0 0 8px",
                    lineHeight: 1.65,
                    display: showDesc ? "block" : "-webkit-box",
                    WebkitLineClamp: 3,
                    WebkitBoxOrient: "vertical",
                    overflow: "hidden",
                  }}
                >
                  Audit the task node frontend and backend timestamp formatting so task events no
                  longer default to displaying as 12 AM. Implement a consistent timezone-aware
                  formatting path for created_at, updated_at, and review timestamps, then verify
                  rendering across the main task views. Submit a short summary of the root cause,
                  changed files, and before/after evidence.
                </p>
                <div style={{ marginBottom: 16 }}>
                  <ShowMore onClick={() => setShowDesc(!showDesc)}>
                    {showDesc ? "Show less" : "Show submission requirement"}
                  </ShowMore>
                </div>

                <div
                  className="grid"
                  style={{
                    gridTemplateColumns: "1fr 1fr",
                    gap: "14px 32px",
                    fontSize: 12,
                    padding: "14px 0",
                    borderTop: `0.5px solid ${C.border1}`,
                    borderBottom: `0.5px solid ${C.border1}`,
                  }}
                >
                  <Field label="Reward offered" value="2.50 PFT" bold />
                  <Field label="Kind" value="Engineering" />
                  <Field label="Submission / verification" value="Mixed / mixed" />
                  <Field
                    label="Generated by"
                    value={<span style={{ color: C.text2 }}>chat-latest · frontier</span>}
                  />
                  <Field label="Actor (authority)" value="rwdm72…PnSfH7" mono />
                  <Field label="Subject (user)" value="rhwiJxk…Cyw2TaE" mono />
                </div>

                <ProofFooter
                  cid="QmPyojgZJM…1jqtB8"
                  tx="BC8EF83AC4…1EB118"
                  rawOpen={raw[1]}
                  onToggleRaw={() => toggleRaw(1)}
                />
              </Card>
            </div>

            {/* 2. Task accepted */}
            <div style={{ position: "relative", marginBottom: 16 }}>
              <TimelineDot n="2" />
              <Card>
                <EventHead title="Task accepted" schema="pf.task.update.v1" />
                <EventWhen time="3:34 PM AST" ledger="2929536" memo="1" />
                <p style={{ fontSize: 14, margin: "0 0 4px", lineHeight: 1.6 }}>
                  The user accepted the task. Status: <Pill variant="green">accepted</Pill>
                </p>
                <ProofFooter
                  cid="QmU1oEk4wL…qRqHDE"
                  tx="C30EB73D82…FD65F4"
                  rawOpen={raw[2]}
                  onToggleRaw={() => toggleRaw(2)}
                />
              </Card>
            </div>

            {/* 3. Evidence submitted */}
            <div style={{ position: "relative", marginBottom: 16 }}>
              <TimelineDot n="3" variant="purple" />
              <Card>
                <EventHead
                  title="Evidence submitted"
                  schema="pf.task.submission.v1"
                  tag="Submission"
                  tagVariant="purple"
                />
                <EventWhen time="3:48 PM AST" ledger="2929813" memo="2" />
                <p style={{ fontSize: 14, margin: "0 0 16px", lineHeight: 1.6 }}>
                  The user submitted initial task evidence. Phase:{" "}
                  <InlineMono>initial_submission</InlineMono> · 2 items
                </p>

                <div className="flex flex-col gap-2" style={{ marginBottom: 16 }}>
                  {[
                    {
                      icon: ImageIcon,
                      name: "screenshotproof.png",
                      desc: 'Tasks page with "Rewarded" tab selected and count badge 14. Header stats show 2 outstanding, 5 PFT in flight, 17 chain indexed. Multiple rewarded tasks visible with non-default relative timestamps.',
                    },
                    {
                      icon: Code2,
                      name: "Code excerpt",
                      desc: (
                        <>
                          Inline text describing the root cause and fix in{" "}
                          <Mono>shared/task-time-format.js</Mono>
                        </>
                      ),
                    },
                  ].map((a, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-3"
                      style={{
                        padding: "10px 12px",
                        background: C.bgSoft,
                        border: `0.5px solid ${C.border1}`,
                        borderRadius: 8,
                        fontSize: 13,
                      }}
                    >
                      <div
                        className="flex items-center justify-center"
                        style={{
                          width: 32,
                          height: 32,
                          background: "white",
                          border: `0.5px solid ${C.border1}`,
                          borderRadius: 8,
                          color: C.text2,
                          flex: "0 0 auto",
                        }}
                      >
                        <a.icon size={14} strokeWidth={1.5} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 2 }}>
                          {a.name}
                        </div>
                        <div
                          style={{
                            fontSize: 12,
                            color: C.text2,
                            display: "-webkit-box",
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: "vertical",
                            overflow: "hidden",
                          }}
                        >
                          {a.desc}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                <ProofFooter
                  cid="QmauRRaxDB…yvmRmx"
                  tx="446A751A0D…03B996"
                  rawOpen={raw[3]}
                  onToggleRaw={() => toggleRaw(3)}
                />
              </Card>
            </div>

            {/* 4. Verification requested */}
            <div style={{ position: "relative", marginBottom: 16 }}>
              <TimelineDot n="4" variant="amber" />
              <Card>
                <EventHead
                  title="Verification requested"
                  schema="pf.task.update.v1"
                  tag="Verification exchange"
                  tagVariant="blue"
                />
                <EventWhen time="3:48 PM AST" ledger="2929818" memo="3" />
                <p style={{ fontSize: 14, margin: "0 0 14px", lineHeight: 1.6 }}>
                  The task authority requested follow-up verification evidence. Status:{" "}
                  <Pill variant="amber">verification_requested</Pill> Assessment:{" "}
                  <Pill variant="green">legitimate</Pill>
                </p>

                <Quote label="The ask">
                  Provide a short code excerpt from <InlineMono>shared/task-time-format.js</InlineMono>{" "}
                  showing the conditional logic that distinguishes date-only deadlines (midnight
                  UTC values) from real timestamps, including one example input and the exact
                  formatted output it now returns for each case.
                </Quote>

                <div
                  className="grid"
                  style={{
                    gridTemplateColumns: "repeat(3, 1fr)",
                    gap: "10px 24px",
                    fontSize: 12,
                    padding: "12px 0",
                    borderTop: `0.5px solid ${C.border1}`,
                    borderBottom: `0.5px solid ${C.border1}`,
                  }}
                >
                  <Field label="Verification type" value="Text" />
                  <Field
                    label="Generated by"
                    value={<span style={{ color: C.text2 }}>verification_request_v1</span>}
                  />
                  <Field label="Authority" value="rwdm72…PnSfH7" mono />
                </div>

                <ProofFooter
                  cid="QmSs7hBksx…J1NYjh"
                  tx="A403F98942…BD06AA"
                  rawOpen={raw[4]}
                  onToggleRaw={() => toggleRaw(4)}
                />
              </Card>
            </div>

            {/* 5. Verification response */}
            <div style={{ position: "relative", marginBottom: 16 }}>
              <TimelineDot n="5" variant="purple" />
              <Card>
                <EventHead
                  title="Verification response submitted"
                  schema="pf.task.verification_response.v1"
                  tag="Verification exchange"
                  tagVariant="blue"
                />
                <EventWhen time="4:00 PM AST" ledger="2930053" memo="4" />
                <p style={{ fontSize: 14, margin: "0 0 14px", lineHeight: 1.6 }}>
                  The user responded to the verification request. Phase:{" "}
                  <InlineMono>verification_response</InlineMono>
                </p>

                <Quote label="Response · 1 text evidence item">
                  Commit: <InlineMono>511f0d1</InlineMono> — Fix task timestamp formatting. Code
                  excerpt from <InlineMono>shared/task-time-format.js</InlineMono>:
                  <div
                    style={{
                      marginTop: 8,
                      fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
                      fontSize: 12,
                      background: "rgba(0,0,0,0.04)",
                      padding: "8px 10px",
                      borderRadius: 4,
                      color: C.text1,
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {showFullResponse
                      ? `function isUtcMidnight(date) {
  return date.getUTCHours() === 0
    && date.getUTCMinutes() === 0
    && date.getUTCSeconds() === 0;
}

// Input: 2025-05-20T00:00:00Z
// Output: "May 20"

// Input: 2025-05-19T18:34:12Z
// Output: "May 19, 6:34 PM UTC"`
                      : `function isUtcMidnight(date) {
  return date.getUTCHours() === 0
    && date.getUTCMin…`}
                  </div>
                  <div style={{ marginTop: 8 }}>
                    <ShowMore onClick={() => setShowFullResponse(!showFullResponse)}>
                      {showFullResponse ? "Show less" : "Show full response"}
                    </ShowMore>
                  </div>
                </Quote>

                <ProofFooter
                  cid="QmPVMnwUbW…5pNnZ5"
                  tx="75BD0A9900…CA5B8B"
                  rawOpen={raw[5]}
                  onToggleRaw={() => toggleRaw(5)}
                />
              </Card>
            </div>

            {/* 6. Reward decision */}
            <div style={{ position: "relative", marginBottom: 16 }}>
              <TimelineDot n="6" />
              <Card>
                <EventHead
                  title="Reward decision"
                  schema="pf.task.reward_decision.v1"
                  tag="Reward"
                  tagVariant="green"
                />
                <EventWhen time="4:00 PM AST" ledger="2930058" memo="5" />
                <p style={{ fontSize: 14, margin: "0 0 14px", lineHeight: 1.6 }}>
                  The task authority scored the submitted evidence. Status:{" "}
                  <Pill variant="green">reward_decided</Pill> Tier:{" "}
                  <Pill variant="blue">reward</Pill>
                </p>

                {/* Scorecard */}
                <div
                  className="grid"
                  style={{
                    gridTemplateColumns: "1fr 1fr",
                    gap: 24,
                    padding: "18px 20px",
                    background: C.greenTint,
                    borderRadius: 8,
                    marginBottom: 16,
                  }}
                >
                  {[
                    ["Reward score", 96],
                    ["Evidence quality", 90],
                  ].map(([lbl, val]) => (
                    <div key={lbl} className="flex flex-col gap-1.5">
                      <div style={{ fontSize: 11.5, color: C.text2, fontWeight: 500 }}>{lbl}</div>
                      <div className="flex items-baseline gap-1">
                        <span
                          style={{
                            fontSize: 32,
                            fontWeight: 500,
                            lineHeight: 1,
                            letterSpacing: "-0.02em",
                          }}
                        >
                          {val}
                        </span>
                        <span style={{ fontSize: 14, color: C.text3 }}>/ 100</span>
                      </div>
                      <div
                        style={{
                          height: 4,
                          background: "rgba(0,0,0,0.06)",
                          borderRadius: 999,
                          overflow: "hidden",
                          marginTop: 4,
                        }}
                      >
                        <div
                          style={{
                            height: "100%",
                            background: C.greenDot,
                            width: `${val}%`,
                            borderRadius: 999,
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>

                <Quote label="Summary" accentGreen>
                  Strong verification package with both UI proof and implementation details. The
                  formatter logic and example outputs clearly demonstrated the fix worked as
                  intended.
                </Quote>

                {showReason && (
                  <Quote label="Full reasoning">{fullReason}</Quote>
                )}
                <div style={{ marginBottom: 16 }}>
                  <ShowMore onClick={() => setShowReason(!showReason)}>
                    {showReason ? "Hide full reasoning" : "Show full reasoning"}
                  </ShowMore>
                </div>

                <div
                  className="grid"
                  style={{
                    gridTemplateColumns: "repeat(3, 1fr)",
                    gap: "10px 24px",
                    fontSize: 12,
                    padding: "12px 0",
                    borderTop: `0.5px solid ${C.border1}`,
                    borderBottom: `0.5px solid ${C.border1}`,
                  }}
                >
                  <Field label="Reward paid" value="2.50 PFT" bold />
                  <Field label="Allocation wallet" value="rwdm72…PnSfH7" mono />
                  <Field
                    label="Generated by"
                    value={<span style={{ color: C.text2 }}>reward_scoring_v1</span>}
                  />
                </div>

                <ProofFooter
                  cid="Qmd4SsP8x5…JkM5w8"
                  tx="A1A8C5A5BF…6A59C8"
                  rawOpen={raw[6]}
                  onToggleRaw={() => toggleRaw(6)}
                />
              </Card>
            </div>

            {/* 7. Reward paid */}
            <div style={{ position: "relative", marginBottom: 0 }}>
              <TimelineDot n="7" />
              <Card
                style={{
                  background: C.greenTint,
                  border: `0.5px solid ${C.greenBg}`,
                }}
              >
                <EventHead
                  title="Reward paid"
                  schema="pf.reward.v1"
                  tag="Settlement"
                  tagVariant="green"
                />
                <EventWhen time="4:01 PM AST" ledger="2930060" memo="6" />

                <div style={{ fontSize: 12, color: C.text2, marginTop: 4 }}>
                  On-chain settlement
                </div>
                <div className="flex items-baseline gap-1.5" style={{ margin: "8px 0 12px" }}>
                  <span
                    style={{
                      fontSize: 32,
                      fontWeight: 500,
                      color: C.greenText,
                      lineHeight: 1,
                      letterSpacing: "-0.02em",
                    }}
                  >
                    +2.50
                  </span>
                  <span style={{ fontSize: 14, color: C.greenText, fontWeight: 500 }}>PFT</span>
                </div>
                <div
                  className="flex items-center gap-3 flex-wrap"
                  style={{ fontSize: 13, color: C.text2, marginTop: 4 }}
                >
                  <Mono style={{ color: C.text1 }}>rwdm72…PnSfH7</Mono>
                  <ArrowRight size={14} strokeWidth={1.5} style={{ color: C.text3 }} />
                  <Mono style={{ color: C.text1 }}>rhwiJxk…Cyw2TaE</Mono>
                  <span style={{ color: C.border2 }}>|</span>
                  <span>
                    Tier: <span style={{ color: C.text1, fontWeight: 500 }}>task_engine_live</span>
                  </span>
                </div>

                <div style={{ marginTop: 18 }}>
                  <ProofFooter
                    cid="QmUq9Y4ib4…tS6BfE"
                    tx="FCB3063352…3D142C"
                    rawOpen={raw[7]}
                    onToggleRaw={() => toggleRaw(7)}
                  />
                </div>
              </Card>
            </div>
          </div>

          {/* Appendix */}
          <button
            onClick={() => setAppendixOpen(!appendixOpen)}
            className="flex items-center justify-between w-full cursor-pointer"
            style={{
              margin: "40px 0 16px",
              background: "none",
              border: 0,
              padding: 0,
              color: "inherit",
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 500 }}>Full proof index</span>
            <span
              className="inline-flex items-center gap-1"
              style={{ fontSize: 12, color: C.text3 }}
            >
              All CIDs and transactions{" "}
              {appendixOpen ? (
                <ChevronDown size={12} strokeWidth={1.5} />
              ) : (
                <ChevronRight size={12} strokeWidth={1.5} />
              )}
            </span>
          </button>

          {appendixOpen && (
            <>
              <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                {[
                  { title: "CIDs · IPFS payloads", rows: cids },
                  { title: "Transactions · on-chain", rows: txs },
                ].map((col) => (
                  <div
                    key={col.title}
                    style={{
                      background: C.bgCard,
                      border: `0.5px solid ${C.border1}`,
                      borderRadius: 12,
                      padding: "16px 20px",
                    }}
                  >
                    <h4
                      className="uppercase font-medium"
                      style={{
                        fontSize: 12,
                        color: C.text2,
                        letterSpacing: "0.06em",
                        margin: "0 0 12px",
                      }}
                    >
                      {col.title}
                    </h4>
                    {col.rows.map(([lbl, val], i) => (
                      <div
                        key={lbl}
                        className="flex items-center justify-between gap-2.5"
                        style={{
                          padding: "6px 0",
                          fontSize: 12,
                          borderTop: i === 0 ? "none" : `0.5px solid ${C.border1}`,
                        }}
                      >
                        <span style={{ color: C.text2 }}>{lbl}</span>
                        <Mono style={{ color: C.text1, textAlign: "right" }}>{val}</Mono>
                      </div>
                    ))}
                  </div>
                ))}
              </div>

              {/* Reducer pipeline */}
              <div
                style={{
                  marginTop: 20,
                  background: C.bgCard,
                  border: `0.5px solid ${C.border1}`,
                  borderRadius: 12,
                  padding: "16px 20px",
                }}
              >
                <div
                  className="uppercase font-medium"
                  style={{
                    fontSize: 12,
                    color: C.text2,
                    letterSpacing: "0.06em",
                    marginBottom: 12,
                  }}
                >
                  Projection reducer · execution order
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {reducerChain.map((step, i) => (
                    <React.Fragment key={step}>
                      <span
                        style={{
                          fontSize: 11.5,
                          padding: "4px 10px",
                          background: C.bgSoft,
                          border: `0.5px solid ${C.border1}`,
                          borderRadius: 999,
                          color: C.text1,
                        }}
                      >
                        {step}
                      </span>
                      {i < reducerChain.length - 1 && (
                        <span style={{ color: C.text3, fontSize: 11 }}>→</span>
                      )}
                    </React.Fragment>
                  ))}
                </div>
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}