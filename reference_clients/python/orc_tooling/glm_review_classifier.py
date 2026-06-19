from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import time
from typing import Any
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests


DEFAULT_MODEL = "z-ai/glm-5.2"
PROMPT_VERSION = "orc_network_task_review_triage_v1"
DEFAULT_EXPORT = "/tmp/live-directory-rewarded-tasks-v2.json"
DEFAULT_CACHE_ROOT = Path(__file__).resolve().parents[1] / "runs" / "orc_network_glm52_review"
DEFAULT_ENV_FILES = (
    Path("/home/pfrpc/.hermes/.env"),
    Path("/home/pfrpc/repos/tasknodeofficial/.env.tasknodeofficial-dev"),
)

CATEGORIES = (
    "suspicious_low_value",
    "important_network_function",
    "highly_valuable",
)

PROMPT = """You are a Task Node Orc reviewer triaging rewarded Network tasks.

You receive a batch of live Directory task packets. These are rewarded Network task projections, not full forensic evidence. Classify each packet for Orc review routing.

Use exactly one primaryCategory for each task:
- suspicious_low_value: likely low-value, generic, repetitive, overpaid relative to described work, unclear deliverable, automation/sybil-shaped, or needs integrity review before trusting the reward. This is a triage signal, not proof of fraud.
- important_network_function: materially affects Task Node core function, reward routing/accounting, task lifecycle, Board Manager/Hive routing, protocol/API correctness, operator tooling, verification, or production reliability.
- highly_valuable: strong evidence of broad user/product/research value or high-quality operational insight, even if not directly core-protocol critical.

Score each dimension from 0-100:
- suspiciousLowValueScore: likelihood this is low-value, generic, duplicated, overpaid, or sybil-shaped from the packet.
- networkFunctionScore: importance to core network function, protocol correctness, task/reward integrity, or operator execution.
- highValueScore: overall strategic/user/research value if the work was real and useful.
- reviewPriorityScore: how urgently Orcs should inspect this rewarded task before other review work.

Rules:
- Base claims only on the packet fields. If submitted evidence content is not present, say "projection packet only" in evidenceSignals or riskSignals where relevant.
- Do not mark everything high priority. Separate genuine core risk from ordinary useful work.
- If a title is a broad implementation claim with large reward and no evidence body in packet, raise suspiciousLowValueScore and recommend manual review or integrity review.
- If the task names sybil detection, duplicate rewards, routing, verification, ledger/payment correctness, context pointers, Board Manager, Hive Secretary, or review tooling, raise networkFunctionScore.
- If a task seems useful but self-contained with no core action required, use highly_valuable only when the packet shows concrete value; otherwise suspicious_low_value or important_network_function as appropriate.
- Keep reasoning short and operational.

Return exactly one JSON object:
{
  "classifications": [
    {
      "taskId": "task_...",
      "primaryCategory": "suspicious_low_value|important_network_function|highly_valuable",
      "suspiciousLowValueScore": 0,
      "networkFunctionScore": 0,
      "highValueScore": 0,
      "reviewPriorityScore": 0,
      "recommendedAction": "no_action|manual_review|request_followup_task|core_backlog|integrity_review",
      "confidence": "low|medium|high",
      "reasoning": "one concise sentence",
      "evidenceSignals": ["packet-grounded signal"],
      "riskSignals": ["packet-grounded risk or missing evidence"]
    }
  ]
}
"""


def _utc_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _safe_text(value: Any, limit: int = 1200) -> str:
    return str(value or "").replace("\n", " ").strip()[:limit]


def _safe_number(value: Any, default: float = 0.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return round(number, 6)


def _bounded_score(value: Any) -> int:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0
    return int(max(0, min(100, round(number))))


def _load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(errors="ignore").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        key = key.strip()
        if key in os.environ:
            continue
        value = value.strip().strip('"').strip("'")
        os.environ[key] = value


def ensure_openrouter_key(env_files: list[Path] | None = None) -> str:
    for path in env_files or list(DEFAULT_ENV_FILES):
        _load_env_file(path)
    key = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if not key:
        raise RuntimeError("OPENROUTER_API_KEY missing")
    return key


def load_network_tasks(export_path: Path) -> list[dict[str, Any]]:
    document = json.loads(export_path.read_text())
    rows = document.get("tasks") or []
    tasks = [
        row for row in rows
        if isinstance(row, dict) and _safe_text(row.get("taskKind"), 40).lower() == "network"
    ]
    return tasks


def compact_packet(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "taskId": _safe_text(row.get("taskId"), 180),
        "handle": _safe_text(row.get("handle"), 120),
        "wallet": _safe_text(row.get("wallet"), 180),
        "accountId": _safe_text(row.get("accountId"), 180),
        "requestId": _safe_text(row.get("requestId"), 180),
        "status": _safe_text(row.get("status"), 80),
        "taskKind": _safe_text(row.get("taskKind"), 80),
        "rewardPft": _safe_number(row.get("rewardPft")),
        "rewardOfferPft": _safe_number(row.get("rewardOfferPft")),
        "title": _safe_text(row.get("title"), 260),
        "description": _safe_text(row.get("description"), 900),
        "submissionRequirement": _safe_text(row.get("submissionRequirement"), 900),
        "requestBundleCid": _safe_text(row.get("requestBundleCid"), 180),
        "contextCid": _safe_text(row.get("contextCid"), 180),
        "lastEventCid": _safe_text(row.get("lastEventCid"), 180),
        "lastEventTxHash": _safe_text(row.get("lastEventTxHash"), 180),
        "eventCount": row.get("eventCount"),
        "updatedAt": _safe_text(row.get("updatedAt"), 80),
    }


def _chunks(items: list[dict[str, Any]], size: int) -> list[list[dict[str, Any]]]:
    return [items[index:index + size] for index in range(0, len(items), size)]


def _parse_json_content(text: str) -> dict[str, Any]:
    try:
        parsed = json.loads(text)
        return parsed if isinstance(parsed, dict) else {}
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, flags=re.S)
        if not match:
            raise
        parsed = json.loads(match.group(0))
        return parsed if isinstance(parsed, dict) else {}


def classify_batch(
    packets: list[dict[str, Any]],
    *,
    api_key: str,
    model: str,
    timeout: float,
    session: requests.Session,
) -> tuple[dict[str, Any], dict[str, Any]]:
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": PROMPT},
            {
                "role": "user",
                "content": "\n".join([
                    "CLASSIFY THESE LIVE NETWORK TASK PACKETS",
                    "Return one classification per packet, preserving taskId exactly.",
                    "```json",
                    json.dumps({"packets": packets}, indent=2, sort_keys=True),
                    "```",
                ]),
            },
        ],
        "response_format": {"type": "json_object"},
        "provider": {"data_collection": "deny", "require_parameters": True},
        "temperature": 0,
        "max_tokens": min(5000, max(900, len(packets) * 650)),
        "usage": {"include": True},
        "metadata": {
            "app": "tasknode-orc-tooling",
            "worker": "orc_network_glm52_review_classifier",
            "prompt_version": PROMPT_VERSION,
        },
    }
    headers = {
        "authorization": f"Bearer {api_key}",
        "content-type": "application/json",
        "http-referer": os.environ.get("OPENROUTER_REFERER") or "https://tasknode.postfiat.org",
        "x-title": os.environ.get("OPENROUTER_TITLE") or "Task Node Orc Network Review",
        "x-openrouter-title": os.environ.get("OPENROUTER_TITLE") or "Task Node Orc Network Review",
    }
    response = session.post(
        "https://openrouter.ai/api/v1/chat/completions",
        headers=headers,
        json=body,
        timeout=timeout,
    )
    try:
        raw = response.json()
    except ValueError:
        raw = {"text": response.text}
    if response.status_code >= 400:
        message = raw.get("error", {}).get("message") if isinstance(raw.get("error"), dict) else response.text
        raise RuntimeError(f"openrouter_http_{response.status_code}: {_safe_text(message, 1000)}")
    choices = raw.get("choices") or []
    content = ""
    if choices and isinstance(choices[0], dict):
        content = str((choices[0].get("message") or {}).get("content") or "")
    parse_error = ""
    try:
        parsed = _parse_json_content(content)
    except Exception as exc:  # noqa: BLE001 - cached for audit and retry handling.
        parsed = {}
        parse_error = str(exc)
    if parse_error:
        raw["parseError"] = parse_error
        raw["rawContent"] = _safe_text(content, 4000)
    return parsed, raw


def normalize_classification(raw: dict[str, Any], packet: dict[str, Any]) -> dict[str, Any]:
    if not raw:
        return {
            "taskId": packet["taskId"],
            "handle": packet["handle"],
            "wallet": packet["wallet"],
            "rewardPft": packet["rewardPft"],
            "title": packet["title"],
            "primaryCategory": "suspicious_low_value",
            "suspiciousLowValueScore": 0,
            "networkFunctionScore": 0,
            "highValueScore": 0,
            "reviewPriorityScore": 50,
            "recommendedAction": "manual_review",
            "confidence": "low",
            "reasoning": "GLM response missing or unparsable; manual review required before trusting this packet classification.",
            "evidenceSignals": ["projection packet only"],
            "riskSignals": ["model classification missing"],
            "requestId": packet["requestId"],
            "lastEventTxHash": packet["lastEventTxHash"],
            "lastEventCid": packet["lastEventCid"],
            "requestBundleCid": packet["requestBundleCid"],
            "contextCid": packet["contextCid"],
            "updatedAt": packet["updatedAt"],
        }
    primary = _safe_text(raw.get("primaryCategory"), 80)
    if primary not in CATEGORIES:
        scores = {
            "suspicious_low_value": _bounded_score(raw.get("suspiciousLowValueScore")),
            "important_network_function": _bounded_score(raw.get("networkFunctionScore")),
            "highly_valuable": _bounded_score(raw.get("highValueScore")),
        }
        primary = max(scores, key=scores.get)
    action = _safe_text(raw.get("recommendedAction"), 80)
    if action not in {"no_action", "manual_review", "request_followup_task", "core_backlog", "integrity_review"}:
        action = "manual_review"
    confidence = _safe_text(raw.get("confidence"), 20).lower()
    if confidence not in {"low", "medium", "high"}:
        confidence = "medium"
    return {
        "taskId": packet["taskId"],
        "handle": packet["handle"],
        "wallet": packet["wallet"],
        "rewardPft": packet["rewardPft"],
        "title": packet["title"],
        "primaryCategory": primary,
        "suspiciousLowValueScore": _bounded_score(raw.get("suspiciousLowValueScore")),
        "networkFunctionScore": _bounded_score(raw.get("networkFunctionScore")),
        "highValueScore": _bounded_score(raw.get("highValueScore")),
        "reviewPriorityScore": _bounded_score(raw.get("reviewPriorityScore")),
        "recommendedAction": action,
        "confidence": confidence,
        "reasoning": _safe_text(raw.get("reasoning"), 500),
        "evidenceSignals": [_safe_text(item, 240) for item in raw.get("evidenceSignals", [])[:8]]
        if isinstance(raw.get("evidenceSignals"), list) else [],
        "riskSignals": [_safe_text(item, 240) for item in raw.get("riskSignals", [])[:8]]
        if isinstance(raw.get("riskSignals"), list) else [],
        "requestId": packet["requestId"],
        "lastEventTxHash": packet["lastEventTxHash"],
        "lastEventCid": packet["lastEventCid"],
        "requestBundleCid": packet["requestBundleCid"],
        "contextCid": packet["contextCid"],
        "updatedAt": packet["updatedAt"],
    }


def classify_tasks(
    *,
    export_path: Path,
    cache_root: Path,
    model: str,
    batch_size: int,
    limit: int,
    timeout: float,
    workers: int,
    retries: int,
) -> dict[str, Any]:
    api_key = ensure_openrouter_key()
    rows = load_network_tasks(export_path)
    if limit > 0:
        rows = rows[:limit]
    packets = [compact_packet(row) for row in rows]
    run_id = _utc_stamp()
    run_dir = cache_root / run_id
    raw_dir = run_dir / "raw_batches"
    raw_dir.mkdir(parents=True, exist_ok=False)
    (run_dir / "prompt.md").write_text(PROMPT)
    (run_dir / "inputs.json").write_text(json.dumps({
        "sourceExport": str(export_path),
        "model": model,
        "promptVersion": PROMPT_VERSION,
        "count": len(packets),
        "packets": packets,
    }, indent=2, sort_keys=True))

    all_classifications: list[dict[str, Any]] = []
    usage = {"inputTokens": 0, "outputTokens": 0, "totalTokens": 0, "costUsd": 0.0}
    batches = list(enumerate(_chunks(packets, max(1, batch_size)), start=1))

    def run_batch(index: int, batch: list[dict[str, Any]]) -> tuple[int, list[dict[str, Any]], dict[str, Any], dict[str, Any]]:
        last_raw: dict[str, Any] = {}
        last_error = ""
        for attempt in range(max(0, retries) + 1):
            try:
                with requests.Session() as session:
                    parsed, raw = classify_batch(batch, api_key=api_key, model=model, timeout=timeout, session=session)
                last_raw = raw
                classifications = parsed.get("classifications") if isinstance(parsed, dict) else None
                if isinstance(classifications, list) and classifications:
                    raw["attempt"] = attempt + 1
                    return index, batch, parsed, raw
                last_error = raw.get("parseError") or "missing_classifications"
            except Exception as exc:  # noqa: BLE001 - surfaced in cache.
                last_error = str(exc)
                last_raw = {"error": last_error}
            time.sleep(0.5 + attempt)
        return index, batch, {}, {"error": last_error, "lastRaw": last_raw, "attempt": max(0, retries) + 1}

    def record_batch(index: int, batch: list[dict[str, Any]], parsed: dict[str, Any], raw: dict[str, Any]) -> None:
        (raw_dir / f"batch_{index:03d}.json").write_text(json.dumps({
            "batchIndex": index,
            "taskIds": [packet["taskId"] for packet in batch],
            "parsed": parsed,
            "raw": raw,
        }, indent=2, sort_keys=True))
        by_task_id = {
            _safe_text(item.get("taskId"), 180): item
            for item in (parsed.get("classifications") or [])
            if isinstance(item, dict)
        }
        for packet in batch:
            raw_item = by_task_id.get(packet["taskId"], {})
            all_classifications.append(normalize_classification(raw_item, packet))
        raw_usage = raw.get("usage") if isinstance(raw, dict) else {}
        if isinstance(raw_usage, dict):
            usage["inputTokens"] += int(_safe_number(raw_usage.get("prompt_tokens") or raw_usage.get("input_tokens")))
            usage["outputTokens"] += int(_safe_number(raw_usage.get("completion_tokens") or raw_usage.get("output_tokens")))
            usage["totalTokens"] += int(_safe_number(raw_usage.get("total_tokens")))
            usage["costUsd"] = round(usage["costUsd"] + _safe_number(raw_usage.get("cost")), 6)

    if workers <= 1:
        for index, batch in batches:
            record_batch(*run_batch(index, batch))
    else:
        with ThreadPoolExecutor(max_workers=max(1, workers)) as executor:
            future_map = {
                executor.submit(run_batch, index, batch): (index, batch)
                for index, batch in batches
            }
            for future in as_completed(future_map):
                record_batch(*future.result())

    all_classifications.sort(key=lambda item: (
        -item["reviewPriorityScore"],
        -item["networkFunctionScore"],
        -item["suspiciousLowValueScore"],
        -item["rewardPft"],
        item["taskId"],
    ))
    counts = {
        category: sum(1 for item in all_classifications if item["primaryCategory"] == category)
        for category in CATEGORIES
    }
    by_action: dict[str, int] = {}
    for item in all_classifications:
        by_action[item["recommendedAction"]] = by_action.get(item["recommendedAction"], 0) + 1
    failed_batches = [
        path.name for path in sorted(raw_dir.glob("batch_*.json"))
        if '"error"' in path.read_text(errors="ignore")
    ]
    summary = {
        "ok": True,
        "runId": run_id,
        "cacheDir": str(run_dir),
        "sourceExport": str(export_path),
        "model": model,
        "promptVersion": PROMPT_VERSION,
        "taskCount": len(all_classifications),
        "categoryCounts": counts,
        "recommendedActionCounts": by_action,
        "failedBatchCount": len(failed_batches),
        "failedBatches": failed_batches[:50],
        "usage": usage,
        "topReviewPriority": all_classifications[:20],
        "secretPrinted": False,
    }
    output = {
        **summary,
        "classifications": all_classifications,
    }
    (run_dir / "classifications.json").write_text(json.dumps(output, indent=2, sort_keys=True))
    (run_dir / "summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True))
    return summary


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Classify live rewarded Network tasks with OpenRouter GLM 5.2.")
    parser.add_argument("--export", default=DEFAULT_EXPORT)
    parser.add_argument("--cache-root", default=str(DEFAULT_CACHE_ROOT))
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--timeout", type=float, default=120)
    parser.add_argument("--workers", type=int, default=1)
    parser.add_argument("--retries", type=int, default=1)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    summary = classify_tasks(
        export_path=Path(args.export),
        cache_root=Path(args.cache_root),
        model=args.model,
        batch_size=args.batch_size,
        limit=args.limit,
        timeout=args.timeout,
        workers=args.workers,
        retries=args.retries,
    )
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
