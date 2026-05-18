const tenMinutes = 10 * 60_000;

export const apiRoutePolicies = [
  { id: "app_state", path: "/api/app-state", methods: ["GET"], auth: "optional" },
  { id: "session", path: "/api/session", methods: ["GET"], auth: "optional" },
  {
    id: "auth_dev_start",
    path: "/api/auth/dev/start",
    methods: ["POST"],
    auth: "none",
    rateLimit: { limit: 10, windowMs: 60_000 },
  },
  {
    id: "auth_email_start",
    path: "/api/auth/email/start",
    methods: ["POST"],
    auth: "none",
    rateLimit: { limit: 5, windowMs: tenMinutes },
  },
  {
    id: "auth_email_verify",
    path: "/api/auth/email/verify",
    methods: ["POST"],
    auth: "none",
    rateLimit: { limit: 20, windowMs: tenMinutes },
  },
  { id: "auth_logout", path: "/api/auth/logout", methods: ["POST"], auth: "optional" },
  { id: "auth_providers", path: "/api/auth/providers", methods: ["GET"], auth: "none" },
  { id: "auth_start_provider", pattern: /^\/api\/auth\/start\/[^/]+$/, methods: ["GET"], auth: "optional" },
  { id: "auth_callback_provider", pattern: /^\/api\/auth\/callback\/[^/]+$/, methods: ["GET"], auth: "oauth_state" },
  { id: "auth_provider_start", pattern: /^\/api\/auth\/[^/]+\/start$/, methods: ["GET"], auth: "optional" },
  { id: "auth_provider_callback", pattern: /^\/api\/auth\/[^/]+\/callback$/, methods: ["GET"], auth: "oauth_state" },
  { id: "readiness", path: "/api/readiness", methods: ["GET"], auth: "none" },
  { id: "tasks", path: "/api/tasks", methods: ["GET"], auth: "optional" },
  {
    id: "task_request_intent",
    path: "/api/tasks/request-intent",
    methods: ["POST"],
    auth: "handler",
    rateLimit: { limit: 20, windowMs: 60_000 },
  },
  { id: "chat_estimate", path: "/api/chat/estimate", methods: ["GET", "POST"], auth: "optional" },
  { id: "chat_modes", path: "/api/chat/modes", methods: ["GET"], auth: "none" },
  { id: "chat_conversations", path: "/api/chat/conversations", methods: ["GET"], auth: "optional" },
  { id: "chat_conversation", path: "/api/chat/conversation", methods: ["PATCH", "DELETE"], auth: "handler" },
  { id: "chat_history", path: "/api/chat/history", methods: ["GET"], auth: "optional" },
  { id: "memory", path: "/api/memory", methods: ["GET"], auth: "session" },
  {
    id: "chat_stream",
    path: "/api/chat/stream",
    methods: ["POST"],
    auth: "handler",
    rateLimit: { limit: 30, windowMs: 60_000 },
  },
  {
    id: "chat_send",
    path: "/api/chat/send",
    methods: ["POST"],
    auth: "handler",
    rateLimit: { limit: 60, windowMs: 60_000 },
  },
  { id: "wallet", path: "/api/wallet", methods: ["GET"], auth: "optional" },
  { id: "wallet_balance", path: "/api/wallet/balance", methods: ["GET"], auth: "session" },
  { id: "wallet_transactions", path: "/api/wallet/transactions", methods: ["GET"], auth: "session" },
  { id: "pftl_cache_account_tx", path: "/api/pftl/cache/account-tx", methods: ["GET"], auth: "session" },
  { id: "wallet_actions", path: "/api/wallet/actions", methods: ["GET"], auth: "none" },
  {
    id: "wallet_link_start",
    path: "/api/wallet/link/start",
    methods: ["POST"],
    auth: "handler",
    rateLimit: { limit: 20, windowMs: tenMinutes },
  },
  {
    id: "wallet_link_verify",
    path: "/api/wallet/link/verify",
    methods: ["POST"],
    auth: "handler",
    rateLimit: { limit: 30, windowMs: tenMinutes },
  },
  {
    id: "wallet_action",
    paths: [
      "/api/wallet/create/start",
      "/api/wallet/initiation/retry",
      "/api/wallet/unlock/start",
      "/api/wallet/delink",
      "/api/wallet/relink/start",
    ],
    methods: ["POST"],
    auth: "handler",
    rateLimit: { limit: 20, windowMs: tenMinutes, extra: "pathname" },
  },
  { id: "context", path: "/api/context", methods: ["GET"], auth: "optional" },
  { id: "context_history", path: "/api/context/history", methods: ["GET"], auth: "optional" },
  { id: "context_history_ipfs", prefix: "/api/context/history/ipfs/", methods: ["GET"], auth: "handler" },
  { id: "context_actions", path: "/api/context/actions", methods: ["GET"], auth: "none" },
  { id: "context_import_start", path: "/api/context/import/start", methods: ["POST"], auth: "handler" },
  { id: "context_manifest_ink", path: "/api/context/manifest/ink", methods: ["POST"], auth: "handler" },
  { id: "context_edit_save", path: "/api/context/edit/save", methods: ["POST"], auth: "handler" },
  { id: "context_history_indexed", path: "/api/context/history/indexed", methods: ["POST"], auth: "handler" },
  {
    id: "context_history_rpc_import",
    path: "/api/context/history/rpc/import",
    methods: ["POST"],
    auth: "handler",
    rateLimit: { limit: 5, windowMs: tenMinutes },
  },
  { id: "usage", path: "/api/usage", methods: ["GET"], auth: "optional" },
  { id: "usage_actions", path: "/api/usage/actions", methods: ["GET"], auth: "none" },
  { id: "usage_top_up_start", path: "/api/usage/top-up/start", methods: ["POST"], auth: "handler" },
  { id: "usage_top_up_sync", path: "/api/usage/top-up/sync", methods: ["POST"], auth: "handler" },
  {
    id: "usage_admin_credit",
    path: "/api/usage/credit/admin",
    methods: ["POST"],
    auth: "admin_bearer",
    rateLimit: { limit: 20, windowMs: tenMinutes },
  },
  { id: "usage_ledger", path: "/api/usage/ledger", methods: ["GET"], auth: "optional" },
];

export function routePolicyForPath(pathname) {
  return apiRoutePolicies.find((policy) => {
    if (policy.path && policy.path === pathname) return true;
    if (policy.paths && policy.paths.includes(pathname)) return true;
    if (policy.prefix && pathname.startsWith(policy.prefix)) return true;
    return Boolean(policy.pattern?.test(pathname));
  }) || null;
}

export function routePolicyRateLimitExtra(policy, pathname) {
  return policy?.rateLimit?.extra === "pathname" ? pathname : "";
}
