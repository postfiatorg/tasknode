function cleanText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function cleanLines(lines = []) {
  return lines
    .map((line) => String(line || "").trim())
    .filter(Boolean);
}

function taskId(task = {}) {
  return cleanText(task.taskId || task.fullId || task.id);
}

function taskReward(task = {}) {
  const amount = Number(task.pft || 0);
  return `${Number.isFinite(amount) ? amount.toLocaleString() : "0"} PFT`;
}

function taskSteps(task = {}) {
  return Array.isArray(task.steps) ? task.steps.map(cleanText).filter(Boolean) : [];
}

function taskVerificationText(task = {}) {
  return cleanText(
    task.verification?.body ||
      task.submissionRequirement?.criteria ||
      task.verification?.title ||
      ""
  );
}

export function buildTaskCopyPayloads(task = {}) {
  const title = cleanText(task.title || "Untitled task");
  const id = taskId(task);
  const kind = cleanText(task.kind || "Task");
  const status = cleanText(task.status || task.statusKey || "");
  const due = cleanText(task.fullDue || task.due || "");
  const description = cleanText(task.description || "");
  const steps = taskSteps(task);
  const verification = taskVerificationText(task);
  const requestId = cleanText(task.metadata?.requestId || "");

  const titlePayload = title;
  const summaryPayload = cleanLines([
    title,
    id ? `Task ID: ${id}` : "",
    status ? `Status: ${status}` : "",
    `Reward: ${taskReward(task)}`,
    due ? `Deadline: ${due}` : "",
    description ? `Summary: ${description}` : "",
  ]).join("\n");

  const fullSections = [
    ...cleanLines([
      `Task: ${title}`,
      id ? `Task ID: ${id}` : "",
      requestId ? `Request ID: ${requestId}` : "",
      kind ? `Kind: ${kind}` : "",
      status ? `Status: ${status}` : "",
      `Reward: ${taskReward(task)}`,
      due ? `Deadline: ${due}` : "",
    ]),
    "",
    "Description",
    description || "No description provided.",
  ];

  if (steps.length > 0) {
    fullSections.push("", "Steps", ...steps.map((step, index) => `${index + 1}. ${step}`));
  }

  if (verification) {
    fullSections.push("", "Verification", verification);
  }

  return {
    title: titlePayload,
    summary: summaryPayload,
    full: fullSections.join("\n"),
  };
}

export function copyPreview(text = "", limit = 220) {
  const value = String(text || "").trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1).trim()}...`;
}
