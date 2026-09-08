import { taskStatusColor, taskStatusTone } from "../../shared/task-lifecycle.js";

// Keep protocol colors unchanged; resolve a readable foreground at the UI boundary.
export function themedTaskStatusColor(status, lightColor = taskStatusColor(status)) {
  const role = ({ pending: "warning", active: "success", review: "purple", rewarded: "warning", stopped: "danger" })[taskStatusTone(status)] || "muted";
  return `var(--tn-dark-${role}, ${lightColor})`;
}
