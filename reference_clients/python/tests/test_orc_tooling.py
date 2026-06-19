from types import SimpleNamespace
from concurrent.futures import ThreadPoolExecutor
import json
import os
import tempfile
import unittest
from unittest.mock import patch

from orc_tooling import (
    NETWORK_CAPACITY_NOTE,
    NETWORK_TRIAGE_CAPABILITY_VERSION,
    PRIORITY_PROMPT_VERSION,
    append_run_journal,
    build_dispatch_directive,
    build_followup_request_text,
    build_client,
    build_directory_rewarded_task_packet,
    build_hive_followup_command,
    build_hive_signal_command,
    build_review_queue_reward_packet,
    build_task_reward_packet,
    classify_review,
    classify_pane_text,
    claim_next_runtime_directive,
    close_followup,
    compact_review_task,
    complete_runtime_directive,
    dispatch_orc,
    dispatch_orc_runtime,
    duplicate_reward_monitor_sql,
    duplicate_reward_followup_message,
    escalate_orc,
    enqueue_runtime_directive,
    extract_evidence_artifacts,
    extract_task_brief,
    extract_task_payload,
    FOLLOWUP_CLOSEABLE_TASK_STATUSES,
    heuristic_priority_score,
    inject_directive,
    is_probable_fixture_priority_row,
    is_probable_fixture_review_row,
    nazgul_status,
    network_triage_decision,
    next_network_triage_item,
    normalize_review_state_record,
    operator_status,
    paste_chip_count,
    outstanding_task_briefs,
    prioritize_directory_rewarded_tasks,
    prioritize_network_work,
    prioritize_network_tasks,
    prioritize_review_queue,
    priority_prompt,
    record_operator_interaction,
    redirect_orc,
    request_personal_task,
    request_followup_task,
    review_disposition_requires_action,
    review_next,
    review_state_ontology,
    run_hive_followup,
    run_hive_signal,
    run_runtime_once,
    run_duplicate_reward_monitor,
    run_journal_summary,
    runtime_status,
    sanity_check_priority,
    stale_followup_closures,
    summarize_signed_flow,
    triage_network_work,
    validate_followup_action,
    visible_task_payloads,
    wait_for_orc_idle,
)
from tasknode_pftl.wallets import wallet_from_seed
from orc_tooling.nazgul import next_dispatch_item
from orc_tooling.review_integrity_policy import (
    EXECUTABLE_REWARD_CLAWBACK_SIGNAL,
    NO_SIGNING_NO_FUND_MOVEMENT_MARKER,
    apply_reward_clawback_integrity_policy,
)
from orc_tooling.review_state import (
    append_orc_work_journal,
    ensure_review_state_schema,
    normalize_orc_work_journal_record,
    orc_work_journal_insert_sql,
    orc_runtime_directives_schema_sql,
    review_state_summary,
    upsert_review_state,
)


SMOKE_MNEMONIC = (
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon "
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art"
)


class FakeOrcClient:
    address = "rFakeOperator1111111111111111111111111111"

    def __init__(self):
        self.calls = []

    def login(self):
        self.calls.append(("login",))
        return {"ok": True, "cached": True}

    def request_task(self, **kwargs):
        self.calls.append(("request_task", kwargs))
        return SimpleNamespace(
            config={"requestId": "req_test", "bundleId": "bundle_test"},
            payload={"request_id": "req_test", "request_bundle": {"cid": "bafkreibundle"}},
            prepared={"cid": "bafkreievent"},
            signed=SimpleNamespace(tx_hash="ABC123"),
            submitted={"cid": "bafkreievent", "txHash": "ABC123", "engineResult": "tesSUCCESS"},
        )

    def tasks(self):
        self.calls.append(("tasks",))
        return {"networkTasks": {"status": "available_for_routing"}}


class FakeTasksClient:
    address = "rFakeOperator1111111111111111111111111111"

    def login(self):
        return {"ok": True, "cached": True}

    def tasks(self):
        return {
            "networkTasks": {"status": "at_capacity", "gates": [1, 2]},
            "outstanding": [
                {
                    "taskId": "task_test",
                    "kind": "Network",
                    "status": "Proposed",
                    "title": "Do the thing",
                    "pft": "100",
                    "description": "Objective text",
                    "steps": ["Step one", "Step two"],
                    "submissionRequirement": {"type": "text", "criteria": "Submit evidence."},
                    "verificationPolicy": {"mode": "standard_followup"},
                }
            ],
        }


class FakeStatusClient:
    address = "rFakeOperator1111111111111111111111111111"
    account_id = "acct_fake"

    def login(self):
        return {"ok": True, "cached": True}

    def tasks(self, **kwargs):
        return {
            "networkTasks": {"status": "at_capacity", "gates": [1, 2]},
            "outstanding": [
                {"taskId": "task_network", "kind": "Network", "status": "Proposed", "title": "Network task"},
                {"taskId": "task_personal", "kind": "Personal", "status": "Proposed", "title": "Personal task"},
            ],
            "verification": [],
            "refused": [],
            "rewarded": [
                {"taskId": "task_rewarded", "kind": "Personal", "status": "Rewarded", "title": "Done", "rewardPft": 3}
            ],
            "requests": {"summary": {"active": 1}, "requests": [{"requestId": "req_test"}]},
        }

    def context_document(self):
        return {
            "title": "Orc Operator Context",
            "revision": 3,
            "pointerCount": 3,
            "latestContextPointer": {"cid": "QmContext", "txHash": "CTXTX"},
        }


class FakeCloseClient:
    address = "rFakeOperator1111111111111111111111111111"

    def __init__(self, status="Accepted"):
        self.status = status
        self.calls = []

    def login(self):
        self.calls.append(("login",))
        return {"ok": True, "cached": True}

    def task_detail(self, task_id):
        self.calls.append(("task_detail", task_id))
        return {
            "task": {
                "taskId": task_id,
                "kind": "Personal",
                "status": self.status,
                "lastEventTxHash": "TXFOLLOW",
                "lastEventCid": "QmFollow",
            },
            "rewardOutcome": {"txHash": "TXREWARD", "cid": "QmReward"},
        }


class FakePayloadClient:
    address = "rFakeOperator1111111111111111111111111111"

    def __init__(self):
        self.detail_calls = []

    def login(self):
        return {"ok": True, "cached": True}

    def tasks(self):
        return {
            "networkTasks": {"status": "available_for_routing"},
            "outstanding": [
                {"taskId": "task_personal", "kind": "Personal", "status": "Proposed"},
                {"taskId": "task_network", "kind": "Network", "isNetworkTask": True, "status": "Proposed"},
            ],
        }

    def task_detail(self, task_id):
        self.detail_calls.append(task_id)
        return detail_payload(task_id=task_id, network=task_id == "task_network")


class FakeDirectoryClient:
    address = "rFakeOperator1111111111111111111111111111"

    def login(self):
        return {"ok": True, "cached": True}

    def request(self, method, path, *, params=None, **kwargs):
        self.last_request = (method, path, params)
        return {
            "ok": True,
            "document": {
                "totals": {"tasks": 2, "networkTasks": 2, "pftDistributed": 40000},
                "tasks": [
                    {
                        "accountId": "acct_gmoney",
                        "handle": "gmoney",
                        "displayName": "@gmoney",
                        "wallet": "rGmoney",
                        "taskId": "task_gmoney_network",
                        "title": "Audit reward leakage",
                        "description": "Verify reward leakage, duplicate payment behavior, and task routing evidence.",
                        "taskKind": "network",
                        "rewardPft": 30000,
                        "rewardOfferPft": 30000,
                        "submissionRequirement": "Submit evidence and findings.",
                        "lastEventCid": "QmReward",
                        "lastEventTxHash": "TXREWARD",
                    },
                    {
                        "accountId": "acct_zoz",
                        "handle": "zoz",
                        "displayName": "@zoz",
                        "wallet": "rZoz",
                        "taskId": "task_zoz_network",
                        "title": "Write broad product ideas",
                        "description": "Brainstorm broad ideas.",
                        "taskKind": "network",
                        "rewardPft": 10000,
                        "rewardOfferPft": 10000,
                        "submissionRequirement": "Submit notes.",
                        "lastEventCid": "QmReward2",
                        "lastEventTxHash": "TXREWARD2",
                    },
                ],
            },
        }


def detail_payload(*, task_id="task_network", network=True):
    network_task = {
        "schema": "pf.hive.network_task_request.v1",
        "project_id": "task_node_core_product",
        "project_title": "Task Node Core Product",
        "allocation_id": "netalloc_test",
        "generation_job_id": "nettaskjob_test",
        "routing_reason": "Candidate has capacity.",
        "source_payload_digest": "abc123",
        "reward_band_pft": {"min": 100, "max": 200},
        "project_need_summary": "Need a source-backed memo.",
        "project_document": {"summary": "Build the product loop."},
    } if network else None
    return {
        "task": {
            "taskId": task_id,
            "kind": "Network" if network else "Personal",
            "status": "Proposed",
            "title": "Draft network memo" if network else "Draft personal note",
            "pft": 200 if network else 1,
            "description": "Projection objective",
            "steps": ["Projection step"],
            "submissionRequirement": {"type": "text", "criteria": "Projection criteria"},
            "verificationPolicy": {"mode": "standard_followup"},
            "contextCid": "QmContext",
            "requestBundleCid": "QmBundle",
            "txHash": "TXHASH",
        },
        "actions": {"canAccept": True, "canRefuse": True},
        "submission": {
            "generatedTask": {
                "title": "Generated title",
                "description": "Generated objective",
                "steps": ["Inspect sources", "Write memo"],
                "submission_requirement": {"type": "text", "criteria": "Submit the memo."},
                "verification_policy": {"verification_type": "text"},
                "reward_offer": {"amount_estimate_pft": "200"},
                "network_project_id": "task_node_core_product" if network else "",
                "network_allocation_id": "netalloc_test" if network else "",
                "network_task": network_task,
            }
        },
        "currentVerificationRequest": None,
        "rewardOutcome": None,
    }


class OrcToolingTests(unittest.TestCase):
    def test_build_client_uses_assigned_seed_and_verifies_exact_wallet(self):
        wallet = wallet_from_seed("agent", SMOKE_MNEMONIC)
        with tempfile.TemporaryDirectory() as tmpdir:
            session_file = os.path.join(tmpdir, "sessions.json")
            client = build_client(
                expected_wallet_address=wallet.address,
                seed=SMOKE_MNEMONIC,
                session_store_path=session_file,
                base_url="https://example.invalid",
            )

        self.assertEqual(client.address, wallet.address)

    def test_build_client_rejects_wrong_assigned_wallet(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            with self.assertRaisesRegex(ValueError, "loaded wallet address"):
                build_client(
                    expected_wallet_address="rWrong111111111111111111111111111111",
                    seed=SMOKE_MNEMONIC,
                    session_store_path=os.path.join(tmpdir, "sessions.json"),
                    base_url="https://example.invalid",
                )

    def test_request_personal_task_uses_one_client_and_returns_safe_summary(self):
        client = FakeOrcClient()

        summary = request_personal_task("verify zoz work", submit=True, client=client)

        self.assertEqual(summary["requestId"], "req_test")
        self.assertEqual(summary["txHash"], "ABC123")
        self.assertEqual(summary["engineResult"], "tesSUCCESS")
        self.assertEqual(summary["networkStatus"], "available_for_routing")
        self.assertEqual(summary["secretPrinted"], False)
        self.assertEqual(
            client.calls,
            [
                ("login",),
                (
                    "request_task",
                    {
                        "user_detail_text": "verify zoz work",
                        "requested_task_kind": "personal",
                        "conversation_id": "",
                        "submit": True,
                    },
                ),
                ("tasks",),
            ],
        )

    def test_summarize_signed_flow_marks_preview_as_not_submitted(self):
        flow = SimpleNamespace(
            config={"requestId": "req_preview", "bundleId": "bundle_preview"},
            payload={"request_bundle": {"cid": "bafkreibundle"}},
            prepared={"cid": "bafkreievent"},
            signed=SimpleNamespace(tx_hash="PREVIEW_HASH"),
            submitted=None,
        )

        summary = summarize_signed_flow(flow, address="rOperator", request_text="draft", requested_task_kind="personal")

        self.assertEqual(summary["requestId"], "req_preview")
        self.assertEqual(summary["submitted"], False)
        self.assertEqual(summary["txHash"], "PREVIEW_HASH")

    def test_extract_task_brief_includes_steps_and_submission_requirement(self):
        brief = extract_task_brief(
            {
                "taskId": "task_test",
                "kind": "Personal",
                "status": "Proposed",
                "title": "Verify work",
                "description": "Objective",
                "steps": ["Collect sources"],
                "submissionRequirement": {"type": "text", "criteria": "Submit the note."},
                "verificationPolicy": {"verification_type": "text"},
            }
        )

        self.assertEqual(brief["steps"], ["Collect sources"])
        self.assertEqual(brief["submissionRequirement"]["criteria"], "Submit the note.")
        self.assertEqual(brief["verificationPolicy"]["verification_type"], "text")

    def test_outstanding_task_briefs_reads_api_tasks_once(self):
        summary = outstanding_task_briefs(client=FakeTasksClient())

        self.assertEqual(summary["networkStatus"], "at_capacity")
        self.assertEqual(summary["gateCount"], 2)
        self.assertEqual(summary["tasks"][0]["taskId"], "task_test")
        self.assertEqual(summary["tasks"][0]["steps"], ["Step one", "Step two"])

    def test_orcctl_status_makes_network_capacity_rule_explicit(self):
        with patch("orc_tooling.orcctl.review_state_summary", return_value={"counts": {"not_reviewed": 12}}):
            summary = operator_status(client=FakeStatusClient())

        self.assertEqual(summary["networkStatus"], "at_capacity")
        self.assertEqual(summary["capacityNote"], NETWORK_CAPACITY_NOTE)
        self.assertEqual(summary["groups"]["outstanding"]["network"], 1)
        self.assertEqual(summary["groups"]["outstanding"]["personal"], 1)
        self.assertEqual(summary["groups"]["rewarded"]["personal"], 1)
        self.assertEqual(summary["reviewQueue"]["not_reviewed"], 12)
        self.assertEqual(summary["context"]["latestContextPointer"]["cid"], "QmContext")
        self.assertEqual(summary["secretPrinted"], False)

    def test_extract_task_payload_includes_generated_and_network_context(self):
        payload = extract_task_payload(detail_payload())

        self.assertEqual(payload["executionBrief"]["objective"], "Generated objective")
        self.assertEqual(payload["executionBrief"]["steps"], ["Inspect sources", "Write memo"])
        self.assertEqual(payload["networkTaskPayload"]["project_id"], "task_node_core_product")
        self.assertEqual(payload["networkContext"]["allocationId"], "netalloc_test")
        self.assertEqual(payload["networkContext"]["sourcePayloadDigest"], "abc123")
        self.assertEqual(payload["sourcePointers"]["requestBundleCid"], "QmBundle")
        self.assertEqual(payload["secretPrinted"], False)

    def test_visible_task_payloads_can_filter_network_tasks(self):
        client = FakePayloadClient()

        summary = visible_task_payloads(client=client, network_only=True)

        self.assertEqual(summary["count"], 1)
        self.assertEqual(summary["taskIds"], ["task_network"])
        self.assertEqual(summary["payloads"][0]["networkTaskPayload"]["allocation_id"], "netalloc_test")
        self.assertEqual(client.detail_calls, ["task_network"])

    def test_priority_prompt_defines_json_scoring_contract(self):
        prompt = priority_prompt()

        self.assertIn("Task Node Network Task packet", prompt)
        self.assertIn("another contributor's rewarded Network task submission", prompt)
        self.assertIn("priorityScore", prompt)
        self.assertIn("rankBucket", prompt)
        self.assertIn("reward alone", prompt)

    def test_task_reward_packet_and_heuristic_prioritize_integrity_work(self):
        detail = detail_payload(task_id="task_blocklist", network=True)
        detail["submission"]["generatedTask"]["title"] = "Build Blocklist Regression Test Suite Script"
        detail["submission"]["generatedTask"]["description"] = (
            "Build a sybil blocklist propagation regression script that prevents reward leakage."
        )
        detail["submission"]["generatedTask"]["reward_offer"] = {"amount_estimate_pft": 30000}
        detail["task"]["pft"] = 30000

        packet = build_task_reward_packet(extract_task_payload(detail))
        score = heuristic_priority_score(packet)

        self.assertEqual(packet["promptVersion"], PRIORITY_PROMPT_VERSION)
        self.assertEqual(packet["taskId"], "task_blocklist")
        self.assertGreaterEqual(score["priorityScore"], 70)
        self.assertIn(score["rankBucket"], {"do_first", "do_next"})
        self.assertEqual(score["secretPrinted"], False)

    def test_review_queue_reward_packet_marks_everyone_source_mode(self):
        packet = build_review_queue_reward_packet(
            {
                "taskId": "task_source",
                "title": "Submitted useful feedback",
                "accountId": "acct_user",
                "walletAddress": "rUser",
                "status": "rewarded",
                "rewardActualPft": "10500",
                "executionPayload": {
                    "description": "Find task acceptance workflow problems.",
                    "steps": ["Use the product", "Submit friction points"],
                    "submissionRequirement": {"type": "text", "criteria": "Submit evidence."},
                    "verificationPolicy": {"mode": "standard_followup"},
                    "networkTask": {"project_id": "task_node_core_product"},
                },
                "networkAllocation": {"projectId": "task_node_core_product", "allocationId": "netalloc_test"},
                "submissions": [{"artifacts": [{"value": "The accept button lacks clear verification-step affordance."}]}],
                "verificationResponses": [{"artifacts": [{"value": "Confirmed with source packet screenshots."}]}],
                "rewardEvents": [{"score": {"decision": "reward", "reason": "Useful workflow feedback."}}],
                "sourcePointers": {"lastEventCid": "QmLast", "lastEventTxHash": "TXLAST"},
            },
            review_state={"review_disposition": "not_reviewed", "task_updated_at": "2026-06-18T00:00:00Z"},
        )

        self.assertEqual(packet["sourceMode"], "review_queue")
        self.assertEqual(packet["reviewQueue"]["disposition"], "not_reviewed")
        self.assertIn("accept button", packet["sourceEvidence"]["submissionSummary"])
        score = heuristic_priority_score(packet)
        self.assertIn("shared Orc review queue", score["reasons"][0])

    def test_review_queue_reward_packet_prioritizes_executable_reward_clawback_control(self):
        packet = build_review_queue_reward_packet(
            {
                "taskId": "task_reward_script",
                "title": "Create reward clawback runner",
                "accountId": "acct_user",
                "walletAddress": "rUser",
                "status": "rewarded",
                "rewardActualPft": "30000",
                "executionPayload": {
                    "description": "Build reward-accounting reconciliation tooling.",
                    "steps": ["Inspect reward rows", "Prepare script"],
                    "submissionRequirement": {"type": "text", "criteria": "Submit script and evidence."},
                    "verificationPolicy": {"mode": "standard_followup"},
                    "networkTask": {"project_id": "task_node_core_product"},
                },
                "submissions": [{
                    "artifacts": [{
                        "value": (
                            "Executable artifact: gist.github.com/example/reward-clawback.mjs. "
                            "Run node scripts/reward-clawback.mjs --execute to update reward rows."
                        ),
                    }],
                }],
                "rewardEvents": [{"score": {"decision": "reward", "reason": "Useful reward accounting artifact."}}],
                "sourcePointers": {"lastEventCid": "QmLast", "lastEventTxHash": "TXLAST"},
            },
            review_state={"categories": ["reward_accounting"], "review_disposition": "not_reviewed"},
        )
        score = heuristic_priority_score(packet)

        self.assertIn(EXECUTABLE_REWARD_CLAWBACK_SIGNAL, packet["reviewQueue"]["integritySignals"])
        self.assertEqual(packet["integrityPolicy"]["controlMarker"], NO_SIGNING_NO_FUND_MOVEMENT_MARKER)
        self.assertIn("requires_independent_orc_review_no_signing_no_fund_movement", score["redFlags"])
        self.assertIn("no signing or fund movement", " ".join(score["reasons"]))

    def test_directory_rewarded_task_packet_marks_leaderboard_source(self):
        packet = build_directory_rewarded_task_packet({
            "accountId": "acct_gmoney",
            "handle": "gmoney",
            "wallet": "rGmoney",
            "taskId": "task_gmoney_network",
            "title": "Audit reward leakage",
            "description": "Verify reward leakage and routing evidence.",
            "taskKind": "network",
            "rewardPft": 30000,
            "submissionRequirement": "Submit evidence.",
            "lastEventCid": "QmReward",
            "lastEventTxHash": "TXREWARD",
        })

        self.assertEqual(packet["sourceMode"], "directory_rewarded_tasks")
        self.assertEqual(packet["sourceContributor"]["handle"], "gmoney")
        self.assertEqual(packet["sourceContributor"]["walletAddress"], "rGmoney")
        self.assertEqual(packet["rewardPft"], 30000)

    def test_prioritize_review_queue_scores_shared_unreviewed_rows_without_provider(self):
        queue_row = {
            "task_id": "task_source",
            "title": "Reward leakage report",
            "account_id": "acct_user",
            "last_event_cid": "QmLast",
            "review_disposition": "not_reviewed",
        }
        review_task = {
            "taskId": "task_source",
            "title": "Reward leakage report",
            "accountId": "acct_user",
            "walletAddress": "rUser",
            "status": "rewarded",
            "rewardActualPft": "30000",
            "executionPayload": {
                "description": "Verify duplicate reward leakage and sybil indicators.",
                "steps": ["Inspect rewards", "Submit evidence"],
                "submissionRequirement": {"type": "text", "criteria": "Submit evidence."},
                "verificationPolicy": {"mode": "standard_followup"},
                "networkTask": {"project_id": "task_node_core_product"},
            },
            "submissions": [{"artifacts": [{"value": "Duplicate reward leakage and sybil blocklist issue."}]}],
            "rewardEvents": [{"score": {"decision": "reward", "reason": "Important reward integrity finding."}}],
            "sourcePointers": {"lastEventCid": "QmLast", "lastEventTxHash": "TXLAST"},
        }
        with patch("orc_tooling.priority.review_queue", return_value={"rows": [queue_row]}), \
            patch("orc_tooling.priority.build_rewarded_network_task_review_packet", return_value={"tasks": [review_task]}):
            summary = prioritize_review_queue(use_openrouter=False, candidate_limit=10)

        self.assertEqual(summary["source"], "review_queue")
        self.assertEqual(summary["count"], 1)
        self.assertEqual(summary["priorities"][0]["sourceMode"], "review_queue")
        self.assertEqual(summary["priorities"][0]["taskId"], "task_source")
        self.assertEqual(summary["priorities"][0]["walletAddress"], "rUser")
        self.assertIn("Verify duplicate reward leakage", summary["priorities"][0]["taskProposalDescription"])
        self.assertEqual(summary["priorities"][0]["rewardPft"], "30000")
        self.assertEqual(summary["priorities"][0]["rank"], 1)

    def test_prioritize_review_queue_scores_public_ingested_row_without_local_projection(self):
        queue_row = {
            "task_id": "task_public_only",
            "source_mode": "network_status_packet",
            "title": "Link-failed routing repair",
            "account_id": "acct_public",
            "wallet_address": "rPublic",
            "operator_handle": "publicorc",
            "description": "Derived status packet reports a link-failed generated task.",
            "reward_actual_pft": "0",
            "request_bundle_cid": "bafyRequest",
            "last_event_cid": "bafyReward",
            "last_event_tx_hash": "TXREWARD",
            "event_count": 4,
            "public_hive_task_detail_url": "/api/hive/task-detail?taskId=task_public_only",
            "review_disposition": "not_reviewed",
            "task_updated_at": "2026-06-19T01:00:00Z",
            "status_packet_json": {
                "schema": "pf.task_node.network_task_status_packet.v1",
                "allocationState": "link_failed",
                "taskState": "proposed",
                "rewardMovement": "none",
                "repairRequired": True,
                "repairReason": "link_failed",
            },
        }
        with patch("orc_tooling.priority.review_queue", return_value={"rows": [queue_row]}), \
            patch("orc_tooling.priority.build_rewarded_network_task_review_packet", return_value={"tasks": []}):
            summary = prioritize_review_queue(use_openrouter=False, candidate_limit=10)

        self.assertEqual(summary["count"], 1)
        self.assertEqual(summary["priorities"][0]["taskId"], "task_public_only")
        self.assertEqual(summary["priorities"][0]["sourceMode"], "review_queue")
        self.assertEqual(summary["priorities"][0]["walletAddress"], "rPublic")
        self.assertIn("link-failed generated task", summary["priorities"][0]["taskProposalDescription"])
        self.assertEqual(summary["packetErrorCount"], 0)

    def test_priority_fixture_filter_matches_review_fixture_rows(self):
        self.assertTrue(is_probable_fixture_priority_row({
            "task_id": "task_cancel_paid_123",
            "title": "Cancel smoke task_cancel_paid_123",
            "account_id": "acct_aid_123",
        }))
        self.assertFalse(is_probable_fixture_priority_row({
            "task_id": "task_real",
            "title": "Reward leakage report",
            "account_id": "acct_real",
            "last_event_cid": "QmReal",
        }))

    def test_prioritize_directory_rewarded_tasks_scores_leaderboard_rows(self):
        client = FakeDirectoryClient()

        summary = prioritize_directory_rewarded_tasks(client=client, use_openrouter=False, candidate_limit=20)

        self.assertEqual(summary["source"], "directory_rewarded_tasks")
        self.assertEqual(summary["directoryTotals"]["pftDistributed"], 40000)
        self.assertEqual(summary["count"], 2)
        self.assertEqual(summary["priorities"][0]["walletAddress"], "rGmoney")
        self.assertEqual(summary["priorities"][0]["taskId"], "task_gmoney_network")
        self.assertIn("Verify reward leakage", summary["priorities"][0]["taskProposalDescription"])
        self.assertEqual(client.last_request[1], "/api/directory/rewarded-tasks")

    def test_prioritize_network_work_defaults_to_review_queue_source(self):
        with patch("orc_tooling.priority.prioritize_review_queue", return_value={"ok": True, "source": "review_queue"}):
            summary = prioritize_network_work(use_openrouter=False)

        self.assertEqual(summary["source"], "review_queue")

    def test_prioritize_network_tasks_can_run_heuristic_only(self):
        client = FakePayloadClient()

        summary = prioritize_network_tasks(client=client, use_openrouter=False)

        self.assertEqual(summary["ok"], True)
        self.assertEqual(summary["openrouterAttempted"], False)
        self.assertEqual(summary["count"], 1)
        self.assertEqual(summary["priorities"][0]["taskId"], "task_network")
        self.assertEqual(summary["priorities"][0]["rank"], 1)
        self.assertEqual(summary["priorities"][0]["scoredBy"], "heuristic")
        self.assertEqual(summary["priorities"][0]["triage"]["capability"], NETWORK_TRIAGE_CAPABILITY_VERSION)
        self.assertEqual(summary["priorities"][0]["triage"]["decision"], "work_assigned_network_task")
        self.assertIn("uv run orcctl task detail task_network", summary["priorities"][0]["nextCommand"])
        self.assertEqual(summary["secretPrinted"], False)

    def test_network_triage_decision_is_the_shared_review_contract(self):
        triage = network_triage_decision({
            "taskId": "task_source",
            "sourceMode": "review_queue",
            "rankBucket": "do_first",
            "reviewDisposition": "not_reviewed",
            "priorityScore": 88,
            "rank": 1,
        })

        self.assertEqual(triage["capability"], NETWORK_TRIAGE_CAPABILITY_VERSION)
        self.assertEqual(triage["decision"], "review_rewarded_network_task")
        self.assertEqual(triage["nextCommand"], "uv run orcctl review next --task-id task_source")
        self.assertIn("uv run orcctl review classify task_source", triage["commands"][1])
        self.assertEqual(triage["requiresAction"], True)

    def test_triage_network_work_wraps_priorities_and_exposes_next_item(self):
        priority_payload = {
            "ok": True,
            "source": "review_queue",
            "generatedAt": "2026-06-19T00:00:00Z",
            "model": "heuristic",
            "openrouterAttempted": False,
            "priorities": [
                {
                    "taskId": "task_first",
                    "title": "First",
                    "sourceMode": "review_queue",
                    "rank": 1,
                    "rankBucket": "do_first",
                    "priorityScore": 90,
                    "reviewDisposition": "not_reviewed",
                    "rewardPft": "30000",
                }
            ],
        }
        with patch("orc_tooling.priority.prioritize_network_work", return_value=priority_payload):
            summary = triage_network_work(source="review_queue", use_openrouter=False)

        self.assertEqual(summary["capability"], NETWORK_TRIAGE_CAPABILITY_VERSION)
        self.assertEqual(summary["nextItem"]["taskId"], "task_first")
        self.assertEqual(summary["nextItem"]["triage"]["nextCommand"], "uv run orcctl review next --task-id task_first")
        self.assertEqual(summary["priorities"][0]["triage"]["decision"], "review_rewarded_network_task")

    def test_next_network_triage_item_returns_the_ranked_shared_item(self):
        with patch("orc_tooling.priority.triage_network_work", return_value={
            "nextItem": {
                "taskId": "task_ranked",
                "triage": {"capability": NETWORK_TRIAGE_CAPABILITY_VERSION},
            }
        }):
            item = next_network_triage_item(source="review_queue")

        self.assertEqual(item["taskId"], "task_ranked")

    def test_priority_sanity_check_flags_large_model_delta(self):
        warnings = sanity_check_priority(
            {"taskId": "task_network", "priorityScore": 10, "rankBucket": "defer", "reasons": [], "firstWorkSlice": ""},
            {"taskId": "task_network", "priorityScore": 90},
            {"taskId": "task_network"},
        )

        self.assertIn("model_heuristic_priority_delta_80.0", warnings)
        self.assertIn("model_returned_no_reasons", warnings)
        self.assertIn("model_returned_no_first_work_slice", warnings)

    def test_extract_evidence_artifacts_reads_text_and_file_items(self):
        payload = {
            "schema": "pf.task.submission.v1",
            "evidence": {
                "notes": "top-level note",
                "evidence_items": [
                    {"artifact_type": "text", "value": "submitted memo", "notes": "memo note"},
                    {"artifact_type": "file", "file": {"name": "proof.png", "size": 123, "text": "OCR text"}},
                ],
            },
        }

        artifacts = extract_evidence_artifacts(payload)

        self.assertEqual(artifacts[0]["value"], "submitted memo")
        self.assertEqual(artifacts[0]["notes"], "memo note")
        self.assertEqual(artifacts[1]["file"]["name"], "proof.png")
        self.assertEqual(artifacts[1]["value"], "OCR text")

    def test_compact_review_task_omits_raw_events_by_default(self):
        compact = compact_review_task(
            {
                "taskId": "task_review",
                "title": "Review source task",
                "accountId": "acct_user",
                "walletAddress": "rUser",
                "status": "rewarded",
                "rewardActualPft": "100",
                "executionPayload": {
                    "description": "Check the product state.",
                    "steps": ["Read source", "Submit evidence"],
                    "submissionRequirement": {"type": "text", "criteria": "Proof"},
                },
                "networkAllocation": {"projectId": "task_node_core_product", "allocationId": "netalloc_test"},
                "submissions": [{"artifacts": [{"value": "Long useful feedback."}]}],
                "verificationResponses": [{"artifacts": [{"value": "Follow-up answer."}]}],
                "rewardEvents": [{"score": {"reason": "Good evidence."}}],
                "sourcePointers": {
                    "requestBundleCid": "QmBundle",
                    "contextCid": "QmContext",
                    "lastEventCid": "QmLast",
                    "lastEventTxHash": "TXLAST",
                },
                "rawEvents": [{"payload": {"large": True}}],
            }
        )

        self.assertEqual(compact["taskId"], "task_review")
        self.assertEqual(compact["evidenceSummary"], "Long useful feedback.")
        self.assertEqual(compact["sourceCids"], ["QmBundle", "QmContext", "QmLast"])
        self.assertNotIn("rawReviewTask", compact)

    def test_orcctl_review_filter_identifies_local_fixture_rows(self):
        self.assertTrue(is_probable_fixture_review_row({
            "task_id": "task_cancel_paid_123",
            "title": "Cancel smoke task_cancel_paid_123",
            "account_id": "acct_aid_123",
        }))
        self.assertTrue(is_probable_fixture_review_row({
            "task_id": "directory_polish_boscovich_network_001",
            "title": "Boscovich network task 1",
            "account_id": "acct_dirqa_boscovich",
        }))
        self.assertFalse(is_probable_fixture_review_row({
            "task_id": "task_real",
            "title": "Build useful thing",
            "account_id": "acct_real",
            "last_event_cid": "QmReal",
        }))

    def test_followup_action_gate_rejects_passive_memo_requests(self):
        with self.assertRaises(ValueError):
            validate_followup_action(
                "reviewed_follow_up",
                "Write a memo about this issue for later.",
            )

        validate_followup_action(
            "reviewed_follow_up",
            "Verify the affected reward rows, implement any missing idempotency check, and add a regression smoke test.",
        )

    def test_build_followup_request_text_carries_source_and_concrete_action(self):
        text = build_followup_request_text(
            {
                "task_id": "task_source",
                "summary": "Contributor found reward projection drift.",
                "categories": ["reward_accounting", "data_quality"],
                "recommended_action": (
                    "Verify the affected reward rows, reconcile any inconsistent totals, and add a regression smoke test."
                ),
            },
            extra="Use current task_events and task_projections rows.",
        )

        self.assertIn("task_source", text)
        self.assertIn("reward projection drift", text)
        self.assertIn("reconcile", text)
        self.assertIn("Do not produce a passive memo", text)

    def test_request_followup_records_review_state_linkage(self):
        existing = {
            "task_id": "task_source",
            "disposition": "reviewed_follow_up",
            "action_required": True,
            "confidence": "high",
            "categories": ["reward_accounting"],
            "summary": "Contributor found reward projection drift.",
            "recommended_action": "Verify the affected reward rows and add a regression smoke test.",
            "reviewer_handle": "grashnuk",
            "reviewer_wallet": "rReviewer",
            "source_task_ids": ["task_source"],
            "metadata_json": {"user_signal_status": "sent"},
        }
        captured = []

        def fake_upsert(record, **kwargs):
            captured.append(record)
            return {"ok": True, "task_id": record["taskId"], "metadata_json": record["metadata"]}

        with patch("orc_tooling.orcctl.get_review_state", return_value=existing), \
            patch("orc_tooling.orcctl.request_personal_task", return_value={
                "ok": True,
                "requestId": "req_followup",
                "submitted": True,
                "generatedTaskId": "task_followup",
                "requestStatus": "generated",
                "bundleCid": "QmBundle",
                "eventCid": "QmRequestEvent",
                "txHash": "TXREQUEST",
            }), \
            patch("orc_tooling.orcctl.upsert_review_state", side_effect=fake_upsert):
            result = request_followup_task("task_source", submit=True)

        metadata = captured[0]["metadata"]
        self.assertEqual(result["reviewState"]["followupRequestId"], "req_followup")
        self.assertEqual(result["reviewState"]["followupTaskId"], "task_followup")
        self.assertEqual(metadata["followup_request_id"], "req_followup")
        self.assertEqual(metadata["followup_task_id"], "task_followup")
        self.assertEqual(metadata["followup_request_tx"], "TXREQUEST")
        self.assertEqual(metadata["user_signal_status"], "sent")
        self.assertIn("task_followup", captured[0]["sourceTaskIds"])

    def test_status_surfaces_terminal_followup_as_stale_closeable(self):
        stale = {
            "ok": True,
            "rows": [{
                "sourceTaskId": "task_source",
                "followupTaskId": "task_followup",
                "followupRequestId": "req_followup",
                "followupStatus": "rewarded",
                "followupRewardTx": "TXREWARD",
                "followupRewardCid": "QmReward",
                "closeCommand": "uv run orcctl close-followup task_source --followup-task-id task_followup",
            }],
        }

        with patch("orc_tooling.orcctl.review_state_summary", return_value={"counts": {"reviewed_follow_up": 1}}), \
            patch("orc_tooling.orcctl.stale_followup_closures", return_value=stale):
            summary = operator_status(client=FakeStatusClient())

        self.assertEqual(summary["staleFollowups"]["count"], 1)
        self.assertEqual(summary["staleFollowups"]["closeable"][0]["sourceTaskId"], "task_source")
        self.assertIn("close-followup task_source", summary["staleFollowups"]["closeable"][0]["closeCommand"])
        self.assertEqual(summary["staleFollowups"]["closedCount"], 0)

    def test_close_followup_refuses_nonterminal_task(self):
        self.assertIn("rewarded", FOLLOWUP_CLOSEABLE_TASK_STATUSES)
        self.assertNotIn("accepted", FOLLOWUP_CLOSEABLE_TASK_STATUSES)

        with self.assertRaisesRegex(ValueError, "not terminal"):
            close_followup(
                "task_source",
                followup_task_id="task_followup",
                client=FakeCloseClient(status="Accepted"),
            )

    def test_close_followup_records_terminal_evidence_metadata(self):
        existing = {
            "task_id": "task_source",
            "disposition": "reviewed_follow_up",
            "action_required": True,
            "confidence": "medium",
            "categories": ["reward_accounting"],
            "summary": "Follow-up requested.",
            "recommended_action": "Verify reward rows and add a smoke.",
            "source_task_ids": ["task_source"],
            "metadata_json": {"followup_request_id": "req_followup"},
        }
        captured = []
        ledger_rows = []

        def fake_upsert(record, **kwargs):
            captured.append(record)
            return {"ok": True, "task_id": record["taskId"], "metadata_json": record["metadata"]}

        def fake_ledger(record, **kwargs):
            ledger_rows.append(record)
            return {"ok": True, "inserted": True, "source_task_id": record["sourceTaskId"]}

        with patch("orc_tooling.orcctl.get_review_state", return_value=existing), \
            patch("orc_tooling.orcctl.upsert_review_state", side_effect=fake_upsert), \
            patch("orc_tooling.orcctl.append_orc_work_journal", side_effect=fake_ledger):
            result = close_followup(
                "task_source",
                followup_task_id="task_followup",
                signal_message_id="msg_signal",
                client=FakeCloseClient(status="Rewarded"),
            )

        self.assertEqual(result["ok"], True)
        record = captured[0]
        metadata = record["metadata"]
        self.assertEqual(record["disposition"], "reviewed_follow_up_completed")
        self.assertEqual(record["actionRequired"], False)
        self.assertEqual(metadata["followup_task_id"], "task_followup")
        self.assertEqual(metadata["followup_status"], "rewarded")
        self.assertEqual(metadata["followup_reward_tx"], "TXREWARD")
        self.assertEqual(metadata["followup_reward_cid"], "QmReward")
        self.assertEqual(metadata["user_signal_status"], "sent")
        self.assertIn("task_followup", record["sourceTaskIds"])
        self.assertEqual(result["workJournal"]["inserted"], True)
        self.assertEqual(ledger_rows[0]["taskAction"], "close_followup")
        self.assertEqual(ledger_rows[0]["sourceTaskId"], "task_source")
        self.assertEqual(ledger_rows[0]["followupRequestId"], "req_followup")
        self.assertEqual(ledger_rows[0]["followupTaskId"], "task_followup")
        self.assertEqual(ledger_rows[0]["eventCid"], "QmReward")
        self.assertEqual(ledger_rows[0]["txHash"], "TXREWARD")
        self.assertEqual(ledger_rows[0]["outcomeStatus"], "rewarded")
        self.assertTrue(ledger_rows[0]["terminal"])

    def test_stale_followup_query_filters_to_closeable_terminal_statuses(self):
        calls = []

        def fake_run_json(_database_url, sql):
            calls.append(sql)
            return {"ok": True, "count": 0, "rows": [], "secretPrinted": False}

        with patch("orc_tooling.review_state.ensure_review_state_schema", return_value={"ok": True}), \
            patch("orc_tooling.review_state.tasknode_database_url", return_value="postgres://unit"), \
            patch("orc_tooling.review_state._run_json", side_effect=fake_run_json):
            result = stale_followup_closures(database_url="postgres://unit")

        self.assertEqual(result["count"], 0)
        self.assertIn("followup_request_id", calls[0])
        self.assertIn("task_projections", calls[0])
        self.assertIn("'rewarded'", calls[0])
        self.assertIn("'refused'", calls[0])
        self.assertNotIn("'accepted'", calls[0])

    def test_append_run_journal_writes_redacted_jsonl(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = os.path.join(tmpdir, "journal.jsonl")
            row = append_run_journal(
                command="task.submit",
                phase="submit",
                status="completed",
                run_id="orcrun_test",
                task_id="task_test",
                cid="QmCid",
                tx_hash="TXHASH",
                metadata={"privateKey": "should-redact", "safe": "ok"},
                journal_path=path,
            )
            with open(path, "r", encoding="utf-8") as handle:
                stored = json.loads(handle.read())

        self.assertEqual(row["secretPrinted"], False)
        self.assertEqual(stored["metadata"]["privateKey"], "[REDACTED]")
        self.assertEqual(stored["metadata"]["safe"], "ok")
        self.assertEqual(stored["txHash"], "TXHASH")

    def test_review_state_record_normalizes_and_defaults_action_required(self):
        record = normalize_review_state_record(
            task_id="task_review",
            disposition="reviewed_follow_up",
            categories=["Onboarding", "task_routing,onboarding"],
            summary="Useful onboarding signal.",
            recommended_action="Route to the onboarding backlog.",
            reviewer_handle="@orc-alpha",
        )

        self.assertEqual(record["taskId"], "task_review")
        self.assertEqual(record["disposition"], "reviewed_follow_up")
        self.assertEqual(record["categories"], ["onboarding", "task_routing"])
        self.assertEqual(record["sourceTaskIds"], ["task_review"])
        self.assertEqual(record["actionRequired"], True)
        self.assertEqual(record["secretPrinted"], False)

    def test_review_state_validation_rejects_integrity_without_signal(self):
        with self.assertRaises(ValueError):
            normalize_review_state_record(
                task_id="task_review",
                disposition="reviewed_integrity_follow_up",
                summary="Bad evidence.",
            )

    def test_executable_reward_clawback_artifact_gets_integrity_control(self):
        review_item = {
            "taskId": "task_reward_script",
            "title": "Build reward clawback execution script",
            "executionPayload": {"description": "Create the reward-accounting repair artifact."},
            "submissions": [{
                "artifacts": [{
                    "url": "https://gist.github.com/example/reward-clawback",
                    "value": (
                        "Executable artifact: node scripts/reward-clawback.mjs --execute "
                        "will update reward_actual_pft rows and submit payment reconciliation."
                    ),
                }],
            }],
        }

        policy = apply_reward_clawback_integrity_policy(
            categories=["reward_accounting"],
            metadata={},
            review_item=review_item,
        )
        control = policy["metadata"]["integrityControl"]

        self.assertIn(EXECUTABLE_REWARD_CLAWBACK_SIGNAL, policy["integritySignals"])
        self.assertEqual(control["controlMarker"], NO_SIGNING_NO_FUND_MOVEMENT_MARKER)
        self.assertEqual(control["humanSignerAuthorization"], "none_recorded")
        self.assertEqual(control["independentOrcReviewRequired"], True)
        self.assertEqual(control["operationalUseAllowed"], False)
        self.assertEqual(control["contributorAccusation"], False)

    def test_plain_documentation_task_does_not_get_reward_clawback_control(self):
        policy = apply_reward_clawback_integrity_policy(
            categories=["docs"],
            metadata={},
            review_item={
                "taskId": "task_docs",
                "title": "Document reward workflow friction",
                "submissions": [{"artifacts": [{"value": "Plain text observations. No executable artifact."}]}],
            },
        )

        self.assertNotIn(EXECUTABLE_REWARD_CLAWBACK_SIGNAL, policy["integritySignals"])
        self.assertNotIn("integrityControl", policy["metadata"])

    def test_review_state_normalization_records_explicit_integrity_control(self):
        record = normalize_review_state_record(
            task_id="task_reward_script",
            disposition="reviewed_integrity_follow_up",
            categories=["reward_accounting"],
            integrity_signals=[EXECUTABLE_REWARD_CLAWBACK_SIGNAL],
            summary="Executable reward artifact needs independent review before use.",
        )

        control = record["metadata"]["integrityControl"]
        self.assertEqual(control["controlMarker"], NO_SIGNING_NO_FUND_MOVEMENT_MARKER)
        self.assertEqual(control["independentOrcReviewRequired"], True)

    def test_review_state_ontology_exposes_shared_table_and_dispositions(self):
        ontology = review_state_ontology()

        self.assertEqual(ontology["table"], "orc_task_review_states")
        self.assertEqual(ontology["historyTable"], "orc_task_reviews")
        self.assertEqual(ontology["itemsTable"], "orc_task_review_items")
        self.assertEqual(ontology["workJournalTable"], "orc_work_journal")
        self.assertEqual(ontology["rollupsView"], "orc_review_rollups")
        self.assertEqual(ontology["queueView"], "orc_task_review_queue")
        self.assertIn("reviewed_no_action", ontology["dispositions"])
        self.assertIn("reviewed_follow_up_completed", ontology["dispositions"])
        self.assertIn(EXECUTABLE_REWARD_CLAWBACK_SIGNAL, ontology["integritySignals"])
        self.assertTrue(review_disposition_requires_action("reviewed_follow_up"))
        self.assertFalse(review_disposition_requires_action("reviewed_follow_up_completed"))
        self.assertFalse(review_disposition_requires_action("reviewed_no_action"))

    def test_review_state_schema_creates_shared_history_table(self):
        calls = []

        def fake_run_json(_database_url, sql):
            calls.append(sql)
            return {"ok": True, "secretPrinted": False}

        with patch("orc_tooling.review_state.tasknode_database_url", return_value="postgres://unit"):
            with patch("orc_tooling.review_state._run_json", side_effect=fake_run_json):
                result = ensure_review_state_schema(database_url="postgres://unit")

        sql = calls[0]
        self.assertEqual(result["ok"], True)
        self.assertIn("CREATE TABLE IF NOT EXISTS orc_task_review_states", sql)
        self.assertIn("CREATE TABLE IF NOT EXISTS orc_task_reviews", sql)
        self.assertIn("CREATE TABLE IF NOT EXISTS orc_task_review_items", sql)
        self.assertIn("DROP VIEW IF EXISTS orc_task_review_queue", sql)
        self.assertIn("CREATE VIEW orc_task_review_queue", sql)
        self.assertIn("FROM orc_task_review_items item", sql)
        self.assertIn("network_status_packet", sql)
        self.assertIn("status_packet_json", sql)
        self.assertIn("closed_zero", sql)
        self.assertIn("CREATE TABLE IF NOT EXISTS orc_work_journal", sql)
        self.assertIn("orc_work_journal_idempotency_idx", sql)
        self.assertIn("CREATE VIEW orc_review_rollups", sql)
        self.assertIn("last_reviewed_action", sql)
        self.assertIn("CREATE TABLE IF NOT EXISTS orc_runtime_directives", sql)
        self.assertIn("'historyTable', 'orc_task_reviews'", sql)
        self.assertIn("'itemsTable', 'orc_task_review_items'", sql)
        self.assertIn("'workJournalTable', 'orc_work_journal'", sql)
        self.assertIn("'rollupsView', 'orc_review_rollups'", sql)
        self.assertIn("'runtimeDirectivesTable', 'orc_runtime_directives'", sql)
        self.assertIn("orc_runtime_directives_claimed_worker_unique", orc_runtime_directives_schema_sql())

    def test_upsert_review_state_appends_history_row(self):
        record = normalize_review_state_record(
            task_id="task_review",
            disposition="reviewed_no_action",
            summary="Reviewed and no action remains.",
            recommended_action="No current action remains.",
            reviewer_handle="orc-alpha",
            reviewer_wallet="rReviewer",
        )
        calls = []

        def fake_run_json(_database_url, sql):
            calls.append(sql)
            return {
                "task_id": "task_review",
                "disposition": "reviewed_no_action",
                "review_id": "orcrev_unit",
                "secretPrinted": False,
            }

        with patch("orc_tooling.review_state.ensure_review_state_schema", return_value={"ok": True}):
            with patch("orc_tooling.review_state.tasknode_database_url", return_value="postgres://unit"):
                with patch("orc_tooling.review_state._run_json", side_effect=fake_run_json):
                    result = upsert_review_state(record, database_url="postgres://unit")

        sql = calls[0]
        self.assertEqual(result["review_id"], "orcrev_unit")
        self.assertIn("INSERT INTO orc_task_review_states", sql)
        self.assertIn("INSERT INTO orc_task_reviews", sql)
        self.assertIn("),\nreview_insert AS (", sql)
        self.assertIn(")\nSELECT to_jsonb(upsert)", sql)
        self.assertIn("'review_id'", sql)

    def test_orc_work_journal_is_append_only_with_event_idempotency(self):
        dispatch = normalize_orc_work_journal_record(
            interaction_id="orcint_unit",
            source_task_id="task_source",
            review_disposition="not_reviewed",
            task_action="dispatch",
            operator_handle="orc-alpha",
            status="submitted",
        )
        closed = normalize_orc_work_journal_record(
            interaction_id="orcint_unit",
            source_task_id="task_source",
            review_disposition="reviewed_follow_up_completed",
            followup_task_id="task_followup",
            task_action="close_followup",
            event_cid="QmReward",
            tx_hash="TXREWARD",
            operator_handle="orc-alpha",
            status="closed",
            outcome_status="rewarded",
            terminal=True,
        )

        self.assertNotEqual(dispatch["idempotencyKey"], closed["idempotencyKey"])
        dispatch_sql = orc_work_journal_insert_sql(dispatch)
        closed_sql = orc_work_journal_insert_sql(closed)
        self.assertIn("INSERT INTO orc_work_journal", dispatch_sql)
        self.assertIn("ON CONFLICT DO NOTHING", dispatch_sql)
        self.assertIn("ON CONFLICT DO NOTHING", closed_sql)
        self.assertNotIn("UPDATE ORC_WORK_JOURNAL", dispatch_sql.upper())
        self.assertNotIn("UPDATE ORC_WORK_JOURNAL", closed_sql.upper())

    def test_append_orc_work_journal_inserts_normalized_row(self):
        calls = []

        def fake_run_json(_database_url, sql):
            calls.append(sql)
            if "INSERT INTO orc_work_journal" in sql:
                return {"ok": True, "inserted": True, "source_task_id": "task_source", "secretPrinted": False}
            return {"ok": True, "secretPrinted": False}

        with patch("orc_tooling.review_state.ensure_orc_work_journal_schema", return_value={"ok": True}), \
            patch("orc_tooling.review_state.tasknode_database_url", return_value="postgres://unit"), \
            patch("orc_tooling.review_state._run_json", side_effect=fake_run_json):
            result = append_orc_work_journal({
                "interactionId": "orcint_unit",
                "sourceTaskId": "task_source",
                "taskAction": "dispatch",
                "operatorHandle": "orc-alpha",
            })

        self.assertEqual(result["inserted"], True)
        self.assertIn("INSERT INTO orc_work_journal", calls[0])

    def test_review_state_summary_reports_integrity_controls_for_sauron(self):
        calls = []

        def fake_run_json(_database_url, sql):
            calls.append(sql)
            return {
                "ok": True,
                "counts": {"not_reviewed": 1},
                "integrityControls": {
                    "executable_reward_clawback_artifact": 1,
                    "no_signing_no_fund_movement": 1,
                    "independentOrcReviewRequired": 1,
                },
                "secretPrinted": False,
            }

        with patch("orc_tooling.review_state.ensure_review_state_schema", return_value={"ok": True}):
            with patch("orc_tooling.review_state.tasknode_database_url", return_value="postgres://unit"):
                with patch("orc_tooling.review_state._run_json", side_effect=fake_run_json):
                    result = review_state_summary(database_url="postgres://unit")

        self.assertEqual(result["integrityControls"]["no_signing_no_fund_movement"], 1)
        self.assertIn(EXECUTABLE_REWARD_CLAWBACK_SIGNAL, calls[0])
        self.assertIn("integrityControls", calls[0])

    def test_completed_follow_up_is_terminal_without_action_required(self):
        record = normalize_review_state_record(
            task_id="task_review",
            disposition="reviewed_follow_up_completed",
            categories=["reward_accounting"],
            summary="Follow-up report and user notification completed.",
            recommended_action="No current action remains.",
        )

        self.assertEqual(record["disposition"], "reviewed_follow_up_completed")
        self.assertEqual(record["actionRequired"], False)

    def test_review_next_uses_shared_triage_selection_not_first_queue_row(self):
        review_task = {
            "taskId": "task_ranked",
            "title": "Ranked source task",
            "accountId": "acct_user",
            "walletAddress": "rUser",
            "status": "rewarded",
            "rewardActualPft": "30000",
            "executionPayload": {
                "description": "Verify a reward-integrity finding.",
                "steps": ["Inspect evidence"],
                "submissionRequirement": {"type": "text", "criteria": "Proof"},
            },
            "submissions": [{"artifacts": [{"value": "Reward leakage evidence."}]}],
            "sourcePointers": {"lastEventCid": "QmLast", "lastEventTxHash": "TXLAST"},
        }
        with patch("orc_tooling.orcctl.next_network_triage_item", return_value={
            "task_id": "task_ranked",
            "review_disposition": "not_reviewed",
            "triage": {
                "capability": NETWORK_TRIAGE_CAPABILITY_VERSION,
                "nextCommand": "uv run orcctl review next --task-id task_ranked",
            },
        }), patch("orc_tooling.orcctl.build_rewarded_network_task_review_packet", return_value={"tasks": [review_task]}), \
            patch("orc_tooling.orcctl.get_review_state", return_value={"disposition": "not_reviewed"}), \
            patch("orc_tooling.orcctl.review_queue_item", return_value={}):
            result = review_next()

        self.assertEqual(result["task"]["taskId"], "task_ranked")
        self.assertEqual(result["task"]["triage"]["capability"], NETWORK_TRIAGE_CAPABILITY_VERSION)

    def test_review_next_renders_public_ingested_row_without_local_projection(self):
        queue_row = {
            "task_id": "task_public_only",
            "source_mode": "directory_public",
            "title": "Public rewarded routing report",
            "account_id": "acct_public",
            "wallet_address": "rPublic",
            "description": "Public Directory packet describes reward routing leakage.",
            "reward_actual_pft": "25000",
            "reward_offer_pft": "0",
            "task_status": "rewarded",
            "request_bundle_cid": "bafyRequest",
            "last_event_cid": "bafyReward",
            "last_event_tx_hash": "TXREWARD",
            "public_hive_task_detail_url": "/api/hive/task-detail?taskId=task_public_only",
            "review_disposition": "not_reviewed",
            "item_metadata_json": {
                "project": {"id": "task_node_core_product"},
                "statusPacket": {
                    "schema": "pf.task_node.network_task_status_packet.v1",
                    "allocationState": "published",
                    "taskState": "rewarded",
                    "rewardMovement": "paid_positive",
                    "repairRequired": False,
                    "repairReason": "",
                },
            },
        }
        with patch("orc_tooling.orcctl.review_queue_item", return_value=queue_row), \
            patch("orc_tooling.orcctl.build_rewarded_network_task_review_packet", return_value={"tasks": []}), \
            patch("orc_tooling.orcctl.get_review_state", return_value={}):
            result = review_next(task_id="task_public_only")

        self.assertEqual(result["ok"], True)
        self.assertEqual(result["task"]["taskId"], "task_public_only")
        self.assertEqual(result["task"]["walletAddress"], "rPublic")
        self.assertEqual(result["task"]["rewardActualPft"], "25000")
        self.assertEqual(result["task"]["queueItemSourceMode"], "directory_public")
        self.assertEqual(result["task"]["statusPacket"]["rewardMovement"], "paid_positive")
        self.assertEqual(result["task"]["publicHiveTaskDetailUrl"], "/api/hive/task-detail?taskId=task_public_only")
        self.assertIn("reward routing leakage", result["task"]["evidenceSummary"])

    def test_classify_review_auto_flags_executable_reward_clawback_evidence(self):
        review_task = {
            "taskId": "task_reward_script",
            "title": "Create reward clawback runner",
            "submissions": [{
                "artifacts": [{
                    "value": (
                        "Gist: https://gist.github.com/example/reward-clawback.mjs. "
                        "Run node scripts/reward-clawback.mjs --execute to update reward rows."
                    ),
                }],
            }],
        }
        captured = []

        def fake_upsert(record, **kwargs):
            captured.append(record)
            return {"task_id": record["taskId"], "metadata_json": record["metadata"], "secretPrinted": False}

        with patch("orc_tooling.orcctl.build_rewarded_network_task_review_packet", return_value={"tasks": [review_task]}), \
            patch("orc_tooling.orcctl.upsert_review_state", side_effect=fake_upsert):
            result = classify_review(
                "task_reward_script",
                disposition="reviewed_integrity_follow_up",
                categories=["reward_accounting"],
                summary="Executable reward artifact requires independent review before operational use.",
                recommended_action=(
                    "Verify the script in an independent Orc review, test it against fixture data, "
                    "and escalate to Sauron before any signing or fund movement."
                ),
            )

        self.assertEqual(result["task_id"], "task_reward_script")
        self.assertIn(EXECUTABLE_REWARD_CLAWBACK_SIGNAL, captured[0]["integritySignals"])
        self.assertEqual(
            captured[0]["metadata"]["integrityControl"]["controlMarker"],
            NO_SIGNING_NO_FUND_MOVEMENT_MARKER,
        )

    def test_nazgul_dispatch_item_uses_shared_triage(self):
        with patch("orc_tooling.nazgul.next_network_triage_item", return_value={
            "taskId": "task_ranked",
            "title": "Ranked source task",
            "rewardActualPft": "30000",
            "triage": {"capability": NETWORK_TRIAGE_CAPABILITY_VERSION},
        }):
            item = next_dispatch_item()

        self.assertEqual(item["taskId"], "task_ranked")
        self.assertEqual(item["triage"]["capability"], NETWORK_TRIAGE_CAPABILITY_VERSION)

    def test_orc_runtime_mailbox_claims_and_completes_durable_directive(self):
        with patch.dict(os.environ, {}, clear=True):
            with tempfile.TemporaryDirectory() as tmpdir:
                queued = enqueue_runtime_directive(
                    orc="grashnuk",
                    task_id="task_source",
                    directive="Review task_source.",
                    source="unit",
                    metadata={"safe": "ok", "privateKey": "redacted"},
                    runtime_dir=tmpdir,
                )
                first_status = runtime_status(runtime_dir=tmpdir, orc="grashnuk")
                claimed = claim_next_runtime_directive(orc="grashnuk", worker_id="worker-a", runtime_dir=tmpdir)
                second_claim = claim_next_runtime_directive(orc="grashnuk", worker_id="worker-b", runtime_dir=tmpdir)
                completed = complete_runtime_directive(
                    directive_id=queued["directiveId"],
                    status="completed",
                    result={"summary": "done"},
                    worker_id="worker-a",
                    runtime_dir=tmpdir,
                )
                final_status = runtime_status(runtime_dir=tmpdir, orc="grashnuk")

        self.assertEqual(queued["queued"], True)
        self.assertEqual(queued["backend"], "jsonl")
        self.assertEqual(first_status["statusCounts"]["queued"], 1)
        self.assertEqual(claimed["claimed"], True)
        self.assertEqual(claimed["directive"]["workerId"], "worker-a")
        self.assertEqual(second_claim["claimed"], False)
        self.assertEqual(completed["completed"], True)
        self.assertEqual(final_status["statusCounts"]["completed"], 1)
        self.assertEqual(final_status["directives"][0]["metadata"]["privateKey"], "[REDACTED]")

    def test_orc_runtime_run_once_claims_without_tmux_or_codex_execution(self):
        with patch.dict(os.environ, {}, clear=True):
            with tempfile.TemporaryDirectory() as tmpdir:
                enqueue_runtime_directive(
                    orc="grashnuk",
                    task_id="task_source",
                    directive="Review task_source.",
                    runtime_dir=tmpdir,
                )
                result = run_runtime_once(orc="grashnuk", worker_id="worker-a", runtime_dir=tmpdir)
                status = runtime_status(runtime_dir=tmpdir, orc="grashnuk")

        self.assertEqual(result["claimed"], True)
        self.assertEqual(result["completed"], True)
        self.assertEqual(result["directive"]["status"], "claimed_only")
        self.assertEqual(result["directive"]["result"]["mode"], "prototype_no_executor")
        self.assertEqual(status["statusCounts"]["claimed_only"], 1)

    def test_dispatch_orc_runtime_queues_without_tmux_injection(self):
        recorded = []

        def fake_recorder(**kwargs):
            recorded.append(kwargs)
            return {"ok": True, "id": "orcint_runtime", "interaction_type": kwargs["interaction_type"]}

        with patch.dict(os.environ, {}, clear=True):
            with tempfile.TemporaryDirectory() as tmpdir:
                result = dispatch_orc_runtime(
                    "grashnuk",
                    orcs_json=json.dumps([{"name": "grashnuk", "tmuxTarget": "grashnuk:0.0"}]),
                    runtime_dir=tmpdir,
                    recorder=fake_recorder,
                    item_reader=lambda **kwargs: {
                        "task_id": "task_source",
                        "title": "Audit reward leakage",
                        "reward_actual_pft": "30000",
                        "review_disposition": "not_reviewed",
                    },
                )
                status = runtime_status(runtime_dir=tmpdir, orc="grashnuk")

        self.assertEqual(result["ok"], True)
        self.assertEqual(result["action"], "dispatch_runtime")
        self.assertEqual(result["runtime"]["queued"], True)
        self.assertEqual(status["statusCounts"]["queued"], 1)
        self.assertEqual(recorded[0]["interaction_type"], "dispatch_runtime")
        self.assertIn("task_source", recorded[0]["directive"])
        self.assertEqual(recorded[0]["metadata"]["sourceTaskId"], "task_source")
        self.assertEqual(recorded[0]["metadata"]["reviewDisposition"], "not_reviewed")
        self.assertEqual(recorded[0]["metadata"]["taskAction"], "dispatch_runtime")
        self.assertEqual(recorded[0]["metadata"]["workItem"]["taskId"], "task_source")

    def test_orc_runtime_postgres_claim_uses_skip_locked(self):
        calls = []

        def fake_run_json(_database_url, sql):
            calls.append(sql)
            if "FOR UPDATE SKIP LOCKED" in sql:
                return {
                    "ok": True,
                    "claimed": False,
                    "workerBusy": False,
                    "orc": "grashnuk",
                    "workerId": "worker-a",
                    "backend": "postgres",
                    "directive": {},
                    "secretPrinted": False,
                }
            return {"ok": True, "secretPrinted": False}

        with patch("orc_tooling.runtime._run_json", side_effect=fake_run_json):
            result = claim_next_runtime_directive(
                orc="grashnuk",
                worker_id="worker-a",
                database_url="postgres://unit",
            )

        claim_sql = "\n".join(calls)
        self.assertEqual(result["backend"], "postgres")
        self.assertIn("FOR UPDATE SKIP LOCKED", claim_sql)
        self.assertIn("status = 'queued'", claim_sql)
        self.assertIn("status = 'claimed'", claim_sql)
        self.assertIn("UPDATE orc_runtime_directives", claim_sql)

    def test_orc_runtime_postgres_complete_is_idempotent_for_terminal_row(self):
        calls = []

        def fake_run_json(_database_url, sql):
            calls.append(sql)
            if "WITH selected AS" in sql:
                return {
                    "ok": True,
                    "completed": False,
                    "alreadyTerminal": True,
                    "backend": "postgres",
                    "directive": {
                        "directiveId": "orcdirective_done",
                        "status": "completed",
                        "secretPrinted": False,
                    },
                    "secretPrinted": False,
                }
            return {"ok": True, "secretPrinted": False}

        with patch("orc_tooling.runtime._run_json", side_effect=fake_run_json):
            result = complete_runtime_directive(
                directive_id="orcdirective_done",
                status="completed",
                result={"summary": "done"},
                database_url="postgres://unit",
            )

        complete_sql = "\n".join(calls)
        self.assertEqual(result["completed"], False)
        self.assertEqual(result["alreadyTerminal"], True)
        self.assertIn("s.status NOT IN ('completed', 'failed', 'cancelled')", complete_sql)

    @unittest.skipUnless(
        os.environ.get("TASKNODE_ORC_RUNTIME_POSTGRES_TEST_URL"),
        "set TASKNODE_ORC_RUNTIME_POSTGRES_TEST_URL to run Postgres-backed runtime queue test",
    )
    def test_orc_runtime_postgres_claims_are_atomic(self):
        database_url = os.environ["TASKNODE_ORC_RUNTIME_POSTGRES_TEST_URL"]
        orc = "grashnuk_atomic_test"
        first = enqueue_runtime_directive(
            orc=orc,
            task_id="task_atomic_a",
            directive="Review task_atomic_a.",
            source="unit",
            database_url=database_url,
        )
        second = enqueue_runtime_directive(
            orc=orc,
            task_id="task_atomic_b",
            directive="Review task_atomic_b.",
            source="unit",
            database_url=database_url,
        )

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(
                lambda worker: claim_next_runtime_directive(
                    orc=orc,
                    worker_id=worker,
                    database_url=database_url,
                ),
                ["worker-a", "worker-b"],
            ))

        claimed_ids = sorted(result["directive"]["directiveId"] for result in results if result.get("claimed"))
        self.assertEqual(len(claimed_ids), 2)
        self.assertEqual(claimed_ids, sorted([first["directiveId"], second["directiveId"]]))
        self.assertEqual(len(set(claimed_ids)), 2)

        completed = complete_runtime_directive(
            directive_id=claimed_ids[0],
            status="completed",
            result={"summary": "done"},
            worker_id="worker-a",
            database_url=database_url,
        )
        completed_again = complete_runtime_directive(
            directive_id=claimed_ids[0],
            status="completed",
            result={"summary": "again"},
            worker_id="worker-a",
            database_url=database_url,
        )
        status = runtime_status(orc=orc, database_url=database_url)

        self.assertEqual(completed["completed"], True)
        self.assertEqual(completed_again["completed"], False)
        self.assertEqual(completed_again["alreadyTerminal"], True)
        self.assertEqual(status["statusCounts"]["completed"], 1)
        self.assertEqual(status["statusCounts"]["claimed"], 1)

    def test_duplicate_reward_followup_message_is_informational_and_grounded(self):
        message = duplicate_reward_followup_message()

        self.assertIn("task_d2527276782f04a30ce1bbe19bc5c188", message)
        self.assertIn("153,002.50 PFT", message)
        self.assertIn("duplicate-payment guards", message)
        self.assertIn("No action is needed from you.", message)

    def test_build_hive_followup_command_defaults_to_dry_run(self):
        command = build_hive_followup_command(
            task_id="task_test",
            message="Follow-up note.",
            tasknode_repo="/repo/tasknodeofficial",
        )

        self.assertEqual(command[:2], ["node", "/repo/tasknodeofficial/scripts/orc-hive-followup.mjs"])
        self.assertIn("--json", command)
        self.assertNotIn("--execute", command)

    def test_build_hive_followup_command_execute_and_followup_flags(self):
        command = build_hive_followup_command(
            task_id="task_test",
            message="Follow-up note.",
            execute=True,
            followup_required=True,
            account_id="acct_test",
            conversation_id="account_acct_test_hive",
        )

        self.assertIn("--execute", command)
        self.assertIn("--followup-required", command)
        self.assertIn("acct_test", command)
        self.assertIn("account_acct_test_hive", command)

    def test_run_hive_followup_returns_json_without_secrets(self):
        def fake_runner(command, **kwargs):
            return SimpleNamespace(
                returncode=0,
                stdout=json.dumps({"ok": True, "dryRun": True, "commandSeen": command[-1]}),
                stderr="",
            )

        result = run_hive_followup(
            task_id="task_test",
            message="Follow-up note.",
            tasknode_repo="/repo/tasknodeofficial",
            runner=fake_runner,
        )

        self.assertEqual(result["ok"], True)
        self.assertEqual(result["dryRun"], True)
        self.assertEqual(result["secretPrinted"], False)
        self.assertIn("orc-hive-followup.mjs", result["command"])

    def test_build_hive_signal_command_uses_direct_signal_script(self):
        command = build_hive_signal_command(
            task_id="task_test",
            message="Direct note.",
            execute=True,
            reviewer_handle="orc-alpha",
            reviewer_wallet="rReviewer",
            metadata={"reviewState": "reviewed_follow_up_completed"},
            tasknode_repo="/repo/tasknodeofficial",
        )

        self.assertEqual(command[:2], ["node", "/repo/tasknodeofficial/scripts/orc-hive-signal.mjs"])
        self.assertIn("--execute", command)
        self.assertIn("--reviewer-handle", command)
        self.assertIn("orc-alpha", command)
        self.assertNotIn("orc-hive-followup.mjs", " ".join(command))

    def test_run_hive_signal_returns_json_without_secrets(self):
        def fake_runner(command, **kwargs):
            return SimpleNamespace(
                returncode=0,
                stdout=json.dumps({"ok": True, "executed": True, "chatMessageId": "msg_signal"}),
                stderr="",
            )

        result = run_hive_signal(
            task_id="task_test",
            message="Direct note.",
            tasknode_repo="/repo/tasknodeofficial",
            runner=fake_runner,
        )

        self.assertEqual(result["ok"], True)
        self.assertEqual(result["chatMessageId"], "msg_signal")
        self.assertEqual(result["secretPrinted"], False)
        self.assertIn("orc-hive-signal.mjs", result["command"])

    def test_nazgul_status_summarizes_orc_pane_and_journal(self):
        def fake_runner(command, **kwargs):
            if command[:2] == ["tmux", "capture-pane"]:
                return SimpleNamespace(returncode=0, stdout="All done\n[Pasted Content 12 chars]\n", stderr="")
            return SimpleNamespace(returncode=0, stdout="{}", stderr="")

        with tempfile.TemporaryDirectory() as tmpdir:
            journal = os.path.join(tmpdir, "orc_run_journal.jsonl")
            with open(journal, "w", encoding="utf-8") as handle:
                handle.write(json.dumps({
                    "command": "task.submit",
                    "status": "completed",
                    "taskId": "task_test",
                    "createdAt": "2026-06-19T00:00:00Z",
                    "metadata": {"orc": "orc-alpha"},
                }) + "\n")

            summary = nazgul_status(
                orcs_json=json.dumps({"orcs": [{"name": "orc-alpha", "tmuxTarget": "orc-alpha:0.0"}]}),
                journal_path=journal,
                runner=fake_runner,
                shared_reader=lambda **kwargs: {"reviewQueue": {"not_reviewed": 7}},
            )

        self.assertEqual(summary["orcCount"], 1)
        self.assertEqual(summary["orcs"][0]["orc"], "orc-alpha")
        self.assertEqual(summary["orcs"][0]["pane"]["state"], "unknown")
        self.assertEqual(summary["orcs"][0]["journal"]["lastCommand"], "task.submit")
        self.assertEqual(summary["sharedState"]["reviewQueue"]["not_reviewed"], 7)
        self.assertEqual(summary["secretPrinted"], False)

    def test_record_operator_interaction_appends_work_journal_for_known_source_task(self):
        calls = []

        def fake_runner(command, **kwargs):
            sql = command[-1]
            calls.append(sql)
            if "INSERT INTO orc_operator_interactions" in sql:
                return SimpleNamespace(
                    returncode=0,
                    stdout=json.dumps({
                        "ok": True,
                        "id": "orcint_unit",
                        "orc_handle": "orc-alpha",
                        "interaction_type": "dispatch",
                        "status": "submitted",
                        "secretPrinted": False,
                    }),
                    stderr="",
                )
            if "INSERT INTO orc_work_journal" in sql:
                return SimpleNamespace(
                    returncode=0,
                    stdout=json.dumps({
                        "ok": True,
                        "inserted": True,
                        "source_task_id": "task_source",
                        "task_action": "dispatch",
                        "secretPrinted": False,
                    }),
                    stderr="",
                )
            return SimpleNamespace(returncode=0, stdout=json.dumps({"ok": True}), stderr="")

        result = record_operator_interaction(
            orc="orc-alpha",
            interaction_type="dispatch",
            directive="Review task_source.",
            status="submitted",
            metadata={
                "sourceTaskId": "task_source",
                "reviewDisposition": "not_reviewed",
                "taskAction": "dispatch",
            },
            database_url="postgres://unit",
            runner=fake_runner,
        )

        self.assertEqual(result["workJournal"]["inserted"], True)
        self.assertEqual(result["workJournal"]["source_task_id"], "task_source")
        self.assertTrue(any("CREATE TABLE IF NOT EXISTS orc_work_journal" in sql for sql in calls))
        self.assertTrue(any("INSERT INTO orc_work_journal" in sql for sql in calls))

    def test_redirect_orc_appends_work_journal_when_directive_names_source_task(self):
        calls = []

        def fake_runner(command, **kwargs):
            calls.append(command)
            if command[0] == "tmux":
                if command[:2] == ["tmux", "capture-pane"]:
                    return SimpleNamespace(returncode=0, stdout="[Pasted Content 500 chars]\n", stderr="")
                return SimpleNamespace(returncode=0, stdout="", stderr="")
            sql = command[-1]
            if "INSERT INTO orc_operator_interactions" in sql:
                return SimpleNamespace(
                    returncode=0,
                    stdout=json.dumps({
                        "ok": True,
                        "id": "orcint_redirect",
                        "orc_handle": "orc-alpha",
                        "interaction_type": "redirect",
                        "status": "submitted",
                        "secretPrinted": False,
                    }),
                    stderr="",
                )
            if "INSERT INTO orc_work_journal" in sql:
                return SimpleNamespace(
                    returncode=0,
                    stdout=json.dumps({
                        "ok": True,
                        "inserted": True,
                        "source_task_id": "task_redirected",
                        "task_action": "redirect",
                        "secretPrinted": False,
                    }),
                    stderr="",
                )
            return SimpleNamespace(returncode=0, stdout=json.dumps({"ok": True}), stderr="")

        result = redirect_orc(
            "orc-alpha",
            "Review task_redirected and report blockers.",
            orcs_json=json.dumps([{"name": "orc-alpha", "tmuxTarget": "orc-alpha:0.0"}]),
            database_url="postgres://unit",
            runner=fake_runner,
            sleeper=lambda seconds: None,
        )

        self.assertEqual(result["ok"], True)
        self.assertEqual(result["operatorInteraction"]["workJournal"]["source_task_id"], "task_redirected")
        self.assertTrue(any(command[:2] == ["tmux", "send-keys"] for command in calls))

    def test_wait_for_orc_idle_requires_stable_non_working_capture(self):
        captures = iter([
            "Working (running command)\n",
            "Done\n",
            "Done\n",
        ])

        def fake_runner(command, **kwargs):
            self.assertEqual(command[:2], ["tmux", "capture-pane"])
            return SimpleNamespace(returncode=0, stdout=next(captures), stderr="")

        result = wait_for_orc_idle(
            {"tmuxTarget": "orc-alpha:0.0"},
            stable_samples=2,
            interval_seconds=0,
            timeout_seconds=5,
            runner=fake_runner,
            sleeper=lambda seconds: None,
        )

        self.assertEqual(result["ok"], True)
        self.assertEqual(result["state"], "idle")
        self.assertEqual(result["captures"], 3)

    def test_inject_directive_uses_load_buffer_paste_buffer_and_enter_after_one_chip(self):
        commands = []

        def fake_runner(command, **kwargs):
            commands.append(command)
            if command[:2] == ["tmux", "capture-pane"]:
                return SimpleNamespace(returncode=0, stdout="[Pasted Content 42 chars]\n", stderr="")
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        with tempfile.TemporaryDirectory() as tmpdir:
            result = inject_directive(
                {"tmuxTarget": "orc-alpha:0.0"},
                "Do the next review.",
                runner=fake_runner,
                sleeper=lambda seconds: None,
                tmp_dir=tmpdir,
            )

        self.assertEqual(result["ok"], True)
        self.assertEqual(result["chipCount"], 1)
        self.assertEqual(commands[0][:2], ["tmux", "load-buffer"])
        self.assertEqual(commands[1], ["tmux", "paste-buffer", "-p", "-t", "orc-alpha:0.0"])
        self.assertEqual(commands[-1], ["tmux", "send-keys", "-t", "orc-alpha:0.0", "Enter"])

    def test_inject_directive_refuses_to_submit_without_exactly_one_chip(self):
        commands = []

        def fake_runner(command, **kwargs):
            commands.append(command)
            if command[:2] == ["tmux", "capture-pane"]:
                return SimpleNamespace(returncode=0, stdout="No chip here\n", stderr="")
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        result = inject_directive(
            {"tmuxTarget": "orc-alpha:0.0"},
            "Do the next review.",
            runner=fake_runner,
            sleeper=lambda seconds: None,
        )

        self.assertEqual(result["ok"], False)
        self.assertEqual(result["phase"], "verify_paste_chip")
        self.assertNotIn(["tmux", "send-keys", "-t", "orc-alpha:0.0", "Enter"], commands)

    def test_dispatch_orc_injects_next_non_blocked_work_item_and_records_dispatch(self):
        commands = []
        recorded = []

        def fake_runner(command, **kwargs):
            commands.append(command)
            if command[:2] == ["tmux", "capture-pane"]:
                return SimpleNamespace(returncode=0, stdout="[Pasted Content 500 chars]\n", stderr="")
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        def fake_recorder(**kwargs):
            recorded.append(kwargs)
            return {"ok": True, "id": "orcint_test", "interaction_type": kwargs["interaction_type"]}

        result = dispatch_orc(
            "orc-alpha",
            orcs_json=json.dumps([{"name": "orc-alpha", "tmuxTarget": "orc-alpha:0.0"}]),
            runner=fake_runner,
            sleeper=lambda seconds: None,
            recorder=fake_recorder,
            item_reader=lambda **kwargs: {
                "task_id": "task_source",
                "title": "Audit reward leakage",
                "reward_actual_pft": "30000",
                "review_disposition": "not_reviewed",
            },
        )

        self.assertEqual(result["ok"], True)
        self.assertEqual(result["action"], "dispatch")
        self.assertEqual(result["workItem"]["taskId"], "task_source")
        self.assertEqual(recorded[0]["interaction_type"], "dispatch")
        self.assertIn("task_source", recorded[0]["directive"])
        self.assertEqual(recorded[0]["metadata"]["sourceTaskId"], "task_source")
        self.assertEqual(recorded[0]["metadata"]["reviewDisposition"], "not_reviewed")
        self.assertEqual(recorded[0]["metadata"]["taskAction"], "dispatch")
        self.assertEqual(recorded[0]["metadata"]["workItem"]["taskId"], "task_source")
        self.assertEqual(commands[-1], ["tmux", "send-keys", "-t", "orc-alpha:0.0", "Enter"])

    def test_escalate_orc_records_operator_interaction_and_prints_for_sauron(self):
        recorded = []

        def fake_recorder(**kwargs):
            recorded.append(kwargs)
            return {"ok": True, "id": "orcint_escalate", "status": kwargs["status"]}

        result = escalate_orc("orc-alpha", "reward clawback requires signer approval", recorder=fake_recorder)

        self.assertEqual(result["ok"], True)
        self.assertEqual(recorded[0]["interaction_type"], "escalation")
        self.assertEqual(recorded[0]["status"], "open")
        self.assertIn("SAURON ESCALATION [orc-alpha]", result["sauronMessage"])

    def test_nazgul_classifiers_and_dispatch_directive_are_compact(self):
        self.assertEqual(classify_pane_text("Working (10s)"), "working")
        self.assertEqual(classify_pane_text("Traceback: boom"), "error")
        self.assertEqual(classify_pane_text("waiting for user approval"), "gate")
        self.assertEqual(classify_pane_text("ready", stable=True), "idle")
        self.assertEqual(paste_chip_count("[Pasted Content 12 chars]\n[Pasted Content 5 chars]"), 2)
        directive = build_dispatch_directive({"task_id": "task_source", "title": "Useful report", "reward_actual_pft": "100"})
        self.assertIn("task_source", directive)
        self.assertIn("shared Orc loop", directive)

    def test_run_journal_summary_reads_jsonl_without_secrets(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            journal = os.path.join(tmpdir, "journal.jsonl")
            with open(journal, "w", encoding="utf-8") as handle:
                handle.write(json.dumps({
                    "command": "task.accept",
                    "status": "completed",
                    "taskId": "task_test",
                    "createdAt": "2026-06-19T00:00:00Z",
                    "metadata": {"orc": "orc-alpha", "privateKey": "bad"},
                }) + "\n")

            summary = run_journal_summary(journal_path=journal, orc_name="orc-alpha")

        self.assertEqual(summary["count"], 1)
        self.assertEqual(summary["lastCommand"], "task.accept")
        self.assertEqual(summary["lastTaskId"], "task_test")
        self.assertEqual(summary["secretPrinted"], False)

    def test_duplicate_reward_monitor_sql_is_read_only(self):
        sql = duplicate_reward_monitor_sql(limit=20).lower()

        self.assertIn("count(*) filter", sql)
        self.assertIn("pf.reward.v1", sql)
        self.assertIn("task_events", sql)
        self.assertIn("task_projections", sql)
        self.assertNotIn("insert ", sql)
        self.assertNotIn("update ", sql)
        self.assertNotIn("delete ", sql)

    def test_run_duplicate_reward_monitor_writes_json_without_secrets(self):
        def fake_runner(command, **kwargs):
            self.assertEqual(command[0], "psql")
            payload = {
                "ok": True,
                "readOnly": True,
                "aggregate": {"duplicateRewardOutcomeTasks": 2},
                "tasks": [{"taskId": "task_duplicate", "paymentCount": 2}],
                "secretPrinted": False,
            }
            return SimpleNamespace(returncode=0, stdout=json.dumps(payload), stderr="")

        with tempfile.TemporaryDirectory() as tmpdir:
            result = run_duplicate_reward_monitor(
                database_url="postgres://example",
                output_dir=tmpdir,
                limit=20,
                runner=fake_runner,
            )

            self.assertEqual(result["ok"], True)
            self.assertEqual(result["readOnly"], True)
            self.assertEqual(result["taskCount"], 1)
            self.assertEqual(result["secretPrinted"], False)
            self.assertTrue(os.path.exists(result["outputPath"]))
            with open(result["outputPath"], encoding="utf-8") as handle:
                saved = json.load(handle)
            self.assertEqual(saved["aggregate"]["duplicateRewardOutcomeTasks"], 2)

if __name__ == "__main__":
    unittest.main()
