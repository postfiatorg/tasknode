from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import json
import os
import subprocess
from typing import Any, Callable, Iterator
from uuid import uuid4

from tasknode_pftl.app_data import sql_literal, tasknode_database_url

from .payload import redact_secrets


DEFAULT_ORC_RUNTIME_DIR = "~/.cache/tasknode/orc_runtime"
DEFAULT_ORC_RUNTIME_EVENTS_FILE = "orc_runtime_events.jsonl"
DEFAULT_ORC_RUNTIME_CLAIM_TTL_SECONDS = 6 * 60 * 60
ORC_RUNTIME_CLAIM_TTL_ENV = "TASKNODE_ORC_RUNTIME_CLAIM_TTL_SECONDS"
ORC_RUNTIME_DIRECTIVES_SCHEMA = "pf.orc.runtime_directives.v1"
RUNTIME_EVENT_ENQUEUED = "directive_enqueued"
RUNTIME_EVENT_CLAIMED = "directive_claimed"
RUNTIME_EVENT_COMPLETED = "directive_completed"
POSTGRES_DIRECTIVE_STATUSES = {"queued", "claimed", "completed", "failed", "cancelled"}
POSTGRES_TERMINAL_DIRECTIVE_STATUSES = {"completed", "failed", "cancelled"}
TERMINAL_DIRECTIVE_STATUSES = {"completed", "failed", "cancelled", "claimed_only"}
DATABASE_URL_ENV_KEYS = (
    "TASKNODEOFFICIAL_DATABASE_URL",
    "TASKNODE_APP_DATABASE_URL",
    "TASKNODE_DATABASE_URL",
    "DATABASE_URL",
)


def _safe_text(value: Any, limit: int = 4000) -> str:
    return str(value or "").strip()[:limit]


def _safe_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _jsonb_literal(value: dict[str, Any] | list[Any] | None) -> str:
    return sql_literal(json.dumps(redact_secrets(value if value is not None else {}), sort_keys=True)) + "::jsonb"


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _configured_database_url(database_url: str | None = None) -> str:
    if database_url:
        return database_url
    for key in DATABASE_URL_ENV_KEYS:
        value = os.environ.get(key)
        if value:
            return value
    return ""


def _runtime_claim_ttl_seconds(value: int | float | str | None = None) -> int:
    raw = value
    if raw is None:
        raw = os.environ.get(ORC_RUNTIME_CLAIM_TTL_ENV, "")
    if raw in (None, ""):
        return DEFAULT_ORC_RUNTIME_CLAIM_TTL_SECONDS
    try:
        parsed = int(float(str(raw).strip()))
    except (TypeError, ValueError):
        return DEFAULT_ORC_RUNTIME_CLAIM_TTL_SECONDS
    return max(0, min(parsed, 7 * 24 * 60 * 60))


def _normalize_completion_status(status: str = "completed") -> str:
    clean_status = _safe_text(status, 80).lower() or "completed"
    if clean_status == "claimed_only":
        return "completed"
    if clean_status not in POSTGRES_TERMINAL_DIRECTIVE_STATUSES:
        raise ValueError(f"unsupported terminal directive status: {clean_status}")
    return clean_status


def _run_psql(database_url: str, sql: str) -> str:
    result = subprocess.run(
        ["psql", "-X", "-q", "-t", "-A", "-v", "ON_ERROR_STOP=1", database_url, "-c", sql],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout or "psql failed").strip())
    return result.stdout.strip()


def _run_json(database_url: str, sql: str) -> Any:
    output = _run_psql(database_url, sql)
    lines = [line for line in output.splitlines() if line.strip()]
    if not lines:
        return None
    return json.loads(lines[-1])


def _directive_json_sql(alias: str = "d") -> str:
    return f"""jsonb_build_object(
      'directiveId', {alias}.directive_id,
      'orc', {alias}.orc,
      'directive', {alias}.directive,
      'taskId', {alias}.task_id,
      'source', {alias}.source,
      'metadata', {alias}.metadata_json,
      'status', {alias}.status::text,
      'workerId', {alias}.worker_id,
      'claimedAt', {alias}.claimed_at,
      'completedAt', {alias}.completed_at,
      'result', {alias}.result,
      'attemptCount', {alias}.attempt_count,
      'createdAt', {alias}.created_at,
      'updatedAt', {alias}.updated_at,
      'secretPrinted', false
    )"""


def orc_runtime_directives_schema_sql() -> str:
    return """
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type
    WHERE typname = 'orc_runtime_directive_status'
  ) THEN
    CREATE TYPE orc_runtime_directive_status AS ENUM (
      'queued',
      'claimed',
      'completed',
      'failed',
      'cancelled'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS orc_runtime_directives (
  directive_id text PRIMARY KEY,
  orc text NOT NULL DEFAULT '',
  directive text NOT NULL DEFAULT '',
  task_id text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT '',
  status orc_runtime_directive_status NOT NULL DEFAULT 'queued',
  worker_id text NOT NULL DEFAULT '',
  claimed_at timestamptz,
  completed_at timestamptz,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempt_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE orc_runtime_directives
  ADD COLUMN IF NOT EXISTS orc text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS directive text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS task_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS status orc_runtime_directive_status NOT NULL DEFAULT 'queued',
  ADD COLUMN IF NOT EXISTS worker_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS result jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS orc_runtime_directives_orc_status_created_idx
  ON orc_runtime_directives (orc, status, created_at);

CREATE INDEX IF NOT EXISTS orc_runtime_directives_status_created_idx
  ON orc_runtime_directives (status, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS orc_runtime_directives_claimed_worker_unique
  ON orc_runtime_directives (worker_id, status)
  WHERE status = 'claimed' AND worker_id <> '';
"""


def ensure_orc_runtime_directives_schema(*, database_url: str | None = None) -> dict[str, Any]:
    db_url = tasknode_database_url(database_url)
    sql = f"""
{orc_runtime_directives_schema_sql()}

SELECT jsonb_build_object(
  'ok', true,
  'table', 'orc_runtime_directives',
  'schema', {sql_literal(ORC_RUNTIME_DIRECTIVES_SCHEMA)},
  'secretPrinted', false
);
"""
    return redact_secrets(_run_json(db_url, sql) or {})


def _runtime_dir(runtime_dir: str = DEFAULT_ORC_RUNTIME_DIR) -> str:
    return os.path.expanduser(runtime_dir or DEFAULT_ORC_RUNTIME_DIR)


def runtime_events_path(runtime_dir: str = DEFAULT_ORC_RUNTIME_DIR) -> str:
    return os.path.join(_runtime_dir(runtime_dir), DEFAULT_ORC_RUNTIME_EVENTS_FILE)


def runtime_lock_path(runtime_dir: str = DEFAULT_ORC_RUNTIME_DIR) -> str:
    return os.path.join(_runtime_dir(runtime_dir), ".orc_runtime.lock")


@contextmanager
def _runtime_lock(runtime_dir: str = DEFAULT_ORC_RUNTIME_DIR) -> Iterator[str]:
    directory = _runtime_dir(runtime_dir)
    os.makedirs(directory, exist_ok=True)
    lock_path = runtime_lock_path(directory)
    with open(lock_path, "a", encoding="utf-8") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield runtime_events_path(directory)
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def _read_events_unlocked(path: str) -> list[dict[str, Any]]:
    if not os.path.exists(path):
        return []
    rows: list[dict[str, Any]] = []
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            try:
                parsed = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(parsed, dict):
                rows.append(redact_secrets(parsed))
    return rows


def _append_event_unlocked(path: str, event: dict[str, Any]) -> dict[str, Any]:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    clean_event = redact_secrets(event)
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(clean_event, sort_keys=True) + "\n")
    return clean_event


def read_runtime_events(*, runtime_dir: str = DEFAULT_ORC_RUNTIME_DIR) -> list[dict[str, Any]]:
    with _runtime_lock(runtime_dir) as path:
        return _read_events_unlocked(path)


def _state_from_events(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    directives: dict[str, dict[str, Any]] = {}
    for event in events:
        event_type = _safe_text(event.get("eventType"), 80)
        directive_id = _safe_text(event.get("directiveId"), 160)
        if not directive_id:
            continue
        if event_type == RUNTIME_EVENT_ENQUEUED:
            directives[directive_id] = {
                "directiveId": directive_id,
                "orc": _safe_text(event.get("orc"), 120),
                "directive": _safe_text(event.get("directive"), 100000),
                "taskId": _safe_text(event.get("taskId"), 180),
                "source": _safe_text(event.get("source"), 160),
                "metadata": _safe_dict(event.get("metadata")),
                "status": "queued",
                "createdAt": event.get("createdAt"),
                "updatedAt": event.get("createdAt"),
                "secretPrinted": False,
            }
            continue
        directive = directives.get(directive_id)
        if not directive:
            continue
        if event_type == RUNTIME_EVENT_CLAIMED:
            directive.update({
                "status": "claimed",
                "workerId": _safe_text(event.get("workerId"), 180),
                "claimedAt": event.get("claimedAt"),
                "updatedAt": event.get("claimedAt"),
            })
        elif event_type == RUNTIME_EVENT_COMPLETED:
            directive.update({
                "status": _safe_text(event.get("status"), 80) or "completed",
                "workerId": _safe_text(event.get("workerId"), 180) or directive.get("workerId", ""),
                "completedAt": event.get("completedAt"),
                "updatedAt": event.get("completedAt"),
                "result": _safe_dict(event.get("result")),
            })
    return sorted(directives.values(), key=lambda row: (row.get("createdAt") or "", row.get("directiveId") or ""))


def _postgres_runtime_directives(*, database_url: str, orc: str = "") -> list[dict[str, Any]]:
    ensure_orc_runtime_directives_schema(database_url=database_url)
    wanted = _safe_text(orc, 120).lstrip("@").lower()
    filter_sql = ""
    if wanted:
        filter_sql = f"WHERE lower(ltrim(orc, '@')) = {sql_literal(wanted)}"
    sql = f"""
SELECT COALESCE(jsonb_agg(row.directive ORDER BY row.created_at ASC, row.directive_id ASC), '[]'::jsonb)
FROM (
  SELECT
    d.directive_id,
    d.created_at,
    {_directive_json_sql("d")} AS directive
  FROM orc_runtime_directives d
  {filter_sql}
  ORDER BY d.created_at ASC, d.directive_id ASC
) row;
"""
    rows = _run_json(database_url, sql)
    return [redact_secrets(row) for row in (rows if isinstance(rows, list) else [])]


def _postgres_runtime_status(*, database_url: str, orc: str = "") -> dict[str, Any]:
    rows = _postgres_runtime_directives(database_url=database_url, orc=orc)
    counts: dict[str, int] = {}
    for row in rows:
        status = _safe_text(row.get("status"), 80) or "unknown"
        counts[status] = counts.get(status, 0) + 1
    return redact_secrets({
        "ok": True,
        "backend": "postgres",
        "table": "orc_runtime_directives",
        "schema": ORC_RUNTIME_DIRECTIVES_SCHEMA,
        "orc": _safe_text(orc, 120).lstrip("@"),
        "count": len(rows),
        "statusCounts": counts,
        "directives": rows,
        "secretPrinted": False,
    })


def _postgres_enqueue_runtime_directive(
    *,
    database_url: str,
    orc: str,
    directive: str,
    task_id: str = "",
    source: str = "nazgul",
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    ensure_orc_runtime_directives_schema(database_url=database_url)
    directive_id = f"orcdirective_{uuid4()}"
    normalized_orc = _safe_text(orc, 120).lstrip("@").lower()
    clean_task_id = _safe_text(task_id, 180)
    clean_source = _safe_text(source, 160)
    clean_metadata = redact_secrets(metadata or {})
    active_dedup_sql = ""
    active_dedup_enabled = "false"
    if clean_task_id:
        active_dedup_sql = f"""
SELECT pg_advisory_xact_lock(hashtext({sql_literal(f"orc_runtime_directive:{normalized_orc}:{clean_source}:{clean_task_id}")}));
"""
        active_dedup_enabled = "true"
    sql = f"""
BEGIN;
{active_dedup_sql}
WITH existing AS (
  SELECT *
  FROM orc_runtime_directives
  WHERE {active_dedup_enabled}
    AND task_id = {sql_literal(clean_task_id)}
    AND source = {sql_literal(clean_source)}
    AND lower(ltrim(orc, '@')) = {sql_literal(normalized_orc)}
    AND status IN ('queued', 'claimed')
  ORDER BY created_at ASC, directive_id ASC
  LIMIT 1
),
inserted AS (
  INSERT INTO orc_runtime_directives (
    directive_id,
    orc,
    directive,
    task_id,
    source,
    metadata_json,
    updated_at
  )
  SELECT
    {sql_literal(directive_id)},
    {sql_literal(orc)},
    {sql_literal(directive)},
    {sql_literal(clean_task_id)},
    {sql_literal(clean_source)},
    {_jsonb_literal(clean_metadata)},
    now()
  WHERE NOT EXISTS (SELECT 1 FROM existing)
  RETURNING *
)
SELECT COALESCE(
  (SELECT jsonb_build_object(
    'ok', true,
    'queued', true,
    'idempotent', false,
    'directive', {_directive_json_sql("inserted")},
    'secretPrinted', false
  ) FROM inserted),
  (SELECT jsonb_build_object(
    'ok', true,
    'queued', false,
    'idempotent', true,
    'reason', 'active_directive_exists',
    'directive', {_directive_json_sql("existing")},
    'secretPrinted', false
  ) FROM existing),
  jsonb_build_object(
    'ok', false,
    'queued', false,
    'error', 'runtime_enqueue_failed',
    'secretPrinted', false
  )
);
COMMIT;
"""
    payload = _run_json(database_url, sql) or {}
    stored = _safe_dict(payload.get("directive"))
    return redact_secrets({
        "ok": bool(payload.get("ok", True)),
        "queued": bool(payload.get("queued")),
        "idempotent": bool(payload.get("idempotent")),
        "reason": payload.get("reason", ""),
        "backend": "postgres",
        "directiveId": stored.get("directiveId") or directive_id,
        "orc": orc,
        "taskId": stored.get("taskId", ""),
        "source": stored.get("source", ""),
        "table": "orc_runtime_directives",
        "directivePreview": directive[:500],
        "secretPrinted": False,
    })


def _postgres_claim_next_runtime_directive(
    *,
    database_url: str,
    orc: str,
    worker_id: str = "",
    claim_ttl_seconds: int | None = None,
) -> dict[str, Any]:
    ensure_orc_runtime_directives_schema(database_url=database_url)
    normalized_orc = _safe_text(orc, 120).lstrip("@").lower()
    clean_worker = _safe_text(worker_id, 180) or f"orcworker_{uuid4()}"
    ttl_seconds = _runtime_claim_ttl_seconds(claim_ttl_seconds)
    sql = f"""
BEGIN;
WITH busy AS (
  SELECT directive_id
  FROM orc_runtime_directives
  WHERE status = 'claimed'
    AND worker_id = {sql_literal(clean_worker)}
    AND NOT (
      {ttl_seconds} > 0
      AND claimed_at IS NOT NULL
      AND claimed_at < now() - make_interval(secs => {ttl_seconds})
    )
  LIMIT 1
),
stale_candidate AS (
  SELECT directive_id
  FROM orc_runtime_directives
  WHERE {ttl_seconds} > 0
    AND status = 'claimed'
    AND lower(ltrim(orc, '@')) = {sql_literal(normalized_orc)}
    AND claimed_at IS NOT NULL
    AND claimed_at < now() - make_interval(secs => {ttl_seconds})
    AND NOT EXISTS (SELECT 1 FROM busy)
  ORDER BY claimed_at ASC, directive_id ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1
),
stale_selected AS (
  SELECT
    d.directive_id,
    d.worker_id AS previous_worker_id,
    d.claimed_at AS previous_claimed_at
  FROM orc_runtime_directives d
  JOIN stale_candidate c
    ON c.directive_id = d.directive_id
  FOR UPDATE
),
queued_candidate AS (
  SELECT directive_id
  FROM orc_runtime_directives
  WHERE status = 'queued'
    AND lower(ltrim(orc, '@')) = {sql_literal(normalized_orc)}
    AND NOT EXISTS (SELECT 1 FROM busy)
    AND NOT EXISTS (SELECT 1 FROM stale_selected)
  ORDER BY created_at ASC, directive_id ASC
  FOR UPDATE SKIP LOCKED
  LIMIT 1
),
candidate AS (
  SELECT directive_id, true AS recovered_stale FROM stale_selected
  UNION ALL
  SELECT directive_id, false AS recovered_stale FROM queued_candidate
),
updated AS (
  UPDATE orc_runtime_directives d
  SET
    status = 'claimed',
    worker_id = {sql_literal(clean_worker)},
    claimed_at = now(),
    attempt_count = attempt_count + 1,
    metadata_json = CASE
      WHEN c.recovered_stale THEN
        COALESCE(d.metadata_json, '{{}}'::jsonb) || jsonb_build_object(
          'lastStaleClaimRecovery',
          jsonb_build_object(
            'workerId', COALESCE((SELECT previous_worker_id FROM stale_selected LIMIT 1), ''),
            'claimedAt', (SELECT previous_claimed_at FROM stale_selected LIMIT 1),
            'recoveredAt', now(),
            'claimTtlSeconds', {ttl_seconds}
          )
        )
      ELSE d.metadata_json
    END,
    updated_at = now()
  FROM candidate c
  WHERE d.directive_id = c.directive_id
  RETURNING d.*, c.recovered_stale
)
SELECT jsonb_build_object(
  'ok', true,
  'claimed', EXISTS (SELECT 1 FROM updated),
  'workerBusy', EXISTS (SELECT 1 FROM busy),
  'orc', {sql_literal(orc)},
  'workerId', {sql_literal(clean_worker)},
  'claimTtlSeconds', {ttl_seconds},
  'staleClaimRecovered', COALESCE((SELECT recovered_stale FROM updated LIMIT 1), false),
  'backend', 'postgres',
  'directive', COALESCE((SELECT {_directive_json_sql("updated")} FROM updated), '{{}}'::jsonb),
  'secretPrinted', false
);
COMMIT;
"""
    payload = _run_json(database_url, sql) or {}
    return redact_secrets(payload)


def _postgres_complete_runtime_directive(
    *,
    database_url: str,
    directive_id: str,
    status: str = "completed",
    result: dict[str, Any] | None = None,
    worker_id: str = "",
) -> dict[str, Any]:
    ensure_orc_runtime_directives_schema(database_url=database_url)
    clean_status = _normalize_completion_status(status)
    clean_result = redact_secrets(result or {})
    clean_worker = _safe_text(worker_id, 180)
    sql = f"""
BEGIN;
WITH selected AS (
  SELECT *
  FROM orc_runtime_directives
  WHERE directive_id = {sql_literal(directive_id)}
  FOR UPDATE
),
eligible AS (
  SELECT *
  FROM selected s
  WHERE s.status = 'claimed'
    AND (
      s.worker_id = ''
      OR s.worker_id = {sql_literal(clean_worker)}
    )
),
updated AS (
  UPDATE orc_runtime_directives d
  SET
    status = {sql_literal(clean_status)}::orc_runtime_directive_status,
    worker_id = COALESCE(NULLIF({sql_literal(clean_worker)}, ''), d.worker_id),
    completed_at = now(),
    result = {_jsonb_literal(clean_result)},
    updated_at = now()
  FROM eligible s
  WHERE d.directive_id = s.directive_id
  RETURNING d.*
)
SELECT COALESCE(
  (SELECT jsonb_build_object(
    'ok', true,
    'completed', true,
    'backend', 'postgres',
    'directive', {_directive_json_sql("updated")},
    'secretPrinted', false
  ) FROM updated),
  (SELECT jsonb_build_object(
    'ok', true,
    'completed', false,
    'alreadyTerminal', s.status IN ('completed', 'failed', 'cancelled'),
    'backend', 'postgres',
    'directive', {_directive_json_sql("s")},
    'secretPrinted', false
  ) FROM selected s WHERE s.status IN ('completed', 'failed', 'cancelled')),
  (SELECT jsonb_build_object(
    'ok', false,
    'completed', false,
    'error', 'directive_not_claimed',
    'backend', 'postgres',
    'directive', {_directive_json_sql("s")},
    'secretPrinted', false
  ) FROM selected s WHERE s.status NOT IN ('claimed', 'completed', 'failed', 'cancelled')),
  (SELECT jsonb_build_object(
    'ok', false,
    'completed', false,
    'error', 'directive_worker_mismatch',
    'workerId', {sql_literal(clean_worker)},
    'expectedWorkerId', s.worker_id,
    'backend', 'postgres',
    'directive', {_directive_json_sql("s")},
    'secretPrinted', false
  ) FROM selected s WHERE s.status = 'claimed' AND s.worker_id <> '' AND s.worker_id <> {sql_literal(clean_worker)}),
  jsonb_build_object(
    'ok', false,
    'completed', false,
    'error', 'unknown_directive',
    'directiveId', {sql_literal(directive_id)},
    'backend', 'postgres',
    'secretPrinted', false
  )
);
COMMIT;
"""
    payload = _run_json(database_url, sql) or {}
    if payload.get("error") == "unknown_directive":
        raise ValueError(f"unknown directive: {directive_id}")
    return redact_secrets(payload)


def runtime_directives(
    *,
    runtime_dir: str = DEFAULT_ORC_RUNTIME_DIR,
    orc: str = "",
    database_url: str | None = None,
) -> list[dict[str, Any]]:
    db_url = _configured_database_url(database_url)
    if db_url:
        return _postgres_runtime_directives(database_url=db_url, orc=orc)
    wanted = _safe_text(orc, 120).lstrip("@").lower()
    rows = _state_from_events(read_runtime_events(runtime_dir=runtime_dir))
    if wanted:
        rows = [row for row in rows if _safe_text(row.get("orc"), 120).lstrip("@").lower() == wanted]
    return [redact_secrets(row) for row in rows]


def runtime_status(
    *,
    runtime_dir: str = DEFAULT_ORC_RUNTIME_DIR,
    orc: str = "",
    database_url: str | None = None,
) -> dict[str, Any]:
    db_url = _configured_database_url(database_url)
    if db_url:
        return _postgres_runtime_status(database_url=db_url, orc=orc)
    rows = runtime_directives(runtime_dir=runtime_dir, orc=orc, database_url="")
    counts: dict[str, int] = {}
    for row in rows:
        status = _safe_text(row.get("status"), 80) or "unknown"
        counts[status] = counts.get(status, 0) + 1
    return redact_secrets({
        "ok": True,
        "backend": "jsonl",
        "runtimeDir": _runtime_dir(runtime_dir),
        "eventsPath": runtime_events_path(runtime_dir),
        "orc": _safe_text(orc, 120).lstrip("@"),
        "count": len(rows),
        "statusCounts": counts,
        "directives": rows,
        "secretPrinted": False,
    })


def enqueue_runtime_directive(
    *,
    orc: str,
    directive: str,
    task_id: str = "",
    source: str = "nazgul",
    metadata: dict[str, Any] | None = None,
    runtime_dir: str = DEFAULT_ORC_RUNTIME_DIR,
    database_url: str | None = None,
) -> dict[str, Any]:
    clean_orc = _safe_text(orc, 120).lstrip("@")
    clean_directive = _safe_text(directive, 100000)
    if not clean_orc:
        raise ValueError("orc is required")
    if not clean_directive:
        raise ValueError("directive is required")
    db_url = _configured_database_url(database_url)
    if db_url:
        return _postgres_enqueue_runtime_directive(
            database_url=db_url,
            orc=clean_orc,
            directive=clean_directive,
            task_id=_safe_text(task_id, 180),
            source=_safe_text(source, 160),
            metadata=metadata or {},
        )
    event = {
        "eventType": RUNTIME_EVENT_ENQUEUED,
        "directiveId": f"orcdirective_{uuid4()}",
        "orc": clean_orc,
        "directive": clean_directive,
        "taskId": _safe_text(task_id, 180),
        "source": _safe_text(source, 160),
        "metadata": metadata or {},
        "createdAt": _utcnow(),
        "secretPrinted": False,
    }
    with _runtime_lock(runtime_dir) as path:
        active_task_id = _safe_text(task_id, 180)
        active_source = _safe_text(source, 160)
        if active_task_id:
            rows = _state_from_events(_read_events_unlocked(path))
            existing = next(
                (
                    row for row in rows
                    if _safe_text(row.get("taskId"), 180) == active_task_id
                    and _safe_text(row.get("source"), 160) == active_source
                    and _safe_text(row.get("orc"), 120).lstrip("@").lower() == clean_orc.lower()
                    and _safe_text(row.get("status"), 80) in {"queued", "claimed"}
                ),
                None,
            )
            if existing:
                return redact_secrets({
                    "ok": True,
                    "queued": False,
                    "idempotent": True,
                    "reason": "active_directive_exists",
                    "backend": "jsonl",
                    "directiveId": existing.get("directiveId"),
                    "orc": clean_orc,
                    "taskId": existing.get("taskId", ""),
                    "source": existing.get("source", ""),
                    "eventsPath": runtime_events_path(runtime_dir),
                    "directivePreview": _safe_text(existing.get("directive"), 500),
                    "secretPrinted": False,
                })
        stored = _append_event_unlocked(path, event)
    return redact_secrets({
        "ok": True,
        "queued": True,
        "idempotent": False,
        "backend": "jsonl",
        "directiveId": stored["directiveId"],
        "orc": clean_orc,
        "taskId": stored.get("taskId", ""),
        "source": stored.get("source", ""),
        "eventsPath": runtime_events_path(runtime_dir),
        "directivePreview": clean_directive[:500],
        "secretPrinted": False,
    })


def claim_next_runtime_directive(
    *,
    orc: str,
    worker_id: str = "",
    runtime_dir: str = DEFAULT_ORC_RUNTIME_DIR,
    database_url: str | None = None,
    claim_ttl_seconds: int | None = None,
) -> dict[str, Any]:
    clean_orc = _safe_text(orc, 120).lstrip("@")
    if not clean_orc:
        raise ValueError("orc is required")
    db_url = _configured_database_url(database_url)
    if db_url:
        return _postgres_claim_next_runtime_directive(
            database_url=db_url,
            orc=clean_orc,
            worker_id=worker_id,
            claim_ttl_seconds=claim_ttl_seconds,
        )
    normalized_orc = clean_orc.lower()
    clean_worker = _safe_text(worker_id, 180) or f"orcworker_{uuid4()}"
    with _runtime_lock(runtime_dir) as path:
        rows = _state_from_events(_read_events_unlocked(path))
        selected = next(
            (
                row for row in rows
                if row.get("status") == "queued"
                and _safe_text(row.get("orc"), 120).lstrip("@").lower() == normalized_orc
            ),
            None,
        )
        if not selected:
            return {
                "ok": True,
                "claimed": False,
                "backend": "jsonl",
                "orc": clean_orc,
                "workerId": clean_worker,
                "secretPrinted": False,
            }
        event = {
            "eventType": RUNTIME_EVENT_CLAIMED,
            "directiveId": selected["directiveId"],
            "orc": clean_orc,
            "workerId": clean_worker,
            "claimedAt": _utcnow(),
            "secretPrinted": False,
        }
        _append_event_unlocked(path, event)
        selected.update({
            "status": "claimed",
            "workerId": clean_worker,
            "claimedAt": event["claimedAt"],
            "updatedAt": event["claimedAt"],
        })
    return redact_secrets({
        "ok": True,
        "claimed": True,
        "backend": "jsonl",
        "directive": selected,
        "secretPrinted": False,
    })


def complete_runtime_directive(
    *,
    directive_id: str,
    status: str = "completed",
    result: dict[str, Any] | None = None,
    worker_id: str = "",
    runtime_dir: str = DEFAULT_ORC_RUNTIME_DIR,
    database_url: str | None = None,
) -> dict[str, Any]:
    clean_directive_id = _safe_text(directive_id, 180)
    clean_status = _normalize_completion_status(status)
    if not clean_directive_id:
        raise ValueError("directive_id is required")
    db_url = _configured_database_url(database_url)
    if db_url:
        return _postgres_complete_runtime_directive(
            database_url=db_url,
            directive_id=clean_directive_id,
            status=clean_status,
            result=result or {},
            worker_id=worker_id,
        )
    with _runtime_lock(runtime_dir) as path:
        rows = _state_from_events(_read_events_unlocked(path))
        selected = next((row for row in rows if row.get("directiveId") == clean_directive_id), None)
        if not selected:
            raise ValueError(f"unknown directive: {clean_directive_id}")
        if _safe_text(selected.get("status"), 80) in TERMINAL_DIRECTIVE_STATUSES:
            return redact_secrets({
                "ok": True,
                "completed": False,
                "alreadyTerminal": True,
                "backend": "jsonl",
                "directive": selected,
                "secretPrinted": False,
            })
        selected_status = _safe_text(selected.get("status"), 80)
        if selected_status != "claimed":
            return redact_secrets({
                "ok": False,
                "completed": False,
                "error": "directive_not_claimed",
                "backend": "jsonl",
                "directive": selected,
                "secretPrinted": False,
            })
        clean_worker = _safe_text(worker_id, 180)
        claimed_worker = _safe_text(selected.get("workerId"), 180)
        if claimed_worker and clean_worker != claimed_worker:
            return redact_secrets({
                "ok": False,
                "completed": False,
                "error": "directive_worker_mismatch",
                "workerId": clean_worker,
                "expectedWorkerId": claimed_worker,
                "backend": "jsonl",
                "directive": selected,
                "secretPrinted": False,
            })
        event = {
            "eventType": RUNTIME_EVENT_COMPLETED,
            "directiveId": clean_directive_id,
            "orc": selected.get("orc", ""),
            "workerId": clean_worker or claimed_worker,
            "status": clean_status,
            "result": result or {},
            "completedAt": _utcnow(),
            "secretPrinted": False,
        }
        _append_event_unlocked(path, event)
        selected.update({
            "status": clean_status,
            "result": result or {},
            "completedAt": event["completedAt"],
            "updatedAt": event["completedAt"],
        })
    return redact_secrets({
        "ok": True,
        "completed": True,
        "backend": "jsonl",
        "directive": selected,
        "secretPrinted": False,
    })


def run_runtime_once(
    *,
    orc: str,
    worker_id: str = "",
    runtime_dir: str = DEFAULT_ORC_RUNTIME_DIR,
    database_url: str | None = None,
    claim_ttl_seconds: int | None = None,
    executor: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    claimed = claim_next_runtime_directive(
        orc=orc,
        worker_id=worker_id,
        runtime_dir=runtime_dir,
        database_url=database_url,
        claim_ttl_seconds=claim_ttl_seconds,
    )
    if not claimed.get("claimed"):
        return claimed
    directive = _safe_dict(claimed.get("directive"))
    if not executor:
        result = {
            "mode": "prototype_claim_only",
            "nextStep": "A production Orc runtime must hand this claimed directive to a supervised worker before completing it.",
            "directivePreview": _safe_text(directive.get("directive"), 500),
            "secretPrinted": False,
        }
        preview = dict(directive)
        preview["result"] = result
        return redact_secrets({
            "ok": True,
            "claimed": True,
            "completed": False,
            "backend": claimed.get("backend"),
            "directive": preview,
            "secretPrinted": False,
        })
    result = executor(directive)
    status = _safe_text(result.get("status"), 80) or "completed"
    completed = complete_runtime_directive(
        directive_id=directive["directiveId"],
        status=status,
        result=result,
        worker_id=_safe_text(worker_id, 180) or _safe_text(directive.get("workerId"), 180),
        runtime_dir=runtime_dir,
        database_url=database_url,
    )
    return redact_secrets({
        "ok": True,
        "claimed": True,
        "completed": completed.get("completed", False),
        "backend": completed.get("backend") or claimed.get("backend"),
        "directive": completed.get("directive"),
        "secretPrinted": False,
    })
