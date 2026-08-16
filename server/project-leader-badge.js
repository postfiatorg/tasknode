function normalizeHandle(value = "") {
  return String(value || "")
    .trim()
    .replace(/^@+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/[-_]{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 30);
}

export function configuredProjectLeaderHiveHandles() {
  const configured = String(process.env.TASKNODE_PROJECT_LEADER_HIVE_HANDLES || "")
    .split(",")
    .map(normalizeHandle)
    .filter(Boolean);
  return [...new Set(configured)];
}

export function projectLeaderAccessForHandle(handle = "") {
  const normalizedHandle = normalizeHandle(handle);
  const sanctionedHandles = configuredProjectLeaderHiveHandles();
  const eligible = Boolean(normalizedHandle && sanctionedHandles.includes(normalizedHandle));
  return {
    badgeId: "project_leader",
    label: "Project Leader",
    requirementsLabel: "Discretionary",
    eligible,
    handle: normalizedHandle,
    matchedHandle: eligible ? normalizedHandle : "",
    sanctionedHandles,
    authority: eligible
      ? [
          "define_special_projects",
          "define_open_source_projects",
          "sanction_project_scope",
        ]
      : [],
    proofMethod: "backend_hive_handle_allowlist",
    routingUse: eligible
      ? "Hive inputs from this handle may define discretionary special projects, including open-source projects, for Board Manager consideration."
      : "Project Leader requires discretionary backend approval.",
  };
}

export function compactProjectLeaderAuthority(access = {}) {
  if (access?.eligible !== true) return null;
  return {
    badgeId: "project_leader",
    label: "Project Leader",
    requirementsLabel: "Discretionary",
    handle: normalizeHandle(access.handle || access.matchedHandle),
    matchedHandle: normalizeHandle(access.matchedHandle || access.handle),
    authority: Array.isArray(access.authority) ? access.authority.slice(0, 8) : [],
    proofMethod: "backend_hive_handle_allowlist",
  };
}
