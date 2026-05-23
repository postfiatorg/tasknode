import { useState } from "react";
import {
  Flag,
  X,
  Copy,
  ClipboardCopy,
  ChevronDown,
  ChevronUp,
  FileText,
  ExternalLink,
  Eye,
  Code as CodeIcon,
  GitCommit,
  Paperclip,
  Plus,
  Lock,
  Check,
  ArrowRight,
  Activity,
  ExternalLink as OpenIcon,
} from "lucide-react";

const COLORS = {
  cream: "#F6F3EB",
  creamDeep: "#ECE8DC",
  inputBg: "#F1ECDD",
  text: "#1B1B19",
  textMid: "#3A3936",
  textSecondary: "#6E6B62",
  textTertiary: "#8E8B81",
  border: "#E4E0D4",
  borderStrong: "#D8D3C3",
  accent: "#6C5BC9",
  buttonBg: "#18181A",
  buttonBgDisabled: "#B5B2A8",
  buttonText: "#FAF8F2",
};

const FONT_SANS =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "Söhne", Roboto, "Helvetica Neue", sans-serif';
const FONT_MONO =
  'ui-monospace, "SF Mono", "Cascadia Mono", "Roboto Mono", Menlo, Consolas, monospace';

const EVIDENCE_TYPES = [
  { id: "text", label: "Text", icon: FileText },
  { id: "url", label: "URL", icon: ExternalLink },
  { id: "screenshot", label: "Screenshot", icon: Eye },
  { id: "code", label: "Code", icon: CodeIcon },
  { id: "commit", label: "Commit", icon: GitCommit },
  { id: "file", label: "File", icon: Paperclip },
];

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "submit", label: "Submit" },
  { id: "forensics", label: "Forensics" },
];

const INDEXED_EVENTS = [
  { id: "evt_4a18ef02c739a1d5fb01af71", type: "offered", ledger: 92041823, when: "May 23 · 11:59 PM UTC" },
  { id: "evt_8c2b51a9e1e2d8ce91204bb6", type: "accepted", ledger: 92041967, when: "May 23 · 11:59 PM UTC" },
  { id: "evt_9d0f3617be4d4b22fe731a04", type: "initial_submission", ledger: 92155301, when: "May 28 · 02:12 PM UTC" },
  { id: "evt_7e9fa60cfe8588d5fb9a3ef3", type: "verification_requested", ledger: 92188744, when: "May 29 · 09:40 AM UTC" },
];

const ORIGINAL_TASK = {
  routing: { source: "Hive", project: "task_node", class: "Network Task" },
  context:
    "Task Node still needs a simple implementation proof: show one Network Task moving through offer, acceptance, work submission, review, and reward using the normal PFTL path, with a checkable trail so the board can tell the behavior works rather than only being described.",
  description:
    "Create one concrete Network Task that moves through the normal PFTL flow from offer to reward. The result must include a checkable trail showing task creation, acceptance, work submission, review decision, and reward state so the board can verify the system behavior from evidence instead of description.",
  steps: [
    "Create a single sample Network Task using the existing Task Node/PFTL flow and capture the initial offered state.",
    "Accept the task with the assigned wallet or contributor identity and capture the acceptance state transition.",
    "Submit a small but real work artifact to the task and capture the resulting submission state and stored evidence.",
    "Complete the review and reward flow, then produce a short timeline summary showing each state transition with timestamps or IDs.",
  ],
  evidenceRequirement: {
    kind: "Mixed",
    detail:
      "Submit screenshots or URLs showing each lifecycle state plus a short text summary mapping the sequence: offered, accepted, submitted, reviewed, rewarded. Include any task IDs, transaction references, logs, or persisted JSON artifacts needed for independent verification.",
  },
};

function Dot() {
  return (
    <span aria-hidden style={{ opacity: 0.4, margin: "0 6px", userSelect: "none" }}>
      ·
    </span>
  );
}

function MonoTag({ children }) {
  return (
    <code style={{ fontFamily: FONT_MONO, fontSize: "14px", color: COLORS.textMid }}>
      {children}
    </code>
  );
}

function SectionLabel({ title, meta, action }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginBottom: "12px",
        fontSize: "12px",
        color: COLORS.textTertiary,
      }}
    >
      <div>
        <span style={{ color: COLORS.text, fontWeight: 500 }}>{title}</span>
        {meta && (
          <>
            <Dot />
            <span>{meta}</span>
          </>
        )}
      </div>
      {action}
    </div>
  );
}

function SubLabel({ children, meta }) {
  return (
    <div
      style={{
        fontSize: "12px",
        color: COLORS.textTertiary,
        marginBottom: "8px",
      }}
    >
      <span style={{ color: COLORS.textSecondary, fontWeight: 500 }}>{children}</span>
      {meta && (
        <>
          <Dot />
          <span>{meta}</span>
        </>
      )}
    </div>
  );
}

function AddEvidenceRow({ onClick, label }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: "100%",
        padding: "14px 16px",
        background: hover ? COLORS.creamDeep : "transparent",
        border: `0.5px dashed ${hover ? COLORS.textTertiary : COLORS.borderStrong}`,
        borderRadius: "8px",
        fontSize: "13px",
        color: hover ? COLORS.text : COLORS.textSecondary,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "6px",
        cursor: "pointer",
        fontFamily: "inherit",
        transition: "background 120ms, border-color 120ms, color 120ms",
      }}
    >
      <Plus size={13} strokeWidth={1.75} />
      {label}
    </button>
  );
}

function TypeSelector({ value, onChange }) {
  return (
    <div
      role="radiogroup"
      aria-label="Evidence type"
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: "2px",
        marginBottom: "14px",
        marginLeft: "-10px",
      }}
    >
      {EVIDENCE_TYPES.map((t) => {
        const Icon = t.icon;
        const active = value === t.id;
        return (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(t.id)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              padding: "5px 10px",
              borderRadius: "999px",
              border: "none",
              fontSize: "13px",
              fontWeight: active ? 500 : 400,
              color: active ? COLORS.text : COLORS.textTertiary,
              background: active ? COLORS.creamDeep : "transparent",
              cursor: "pointer",
              fontFamily: "inherit",
              transition: "color 120ms, background 120ms",
            }}
          >
            <Icon size={13} strokeWidth={1.75} />
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

const inputBaseStyle = {
  width: "100%",
  background: COLORS.inputBg,
  border: `0.5px solid ${COLORS.border}`,
  borderRadius: "8px",
  padding: "12px 14px",
  fontSize: "14px",
  lineHeight: 1.55,
  color: COLORS.text,
  fontFamily: "inherit",
  outline: "none",
  boxSizing: "border-box",
  resize: "vertical",
};

function EvidenceInput({ type, value, onChange }) {
  if (type === "text") {
    return (
      <textarea
        rows={5}
        placeholder="Describe the completed work and include any relevant artifact references."
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
        style={inputBaseStyle}
      />
    );
  }
  if (type === "url") {
    return (
      <input
        type="url"
        placeholder="https://"
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
        style={{ ...inputBaseStyle, fontFamily: FONT_MONO, fontSize: "13px" }}
      />
    );
  }
  if (type === "code") {
    return (
      <textarea
        rows={6}
        placeholder="Paste code, output, or transcript."
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
        style={{ ...inputBaseStyle, fontFamily: FONT_MONO, fontSize: "13px" }}
      />
    );
  }
  if (type === "commit") {
    return (
      <input
        type="text"
        placeholder="owner/repo@commit_sha — or full URL"
        value={value || ""}
        onChange={(e) => onChange(e.target.value)}
        style={{ ...inputBaseStyle, fontFamily: FONT_MONO, fontSize: "13px" }}
      />
    );
  }
  if (type === "screenshot" || type === "file") {
    const isScreenshot = type === "screenshot";
    const Icon = isScreenshot ? Eye : Paperclip;
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "14px",
          padding: "16px",
          background: COLORS.inputBg,
          border: `0.5px dashed ${COLORS.borderStrong}`,
          borderRadius: "8px",
        }}
      >
        <Icon size={16} color={COLORS.textTertiary} strokeWidth={1.5} />
        <button
          type="button"
          style={{
            background: "transparent",
            border: `0.5px solid ${COLORS.borderStrong}`,
            padding: "6px 14px",
            borderRadius: "999px",
            fontSize: "13px",
            fontWeight: 500,
            color: COLORS.text,
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          Choose {isScreenshot ? "screenshot" : "file"}
        </button>
        <span style={{ fontSize: "13px", color: COLORS.textTertiary }}>
          No {isScreenshot ? "screenshot" : "file"} selected
        </span>
      </div>
    );
  }
  return null;
}

/* ----------------------------- Tab bodies ----------------------------- */

function OverviewBody({ showOriginal, setShowOriginal, onGoToSubmit }) {
  return (
    <>
      <section style={{ marginBottom: "28px" }}>
        <SectionLabel
          title="Original task"
          meta="Offered May 21 · Initial submission accepted May 28"
          action={
            <button
              type="button"
              onClick={() => setShowOriginal(!showOriginal)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "2px",
                background: "none",
                border: "none",
                padding: 0,
                fontSize: "13px",
                color: COLORS.textSecondary,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              {showOriginal ? "Hide" : "Show"}
              {showOriginal ? (
                <ChevronUp size={12} strokeWidth={1.5} />
              ) : (
                <ChevronDown size={12} strokeWidth={1.5} />
              )}
            </button>
          }
        />
        <p
          style={{
            margin: "0 0 10px",
            fontSize: "15px",
            lineHeight: 1.65,
            color: COLORS.textMid,
          }}
        >
          Walk through one full Network Task end-to-end and capture the on-chain artifacts at each transition. Your initial evidence packet was accepted; the verifier has now opened a follow-up.
        </p>
        {showOriginal && (
          <div
            style={{
              marginTop: "20px",
              paddingLeft: "16px",
              borderLeft: `1.5px solid ${COLORS.border}`,
            }}
          >
            {/* Routing */}
            <div
              style={{
                fontSize: "12px",
                color: COLORS.textTertiary,
                marginBottom: "24px",
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                rowGap: "4px",
              }}
            >
              <span style={{ color: COLORS.textSecondary, fontWeight: 500 }}>Routing</span>
              <Dot />
              <span>{ORIGINAL_TASK.routing.source}</span>
              <Dot />
              <span>
                <span style={{ color: COLORS.textSecondary }}>project</span>{" "}
                <code
                  style={{
                    fontFamily: FONT_MONO,
                    fontSize: "12px",
                    color: COLORS.textMid,
                  }}
                >
                  {ORIGINAL_TASK.routing.project}
                </code>
              </span>
              <Dot />
              <span>
                <span style={{ color: COLORS.textSecondary }}>class</span>{" "}
                {ORIGINAL_TASK.routing.class}
              </span>
            </div>

            {/* Context */}
            <div style={{ marginBottom: "24px" }}>
              <SubLabel>Context</SubLabel>
              <p
                style={{
                  margin: 0,
                  fontSize: "14px",
                  lineHeight: 1.65,
                  color: COLORS.textMid,
                }}
              >
                {ORIGINAL_TASK.context}
              </p>
            </div>

            {/* Description */}
            <div style={{ marginBottom: "24px" }}>
              <SubLabel>Description</SubLabel>
              <p
                style={{
                  margin: 0,
                  fontSize: "14px",
                  lineHeight: 1.65,
                  color: COLORS.textMid,
                }}
              >
                {ORIGINAL_TASK.description}
              </p>
            </div>

            {/* Steps */}
            <div style={{ marginBottom: "24px" }}>
              <SubLabel meta={`${ORIGINAL_TASK.steps.length} in sequence`}>Steps</SubLabel>
              <ol
                style={{
                  margin: 0,
                  padding: 0,
                  listStyle: "none",
                  display: "flex",
                  flexDirection: "column",
                  gap: "12px",
                }}
              >
                {ORIGINAL_TASK.steps.map((step, idx) => (
                  <li
                    key={idx}
                    style={{
                      display: "flex",
                      gap: "12px",
                      alignItems: "flex-start",
                    }}
                  >
                    <span
                      aria-hidden
                      style={{
                        width: "20px",
                        height: "20px",
                        borderRadius: "50%",
                        border: `0.5px solid ${COLORS.borderStrong}`,
                        color: COLORS.textTertiary,
                        fontSize: "11px",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        flexShrink: 0,
                        marginTop: "1px",
                      }}
                    >
                      {idx + 1}
                    </span>
                    <span
                      style={{
                        fontSize: "14px",
                        lineHeight: 1.6,
                        color: COLORS.textMid,
                      }}
                    >
                      {step}
                    </span>
                  </li>
                ))}
              </ol>
            </div>

            {/* Initial evidence requirement */}
            <div>
              <SubLabel meta={ORIGINAL_TASK.evidenceRequirement.kind}>
                Initial evidence requirement
              </SubLabel>
              <p
                style={{
                  margin: 0,
                  fontSize: "14px",
                  lineHeight: 1.65,
                  color: COLORS.textMid,
                }}
              >
                {ORIGINAL_TASK.evidenceRequirement.detail}
              </p>
            </div>
          </div>
        )}
      </section>

      <div style={{ borderTop: `0.5px solid ${COLORS.border}`, marginBottom: "28px" }} />

      <section style={{ marginBottom: "32px" }}>
        <SectionLabel title="Verification requested" meta="May 29 · 20m ago" />
        <p
          style={{
            margin: "0 0 14px",
            fontSize: "16px",
            lineHeight: 1.65,
            color: COLORS.text,
          }}
        >
          Provide a concise lifecycle summary listing the exact Event ID and corresponding ledger number for the five key transitions in your demonstrated Network Task flow:{" "}
          <MonoTag>offered</MonoTag>, <MonoTag>accepted</MonoTag>,{" "}
          <MonoTag>initial_submission</MonoTag>, <MonoTag>reward_decided</MonoTag>,{" "}
          <MonoTag>reward_paid</MonoTag>.
        </p>
        <p
          style={{
            margin: 0,
            fontSize: "14px",
            lineHeight: 1.65,
            color: COLORS.textSecondary,
          }}
        >
          Confirms you can accurately navigate the on-chain artifacts tied to this task.
        </p>
      </section>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "22px",
          paddingTop: "8px",
        }}
      >
        <button
          type="button"
          onClick={onGoToSubmit}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            background: COLORS.buttonBg,
            color: COLORS.buttonText,
            padding: "10px 18px",
            borderRadius: "999px",
            fontSize: "14px",
            fontWeight: 500,
            border: "none",
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          Respond in Submit
          <ArrowRight size={14} strokeWidth={2} />
        </button>
        <button
          type="button"
          style={{
            background: "none",
            border: "none",
            padding: 0,
            fontSize: "13px",
            color: COLORS.textTertiary,
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          Cancel task
        </button>
      </div>
    </>
  );
}

function SubmitBody({
  showRequest,
  setShowRequest,
  evidence,
  updateEvidence,
  removeEvidence,
  addEvidence,
  notes,
  setNotes,
  ready,
  setReady,
  walletUnlocked,
  setWalletUnlocked,
}) {
  const submitLabel = walletUnlocked ? "Sign and submit" : "Unlock wallet to sign";
  const SubmitIcon = walletUnlocked ? Check : Lock;

  let submitHint;
  if (!ready) submitHint = "Confirm submission readiness above to enable signing.";
  else if (!walletUnlocked) submitHint = "Wallet locked. Signing happens after unlock.";
  else submitHint = "Ready. Signing will use the linked wallet.";

  return (
    <>
      {/* Verification request (collapsible context) */}
      <section style={{ marginBottom: "28px" }}>
        <SectionLabel
          title="Verification request"
          meta="May 29 · 20m ago"
          action={
            <button
              type="button"
              onClick={() => setShowRequest(!showRequest)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "2px",
                background: "none",
                border: "none",
                padding: 0,
                fontSize: "13px",
                color: COLORS.textSecondary,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              {showRequest ? "Hide" : "Show"}
              {showRequest ? (
                <ChevronUp size={12} strokeWidth={1.5} />
              ) : (
                <ChevronDown size={12} strokeWidth={1.5} />
              )}
            </button>
          }
        />
        {showRequest && (
          <p
            style={{
              margin: 0,
              fontSize: "15px",
              lineHeight: 1.65,
              color: COLORS.textMid,
            }}
          >
            Provide a concise lifecycle summary listing the exact Event ID and corresponding ledger number for the five key transitions in your demonstrated Network Task flow:{" "}
            <MonoTag>offered</MonoTag>, <MonoTag>accepted</MonoTag>,{" "}
            <MonoTag>initial_submission</MonoTag>, <MonoTag>reward_decided</MonoTag>,{" "}
            <MonoTag>reward_paid</MonoTag>.
          </p>
        )}
      </section>

      <div style={{ borderTop: `0.5px solid ${COLORS.border}`, marginBottom: "28px" }} />

      <SectionLabel
        title="Your response"
        meta={
          evidence.length === 1
            ? "1 item — add more if a single piece doesn't cover it"
            : `${evidence.length} items`
        }
      />

      {evidence.map((item, idx) => (
        <section
          key={item.id}
          style={{
            marginBottom: "24px",
            paddingBottom: idx < evidence.length - 1 ? "24px" : 0,
            borderBottom:
              idx < evidence.length - 1 ? `0.5px solid ${COLORS.border}` : "none",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: "10px",
              fontSize: "12px",
              color: COLORS.textTertiary,
            }}
          >
            <span style={{ color: COLORS.textSecondary, fontWeight: 500 }}>
              Evidence {idx + 1}
            </span>
            <button
              type="button"
              onClick={() => removeEvidence(item.id)}
              disabled={evidence.length === 1}
              style={{
                background: "none",
                border: "none",
                padding: 0,
                fontSize: "13px",
                color: COLORS.textTertiary,
                cursor: evidence.length === 1 ? "not-allowed" : "pointer",
                opacity: evidence.length === 1 ? 0.4 : 1,
                fontFamily: "inherit",
              }}
            >
              Remove
            </button>
          </div>
          <TypeSelector
            value={item.type}
            onChange={(type) => updateEvidence(item.id, { type, value: "" })}
          />
          <EvidenceInput
            type={item.type}
            value={item.value}
            onChange={(value) => updateEvidence(item.id, { value })}
          />
        </section>
      ))}

      <div style={{ marginTop: "16px", marginBottom: "32px" }}>
        <AddEvidenceRow
          onClick={addEvidence}
          label={evidence.length === 1 ? "Add another piece of evidence" : "Add another"}
        />
      </div>

      <div style={{ borderTop: `0.5px solid ${COLORS.border}`, marginBottom: "28px" }} />

      <section style={{ marginBottom: "32px" }}>
        <SectionLabel title="Notes for the verifier" meta="Optional" />
        <textarea
          rows={3}
          placeholder="Add context that helps assess this submission."
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          style={inputBaseStyle}
        />
      </section>

      <div style={{ borderTop: `0.5px solid ${COLORS.border}`, marginBottom: "24px" }} />

      <div style={{ marginBottom: "18px" }}>
        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "8px",
            fontSize: "14px",
            color: COLORS.text,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={ready}
            onChange={(e) => setReady(e.target.checked)}
            style={{
              width: "15px",
              height: "15px",
              cursor: "pointer",
              accentColor: COLORS.text,
            }}
          />
          This evidence is ready to submit
        </label>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "16px",
          paddingTop: "4px",
          flexWrap: "wrap",
        }}
      >
        <button
          type="button"
          onClick={() => ready && setWalletUnlocked(!walletUnlocked)}
          disabled={!ready}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            background: ready ? COLORS.buttonBg : COLORS.buttonBgDisabled,
            color: COLORS.buttonText,
            padding: "10px 18px",
            borderRadius: "999px",
            fontSize: "14px",
            fontWeight: 500,
            border: "none",
            cursor: ready ? "pointer" : "not-allowed",
            fontFamily: "inherit",
            transition: "background 120ms",
          }}
        >
          <SubmitIcon size={14} strokeWidth={2} />
          {submitLabel}
          <ArrowRight size={14} strokeWidth={2} />
        </button>
        <span style={{ fontSize: "13px", color: COLORS.textTertiary }}>{submitHint}</span>
      </div>
    </>
  );
}

function ForensicsBody() {
  return (
    <>
      <SectionLabel
        title="Indexed events"
        meta={`${INDEXED_EVENTS.length} on-chain artifacts for this task`}
      />
      <div style={{ marginBottom: "28px" }}>
        {INDEXED_EVENTS.map((evt, idx) => (
          <div
            key={evt.id}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: "14px",
              padding: "14px 0",
              borderBottom:
                idx < INDEXED_EVENTS.length - 1 ? `0.5px solid ${COLORS.border}` : "none",
            }}
          >
            <Activity
              size={14}
              strokeWidth={1.5}
              color={COLORS.textTertiary}
              style={{ marginTop: "3px", flexShrink: 0 }}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "10px",
                  marginBottom: "4px",
                  flexWrap: "wrap",
                }}
              >
                <span
                  style={{
                    fontFamily: FONT_MONO,
                    fontSize: "13px",
                    color: COLORS.text,
                    fontWeight: 500,
                  }}
                >
                  {evt.type}
                </span>
                <span style={{ fontSize: "12px", color: COLORS.textTertiary }}>
                  ledger {evt.ledger.toLocaleString()}
                </span>
                <Dot />
                <span style={{ fontSize: "12px", color: COLORS.textTertiary }}>
                  {evt.when}
                </span>
              </div>
              <div
                style={{
                  fontFamily: FONT_MONO,
                  fontSize: "12px",
                  color: COLORS.textSecondary,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "4px",
                  wordBreak: "break-all",
                }}
              >
                {evt.id}
                <Copy size={11} strokeWidth={1.5} style={{ cursor: "pointer", flexShrink: 0 }} />
              </div>
            </div>
            <button
              type="button"
              aria-label="Open in explorer"
              style={{
                background: "none",
                border: "none",
                padding: "4px",
                color: COLORS.textTertiary,
                cursor: "pointer",
                flexShrink: 0,
              }}
            >
              <OpenIcon size={13} strokeWidth={1.5} />
            </button>
          </div>
        ))}
      </div>
      <span style={{ fontSize: "13px", color: COLORS.textTertiary }}>
        Refreshes from chain every 30 seconds.
      </span>
    </>
  );
}

/* ----------------------------- Main component ----------------------------- */

export default function VerificationTask() {
  const [activeTab, setActiveTab] = useState("overview");

  // Shared task state — persists when switching tabs
  const [showOriginalInOverview, setShowOriginalInOverview] = useState(false);
  const [showRequestInSubmit, setShowRequestInSubmit] = useState(true);
  const [evidence, setEvidence] = useState([{ id: 1, type: "text", value: "" }]);
  const [notes, setNotes] = useState("");
  const [ready, setReady] = useState(false);
  const [walletUnlocked, setWalletUnlocked] = useState(false);

  function updateEvidence(id, patch) {
    setEvidence((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }
  function removeEvidence(id) {
    setEvidence((prev) => prev.filter((e) => e.id !== id));
  }
  function addEvidence() {
    const nextId = Math.max(0, ...evidence.map((e) => e.id)) + 1;
    setEvidence((prev) => [...prev, { id: nextId, type: "text", value: "" }]);
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        background: COLORS.cream,
        padding: "32px 16px",
        fontFamily: FONT_SANS,
        color: COLORS.text,
        display: "flex",
        justifyContent: "center",
      }}
    >
      <div style={{ width: "100%", maxWidth: "720px" }}>
        {/* Top bar */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            paddingBottom: "20px",
            borderBottom: `0.5px solid ${COLORS.border}`,
          }}
        >
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              fontSize: "11px",
              letterSpacing: "0.08em",
              color: COLORS.textTertiary,
              fontWeight: 500,
            }}
          >
            <Flag size={12} strokeWidth={1.75} />
            NETWORK TASK
          </span>
          <button
            type="button"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
              background: "none",
              border: "none",
              padding: 0,
              fontSize: "13px",
              color: COLORS.textTertiary,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            <X size={14} strokeWidth={1.5} />
            Close
          </button>
        </div>

        {/* Title + meta + tabs (shared header) */}
        <div style={{ paddingTop: "32px" }}>
          <h1
            style={{
              fontSize: "24px",
              fontWeight: 500,
              letterSpacing: "-0.01em",
              lineHeight: 1.25,
              margin: "0 0 10px",
            }}
          >
            Demonstrate one complete Network Task lifecycle
          </h1>

          <div
            style={{
              fontSize: "12px",
              color: COLORS.textTertiary,
              fontFamily: FONT_MONO,
              marginBottom: "22px",
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: "0 18px",
            }}
          >
            <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
              task_b7ddc205f0edb66ceac71e159c4dd51c
              <Copy size={12} strokeWidth={1.5} style={{ cursor: "pointer" }} />
            </span>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                fontFamily: FONT_SANS,
                color: COLORS.textSecondary,
                cursor: "pointer",
              }}
            >
              <ClipboardCopy size={13} strokeWidth={1.5} />
              Copy task brief
            </span>
          </div>

          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              fontSize: "13px",
              color: COLORS.textSecondary,
              marginBottom: "28px",
              rowGap: "4px",
            }}
          >
            <span
              aria-hidden
              style={{
                width: "7px",
                height: "7px",
                borderRadius: "50%",
                background: COLORS.accent,
                display: "inline-block",
                marginRight: "8px",
              }}
            />
            <span style={{ color: COLORS.text }}>Verification requested</span>
            <Dot />
            <span>Due May 29</span>
            <Dot />
            <span>
              <span style={{ color: COLORS.text, fontWeight: 500 }}>12,000</span> PFT reward
            </span>
            <Dot />
            <span>4 indexed events</span>
          </div>

          <div
            role="tablist"
            style={{
              display: "flex",
              gap: "26px",
              borderBottom: `0.5px solid ${COLORS.border}`,
              fontSize: "14px",
              marginBottom: "36px",
            }}
          >
            {TABS.map((t) => {
              const active = activeTab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setActiveTab(t.id)}
                  style={{
                    padding: "10px 0",
                    borderBottom: active ? `1.5px solid ${COLORS.text}` : "1.5px solid transparent",
                    marginBottom: "-0.5px",
                    color: active ? COLORS.text : COLORS.textTertiary,
                    fontWeight: active ? 500 : 400,
                    background: "none",
                    borderTop: "none",
                    borderLeft: "none",
                    borderRight: "none",
                    cursor: "pointer",
                    fontFamily: "inherit",
                    fontSize: "inherit",
                    transition: "color 120ms",
                  }}
                >
                  {t.label}
                </button>
              );
            })}
          </div>

          {/* Tab body */}
          {activeTab === "overview" && (
            <OverviewBody
              showOriginal={showOriginalInOverview}
              setShowOriginal={setShowOriginalInOverview}
              onGoToSubmit={() => setActiveTab("submit")}
            />
          )}
          {activeTab === "submit" && (
            <SubmitBody
              showRequest={showRequestInSubmit}
              setShowRequest={setShowRequestInSubmit}
              evidence={evidence}
              updateEvidence={updateEvidence}
              removeEvidence={removeEvidence}
              addEvidence={addEvidence}
              notes={notes}
              setNotes={setNotes}
              ready={ready}
              setReady={setReady}
              walletUnlocked={walletUnlocked}
              setWalletUnlocked={setWalletUnlocked}
            />
          )}
          {activeTab === "forensics" && <ForensicsBody />}
        </div>
      </div>
    </div>
  );
}