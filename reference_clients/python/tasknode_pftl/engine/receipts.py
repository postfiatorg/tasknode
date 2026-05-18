from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True), encoding="utf-8")


def write_n1_markdown(path: Path, receipt: dict[str, Any]) -> None:
    result = receipt["result"]
    task = result.get("generated_task") or {}
    score = result.get("score") or {}
    projection = (result.get("projection") or {}).get(result["task_id"], {})
    lines = [
        "# Pythonic Task Engine N=1 Live Walkthrough",
        "",
        f"- Run id: `{receipt['run_id']}`",
        f"- Network: `{receipt['network']['name']}`",
        f"- Provider: `{receipt['provider']}`",
        f"- Task id: `{result['task_id']}`",
        f"- Request id: `{result['request_id']}`",
        f"- Replay status: `{projection.get('status')}`",
        f"- Reward paid: `{result['reward_paid']}`",
        f"- Reward amount: `{result['reward_pft']}` PFT",
        f"- Pointer events found: `{result['pointer_events_found']}`",
        "",
        "## User Bundle",
        "",
        f"- Account id: `{receipt.get('fixture', {}).get('account_id', '')}`",
        f"- Conversation: `{receipt.get('fixture', {}).get('conversation_title', '')}`",
        f"- Context id: `{result.get('context_id', '')}`",
        f"- Context CID: `{result['cids'].get('context_doc', '')}`",
        f"- Request bundle CID: `{result['cids'].get('request_bundle', '')}`",
        "",
        "## Generated Task",
        "",
        f"- Title: {task.get('title', '')}",
        f"- Kind: `{task.get('task_kind', '')}`",
        f"- Submission type: `{(task.get('submission_requirement') or {}).get('type', '')}`",
        f"- Reward offer: `{(task.get('reward_offer') or {}).get('amount_estimate_pft', '')}` PFT",
        "",
        task.get("description", ""),
        "",
        "Steps:",
    ]
    for step in task.get("steps") or []:
        lines.append(f"- {step}")
    lines.extend([
        "",
        "Submission requirement:",
        "",
        (task.get("submission_requirement") or {}).get("criteria", ""),
        "",
        "## Initial Evidence",
        "",
    ])
    append_processed_evidence(lines, result["submissions"]["initial"]["processed_evidence"])
    lines.extend([
        "",
        "## Verification Request",
        "",
        f"- Assessment: `{result['verification_request'].get('assessment', '')}`",
        f"- Verification type: `{result['verification_request'].get('verification_type', '')}`",
        "",
        result["verification_request"].get("verification_ask", ""),
        "",
        "## Verification Evidence",
        "",
    ])
    append_processed_evidence(lines, result["submissions"]["verification"]["processed_evidence"])
    lines.extend([
        "",
        "## Score",
        "",
        f"- Decision: `{score.get('decision', '')}`",
        f"- Completion: `{score.get('completion', '')}`",
        f"- Evidence quality: `{score.get('evidence_quality', '')}`",
        f"- Reward: `{score.get('reward_pft', '')}` PFT",
        "",
        score.get("reason", ""),
        "",
        score.get("user_feedback", ""),
        "",
        "## Transactions",
        "",
    ])
    for key, tx in (result.get("txs") or {}).items():
        if not tx:
            continue
        lines.append(f"- {key}: `{tx.get('tx_hash')}`")
    lines.extend(["", "## IPFS CIDs", ""])
    for key, value in (result.get("cids") or {}).items():
        if isinstance(value, list):
            for index, cid in enumerate(value, start=1):
                lines.append(f"- {key} {index}: `{cid}`")
        elif value:
            lines.append(f"- {key}: `{value}`")
    lines.extend(["", "## Model Calls", ""])
    for label, metadata in [
        ("Task generation", result.get("taskgen") or {}),
        ("Verification request", result.get("verification_request_model") or {}),
        ("Scoring", result.get("scoring") or {}),
    ]:
        lines.extend([
            f"### {label}",
            "",
            f"- Provider: `{metadata.get('provider', '')}`",
            f"- Model: `{metadata.get('model', '')}`",
            f"- Prompt: `{metadata.get('prompt_version', '')}`",
            f"- Latency ms: `{metadata.get('latency_ms', '')}`",
            f"- Response id: `{metadata.get('provider_response_id') or metadata.get('openai_response_id') or ''}`",
            "",
        ])
    path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


def append_processed_evidence(lines: list[str], processed: dict[str, Any]) -> None:
    for index, artifact in enumerate(processed.get("artifacts") or [], start=1):
        source = artifact.get("source") or {}
        source_label = source.get("url") or source.get("file_name") or source.get("path") or source.get("origin") or ""
        lines.extend([
            f"### Artifact {index}: `{artifact.get('artifact_type', '')}`",
            "",
            f"- Source: `{source_label}`",
            f"- Status: `{artifact.get('status', '')}`",
            f"- Parser: `{artifact.get('parser', '')}`",
            f"- SHA-256: `{artifact.get('sha256', '')}`",
            "",
            "```text",
            str(artifact.get("excerpt") or "").strip()[:2000],
            "```",
            "",
        ])
