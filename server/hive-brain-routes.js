import {
  getHiveBrainLive,
  getHiveBrainRunDetail,
  listHiveBrainTaskGenerationHistory,
  listHiveBrainRuns,
} from "./repositories/hive-brain.js";
import { getHiveLiveTaskPacket } from "./repositories/hive-live-task-packet.js";
import {
  accountCanResolveCheckedOutTaskAccountingHarvest,
  checkoutTaskAccountingHarvest,
  getLatestTaskAccountingHarvestReport,
  listTaskAccountingHarvestCheckouts,
  listTaskAccountingHarvests,
  resolveTaskAccountingHarvest,
} from "./repositories/task-accounting-harvester.js";
import { subscribeHiveBrainLive } from "./hive-brain-live.js";
import {
  canResolveTaskAccountingHarvest,
  hiveBrainOperatorAccess,
  taskAccountingCheckoutPermissions,
  wantsRawAuditPacket,
} from "./hive-operator-access.js";

function safeText(value = "", max = 1000) {
  return String(value || "").trim().slice(0, max);
}

function sendSse(res, event = "message", payload = {}) {
  if (res.writableEnded) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function streamHiveBrainLive({ req, res }) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  let closed = false;
  let lastRunId = "";
  let lastOutputText = "";
  let lastStatus = "";
  const pushDurableSnapshot = async () => {
    if (closed || res.writableEnded) return;
    const live = await getHiveBrainLive().catch((error) => ({
      ok: false,
      error: error?.message || "hive_brain_live_failed",
      run: null,
    }));
    const run = live?.run || {};
    const outputText = String(run.outputText || "");
    const runId = String(run.id || run.runId || "");
    if (runId !== lastRunId) {
      lastRunId = runId;
      lastOutputText = "";
      lastStatus = "";
      sendSse(res, "snapshot", live);
    }
    if (outputText.length > lastOutputText.length && outputText.startsWith(lastOutputText)) {
      sendSse(res, "output_delta", {
        runId,
        delta: outputText.slice(lastOutputText.length),
        outputBytes: Buffer.byteLength(outputText),
        updatedAt: run.updatedAt || new Date().toISOString(),
      });
      lastOutputText = outputText;
    } else if (outputText !== lastOutputText) {
      sendSse(res, "snapshot", live);
      lastOutputText = outputText;
    }
    if ((run.status || "") !== lastStatus) {
      lastStatus = run.status || "";
      sendSse(res, "run_status", live);
    }
  };
  const unsubscribe = subscribeHiveBrainLive((event, payload) => {
    if (!closed) sendSse(res, event, payload);
  });
  await pushDurableSnapshot();
  const poll = setInterval(() => {
    pushDurableSnapshot().catch(() => null);
  }, 1000);
  const heartbeat = setInterval(() => {
    if (!closed && !res.writableEnded) res.write(": heartbeat\n\n");
  }, 15000);
  const cleanup = () => {
    closed = true;
    clearInterval(poll);
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.on("close", cleanup);
}

export async function handleHiveBrainRoute({ getLinkedWallet, json, readJson, req, res, session, url }) {
  if (!url.pathname.startsWith("/api/hive/brain")) return false;
  const access = await hiveBrainOperatorAccess(session);
  if (!access.ok) {
    json(res, access.status || 403, {
      ok: false,
      error: access.error,
      message: access.message,
    });
    return true;
  }
  const resolvePrefix = "/api/hive/brain/harvests/";
  const resolveSuffix = "/resolve";
  const checkoutSuffix = "/checkout";
  if (url.pathname.startsWith(resolvePrefix) && url.pathname.endsWith(checkoutSuffix)) {
    if (req.method !== "POST") {
      json(res, 405, {
        ok: false,
        error: "task_accounting_harvest_checkout_method_not_allowed",
        message: "Task Accounting harvest checkout requires POST.",
      });
      return true;
    }
    const permissions = await taskAccountingCheckoutPermissions({ getLinkedWallet, session });
    if (!permissions.canCheckout && !permissions.walletAddress) {
      json(res, 409, {
        ok: false,
        error: "task_accounting_harvest_checkout_wallet_required",
        message: "Link a wallet before checking out a harvest row.",
        permissions,
      });
      return true;
    }
    if (!permissions.canCheckout) {
      json(res, 403, {
        ok: false,
        error: "task_accounting_harvest_checkout_core_contributor_or_orc_required",
        message: "Only verified Core Contributors or active Orc agents can check out harvest rows.",
        permissions,
      });
      return true;
    }
    if (!permissions.walletAddress) {
      json(res, 409, {
        ok: false,
        error: "task_accounting_harvest_checkout_wallet_required",
        message: "Link a wallet before checking out a harvest row.",
        permissions,
      });
      return true;
    }
    const taskId = decodeURIComponent(url.pathname.slice(resolvePrefix.length, -checkoutSuffix.length));
    const body = await checkoutTaskAccountingHarvest({
      taskId,
      accountId: session.accountId,
      walletAddress: permissions.walletAddress,
      metadata: {
        source: "hive_brain",
        route: "/api/hive/brain/harvests/:taskId/checkout",
      },
    });
    json(res, body.ok ? 200 : body.status || 400, {
      ...body,
      permissions,
    });
    return true;
  }
  if (url.pathname.startsWith(resolvePrefix) && url.pathname.endsWith(resolveSuffix)) {
    if (req.method !== "POST") {
      json(res, 405, {
        ok: false,
        error: "task_accounting_harvest_resolve_method_not_allowed",
        message: "Task Accounting harvest resolution requires POST.",
      });
      return true;
    }
    const linkedWallet = typeof getLinkedWallet === "function"
      ? await getLinkedWallet({ accountId: session.accountId })
      : null;
    const taskId = decodeURIComponent(url.pathname.slice(resolvePrefix.length, -resolveSuffix.length));
    const canResolveAsOperator = canResolveTaskAccountingHarvest({ session, profile: access.profile, linkedWallet });
    const canResolveAsCheckoutOwner = canResolveAsOperator ? false : await accountCanResolveCheckedOutTaskAccountingHarvest({
      taskId,
      accountId: session.accountId,
      walletAddress: safeText(linkedWallet?.address || linkedWallet?.walletAddress || "", 120),
    });
    if (!canResolveAsOperator && !canResolveAsCheckoutOwner) {
      json(res, 403, {
        ok: false,
        error: "task_accounting_harvest_resolver_required",
        message: "Only authorized Task Accounting operators or the eligible checkout owner can resolve harvest rows.",
      });
      return true;
    }
    const payload = typeof readJson === "function" ? await readJson(req, 8192) : {};
    const body = await resolveTaskAccountingHarvest({
      taskId,
      resolvedByAccountId: session.accountId,
      outcome: payload?.outcome || payload?.resolutionOutcome || "",
      note: payload?.note || payload?.resolutionNote || "",
    });
    json(res, body.ok ? 200 : body.status || 404, body);
    return true;
  }
  if (url.pathname === "/api/hive/brain/harvest-checkouts") {
    if (req.method !== "GET") {
      json(res, 405, {
        ok: false,
        error: "task_accounting_harvest_checkouts_method_not_allowed",
        message: "Task Accounting harvest checkout log supports GET.",
      });
      return true;
    }
    const [body, permissions] = await Promise.all([
      listTaskAccountingHarvestCheckouts({
        includeResolved: ["1", "true", "yes"].includes(String(url.searchParams.get("includeResolved") || "").toLowerCase()),
        limit: url.searchParams.get("limit") || 80,
        page: url.searchParams.get("page") || 1,
      }),
      taskAccountingCheckoutPermissions({ getLinkedWallet, session }),
    ]);
    json(res, 200, { ...body, permissions });
    return true;
  }
  if (url.pathname === "/api/hive/brain/harvest-report") {
    if (req.method !== "GET") {
      json(res, 405, {
        ok: false,
        error: "task_accounting_harvest_report_method_not_allowed",
        message: "Harvest Report supports GET.",
      });
      return true;
    }
    const body = await getLatestTaskAccountingHarvestReport({
      generate: !["0", "false", "no"].includes(String(url.searchParams.get("generate") || "true").toLowerCase()),
    });
    json(res, body.ok ? 200 : body.status || 500, body);
    return true;
  }
  if (url.pathname === "/api/hive/brain/harvests") {
    if (req.method !== "GET") {
      json(res, 405, {
        ok: false,
        error: "task_accounting_harvests_method_not_allowed",
        message: "Task Accounting harvests supports GET.",
      });
      return true;
    }
    const [body, permissions] = await Promise.all([
      listTaskAccountingHarvests({
        status: url.searchParams.get("status") || "",
        classification: url.searchParams.get("classification") || "",
        requiresAction: url.searchParams.get("requiresAction") || "",
        resolved: url.searchParams.get("resolved") || "",
        includeResolved: ["1", "true", "yes"].includes(String(url.searchParams.get("includeResolved") || "").toLowerCase()),
        limit: url.searchParams.get("limit") || 80,
        page: url.searchParams.get("page") || 1,
      }),
      taskAccountingCheckoutPermissions({ getLinkedWallet, session }),
    ]);
    json(res, 200, { ...body, permissions });
    return true;
  }
  if (url.pathname === "/api/hive/brain/live-task-packet") {
    if (req.method !== "GET") {
      json(res, 405, {
        ok: false,
        error: "hive_live_task_packet_method_not_allowed",
        message: "Live Task Packet supports GET.",
      });
      return true;
    }
    const body = await getHiveLiveTaskPacket({
      limit: url.searchParams.get("limit") || 24,
    });
    json(res, body.ok ? 200 : body.status || 500, body);
    return true;
  }
  if (url.pathname === "/api/hive/brain/runs") {
    if (req.method !== "GET") {
      json(res, 405, { ok: false, error: "hive_brain_runs_method_not_allowed", message: "Hive Brain runs supports GET." });
      return true;
    }
    const body = await listHiveBrainRuns({
      limit: url.searchParams.get("limit") || 20,
      page: url.searchParams.get("page") || 1,
      action: url.searchParams.get("action") || "all",
      queryText: url.searchParams.get("q") || "",
    });
    json(res, 200, body);
    return true;
  }
  if (url.pathname === "/api/hive/brain/task-generation-history") {
    if (req.method !== "GET") {
      json(res, 405, {
        ok: false,
        error: "hive_brain_task_generation_history_method_not_allowed",
        message: "Hive Brain task generation history supports GET.",
      });
      return true;
    }
    const body = await listHiveBrainTaskGenerationHistory({
      limit: url.searchParams.get("limit") || 24,
      page: url.searchParams.get("page") || 1,
    });
    json(res, 200, body);
    return true;
  }
  if (url.pathname.startsWith("/api/hive/brain/run/")) {
    if (req.method !== "GET") {
      json(res, 405, { ok: false, error: "hive_brain_run_method_not_allowed", message: "Hive Brain run detail supports GET." });
      return true;
    }
    const runId = decodeURIComponent(url.pathname.slice("/api/hive/brain/run/".length));
    const body = await getHiveBrainRunDetail({ runId, includeSourcePacket: wantsRawAuditPacket(url) });
    json(res, body.ok ? 200 : body.status || 404, body);
    return true;
  }
  if (url.pathname === "/api/hive/brain/live") {
    if (req.method !== "GET") {
      json(res, 405, { ok: false, error: "hive_brain_live_method_not_allowed", message: "Hive Brain live supports GET." });
      return true;
    }
    await streamHiveBrainLive({ req, res });
    return true;
  }
  json(res, 404, { ok: false, error: "hive_brain_route_not_found" });
  return true;
}
