import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
const moduleAt = (file) => import(pathToFileURL(resolve(file)));
const { query, transactionCommand, closePool } = await moduleAt("server/db/pool.js");
const { explainNetworkTaskCandidateEligibility } = await moduleAt("server/repositories/network-task-eligibility.js");
const { getNetworkTaskCapacityState } = await moduleAt("server/repositories/network-task-capacity.js");
const { getAccountIdentityProfile } = await moduleAt("server/repositories/account-profiles.js");
const { boardRoutingCandidates } = await moduleAt("server/board-task-policy.js");
const alias = (id) => "contributor_" + createHash("sha256").update("hive-audit-20260919:" + id).digest("hex").slice(0, 10);
try {
  const report = await transactionCommand(async () => {
    await query("SET TRANSACTION READ ONLY");
    const transactionMode = (await query("SHOW transaction_read_only")).rows[0];
    if (transactionMode.transaction_read_only !== "on") throw new Error("audit_requires_read_only_transaction");
    await query("SET LOCAL statement_timeout='20s'");
    await query("SET LOCAL lock_timeout='2s'");
    const start = new Date().toISOString();
    const accounts = (await query(`
      WITH candidates AS (
        SELECT account_id FROM account_network_badges WHERE status='verified' AND revoked_at IS NULL
        UNION SELECT account_id FROM account_linked_wallets WHERE status='linked'
        UNION SELECT account_id FROM pftl_sync_wallets WHERE role='user' AND status='active'
      )
      SELECT c.account_id, (SELECT count(*)::int FROM task_projections t WHERE t.account_id=c.account_id AND t.status='rewarded') AS rewarded_tasks,
       (SELECT max(created_at) FROM network_task_allocations a WHERE a.candidate_account_id=c.account_id) AS last_allocation_at,
       (SELECT max(t.created_at) FROM network_task_allocations a JOIN task_projections t ON t.task_id=a.generated_task_id WHERE a.candidate_account_id=c.account_id) AS last_network_offer_at,
       (SELECT max(t.last_event_at) FROM task_projections t WHERE t.account_id=c.account_id) AS last_task_activity_at
      FROM candidates c ORDER BY rewarded_tasks DESC,c.account_id
    `)).rows;
    if (accounts.length > 500) throw new Error("candidate_universe_exceeds_audit_bound");
    const boardIds = ["board_pf_terminal","board_community_promotion","board_postfiat_l1v2","board_ai_l1_governance","board_tasknode_fixes","board_capital_markets"];
    const boards = (await query("SELECT id,status,metadata_json FROM network_projects WHERE id=ANY($1::text[])", [boardIds])).rows;
    const members = [];
    for (const [index, account] of accounts.entries()) {
      const verdict = await explainNetworkTaskCandidateEligibility({ accountId: account.account_id });
      const capacity = await getNetworkTaskCapacityState({ accountId: account.account_id, walletAddress: verdict.walletAddress || "" });
      const identity = await getAccountIdentityProfile({ accountId: account.account_id });
      const member = { account_id:account.account_id, public_handle:identity?.hiveHandle || "", engine_verdict:verdict.eligible ? "eligible" : "refused", free_slots:capacity.freeSlots };
      members.push({
        contributor:alias(account.account_id), sourceRank:index+1, engineEligible:verdict.eligible, exclusion:verdict.reason || "",
        badges:verdict.badgeIds || [], defaultBadge:verdict.defaultBadge || "", capacity,
        walletResolved:Boolean(verdict.walletAddress),
        lastAllocationAt:account.last_allocation_at, lastNetworkOfferAt:account.last_network_offer_at, lastTaskActivityAt:account.last_task_activity_at,
        allowedBoards:boards.filter(board=>boardRoutingCandidates(board,[member]).length>0).map(board=>board.id)
      });
    }
    const idle = members.filter(m=>m.engineEligible && m.capacity.available);
    const surfaced = idle.filter(m=>m.sourceRank<=100).slice(0,12);
    return { observedAt:start, completedAt:new Date().toISOString(), readOnly:true,
      universe:members.length, engineEligible:members.filter(m=>m.engineEligible).length,
      noCapacity:members.filter(m=>m.engineEligible&&!m.capacity.available).length,
      idleEligible:idle.length, sourceTop100Excluded:members.filter(m=>m.sourceRank>100).length,
      surfacedCandidateCount:surfaced.length,
      boardCandidates:boards.map(b=>({boardId:b.id,status:b.status,allIdleAllowed:idle.filter(m=>m.allowedBoards.includes(b.id)).length,surfacedAllowed:surfaced.filter(m=>m.allowedBoards.includes(b.id)).length})),
      contributors:members.map(m=>({...m,surfaced:surfaced.includes(m)})),
      limitations:["Eligibility is current; continuous historical eligibility and first waiting timestamps are not inferred from last task dates.","Board and badge eligibility identify available capacity, not a model judgment that a particular project need fits."]
    };
  });
  console.log(JSON.stringify(report,null,2));
} catch(error) { console.error(JSON.stringify({error:error.code||error.name,message:error.message})); process.exitCode=1; }
finally { await closePool(); }
