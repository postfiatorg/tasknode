import assert from "node:assert/strict";

import {
  listMachineOperatorDisclosures,
  publicMachineOperatorDisclosureFromProfiles,
} from "../server/repositories/capability-profiles.js";
import { publicProfileFromParts } from "../server/repositories/profile-public.js";

const accountId = "acct_orc_ui_smoke";
const disclosure = publicMachineOperatorDisclosureFromProfiles([
  {
    id: "cap_orc_ui",
    account_id: accountId,
    capability_type: "evidence_evaluation_orc",
    scope_label: "Task Node Core Product",
    status: "verified",
    evidence_task_id: "task_orc_capability",
    verified_at: "2026-06-15T08:00:00.000Z",
    metadata_json: {
      public_label: "Orc operator",
      machine_operator: true,
      operator_kind: "evidence_evaluation_orc",
      mandate_url: "https://example.com/mandate",
    },
  },
]);

assert.equal(disclosure.isMachineOperator, true);
assert.equal(disclosure.label, "Orc operator");
assert.equal(disclosure.kind, "evidence_evaluation_orc");
assert.equal(disclosure.capabilities[0].evidenceTaskId, "task_orc_capability");
assert.equal(JSON.stringify(disclosure).includes("walletSeed"), false);
assert.equal(JSON.stringify(disclosure).includes("mnemonic"), false);
assert.equal(JSON.stringify(disclosure).includes("tasknode_session"), false);
assert.equal(JSON.stringify(disclosure).includes("sessionToken"), false);

assert.equal(publicMachineOperatorDisclosureFromProfiles([
  {
    id: "cap_regular",
    account_id: accountId,
    capability_type: "repo_pr_access",
    scope_label: "Private repo",
    status: "verified",
  },
]), null);

let queryCount = 0;
const listed = await listMachineOperatorDisclosures({
  accountIds: [accountId, "acct_regular"],
  databaseReady: true,
  queryImpl: async (sql, params) => {
    queryCount += 1;
    assert.ok(sql.includes("FROM board_manager_capability_profiles"));
    assert.deepEqual(params[0], [accountId, "acct_regular"]);
    return {
      rows: [
        {
          id: "cap_orc_ui",
          account_id: accountId,
          capability_type: "machine_operator",
          scope_label: "Task Node",
          status: "verified",
          metadata_json: { public_label: "Machine operator", machine_operator: true },
        },
        {
          id: "cap_regular",
          account_id: "acct_regular",
          capability_type: "repo_pr_access",
          scope_label: "Task Node private repo",
          status: "verified",
        },
      ],
    };
  },
});
assert.equal(queryCount, 1);
assert.equal(listed[accountId].isMachineOperator, true);
assert.equal(listed.acct_regular, undefined);

const profile = publicProfileFromParts({
  accountId,
  input: {
    account_id: accountId,
    identity: {
      primary_wallet: "rOrcUiSmokeWallet",
      wallet_count: 1,
    },
    reward_totals: {},
    contribution_tier: {},
  },
  operatorDisclosure: listed[accountId],
});
assert.equal(profile.identity.operatorDisclosure.isMachineOperator, true);
assert.equal(profile.identity.operatorDisclosure.label, "Machine operator");

console.log("board-manager-orc-ui-smoke ok");
