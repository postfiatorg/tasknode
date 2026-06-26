const webRoles = new Set(["all", "web", "app", "api"]);
const workerRoles = new Set([
  "all",
  "worker",
  "background",
  "worker:pftl",
  "worker:taskgen",
  "worker:task-review",
  "worker:context-rewrite",
  "worker:hive",
  "worker:memory-profile",
  "worker:airdrop",
]);

export function tasknodeProcessRole(env = process.env) {
  return String(env.TASKNODE_PROCESS_ROLE || env.FLY_PROCESS_GROUP || "all")
    .trim()
    .toLowerCase() || "all";
}

export function shouldStartHttpServer(role = tasknodeProcessRole()) {
  return webRoles.has(String(role || "").toLowerCase());
}

export function shouldStartBackgroundWorkers(role = tasknodeProcessRole()) {
  return workerRoles.has(String(role || "").toLowerCase());
}

export function isMonolithWorkerRole(role = tasknodeProcessRole()) {
  return ["all", "worker", "background"].includes(String(role || "").toLowerCase());
}
