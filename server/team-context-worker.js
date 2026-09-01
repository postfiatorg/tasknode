import { loadPrompt } from "./prompt-registry.js";
import {
  claimTeamContextJobs,
  completeTeamContextJob,
  failTeamContextJob,
} from "./repositories/team-context.js";
import {
  TEAM_CONTEXT_VERCEL_MODEL,
  vercelAiGatewayConfigured,
  vercelChatCompletion,
} from "./vercel-inference.js";
import { TEAM_CONTEXT_PROMPT_VERSION } from "./team-context-contract.js";

const systemPrompt = loadPrompt(`team/${TEAM_CONTEXT_PROMPT_VERSION}.md`);
let timer = null;
let running = false;

function safeText(value = "", max = 2400) {
  return String(value || "").trim().slice(0, max);
}

function visibleMembers(source = {}) {
  return (Array.isArray(source.members) ? source.members : []).filter((member) => member?.taskHistoryVisible === true);
}

function memberBindings(source = {}) {
  return visibleMembers(source).map((member, index) => ({
    memberKey: `member_${index + 1}`,
    accountId: safeText(member.accountId, 180),
    member,
  }));
}

function rewardedMemberBindings(source = {}) {
  return memberBindings(source).filter((binding) =>
    Array.isArray(binding.member.recentRewardedTasks)
    && binding.member.recentRewardedTasks.length > 0
  );
}

function wordCount(value = "") {
  return String(value || "").split(" ").filter(Boolean).length;
}

function compileMemberSummary(responseMember = {}, overview = "") {
  const workstream = safeText(overview, 240);
  const focus = safeText(responseMember.focus, 1400);
  const operationalEffect = safeText(responseMember.operational_effect, 1200);
  const completedChanges = Array.isArray(responseMember.completed_changes)
    ? responseMember.completed_changes.map((change) => safeText(change, 900))
    : [];

  if (
    !focus
    || !operationalEffect
    || completedChanges.length < 1
    || completedChanges.length > 12
    || completedChanges.some((change) => !change)
  ) {
    throw new Error("team_context_response_member_detail_invalid");
  }

  const recentWork = safeText([focus, ...completedChanges, operationalEffect].join(" "), 6000);
  const detailWordCount = wordCount(recentWork);
  if (detailWordCount < 90) throw new Error("team_context_response_member_detail_too_short");
  return { recentWork, workstream };
}

export function parseTeamContextResponse(text = "", source = {}) {
  let parsed = null;
  try {
    parsed = JSON.parse(String(text || "").trim());
  } catch {
    throw new Error("team_context_response_invalid_json");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("team_context_response_invalid_object");
  }
  const expected = rewardedMemberBindings(source);
  const allBindings = memberBindings(source);
  const members = Array.isArray(parsed.members) ? parsed.members : [];
  const byMemberKey = new Map();
  for (const member of members) {
    const memberKey = safeText(member?.member_key, 80);
    if (!memberKey || byMemberKey.has(memberKey)) {
      throw new Error("team_context_response_member_invalid");
    }
    byMemberKey.set(memberKey, member);
  }
  if (
    byMemberKey.size !== expected.length
    || expected.some((binding) => !byMemberKey.has(binding.memberKey))
  ) {
    throw new Error("team_context_response_member_set_mismatch");
  }
  return {
    overview: safeText(parsed.overview, 240),
    members: allBindings.map((binding) => {
      if (!byMemberKey.has(binding.memberKey)) {
        return {
          account_id: binding.accountId,
          workstream: "",
          recent_work: "No rewarded work is available yet for this member.",
        };
      }
      const compiled = compileMemberSummary(
        byMemberKey.get(binding.memberKey),
        parsed.overview
      );
      return {
        account_id: binding.accountId,
        workstream: compiled.workstream,
        recent_work: compiled.recentWork,
      };
    }),
  };
}

function requestPacket(source = {}) {
  return {
    schema: source.schema,
    team_members: rewardedMemberBindings(source).map(({ memberKey, member }) => ({
      member_key: memberKey,
      display_name: member.displayName,
      recent_rewarded_tasks: member.recentRewardedTasks || [],
    })),
  };
}

function usageFromBody(body = {}) {
  const usage = body.usage || {};
  return {
    inputTokens: Number(usage.prompt_tokens || usage.input_tokens || 0),
    outputTokens: Number(usage.completion_tokens || usage.output_tokens || 0),
    totalTokens: Number(usage.total_tokens || 0),
  };
}

async function generateSingleMemberReport(source = {}, member = {}, options = {}) {
  const singleMemberSource = { ...source, members: [member] };
  const body = await vercelChatCompletion({
    model: TEAM_CONTEXT_VERCEL_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: JSON.stringify(requestPacket(singleMemberSource)) },
    ],
    maxTokens: Number(process.env.TASKNODE_TEAM_CONTEXT_MAX_TOKENS || 32_000),
    timeoutMs: Number(process.env.TASKNODE_TEAM_CONTEXT_PROVIDER_TIMEOUT_MS || 240_000),
    ...options,
  });
  const choice = body?.choices?.[0] || {};
  if (choice.finish_reason === "length") throw new Error("team_context_response_truncated");
  const content = choice?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("team_context_response_missing");
  return {
    report: parseTeamContextResponse(content, singleMemberSource),
    usage: usageFromBody(body),
  };
}

export async function generateTeamContextReport(source = {}, options = {}) {
  const rewardedBindings = rewardedMemberBindings(source);
  const generated = await Promise.all(
    rewardedBindings.map((binding) =>
      generateSingleMemberReport(source, binding.member, options)
    )
  );
  const generatedByAccount = new Map(
    generated.map((result) => {
      const member = result.report.members[0];
      return [safeText(member?.account_id, 180), member];
    })
  );
  const workstreams = generated
    .map((result) => safeText(result.report.members[0]?.workstream, 240))
    .filter(Boolean);
  const usage = generated.reduce((total, result) => ({
    inputTokens: total.inputTokens + Number(result.usage.inputTokens || 0),
    outputTokens: total.outputTokens + Number(result.usage.outputTokens || 0),
    totalTokens: total.totalTokens + Number(result.usage.totalTokens || 0),
  }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  return {
    report: {
      overview: workstreams.length > 0
        ? safeText(`The team's recent rewarded work spans ${workstreams.join("; ")}.`, 2400)
        : "",
      members: memberBindings(source).map((binding) =>
        generatedByAccount.get(binding.accountId) || {
          account_id: binding.accountId,
          workstream: "",
          recent_work: "No rewarded work is available yet for this member.",
        }
      ),
    },
    usage,
  };
}

export async function processTeamContextQueueOnce({ limit = 2 } = {}) {
  if (!vercelAiGatewayConfigured()) return { ok: true, skipped: true, reason: "vercel_ai_gateway_not_configured" };
  if (running) return { ok: true, skipped: true, reason: "team_context_worker_busy" };
  running = true;
  let processed = 0;
  let failed = 0;
  try {
    const jobs = await claimTeamContextJobs({ limit });
    for (const job of jobs) {
      try {
        const generated = await generateTeamContextReport(job.source_packet_json);
        await completeTeamContextJob({
          job,
          report: generated.report,
          usage: generated.usage,
          model: TEAM_CONTEXT_VERCEL_MODEL,
        });
        processed += 1;
      } catch (error) {
        failed += 1;
        await failTeamContextJob(job, error);
      }
    }
    return { ok: true, claimed: jobs.length, processed, failed };
  } finally {
    running = false;
  }
}

export function startTeamContextWorker() {
  if (timer || process.env.TASKNODE_TEAM_CONTEXT_ENABLED === "false" || !vercelAiGatewayConfigured()) {
    return { ok: true, skipped: true };
  }
  const intervalMs = Math.max(5000, Number(process.env.TASKNODE_TEAM_CONTEXT_INTERVAL_MS || 15_000));
  const tick = () => processTeamContextQueueOnce({
    limit: Number(process.env.TASKNODE_TEAM_CONTEXT_BATCH_SIZE || 2),
  }).catch((error) => console.warn("team_context_worker_failed", { error: error?.message || String(error) }));
  const initial = setTimeout(tick, 2500);
  initial.unref?.();
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return { ok: true, intervalMs, model: TEAM_CONTEXT_VERCEL_MODEL, provider: "vercel" };
}
