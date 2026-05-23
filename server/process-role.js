const webRoles = new Set(["all", "web", "app", "api"]);
const workerRoles = new Set(["all", "worker", "background"]);

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

