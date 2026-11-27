import { databaseEnabled, query } from "./db/pool.js";
import { getIndex } from "./repositories/index-viewer.js";
import { BUNDLE_FILE_FORMAT, createBundleFileLoader, fetchBundleFile } from "./validator-bundle-files.js";
import {
  FINANCE_HUB_TIER,
  GOODBRIEF_SANDBOX_ATTR,
  GOODBRIEF_SRCDOC_CSP,
  buildFinanceHubWatermark,
  evaluateFinanceHubAccess,
  prepareGoodbriefSrcDoc,
} from "./finance-hub-access.js";
import { filterLibraryItems } from "./finance-hub-library.js";

const IDLE_VISIT_GAP_MS = 30 * 60_000;
const TICKER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/;

const bundleFileLoader = createBundleFileLoader({
  fetchFile: (id, index, filePath) => fetchBundleFile(query, id, index, filePath),
});

function sanitizeWatchlist(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const result = [];
  for (const raw of list) {
    const ticker = String(raw || "").trim().toUpperCase();
    if (!ticker || !TICKER_RE.test(ticker) || seen.has(ticker)) continue;
    seen.add(ticker);
    result.push(ticker);
    if (result.length >= 100) break;
  }
  return result;
}

export async function readFinanceHubUserState(accountId = "", { queryImpl = query, now = new Date() } = {}) {
  if (!accountId || (!databaseEnabled() && queryImpl === query)) {
    return { watchlist: [], visitBaselineAt: null, lastActiveAt: null, goodbriefNotifyEnabled: false };
  }
  const nowDate = now instanceof Date ? now : new Date(now);
  const res = await queryImpl(
    `SELECT watchlist_json, visit_baseline_at, last_active_at, goodbrief_notify_enabled
       FROM finance_hub_user_state
      WHERE account_id = $1 LIMIT 1`,
    [accountId]
  );
  const row = res.rows[0];
  if (!row) {
    await queryImpl(
      `INSERT INTO finance_hub_user_state (account_id, watchlist_json, visit_baseline_at, last_active_at, updated_at)
       VALUES ($1, '[]'::jsonb, $2::timestamptz, $2::timestamptz, now())
       ON CONFLICT (account_id) DO NOTHING`,
      [accountId, nowDate.toISOString()]
    ).catch(() => {});
    return {
      watchlist: [],
      visitBaselineAt: nowDate.toISOString(),
      lastActiveAt: nowDate.toISOString(),
      goodbriefNotifyEnabled: false,
    };
  }

  let visitBaselineAt = row.visit_baseline_at ? new Date(row.visit_baseline_at).toISOString() : null;
  const lastActiveMs = row.last_active_at ? new Date(row.last_active_at).getTime() : 0;
  // Advance visit baseline only after an idle gap so refreshes, extra tabs,
  // and mobile handoffs preserve "New since your last visit" badges.
  if (lastActiveMs && nowDate.getTime() - lastActiveMs > IDLE_VISIT_GAP_MS) {
    visitBaselineAt = new Date(lastActiveMs).toISOString();
  }
  await queryImpl(
    `UPDATE finance_hub_user_state
        SET visit_baseline_at = COALESCE($2::timestamptz, visit_baseline_at),
            last_active_at = $3::timestamptz,
            updated_at = now()
      WHERE account_id = $1`,
    [accountId, visitBaselineAt, nowDate.toISOString()]
  ).catch(() => {});

  return {
    watchlist: sanitizeWatchlist(row.watchlist_json),
    visitBaselineAt,
    lastActiveAt: nowDate.toISOString(),
    goodbriefNotifyEnabled: Boolean(row.goodbrief_notify_enabled),
  };
}

export async function saveFinanceHubUserState(accountId = "", patch = {}, { queryImpl = query, now = new Date() } = {}) {
  const nowIso = (now instanceof Date ? now : new Date(now)).toISOString();
  const current = await readFinanceHubUserState(accountId, { queryImpl, now });
  const watchlist = patch.watchlist !== undefined ? sanitizeWatchlist(patch.watchlist) : current.watchlist;
  const goodbriefNotifyEnabled = patch.goodbriefNotifyEnabled !== undefined
    ? Boolean(patch.goodbriefNotifyEnabled)
    : current.goodbriefNotifyEnabled;
  const visitBaselineAt = patch.visitBaselineAt !== undefined ? patch.visitBaselineAt : current.visitBaselineAt;

  if (databaseEnabled() || queryImpl !== query) {
    await queryImpl(
      `INSERT INTO finance_hub_user_state
         (account_id, watchlist_json, visit_baseline_at, last_active_at, goodbrief_notify_enabled, updated_at)
       VALUES ($1, $2::jsonb, $3::timestamptz, $4::timestamptz, $5, now())
       ON CONFLICT (account_id) DO UPDATE SET
         watchlist_json = EXCLUDED.watchlist_json,
         visit_baseline_at = COALESCE(EXCLUDED.visit_baseline_at, finance_hub_user_state.visit_baseline_at),
         last_active_at = EXCLUDED.last_active_at,
         goodbrief_notify_enabled = EXCLUDED.goodbrief_notify_enabled,
         updated_at = now()`,
      [accountId, JSON.stringify(watchlist), visitBaselineAt, nowIso, goodbriefNotifyEnabled]
    );
  }
  return { watchlist, visitBaselineAt, lastActiveAt: nowIso, goodbriefNotifyEnabled };
}

async function tryLoadBundleJson(indexId, index, filePath, loadFile) {
  if (!index || index.metadata?.fileFormat !== BUNDLE_FILE_FORMAT) return null;
  try {
    const bytes = await loadFile(indexId, index, filePath);
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
}

async function tryLoadBundleText(indexId, index, filePath, loadFile) {
  if (!index || index.metadata?.fileFormat !== BUNDLE_FILE_FORMAT) return null;
  try {
    const bytes = await loadFile(indexId, index, filePath);
    return bytes.toString("utf8");
  } catch {
    return null;
  }
}

export function createFinanceHubRoutesHandler({
  readIndex = getIndex,
  checkAccess = evaluateFinanceHubAccess,
  loadFile = (id, index, filePath) => bundleFileLoader.load(id, index, filePath),
  readUserState = readFinanceHubUserState,
  saveUserState = saveFinanceHubUserState,
  now = () => new Date(),
  watermarkSecret,
} = {}) {
  const watermarkFor = (fields) => buildFinanceHubWatermark({ ...fields, ...(watermarkSecret ? { secret: watermarkSecret } : {}) });
  return async function handleFinanceHubRoute({ json, readJson, req, res, session, url }) {
    const pathname = url.pathname;
    if (!pathname.startsWith("/api/finance-hub/")) return false;
    const accountId = session?.accountId || "";

    try {
      if (pathname === "/api/finance-hub/access" && req.method === "GET") {
        const gaIndex = await readIndex("ga-models").catch(() => null);
        const access = await checkAccess({ accountId, tier: FINANCE_HUB_TIER, index: gaIndex, now: now() });
        json(res, 200, { ok: true, access }, { "cache-control": "private, no-store" });
        return true;
      }

      if (!accountId) {
        json(res, 401, { ok: false, error: "sign_in_required" }, { "cache-control": "no-store" });
        return true;
      }

      if (pathname === "/api/finance-hub/state") {
        const access = await checkAccess({ accountId, tier: FINANCE_HUB_TIER, now: now() });
        if (!access.ok) {
          json(res, 403, { ok: false, error: access.reason }, { "cache-control": "no-store" });
          return true;
        }
        if (req.method === "GET") {
          const state = await readUserState(accountId, { now: now() });
          json(res, 200, { ok: true, state }, { "cache-control": "private, no-store" });
          return true;
        }
        if (req.method === "PUT") {
          const payload = await readJson(req, 16_384);
          const state = await saveUserState(accountId, {
            watchlist: payload?.watchlist,
            goodbriefNotifyEnabled: payload?.goodbriefNotifyEnabled,
          }, { now: now() });
          json(res, 200, { ok: true, state }, { "cache-control": "private, no-store" });
          return true;
        }
      }

      if (pathname === "/api/finance-hub/mark-caught-up" && req.method === "POST") {
        const access = await checkAccess({ accountId, tier: FINANCE_HUB_TIER, now: now() });
        if (!access.ok) {
          json(res, 403, { ok: false, error: access.reason }, { "cache-control": "no-store" });
          return true;
        }
        const nowDate = now();
        const state = await saveUserState(accountId, { visitBaselineAt: nowDate.toISOString() }, { now: nowDate });
        json(res, 200, { ok: true, state }, { "cache-control": "private, no-store" });
        return true;
      }

      if (pathname === "/api/finance-hub/goodbrief" && req.method === "GET") {
        const goodbriefIndex = await readIndex("goodbrief");
        const access = await checkAccess({
          accountId,
          tier: goodbriefIndex?.tier || FINANCE_HUB_TIER,
          index: goodbriefIndex,
          now: now(),
        });
        if (!access.ok) {
          json(res, 403, { ok: false, error: access.reason }, { "cache-control": "no-store" });
          return true;
        }
        let html = goodbriefIndex ? await tryLoadBundleText("goodbrief", goodbriefIndex, "index.html", loadFile) : null;
        let summary = goodbriefIndex ? await tryLoadBundleJson("goodbrief", goodbriefIndex, "summary.json", loadFile) : null;
        let sourceIndex = goodbriefIndex ? "goodbrief" : "";

        // Migration fallback: read Goodbrief from ga-models only if independently authorized.
        if (!html) {
          const gaIndex = await readIndex("ga-models");
          const gaAccess = gaIndex
            ? await checkAccess({ accountId, tier: gaIndex.tier || FINANCE_HUB_TIER, index: gaIndex, now: now() })
            : { ok: false };
          if (gaAccess.ok) {
            html = await tryLoadBundleText("ga-models", gaIndex, "goodbrief.html", loadFile)
              || await tryLoadBundleText("ga-models", gaIndex, "hub/goodbrief.html", loadFile);
            sourceIndex = html ? "ga-models" : "";
          }
        }

        const watermark = watermarkFor({
          accountId,
          basis: access.basis,
          indexId: sourceIndex || "goodbrief",
          filePath: "index.html",
          issuedAt: now(),
        });

        const srcDoc = html
          ? prepareGoodbriefSrcDoc(html, { watermarkId: watermark?.watermarkId || null, title: goodbriefIndex?.title || "Goodbrief" })
          : null;

        json(
          res,
          200,
          {
            ok: true,
            available: Boolean(srcDoc),
            title: goodbriefIndex?.title || summary?.title || "Goodbrief Macro Roundup",
            publishedAt: goodbriefIndex?.publishedAt || summary?.published_at || null,
            summary: summary || null,
            srcDoc,
            sandbox: GOODBRIEF_SANDBOX_ATTR,
            csp: GOODBRIEF_SRCDOC_CSP,
            watermarkId: watermark?.watermarkId || null,
          },
          {
            "cache-control": "private, no-store",
            ...(watermark ? { [watermark.headerName]: watermark.headerValue } : {}),
          }
        );
        return true;
      }

      if (pathname === "/api/finance-hub/today" && req.method === "GET") {
        const [gaIndex, goodbriefIndex] = await Promise.all([
          readIndex("ga-models").catch(() => null),
          readIndex("goodbrief").catch(() => null),
        ]);
        const gaAccess = await checkAccess({
          accountId,
          tier: gaIndex?.tier || FINANCE_HUB_TIER,
          index: gaIndex,
          now: now(),
        });
        if (!gaAccess.ok) {
          json(res, 403, { ok: false, error: gaAccess.reason }, { "cache-control": "no-store" });
          return true;
        }
        // Goodbrief summary card is checked independently against goodbrief's allowed_bases.
        const gbAccess = goodbriefIndex
          ? await checkAccess({ accountId, tier: goodbriefIndex.tier || FINANCE_HUB_TIER, index: goodbriefIndex, now: now() })
          : { ok: false };

        const [todayDoc, coverageChanges, modelsIndex, libraryDoc, goodbriefSummary, userState] = await Promise.all([
          tryLoadBundleJson("ga-models", gaIndex, "hub/today.json", loadFile),
          tryLoadBundleJson("ga-models", gaIndex, "hub/coverage_changes.json", loadFile),
          tryLoadBundleJson("ga-models", gaIndex, "hub/models.json", loadFile)
            .then((d) => d || tryLoadBundleJson("ga-models", gaIndex, "models.json", loadFile)),
          tryLoadBundleJson("ga-models", gaIndex, "hub/library.json", loadFile),
          gbAccess.ok ? tryLoadBundleJson("goodbrief", goodbriefIndex, "summary.json", loadFile) : null,
          readUserState(accountId, { now: now() }),
        ]);

        const watermark = watermarkFor({
          accountId,
          basis: gaAccess.basis,
          indexId: "ga-models",
          filePath: "hub/today.json",
          issuedAt: now(),
        });

        json(
          res,
          200,
          {
            ok: true,
            access: gaAccess,
            goodbriefAllowed: Boolean(gbAccess.ok),
            watermarkId: watermark?.watermarkId || null,
            userState,
            updatedAt: todayDoc?.updated_at || gaIndex?.publishedAt || null,
            goodbrief: goodbriefSummary || (gbAccess.ok ? todayDoc?.goodbrief || null : null),
            justReported: Array.isArray(todayDoc?.just_reported) ? todayDoc.just_reported : [],
            modelUpdates: Array.isArray(todayDoc?.model_updates) ? todayDoc.model_updates : [],
            reportingThisWeek: Array.isArray(todayDoc?.reporting_this_week) ? todayDoc.reporting_this_week : [],
            liveMovers: Array.isArray(todayDoc?.live_movers) ? todayDoc.live_movers : [],
            liveMoversSessionLabel: todayDoc?.live_movers_session_label || "",
            coverageChanges: Array.isArray(coverageChanges?.changes)
              ? coverageChanges.changes
              : Array.isArray(todayDoc?.coverage_changes)
                ? todayDoc.coverage_changes
                : [],
            models: Array.isArray(modelsIndex?.models)
              ? modelsIndex.models
              : Array.isArray(todayDoc?.models)
                ? todayDoc.models
                : [],
            library: filterLibraryItems(
              Array.isArray(libraryDoc?.items) ? libraryDoc.items : todayDoc?.library,
              gaAccess.basis
            ),
          },
          {
            "cache-control": "private, no-store",
            ...(watermark ? { [watermark.headerName]: watermark.headerValue } : {}),
          }
        );
        return true;
      }

      if (pathname === "/api/finance-hub/library" && req.method === "GET") {
        const gaIndex = await readIndex("ga-models").catch(() => null);
        const access = await checkAccess({
          accountId,
          tier: gaIndex?.tier || FINANCE_HUB_TIER,
          index: gaIndex,
          now: now(),
        });
        if (!access.ok) {
          json(res, 403, { ok: false, error: access.reason }, { "cache-control": "no-store" });
          return true;
        }
        const libraryDoc = await tryLoadBundleJson("ga-models", gaIndex, "hub/library.json", loadFile);
        const watermark = watermarkFor({
          accountId,
          basis: access.basis,
          indexId: "ga-models",
          filePath: "hub/library.json",
          issuedAt: now(),
        });
        json(
          res,
          200,
          {
            ok: true,
            items: filterLibraryItems(libraryDoc?.items, access.basis),
            watermarkId: watermark?.watermarkId || null,
          },
          {
            "cache-control": "private, no-store",
            ...(watermark ? { [watermark.headerName]: watermark.headerValue } : {}),
          }
        );
        return true;
      }

      return false;
    } catch (error) {
      json(
        res,
        error?.status || 503,
        { ok: false, error: error?.status ? error.message : "finance_hub_unavailable" },
        { "cache-control": "no-store" }
      );
      return true;
    }
  };
}

export const handleFinanceHubRoute = createFinanceHubRoutesHandler();
