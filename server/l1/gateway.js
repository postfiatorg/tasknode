import { handleBridgeRoutes } from "./bridge-routes.js";
import { handleNavcoinRoutes } from "./navcoin-routes.js";
export function registerL1Gateway(server, { getSession, sessionCookieName, cookieValue, json, readJson }) {
  const handlers = server.listeners("request");
  server.removeAllListeners("request");
  server.on("request", (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith("/api/l1/")) { for (const handler of handlers) handler(req, res); return; }
    void (async () => {
      const session = await getSession(cookieValue(req, sessionCookieName));
      if (!session?.accountId) { json(res, 401, { error: "l1_login_required" }); return; }
      const context = { req, res, url, session, json, readJson, proxyUrl: process.env.L1_WALLET_PROXY_URL || "" };
      if (await handleBridgeRoutes(context) || await handleNavcoinRoutes(context)) return;
      json(res, 503, { error: "l1_gateway_not_ready" });
    })().catch(() => json(res, 502, { error: "l1_gateway_unavailable" }));
  });
}
