from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any

import requests

from .codec import canonical_json, now_iso, sha256_hex
from .config import PftlConfig


MINIMAL_TASKGEN_SYSTEM = """You generate one concise Task Node task.
Return only JSON. No markdown.
The task must be specific, useful, and verifiable.
Do not include unrelated PFTasks legacy fields.
"""


@dataclass
class TaskgenResult:
    output: dict[str, Any]
    metadata: dict[str, Any]


def build_request_bundle(*, subject_wallet: str, allocation_wallet: str, client_name: str = "python-reference") -> dict[str, Any]:
    created_at = now_iso()
    context_summary = (
        "The user is building a PFTL-native Task Node protocol harness. "
        "The work should prioritize replayability, encrypted IPFS payloads, "
        "wallet-scoped state, and a clean reference implementation for Codex agents."
    )
    bundle = {
        "schema": "pf.task.request_bundle.v1",
        "bundle_id": f"bundle_{sha256_hex(subject_wallet + created_at)[:24]}",
        "subject_wallet": subject_wallet,
        "created_at": created_at,
        "client": {
            "name": client_name,
            "version": "0.1.0",
            "session_id": f"session_{sha256_hex(created_at)[:16]}",
        },
        "request": {
            "request_id": f"req_{sha256_hex('request' + subject_wallet + created_at)[:24]}",
            "request_text": "Issue a task to validate the PFTL-native Task Node lifecycle with encrypted evidence and replay.",
            "requested_task_kind": "system",
            "source": "agent",
        },
        "recent_chat": {
            "messages": [
                {
                    "id": "msg_001",
                    "role": "user",
                    "content": "Build an end-to-end PFTL-native task flow outside the app surface.",
                    "created_at": created_at,
                    "digest": "sha256:" + sha256_hex("Build an end-to-end PFTL-native task flow outside the app surface."),
                },
                {
                    "id": "msg_002",
                    "role": "assistant",
                    "content": "I will create a reference Python harness that writes pointer events and replays task state.",
                    "created_at": created_at,
                    "digest": "sha256:" + sha256_hex("reference Python harness"),
                },
            ],
            "summary": "User wants a portable off-app Task Node lifecycle simulation for PFTL.",
            "window": {
                "started_at": created_at,
                "ended_at": created_at,
            },
        },
        "relevant_history": {
            "strategy": "manual",
            "items": [
                {
                    "kind": "task_summary",
                    "cid": None,
                    "digest": "sha256:" + sha256_hex("PFTL pointer task engine spec"),
                    "summary": "Task state should be canonical from pf.ptr/v4 pointers and encrypted IPFS payloads; databases are cache.",
                    "score": 0.95,
                }
            ],
        },
        "context": {
            "primary_context_doc": {
                "context_id": f"ctx_{sha256_hex(context_summary)[:24]}",
                "cid": None,
                "digest": "sha256:" + sha256_hex(context_summary),
                "summary": context_summary,
                "revision": "simulated",
            },
            "additional_refs": [],
        },
        "policy": {
            "task_policy_version": "task-policy-minimal-v1",
            "reward_policy_version": "reward-policy-minimal-v1",
            "generation_policy_version": "taskgen-policy-minimal-v1",
        },
        "wallet": {
            "subject_wallet": subject_wallet,
            "allocation_wallet": allocation_wallet,
            "authority_hint": None,
        },
    }
    return bundle


def project_taskgen_input(bundle: dict[str, Any], *, bundle_cid: str, bundle_digest: str) -> dict[str, Any]:
    return {
        "schema": "pf.taskgen.input.v1",
        "request_bundle": {
            "bundle_id": bundle["bundle_id"],
            "cid": bundle_cid,
            "digest": bundle_digest,
        },
        "request": bundle["request"],
        "context": {
            "context_cid": bundle["context"]["primary_context_doc"].get("cid"),
            "context_digest": bundle["context"]["primary_context_doc"]["digest"],
            "summary": bundle["context"]["primary_context_doc"]["summary"],
        },
        "chat": {
            "recent_chat_summary": bundle["recent_chat"]["summary"],
            "relevant_history_summary": "; ".join(item["summary"] for item in bundle["relevant_history"]["items"]),
            "recent_messages": [
                {
                    "role": item["role"],
                    "content": item["content"],
                    "created_at": item["created_at"],
                }
                for item in bundle["recent_chat"]["messages"]
            ],
            "summary": bundle["recent_chat"]["summary"],
        },
        "wallet": bundle["wallet"],
        "policy": bundle["policy"],
    }


def _fallback_task(task_input: dict[str, Any], *, reason: str | None = None) -> TaskgenResult:
    output = {
        "schema": "pf.taskgen.output.v1",
        "title": "Replay the PFTL task lifecycle",
        "description": (
            "Run the reference Task Node harness end to end, confirm every lifecycle pointer is written to PFTL, "
            "and provide the replay projection showing the task reaches rewarded state."
        ),
        "task_kind": "system",
        "submission_requirement": {
            "type": "text",
            "criteria": "Submit a concise evidence packet with the run id, pointer transaction hashes, IPFS CIDs, and final replay status.",
        },
        "verification_policy": {
            "followup_required": True,
            "mode": "standard_followup",
            "verification_type": "text",
        },
        "reward_offer": {
            "amount_estimate_pft": "3.20",
        },
        "deadline": {
            "accept_by": now_iso(),
            "deadline_at": None,
        },
    }
    return TaskgenResult(
        output=output,
        metadata={
            "model": "deterministic-fallback",
            "prompt_version": "taskgen-minimal-v1",
            "prompt_digest": sha256_hex(MINIMAL_TASKGEN_SYSTEM),
            "input_packet_digest": sha256_hex(task_input),
            "output_digest": sha256_hex(output),
            "latency_ms": 0,
            "parse_status": "fallback",
            "fallback_reason": reason,
        },
    )


def _parse_json_object(text: str) -> dict[str, Any]:
    raw = text.strip()
    if raw.startswith("```"):
        raw = raw.strip("`")
        if raw.lower().startswith("json"):
            raw = raw[4:].strip()
    return json.loads(raw)


def _validate_taskgen_output(value: dict[str, Any]) -> dict[str, Any]:
    required = ["title", "description", "task_kind", "submission_requirement", "verification_policy", "reward_offer", "deadline"]
    missing = [key for key in required if key not in value]
    if missing:
        raise ValueError(f"Taskgen output missing: {', '.join(missing)}")
    value.setdefault("schema", "pf.taskgen.output.v1")
    requirement = value.get("submission_requirement") or {}
    if requirement.get("type") not in {"text", "url", "github_commit", "screenshot", "file", "mixed"}:
        requirement["type"] = "text"
    if not requirement.get("criteria"):
        requirement["criteria"] = "Submit a concise text evidence packet."
    value["submission_requirement"] = requirement
    policy = value.get("verification_policy") or {}
    policy.setdefault("followup_required", True)
    policy.setdefault("mode", "standard_followup")
    policy.setdefault("verification_type", requirement["type"])
    value["verification_policy"] = policy
    reward = value.get("reward_offer") or {}
    reward.setdefault("amount_estimate_pft", "3.20")
    value["reward_offer"] = reward
    deadline = value.get("deadline") or {}
    deadline.setdefault("accept_by", now_iso())
    deadline.setdefault("deadline_at", None)
    value["deadline"] = deadline
    return value


def generate_task(
    config: PftlConfig,
    task_input: dict[str, Any],
    *,
    model: str | None = None,
    benchmark_high_reasoning: bool = False,
) -> TaskgenResult:
    model_name = model or config.taskgen_model
    prompt_digest = sha256_hex(MINIMAL_TASKGEN_SYSTEM)
    input_digest = sha256_hex(task_input)
    if not config.openai_api_key:
        return _fallback_task(task_input, reason="missing_openai_api_key")

    user_prompt = (
        "Generate a minimal Task Node task from this input packet. "
        "Return JSON matching schema pf.taskgen.output.v1.\n\n"
        + canonical_json(task_input)
    )
    started = time.time()
    try:
        response = requests.post(
            f"{config.openai_base_url}/chat/completions",
            headers={
                "Authorization": f"Bearer {config.openai_api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": model_name,
                "messages": [
                    {"role": "system", "content": MINIMAL_TASKGEN_SYSTEM},
                    {"role": "user", "content": user_prompt},
                ],
                "response_format": {"type": "json_object"},
                "temperature": 0.2,
            },
            timeout=45,
        )
        response.raise_for_status()
        body = response.json()
        content = body["choices"][0]["message"]["content"]
        output = _validate_taskgen_output(_parse_json_object(content))
        latency_ms = int((time.time() - started) * 1000)
        metadata = {
            "model": model_name,
            "prompt_version": "taskgen-minimal-v1",
            "prompt_digest": prompt_digest,
            "input_packet_digest": input_digest,
            "output_digest": sha256_hex(output),
            "latency_ms": latency_ms,
            "parse_status": "ok",
            "openai_response_id": body.get("id"),
            "benchmark": None,
        }
        if benchmark_high_reasoning:
            metadata["benchmark"] = benchmark_taskgen(config, task_input)
        return TaskgenResult(output=output, metadata=metadata)
    except Exception as exc:
        return _fallback_task(task_input, reason=f"{type(exc).__name__}: {exc}")


def benchmark_taskgen(config: PftlConfig, task_input: dict[str, Any]) -> dict[str, Any]:
    started = time.time()
    try:
        response = requests.post(
            f"{config.openai_base_url}/chat/completions",
            headers={
                "Authorization": f"Bearer {config.openai_api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": config.high_reasoning_model,
                "messages": [
                    {"role": "system", "content": MINIMAL_TASKGEN_SYSTEM},
                    {"role": "user", "content": canonical_json(task_input)},
                ],
                "response_format": {"type": "json_object"},
                "temperature": 0.1,
            },
            timeout=90,
        )
        response.raise_for_status()
        body = response.json()
        output = _validate_taskgen_output(_parse_json_object(body["choices"][0]["message"]["content"]))
        return {
            "model": config.high_reasoning_model,
            "latency_ms": int((time.time() - started) * 1000),
            "output_digest": sha256_hex(output),
            "parse_status": "ok",
            "openai_response_id": body.get("id"),
        }
    except Exception as exc:
        return {
            "model": config.high_reasoning_model,
            "latency_ms": int((time.time() - started) * 1000),
            "parse_status": "failed",
            "error": f"{type(exc).__name__}: {exc}",
        }


def build_verification_request(task_offer: dict[str, Any], initial_submission: dict[str, Any]) -> dict[str, Any]:
    requirement = task_offer.get("submission_requirement") or {}
    verification_type = (task_offer.get("verification_policy") or {}).get("verification_type") or requirement.get("type") or "text"
    return {
        "verification_type": verification_type,
        "verification_ask": (
            "Confirm the run completed end to end. Include the request, offer, acceptance, submission, "
            "verification response, and reward transaction hashes, plus the replayed final status."
        ),
        "verification_policy": task_offer.get("verification_policy") or {"mode": "standard_followup", "followup_required": True},
        "generated_at": now_iso(),
        "prompt_version": "verification-minimal-v1",
        "input_digest": sha256_hex({
            "task_offer": task_offer,
            "initial_submission": initial_submission,
        }),
    }

