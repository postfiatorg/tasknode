const PROJECT_DETAIL_PAGE_SIZE = 8;

export function projectTypeLabel(value = "") {
  return String(value || "")
    .split("_")
    .filter(Boolean)
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

export function operatorForWallet(wallet, operators = {}) {
  return operators[wallet] || { codename: compactWallet(wallet), archetype: "", badge: 0, allotted: false, cap: 0, load: 0, status: "quiet", nft: null, operatorDisclosure: null };
}

export function compactWallet(wallet = "") {
  const normalized = String(wallet || "").trim();
  if (normalized.length <= 12) return normalized || "unassigned";
  return `${normalized.slice(0, 6)}...${normalized.slice(-5)}`;
}

export function shortId(value = "") {
  const normalized = String(value || "").trim();
  if (normalized.length <= 18) return normalized || "-";
  return `${normalized.slice(0, 10)}...${normalized.slice(-6)}`;
}

export function shortHash(value = "") {
  const normalized = String(value || "").trim();
  if (normalized.length <= 16) return normalized || "-";
  return `${normalized.slice(0, 8)}...${normalized.slice(-6)}`;
}

export function formatPft(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return "0";
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: number % 1 === 0 ? 0 : 2,
  }).format(number);
}

export function formatCompactPft(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return "0";
  if (Math.abs(number) < 1000) return formatPft(number);
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(number);
}

export function contributorsSubtitle(project = {}) {
  const allocated = project.contributors?.length || 0;
  if (allocated) return `${allocated} allocated ${allocated === 1 ? "operator" : "operators"} on this project`;
  return "No operators allocated yet";
}

export function paginateRows(rows = [], requestedPage = 1, pageSize = PROJECT_DETAIL_PAGE_SIZE) {
  const normalizedRows = Array.isArray(rows) ? rows : [];
  const pageCount = Math.max(1, Math.ceil(normalizedRows.length / pageSize));
  const page = Math.min(Math.max(1, requestedPage), pageCount);
  const startIndex = (page - 1) * pageSize;
  return {
    page,
    pageCount,
    rows: normalizedRows.slice(startIndex, startIndex + pageSize),
  };
}

export function tasksSubtitle(project = {}) {
  const allocated = project.tasks?.length || 0;
  const pending = Number(project.pendingGenerationCount || 0);
  if (project.nextTask?.title) return `${allocated} task ${allocated === 1 ? "row" : "rows"}; next: ${project.nextTask.title}`;
  if (allocated) return `${allocated} allocated task ${allocated === 1 ? "row" : "rows"} on this project`;
  if (pending) return `${pending} Network Task generation ${pending === 1 ? "job is" : "jobs are"} queued for this project`;
  return "No project task rows yet";
}

export function taskNextAction(state = "") {
  const normalized = String(state || "").trim().toLowerCase();
  if (normalized === "accepted") return "Complete the task and submit evidence for review.";
  if (normalized === "verification_requested") return "Answer the reviewer follow-up.";
  if (normalized === "verification_response_submitted") return "Wait for review.";
  if (normalized === "submitted") return "Wait for review and respond if verification is requested.";
  if (normalized === "proposed") return "Open the task and accept or refuse it before the deadline.";
  if (normalized === "reward_decided") return "Wait for the terminal reward outcome to settle.";
  if (["rewarded", "paid"].includes(normalized)) return "Reward paid. View proof, copy the tx, or request another task.";
  if (["refused", "cancelled", "rejected", "expired"].includes(normalized)) return "Task is stopped; wait for a new routed task if more work is needed.";
  return "Open the task row and inspect the latest state.";
}

export function nextTaskEyebrow(nextTask = {}) {
  if (!nextTask?.viewerScoped) return "Next reward task";
  const normalized = String(nextTask.state || "").trim().toLowerCase();
  if (nextTask.viewerRelation === "offer" || normalized === "proposed") return "Your task offer";
  if (normalized === "verification_requested") return "Your review request";
  if (["submitted", "verification_response_submitted", "reward_decided"].includes(normalized)) return "Your task status";
  return "Your active task";
}

export function formatContextTime(value = "") {
  if (!value) return "";
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return String(value);
  }
}

export function NftBadge({ variant = 0, size = 28 }) {
  const palettes = [
    { bg: "#1A1A1A", fg: "#E24B4A" },
    { bg: "#0C447C", fg: "#85B7EB" },
    { bg: "#0F6E56", fg: "#9FE1CB" },
    { bg: "#1A1A1A", fg: "#EF9F27" },
    { bg: "#3C3489", fg: "#CECBF6" },
    { bg: "#1A1A1A", fg: "#5DCAA5" },
    { bg: "#72243E", fg: "#F4C0D1" },
    { bg: "#1A1A1A", fg: "#D85A30" },
  ];
  const palette = palettes[variant % palettes.length];
  const shape = variant % 8;

  return (
    <svg className="hive-nft-badge" height={size} viewBox="0 0 28 28" width={size}>
      <rect fill={palette.bg} height="28" width="28" />
      {shape === 0 && (
        <g fill={palette.fg} stroke={palette.fg}>
          <rect fill="none" height="19" strokeWidth="0.6" width="19" x="4.5" y="4.5" />
          <circle cx="14" cy="14" r="3" stroke="none" />
        </g>
      )}
      {shape === 1 && (
        <g fill={palette.fg}>
          <rect height="6" width="6" x="6" y="6" />
          <rect height="6" width="6" x="16" y="6" />
          <rect height="6" width="6" x="6" y="16" />
          <rect height="6" width="6" x="16" y="16" />
        </g>
      )}
      {shape === 2 && <path d="M 4 14 L 14 4 L 24 14 L 14 24 Z" fill={palette.fg} />}
      {shape === 3 && (
        <g fill="none" stroke={palette.fg} strokeWidth="0.8">
          <path d="M 4 4 L 24 24" />
          <path d="M 24 4 L 4 24" />
          <circle cx="14" cy="14" fill={palette.fg} r="4" />
        </g>
      )}
      {shape === 4 && (
        <g>
          <circle cx="14" cy="14" fill="none" r="8" stroke={palette.fg} strokeWidth="0.8" />
          <circle cx="14" cy="14" fill={palette.fg} r="3" />
        </g>
      )}
      {shape === 5 && <DotGrid fill={palette.fg} />}
      {shape === 6 && (
        <g>
          <rect fill="none" height="20" stroke={palette.fg} strokeWidth="0.6" width="20" x="4" y="4" />
          <rect fill="none" height="10" stroke={palette.fg} strokeWidth="0.6" width="10" x="9" y="9" />
          <rect fill={palette.fg} height="4" width="4" x="12" y="12" />
        </g>
      )}
      {shape === 7 && (
        <g>
          <path d="M 4 23 L 14 5 L 24 23 Z" fill="none" stroke={palette.fg} strokeWidth="0.8" />
          <circle cx="14" cy="17" fill={palette.fg} r="2.5" />
        </g>
      )}
    </svg>
  );
}

export function DotGrid({ fill }) {
  const points = [5, 10, 15, 20];
  return (
    <g fill={fill}>
      {points.flatMap((y) =>
        points.map((x) => <circle cx={x} cy={y} key={`${x}-${y}`} r="1" />)
      )}
    </g>
  );
}

export function actionLabel(action) {
  const normalized = String(action || "").trim().toLowerCase();
  return (
    {
      proposed: "proposed",
      accepted: "accepted",
      submitted: "submitted",
      verification_requested: "v. requested",
      verification_response_submitted: "awaiting review",
      verification_response: "v. response",
      v_requested: "v. requested",
      v_response: "v. response",
      reward_decided: "reward pending",
      rewarded: "rewarded",
      paid: "paid",
      cancelled: "cancelled",
      rejected: "rejected",
      expired: "expired",
      refused: "refused",
    }[normalized] || normalized || "recorded"
  );
}

export function taskState(state) {
  const normalized = String(state || "").trim().toLowerCase();
  return (
    {
      proposed: { key: "proposed", label: "proposed", tone: "amber", ring: true, dim: false },
      accepted: { key: "accepted", label: "accepted", tone: "green", ring: false, dim: false },
      submitted: { key: "submitted", label: "submitted", tone: "green", ring: false, dim: false },
      verification_requested: { key: "verification_requested", label: "v. requested", tone: "amber", ring: false, dim: false },
      verification_response_submitted: { key: "verification_response_submitted", label: "awaiting review", tone: "green", ring: false, dim: false },
      verification_response: { key: "verification_response", label: "v. response", tone: "green", ring: false, dim: false },
      reward_decided: { key: "reward_decided", label: "reward pending", tone: "muted", ring: false, dim: true },
      rewarded: { key: "rewarded", label: "rewarded", tone: "muted", ring: false, dim: true },
      paid: { key: "paid", label: "paid", tone: "muted", ring: false, dim: true },
      refused: { key: "refused", label: "refused", tone: "muted", ring: true, dim: true },
      cancelled: { key: "cancelled", label: "cancelled", tone: "muted", ring: true, dim: true },
      rejected: { key: "rejected", label: "rejected", tone: "muted", ring: true, dim: true },
      expired: { key: "expired", label: "expired", tone: "muted", ring: true, dim: true },
    }[normalized] || { key: "unknown", label: normalized || "unknown", tone: "muted", ring: true, dim: true }
  );
}
