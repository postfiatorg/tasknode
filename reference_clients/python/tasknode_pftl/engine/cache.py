from __future__ import annotations

from typing import Any

from tasknode_pftl.app_data import psql_json, sql_literal, tasknode_database_url
from tasknode_pftl.codec import now_iso, sha256_hex


def load_task_queue_summary(
    *,
    database_url: str | None = None,
    account_id: str = "",
    wallet_address: str = "",
    limit: int = 60,
) -> dict[str, Any]:
    db_url = tasknode_database_url(database_url)
    safe_limit = max(1, min(int(limit), 200))
    account_filter = ""
    wallet_filter = ""
    if account_id:
        account_filter = f"AND account_id = {sql_literal(account_id)}"
    if wallet_address:
        wallet_filter = f"AND subject_wallet = {sql_literal(wallet_address)}"
    sql = f"""
SELECT COALESCE(jsonb_agg(to_jsonb(row) ORDER BY row.updated_at DESC), '[]'::jsonb)
FROM (
  SELECT
    task_id,
    account_id,
    subject_wallet,
    authority_wallet,
    allocation_wallet,
    request_id,
    status,
    title,
    description,
    task_kind,
    reward_offer_pft,
    reward_actual_pft,
    request_bundle_cid,
    context_cid,
    submission_type,
    submission_requirement_text,
    verification_policy_json,
    updated_at,
    metadata_json
  FROM task_projections
  WHERE TRUE
    {account_filter}
    {wallet_filter}
  ORDER BY updated_at DESC, task_id DESC
  LIMIT {safe_limit}
) AS row;
"""
    rows = psql_json(db_url, sql) or []
    return summarize_task_queue(rows)


def summarize_task_queue(rows: list[dict[str, Any]]) -> dict[str, Any]:
    groups = {
        "outstanding": [],
        "pending_verification": [],
        "refused": [],
        "rewarded": [],
    }
    for row in rows:
        status = str(row.get("status") or "unknown").strip().lower()
        item = task_queue_item(row)
        if status == "rewarded":
            groups["rewarded"].append(item)
        elif status in {"verification_requested", "verification_response_submitted"}:
            groups["pending_verification"].append(item)
        elif status in {"refused", "rejected", "expired", "cancelled"}:
            groups["refused"].append(item)
        else:
            groups["outstanding"].append(item)
    groups["rewarded"] = groups["rewarded"][:12]
    groups["refused"] = groups["refused"][:10]
    return {
        "schema": "pf.task.queue_cache.v1",
        "generated_at": now_iso(),
        "source": "postgres_task_projections",
        "row_count": len(rows),
        "digest": "sha256:" + sha256_hex(rows),
        "groups": groups,
        "summary": {
            "outstanding": len(groups["outstanding"]),
            "pending_verification": len(groups["pending_verification"]),
            "refused": len(groups["refused"]),
            "rewarded": len(groups["rewarded"]),
        },
    }


def task_queue_item(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "task_id": row.get("task_id"),
        "status": row.get("status"),
        "title": row.get("title"),
        "task_kind": row.get("task_kind"),
        "reward_offer_pft": str(row.get("reward_offer_pft") or "0"),
        "reward_actual_pft": str(row.get("reward_actual_pft") or "0"),
        "submission_type": row.get("submission_type"),
        "updated_at": str(row.get("updated_at") or ""),
    }


def attach_task_queue_cache(
    bundle: dict[str, Any],
    *,
    database_url: str | None = None,
    account_id: str = "",
    wallet_address: str = "",
) -> dict[str, Any]:
    try:
        bundle["task_queue"] = load_task_queue_summary(
            database_url=database_url,
            account_id=account_id,
            wallet_address=wallet_address,
        )
    except Exception as exc:
        bundle["task_queue"] = {
            "schema": "pf.task.queue_cache.v1",
            "generated_at": now_iso(),
            "source": "postgres_task_projections",
            "status": "cache_unavailable",
            "error": f"{type(exc).__name__}: {exc}",
            "groups": {
                "outstanding": [],
                "pending_verification": [],
                "refused": [],
                "rewarded": [],
            },
            "summary": {
                "outstanding": 0,
                "pending_verification": 0,
                "refused": 0,
                "rewarded": 0,
            },
        }
    return bundle
