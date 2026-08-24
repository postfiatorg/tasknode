function safeText(value = "", max = 240) {
  return String(value || "").trim().slice(0, max);
}

function taskRows(value) {
  return Array.isArray(value) ? value : [];
}

export function docsActiveTaskOptions(tasks = {}) {
  const seen = new Set();
  const options = [];
  for (const task of [...taskRows(tasks.outstanding), ...taskRows(tasks.verification)]) {
    const taskId = safeText(task?.taskId || task?.fullId || task?.id, 180);
    if (!taskId || seen.has(taskId)) continue;
    seen.add(taskId);
    options.push({
      taskId,
      title: safeText(task?.title, 240) || "Untitled task",
      status: safeText(task?.status, 80) || "Active",
      updatedAt: safeText(task?.updatedAt || task?.lastEventAt, 80),
    });
  }
  return options.sort((a, b) => (
    Date.parse(b.updatedAt || "") - Date.parse(a.updatedAt || "") ||
    a.title.localeCompare(b.title)
  ));
}

export function filterDocsTaskOptions(options = [], query = "") {
  const needle = safeText(query, 240).toLowerCase();
  if (!needle) return taskRows(options);
  return taskRows(options).filter((task) => (
    task.taskId.toLowerCase().includes(needle) ||
    task.title.toLowerCase().includes(needle) ||
    task.status.toLowerCase().includes(needle)
  ));
}

export function shareTargetInput(identity = {}) {
  const handle = safeText(identity.hiveHandle, 80).replace(/^@+/, "");
  return handle ? `@${handle}` : safeText(identity.walletAddress, 120);
}

export function validSelectedShareTarget(identity, input = "") {
  if (!identity?.accountId) return false;
  return shareTargetInput(identity).toLowerCase() === safeText(input, 180).toLowerCase();
}

export function pfdocsShareUrl({ access = "", href = "", origin = "" } = {}) {
  try {
    const expectedOrigin = new URL(origin).origin;
    const capabilityUrl = new URL(href, expectedOrigin);
    if (capabilityUrl.origin !== expectedOrigin || capabilityUrl.pathname !== "/pad/") return "";
    const capabilityPattern = access === "view"
      ? /^#\/[0-9]+\/pad\/view\/[A-Za-z0-9+/_=-]+\/$/
      : access === "edit"
        ? /^#\/[0-9]+\/pad\/edit\/[A-Za-z0-9+/_=-]+\/$/
        : null;
    if (!capabilityPattern?.test(capabilityUrl.hash)) return "";
    return capabilityUrl.toString();
  } catch {
    return "";
  }
}
