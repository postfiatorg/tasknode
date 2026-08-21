from __future__ import annotations

from typing import Any

from tasknode_pftl.app_data import psql_json, sql_literal, tasknode_database_url

from .payload import redact_secrets


NETWORK_TASK_STATUS_TERMINAL = "rewarded"


def _safe_int(value: Any, default: int = 20, *, minimum: int = 1, maximum: int = 200) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return min(max(parsed, minimum), maximum)


def _safe_text(value: Any, limit: int = 4000) -> str:
    return str(value or "").strip()[:limit]


def _safe_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _safe_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _normalized_handle(handle: str = "") -> str:
    return _safe_text(handle, 180).lstrip("@").lower()


def _json_array_literal(values: list[str]) -> str:
    if not values:
        return "ARRAY[]::text[]"
    return "ARRAY[" + ",".join(sql_literal(value) for value in values) + "]::text[]"


def _resolve_identity_sql(*, handle: str = "", account_id: str = "", wallet: str = "", task_id: str = "") -> str:
    normalized_handle = _normalized_handle(handle)
    return f"""
WITH direct_inputs AS (
  SELECT
    {sql_literal(account_id)}::text AS account_id,
    {sql_literal(wallet)}::text AS wallet_address,
    {sql_literal(task_id)}::text AS task_id,
    {sql_literal(normalized_handle)}::text AS handle
),
task_scope AS (
  SELECT p.account_id, p.subject_wallet AS wallet_address
  FROM task_projections p, direct_inputs input
  WHERE input.task_id <> ''
    AND p.task_id = input.task_id
  LIMIT 1
),
handle_scope AS (
  SELECT DISTINCT vector.account_id, ''::text AS wallet_address, 'user_identity_vectors.public_handle' AS source
  FROM user_identity_vectors vector, direct_inputs input
  WHERE input.handle <> ''
    AND lower(vector.public_handle) = input.handle
  UNION
  SELECT DISTINCT profile.account_id, profile.wallet_address, 'recommended_connection_profiles.hive_handle' AS source
  FROM recommended_connection_profiles profile, direct_inputs input
  WHERE input.handle <> ''
    AND lower(profile.hive_handle) = input.handle
    AND COALESCE(profile.disabled_at::text, '') = ''
  UNION
  SELECT DISTINCT obs.account_id, ''::text AS wallet_address, 'user_observability_events.public_handle' AS source
  FROM user_observability_events obs, direct_inputs input
  WHERE input.handle <> ''
    AND lower(obs.public_handle) = input.handle
),
wallet_scope AS (
  SELECT DISTINCT sync.account_id, sync.wallet_address, 'pftl_sync_wallets.wallet_address' AS source
  FROM pftl_sync_wallets sync, direct_inputs input
  WHERE input.wallet_address <> ''
    AND sync.wallet_address = input.wallet_address
  UNION
  SELECT DISTINCT projection.account_id, projection.subject_wallet AS wallet_address, 'task_projections.subject_wallet' AS source
  FROM task_projections projection, direct_inputs input
  WHERE input.wallet_address <> ''
    AND projection.subject_wallet = input.wallet_address
),
candidate_accounts AS (
  SELECT account_id, wallet_address, 'input.account_id' AS source
  FROM direct_inputs
  WHERE account_id <> ''
  UNION
  SELECT account_id, wallet_address, 'input.task_id' AS source
  FROM task_scope
  UNION
  SELECT account_id, wallet_address, source
  FROM handle_scope
  UNION
  SELECT account_id, wallet_address, source
  FROM wallet_scope
),
selected AS (
  SELECT DISTINCT account_id, wallet_address, source
  FROM candidate_accounts
  WHERE COALESCE(account_id, '') <> ''
     OR COALESCE(wallet_address, '') <> ''
),
account_ids AS (
  SELECT DISTINCT account_id
  FROM selected
  WHERE account_id <> ''
),
wallet_inputs AS (
  SELECT DISTINCT wallet_address
  FROM selected
  WHERE wallet_address <> ''
),
wallet_rows AS (
  SELECT DISTINCT account_id, wallet_address, role, status, source, last_seen_at
  FROM (
    SELECT account_id, wallet_address, role, status, 'pftl_sync_wallets' AS source,
           COALESCE(last_hot_sync_at, last_archive_sync_at, updated_at, created_at) AS last_seen_at
    FROM pftl_sync_wallets
    WHERE account_id IN (SELECT account_id FROM account_ids)
       OR wallet_address IN (SELECT wallet_address FROM wallet_inputs)
    UNION
    SELECT account_id, subject_wallet AS wallet_address, 'user' AS role, 'historical' AS status,
           'task_projections' AS source, max(updated_at) AS last_seen_at
    FROM task_projections
    WHERE (account_id IN (SELECT account_id FROM account_ids)
       OR subject_wallet IN (SELECT wallet_address FROM wallet_inputs))
      AND subject_wallet <> ''
    GROUP BY account_id, subject_wallet
  ) rows
  WHERE wallet_address <> ''
),
identity_rows AS (
  SELECT vector.*
  FROM user_identity_vectors vector
  WHERE vector.account_id IN (SELECT account_id FROM account_ids)
     OR EXISTS (
       SELECT 1
       FROM jsonb_array_elements(vector.wallets_json) AS wallet
       WHERE wallet->>'walletAddress' IN (SELECT wallet_address FROM wallet_inputs)
     )
),
recommended_rows AS (
  SELECT DISTINCT account_id, hive_handle, display_name, wallet_address
  FROM recommended_connection_profiles
  WHERE account_id IN (SELECT account_id FROM account_ids)
     OR wallet_address IN (SELECT wallet_address FROM wallet_inputs)
     OR ({sql_literal(normalized_handle)} <> '' AND lower(hive_handle) = {sql_literal(normalized_handle)})
)
SELECT jsonb_build_object(
  'lookup', jsonb_build_object(
    'handle', {sql_literal(handle)},
    'normalizedHandle', {sql_literal(normalized_handle)},
    'accountId', {sql_literal(account_id)},
    'walletAddress', {sql_literal(wallet)},
    'taskId', {sql_literal(task_id)}
  ),
  'resolved', EXISTS(SELECT 1 FROM selected),
  'accountIds', COALESCE((SELECT jsonb_agg(DISTINCT account_id) FROM selected WHERE account_id <> ''), '[]'::jsonb),
  'walletAddresses', COALESCE((SELECT jsonb_agg(DISTINCT wallet_address) FROM wallet_rows), '[]'::jsonb),
  'identityVectors', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'accountId', identity.account_id,
      'publicHandle', identity.public_handle,
      'displayName', identity.display_name,
      'providerNames', jsonb_path_query_array(COALESCE(identity.providers_json, '[]'::jsonb), '$[*].provider'),
      'providerCount', jsonb_array_length(COALESCE(identity.providers_json, '[]'::jsonb)),
      'wallets', identity.wallets_json,
      'activeWalletCount', identity.active_wallet_count,
      'historicalWalletCount', identity.historical_wallet_count,
      'telegramLinked', identity.telegram_linked,
      'updatedAt', identity.updated_at
    ) ORDER BY updated_at DESC NULLS LAST)
    FROM identity_rows identity
  ), '[]'::jsonb),
  'recommendedProfiles', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'accountId', account_id,
      'hiveHandle', hive_handle,
      'displayName', display_name,
      'walletAddress', wallet_address
    ) ORDER BY hive_handle, wallet_address)
    FROM recommended_rows
  ), '[]'::jsonb),
  'sources', COALESCE((
    SELECT jsonb_agg(DISTINCT source)
    FROM selected
  ), '[]'::jsonb)
);
"""


def resolve_identity(
    *,
    handle: str = "",
    account_id: str = "",
    wallet: str = "",
    task_id: str = "",
    database_url: str | None = None,
) -> dict[str, Any]:
    db_url = tasknode_database_url(database_url)
    identity = psql_json(db_url, _resolve_identity_sql(handle=handle, account_id=account_id, wallet=wallet, task_id=task_id))
    return redact_secrets(identity or {})


def _task_scope_filter(identity: dict[str, Any], *, task_id: str = "") -> str:
    if task_id:
        return f"p.task_id = {sql_literal(task_id)}"
    account_ids = [str(value) for value in _safe_list(identity.get("accountIds")) if str(value or "")]
    wallet_addresses = [str(value) for value in _safe_list(identity.get("walletAddresses")) if str(value or "")]
    filters = []
    if account_ids:
        filters.append(f"p.account_id = ANY({_json_array_literal(account_ids)})")
    if wallet_addresses:
        filters.append(f"p.subject_wallet = ANY({_json_array_literal(wallet_addresses)})")
    return "(" + " OR ".join(filters) + ")" if filters else "false"


def _rewarded_network_tasks_sql(
    identity: dict[str, Any],
    *,
    task_id: str = "",
    status: str = NETWORK_TASK_STATUS_TERMINAL,
    limit: int = 20,
) -> str:
    bounded_limit = _safe_int(limit, default=20, maximum=200)
    status_filter = ""
    if status:
        status_filter = f"AND p.status = {sql_literal(status)}"
    return f"""
WITH selected_tasks AS (
  SELECT
    p.*,
    alloc.id AS allocation_id,
    alloc.project_id AS allocation_project_id,
    alloc.allocation_status,
    alloc.candidate_account_id,
    alloc.candidate_wallet_address,
    alloc.project_need_summary AS allocation_project_need_summary,
    alloc.reward_min_pft,
    alloc.reward_max_pft,
    alloc.metadata_json AS allocation_metadata_json,
    job.id AS generation_job_id,
    job.source_payload_digest,
    job.source_payload_json,
    job.source_payload_text,
    job.generated_task_payload,
    job.request_bundle_cid AS job_request_bundle_cid,
    job.offer_cid,
    job.offer_tx_hash,
    ref.project_id AS ref_project_id,
    ref.source AS ref_source,
    ref.metadata_json AS ref_metadata_json
  FROM task_projections p
  LEFT JOIN network_task_allocations alloc
    ON alloc.generated_task_id = p.task_id
    OR (alloc.task_request_id <> '' AND alloc.task_request_id = p.request_id)
  LEFT JOIN network_task_generation_jobs job
    ON job.task_id = p.task_id
    OR (alloc.id IS NOT NULL AND job.allocation_id = alloc.id)
  LEFT JOIN network_project_task_refs ref
    ON ref.task_id = p.task_id
  WHERE ({_task_scope_filter(identity, task_id=task_id)})
    AND lower(COALESCE(NULLIF(p.task_kind, ''), p.metadata_json->'generatedTask'->>'task_kind', '')) = 'network'
    {status_filter}
  ORDER BY p.updated_at DESC, p.task_id DESC
  LIMIT {bounded_limit}
),
events AS (
  SELECT
    e.task_id,
    jsonb_agg(jsonb_build_object(
      'eventType', e.event_type,
      'sourceTxHash', e.source_tx_hash,
      'sourceCid', e.source_cid,
      'eventDigest', e.event_digest,
      'occurredAt', e.occurred_at,
      'payload', e.payload_json
    ) ORDER BY e.occurred_at ASC, e.id ASC) AS events_json
  FROM task_events e
  WHERE e.task_id IN (SELECT task_id FROM selected_tasks)
    AND e.event_type IN (
      'pf.task.offer.v1',
      'pf.task.update.v1',
      'pf.task.submission.v1',
      'pf.task.verification_response.v1',
      'pf.task.reward_decision.v1',
      'pf.reward.v1'
    )
  GROUP BY e.task_id
)
SELECT COALESCE(jsonb_agg(jsonb_build_object(
  'taskId', task_id,
  'accountId', account_id,
  'subjectWallet', subject_wallet,
  'status', status,
  'title', title,
  'description', description,
  'taskKind', task_kind,
  'rewardOfferPft', reward_offer_pft::text,
  'rewardActualPft', reward_actual_pft::text,
  'submissionType', submission_type,
  'submissionRequirementText', submission_requirement_text,
  'verificationPolicy', verification_policy_json,
  'requestId', request_id,
  'requestBundleCid', request_bundle_cid,
  'contextCid', context_cid,
  'lastEventTxHash', last_event_tx_hash,
  'lastEventCid', last_event_cid,
  'createdAt', created_at,
  'updatedAt', updated_at,
  'metadata', metadata_json,
  'networkAllocation', jsonb_build_object(
    'allocationId', allocation_id,
    'projectId', allocation_project_id,
    'status', allocation_status,
    'candidateAccountId', candidate_account_id,
    'candidateWalletAddress', candidate_wallet_address,
    'projectNeedSummary', allocation_project_need_summary,
    'rewardMinPft', reward_min_pft::text,
    'rewardMaxPft', reward_max_pft::text,
    'metadata', allocation_metadata_json
  ),
  'generationJob', jsonb_build_object(
    'jobId', generation_job_id,
    'sourcePayloadDigest', source_payload_digest,
    'sourcePayload', source_payload_json,
    'sourcePayloadText', source_payload_text,
    'generatedTaskPayload', generated_task_payload,
    'requestBundleCid', job_request_bundle_cid,
    'offerCid', offer_cid,
    'offerTxHash', offer_tx_hash
  ),
  'networkProjectRef', jsonb_build_object(
    'projectId', ref_project_id,
    'source', ref_source,
    'metadata', ref_metadata_json
  ),
  'events', COALESCE(events.events_json, '[]'::jsonb)
) ORDER BY updated_at DESC, task_id DESC), '[]'::jsonb)
FROM selected_tasks
LEFT JOIN events USING (task_id);
"""


def _first_nonempty(*values: Any) -> str:
    for value in values:
        text = _safe_text(value, 20000)
        if text:
            return text
    return ""


def extract_evidence_artifacts(payload: dict[str, Any], *, text_limit: int = 5000) -> list[dict[str, Any]]:
    evidence = _safe_dict(payload.get("evidence") or payload.get("submission") or payload.get("response"))
    items = _safe_list(payload.get("evidence_items")) or _safe_list(evidence.get("evidence_items"))
    if not items and evidence:
        items = [evidence]

    artifacts: list[dict[str, Any]] = []
    for index, item in enumerate(items, start=1):
        item = _safe_dict(item)
        file_info = _safe_dict(item.get("file"))
        value = _first_nonempty(
            item.get("value"),
            item.get("text"),
            item.get("content"),
            file_info.get("text"),
            evidence.get("value") if len(items) == 1 else "",
            evidence.get("text") if len(items) == 1 else "",
        )
        artifacts.append(redact_secrets({
            "index": item.get("index") or index,
            "artifactType": item.get("artifact_type") or payload.get("artifact_type") or payload.get("evidence_type") or "",
            "notes": _safe_text(item.get("notes") or evidence.get("notes"), text_limit),
            "value": _safe_text(value, text_limit),
            "file": {
                "name": file_info.get("name") or "",
                "size": file_info.get("size") or None,
                "text": _safe_text(file_info.get("text"), text_limit),
            } if file_info else {},
            "url": item.get("url") or _safe_dict(item.get("source")).get("url") or "",
        }))
    return artifacts


def _review_score(payload: dict[str, Any]) -> dict[str, Any]:
    score = _safe_dict(payload.get("reward_score") or payload.get("score"))
    return redact_secrets({
        "decision": score.get("decision") or payload.get("reward_decision") or payload.get("decision") or "",
        "rewardPft": score.get("reward_pft") or payload.get("reward_pft") or payload.get("amount_pft") or "",
        "completion": score.get("completion"),
        "evidenceQuality": score.get("evidence_quality") or score.get("evidenceQuality"),
        "reason": score.get("reason") or payload.get("reward_summary") or "",
        "userFeedback": score.get("user_feedback") or score.get("userFeedback") or payload.get("user_feedback") or "",
    })


def _task_execution_payload(task_row: dict[str, Any]) -> dict[str, Any]:
    metadata = _safe_dict(task_row.get("metadata"))
    generated = _safe_dict(metadata.get("generatedTask")) or _safe_dict(_safe_dict(task_row.get("generationJob")).get("generatedTaskPayload"))
    offer_payload = next((
        _safe_dict(event.get("payload"))
        for event in _safe_list(task_row.get("events"))
        if event.get("eventType") == "pf.task.offer.v1"
    ), {})
    generated = generated or offer_payload
    return redact_secrets({
        "title": generated.get("title") or task_row.get("title") or "",
        "description": generated.get("description") or task_row.get("description") or "",
        "steps": generated.get("steps") or [],
        "submissionRequirement": generated.get("submission_requirement") or {
            "type": task_row.get("submissionType") or "",
            "criteria": task_row.get("submissionRequirementText") or "",
        },
        "verificationPolicy": generated.get("verification_policy") or task_row.get("verificationPolicy") or {},
        "networkTask": generated.get("network_task") or {},
    })


def _compact_task_review(task_row: dict[str, Any], *, include_raw_events: bool = False, text_limit: int = 5000) -> dict[str, Any]:
    events = _safe_list(task_row.get("events"))
    submissions = []
    verification_responses = []
    reward_events = []
    verification_requests = []
    for event in events:
        event_type = event.get("eventType")
        payload = _safe_dict(event.get("payload"))
        base = {
            "eventType": event_type,
            "sourceCid": event.get("sourceCid"),
            "sourceTxHash": event.get("sourceTxHash"),
            "occurredAt": event.get("occurredAt"),
        }
        if event_type == "pf.task.submission.v1":
            submissions.append({**base, "artifacts": extract_evidence_artifacts(payload, text_limit=text_limit)})
        elif event_type == "pf.task.verification_response.v1":
            verification_responses.append({**base, "artifacts": extract_evidence_artifacts(payload, text_limit=text_limit)})
        elif event_type == "pf.task.update.v1" and (
            payload.get("transition") == "verification_requested" or payload.get("status_after") == "verification_requested"
        ):
            verification_requests.append(redact_secrets({
                **base,
                "ask": payload.get("verification_ask") or _safe_dict(payload.get("verification_request")).get("verification_ask") or "",
                "reason": _safe_dict(payload.get("verification_request")).get("reason") or "",
                "assessment": _safe_dict(payload.get("verification_request")).get("assessment") or "",
            }))
        elif event_type in {"pf.reward.v1", "pf.task.reward_decision.v1"}:
            reward_events.append({**base, "score": _review_score(payload)})

    packet = {
        "taskId": task_row.get("taskId"),
        "accountId": task_row.get("accountId"),
        "walletAddress": task_row.get("subjectWallet"),
        "status": task_row.get("status"),
        "title": task_row.get("title"),
        "rewardOfferPft": task_row.get("rewardOfferPft"),
        "rewardActualPft": task_row.get("rewardActualPft"),
        "updatedAt": task_row.get("updatedAt"),
        "executionPayload": _task_execution_payload(task_row),
        "networkAllocation": task_row.get("networkAllocation"),
        "generationJob": {
            key: value
            for key, value in _safe_dict(task_row.get("generationJob")).items()
            if key not in {"sourcePayload", "sourcePayloadText", "generatedTaskPayload"}
        },
        "sourcePayload": _safe_dict(_safe_dict(task_row.get("generationJob")).get("sourcePayload")),
        "sourcePayloadText": _safe_text(_safe_dict(task_row.get("generationJob")).get("sourcePayloadText"), text_limit),
        "submissions": submissions,
        "verificationRequests": verification_requests,
        "verificationResponses": verification_responses,
        "rewardEvents": reward_events,
        "sourcePointers": {
            "requestBundleCid": task_row.get("requestBundleCid"),
            "contextCid": task_row.get("contextCid"),
            "lastEventCid": task_row.get("lastEventCid"),
            "lastEventTxHash": task_row.get("lastEventTxHash"),
        },
    }
    if include_raw_events:
        packet["rawEvents"] = events
    return redact_secrets(packet)


def build_rewarded_network_task_review_packet(
    *,
    handle: str = "",
    account_id: str = "",
    wallet: str = "",
    task_id: str = "",
    status: str = NETWORK_TASK_STATUS_TERMINAL,
    limit: int = 20,
    text_limit: int = 5000,
    include_raw_events: bool = False,
    database_url: str | None = None,
) -> dict[str, Any]:
    db_url = tasknode_database_url(database_url)
    identity = resolve_identity(
        handle=handle,
        account_id=account_id,
        wallet=wallet,
        task_id=task_id,
        database_url=db_url,
    )
    if not identity.get("resolved") and not task_id:
        return {
            "ok": False,
            "error": "identity_not_resolved",
            "identity": identity,
            "ontology": REVIEW_ONTOLOGY,
            "tasks": [],
            "secretPrinted": False,
        }
    rows = psql_json(
        db_url,
        _rewarded_network_tasks_sql(identity, task_id=task_id, status=status, limit=limit),
    ) or []
    tasks = [
        _compact_task_review(_safe_dict(row), include_raw_events=include_raw_events, text_limit=text_limit)
        for row in _safe_list(rows)
    ]
    return redact_secrets({
        "ok": True,
        "identity": identity,
        "ontology": REVIEW_ONTOLOGY,
        "query": {
            "handle": handle,
            "accountId": account_id,
            "walletAddress": wallet,
            "taskId": task_id,
            "status": status or "any",
            "limit": _safe_int(limit, default=20, maximum=200),
        },
        "count": len(tasks),
        "tasks": tasks,
        "secretPrinted": False,
    })


REVIEW_ONTOLOGY = {
    "Person": "Public handle/display identity resolved to account and wallet facts.",
    "Account": "Task Node account_id; account-scoped profile, memory, and public handle rows.",
    "Wallet": "PFTL classic address; wallet-scoped task offers, submissions, and rewards.",
    "NetworkTask": "task_projections row where task_kind=network, joined to allocation and generation job.",
    "TaskBrief": "Generated task offer: objective, steps, submission requirement, verification policy.",
    "SourcePacket": "Board Manager / generation-job source payload that explains why the task was routed.",
    "Submission": "pf.task.submission.v1 evidence payload supplied by the worker.",
    "VerificationResponse": "pf.task.verification_response.v1 follow-up evidence payload.",
    "RewardOutcome": "pf.reward.v1 or pf.task.reward_decision.v1 score, reason, feedback, and paid PFT.",
}
