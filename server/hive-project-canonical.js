function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function compact(value = "") {
  return safeText(value, 6000).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export const canonicalHiveProjects = Object.freeze({
  taskNodeCoreProduct: Object.freeze({
    id: "task_node_core_product",
    type: "protocol_applications",
    title: "Task Node Core Product",
    summary: "Build and operate Task Node as one product loop for chat, context, tasks, wallets, Telegram, Hive, profiles, rewards, and reliability.",
    objective: "Keep all Task Node product, reliability, contributor, delivery, and beta-readiness work routed through one durable board.",
    about: "Task Node work is one product workstream. Feature, reliability, rewards, messaging, queue, context, wallet, Telegram, and Hive-board tasks should be phases or tasks inside this project rather than separate boards.",
    priority: 10,
    phase_label: "Beta",
    phase_current: 1,
    phase_total: 1,
  }),
  marketAlphaTasks: Object.freeze({
    id: "market_alpha_tasks",
    type: "alpha_generation",
    title: "Market Alpha Tasks",
    summary: "Prepare production market-alpha tasks for public equities and crypto where contributors may have edge.",
    objective: "Define, route, and validate market-alpha work without mixing it into Task Node product execution.",
    about: "Market Alpha Tasks is a separate network workstream for capital-markets tasks. It should not be used for Task Node app, reliability, access, rewards, or board-maintenance work.",
    priority: 20,
    phase_label: "Scoping",
    phase_current: 1,
    phase_total: 1,
  }),
});

const taskNodeSignals = [
  "task node",
  "telegram",
  "hive board",
  "hive output",
  "hive message",
  "hive response",
  "context editing",
  "context refine",
  "profile nft",
  "acceptance gate",
  "beta readiness",
  "access delivery",
  "message delivery",
  "status visibility",
  "reward visibility",
  "contributor reward",
  "board messaging",
];

const marketAlphaSignals = [
  "market alpha",
  "public equities",
  "crypto",
  "alpha task",
  "alpha generation",
];

export function canonicalHiveProjectFor(project = {}) {
  const semanticText = compact([
    project.title,
    project.name,
    project.summary,
    project.objective,
    project.about,
    project.description,
    project.type,
  ].filter(Boolean).join(" "));
  const idText = compact(project.id);
  const text = compact([
    project.id,
    project.title,
    project.name,
    project.summary,
    project.objective,
    project.about,
    project.description,
    project.type,
  ].filter(Boolean).join(" "));
  if (!text) return null;
  const titleText = compact([project.title, project.name].filter(Boolean).join(" "));
  const titleOrIdText = compact([project.id, project.title, project.name].filter(Boolean).join(" "));
  const titleIsMarketAlpha = marketAlphaSignals.some((signal) => titleText.includes(signal));
  const semanticIsMarketAlpha = marketAlphaSignals.some((signal) => semanticText.includes(signal));
  const titleOrIdIsTaskNode = taskNodeSignals.some((signal) => titleOrIdText.includes(signal));
  if (titleIsMarketAlpha || (semanticIsMarketAlpha && !titleOrIdIsTaskNode)) {
    return canonicalHiveProjects.marketAlphaTasks;
  }
  if (titleOrIdIsTaskNode || taskNodeSignals.some((signal) => idText.includes(signal))) {
    return canonicalHiveProjects.taskNodeCoreProduct;
  }
  if (marketAlphaSignals.some((signal) => idText.includes(signal))) return canonicalHiveProjects.marketAlphaTasks;
  return null;
}

export function applyCanonicalHiveProject(project = {}) {
  const canonical = canonicalHiveProjectFor(project);
  if (!canonical) return { ...project };
  return {
    ...project,
    id: canonical.id,
    type: canonical.type,
    title: canonical.title,
    summary: canonical.summary,
    objective: canonical.objective,
    about: canonical.about,
    priority: canonical.priority,
    phase_label: project.phase_label || project.phaseLabel || canonical.phase_label,
    phase_current: project.phase_current ?? project.phaseCurrent ?? canonical.phase_current,
    phase_total: project.phase_total ?? project.phaseTotal ?? canonical.phase_total,
    canonical_project_id: canonical.id,
  };
}
