from __future__ import annotations

import json
import time
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any

import requests

from .codec import canonical_json, now_iso, sha256_hex
from .config import PftlConfig
from .prompt_registry import load_prompt, prompt_digest


TASKGEN_PROMPT_VERSION = "taskgen_minimal_v1"
TASKGEN_PROMPT_PATH = "task_engine/taskgen_minimal_v1.md"
MINIMAL_TASKGEN_SYSTEM = load_prompt(TASKGEN_PROMPT_PATH)
PRIVATE_TASKGEN_PROVIDER_ORDER = ["novita", "atlas-cloud", "siliconflow", "deepinfra"]

DEFAULT_REFERENCE_REWARD_PFT = Decimal("3.20")
MIN_REFERENCE_REWARD_PFT = Decimal("0.50")
MAX_REFERENCE_REWARD_PFT = Decimal("5.00")


TASKGEN_RESPONSE_FORMAT = {
    "type": "json_schema",
    "json_schema": {
        "name": "taskgen_output",
        "strict": True,
        "schema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "schema": {"type": "string", "enum": ["pf.taskgen.output.v1"]},
                "title": {"type": "string"},
                "description": {"type": "string"},
                "task_kind": {"type": "string"},
                "steps": {
                    "type": "array",
                    "items": {"type": "string"},
                },
                "submission_requirement": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "type": {
                            "type": "string",
                            "enum": ["text", "url", "github_commit", "screenshot", "file", "mixed"],
                        },
                        "criteria": {"type": "string"},
                    },
                    "required": ["type", "criteria"],
                },
                "verification_policy": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "followup_required": {"type": "boolean"},
                        "mode": {"type": "string"},
                        "verification_type": {
                            "type": "string",
                            "enum": ["text", "url", "github_commit", "screenshot", "file", "mixed"],
                        },
                    },
                    "required": ["followup_required", "mode", "verification_type"],
                },
                "reward_offer": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "amount_estimate_pft": {"type": "string"},
                    },
                    "required": ["amount_estimate_pft"],
                },
                "deadline": {
                    "type": "object",
                    "additionalProperties": False,
                    "properties": {
                        "accept_by": {"type": "string"},
                        "deadline_at": {"type": ["string", "null"]},
                    },
                    "required": ["accept_by", "deadline_at"],
                },
            },
            "required": [
                "schema",
                "title",
                "description",
                "task_kind",
                "steps",
                "submission_requirement",
                "verification_policy",
                "reward_offer",
                "deadline",
            ],
        },
    },
}


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
    recent_history_items = bundle.get("relevant_history", {}).get("items") or []
    memory = bundle.get("memory") or {}
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
            "relevant_history_summary": "; ".join(item.get("summary", "") for item in recent_history_items if item.get("summary")),
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
        "memory": {
            "deep_memory": memory.get("deep_memory") or [],
            "recent_memory": memory.get("recent_memory") or [],
        },
        "task_queue": bundle.get("task_queue") or {
            "schema": "pf.task.queue_cache.v1",
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
        },
        "wallet": bundle["wallet"],
        "policy": bundle["policy"],
    }


def _parse_json_object(text: str) -> dict[str, Any]:
    raw = text.strip()
    if raw.startswith("```"):
        raw = raw.strip("`")
        if raw.lower().startswith("json"):
            raw = raw[4:].strip()
    return json.loads(raw)


def _openrouter_provider_preferences() -> dict[str, Any]:
    return {
        "zdr": True,
        "data_collection": "deny",
        "require_parameters": True,
        "order": PRIVATE_TASKGEN_PROVIDER_ORDER,
        "only": PRIVATE_TASKGEN_PROVIDER_ORDER,
    }


def _structured_chat_completion(
    *,
    config: PftlConfig,
    provider: str,
    model: str,
    messages: list[dict[str, str]],
    response_format: dict[str, Any],
    timeout: int,
) -> dict[str, Any]:
    normalized = str(provider or "frontier").strip().lower()
    if normalized == "frontier":
        if not config.openai_api_key:
            raise RuntimeError("OPENAI_API_KEY is required for frontier task generation")
        response = requests.post(
            f"{config.openai_base_url}/chat/completions",
            headers={
                "Authorization": f"Bearer {config.openai_api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": model,
                "messages": messages,
                "response_format": response_format,
            },
            timeout=timeout,
        )
    elif normalized == "private":
        if not config.openrouter_api_key:
            raise RuntimeError("OPENROUTER_API_KEY is required for private task generation")
        response = requests.post(
            f"{config.openrouter_base_url}/chat/completions",
            headers={
                "Authorization": f"Bearer {config.openrouter_api_key}",
                "Content-Type": "application/json",
                "HTTP-Referer": "https://tasknodeofficial.local",
                "X-Title": "Task Node Official Python Task Engine",
            },
            json={
                "model": model,
                "messages": messages,
                "response_format": response_format,
                "provider": _openrouter_provider_preferences(),
            },
            timeout=timeout,
        )
    else:
        raise RuntimeError(f"Unsupported task generation provider: {provider}")
    if hasattr(response, "ok") and not response.ok:
        raise RuntimeError(f"{normalized} task generation HTTP {response.status_code}: {response.text[:500]}")
    if hasattr(response, "raise_for_status"):
        response.raise_for_status()
    return response.json()


def _normalize_reference_reward(value: Any) -> str:
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, ValueError):
        amount = DEFAULT_REFERENCE_REWARD_PFT
    if amount < MIN_REFERENCE_REWARD_PFT or amount > MAX_REFERENCE_REWARD_PFT:
        amount = DEFAULT_REFERENCE_REWARD_PFT
    return f"{amount:.2f}"


def _validate_taskgen_output(value: dict[str, Any]) -> dict[str, Any]:
    required = ["title", "description", "task_kind", "submission_requirement", "verification_policy", "reward_offer", "deadline"]
    missing = [key for key in required if key not in value]
    if missing:
        raise ValueError(f"Taskgen output missing: {', '.join(missing)}")
    if value.get("schema") != "pf.taskgen.output.v1":
        raise ValueError("Taskgen output has invalid schema")
    steps = value.get("steps")
    if not isinstance(steps, list):
        steps = []
    value["steps"] = [str(step).strip() for step in steps if str(step or "").strip()][:5]
    requirement = value.get("submission_requirement") or {}
    if requirement.get("type") not in {"text", "url", "github_commit", "screenshot", "file", "mixed"}:
        raise ValueError("Taskgen output has invalid submission requirement type")
    if not requirement.get("criteria"):
        raise ValueError("Taskgen output missing submission requirement criteria")
    value["submission_requirement"] = requirement
    policy = value.get("verification_policy") or {}
    for key in ("followup_required", "mode", "verification_type"):
        if key not in policy:
            raise ValueError(f"Taskgen output missing verification policy {key}")
    if policy.get("verification_type") not in {"text", "url", "github_commit", "screenshot", "file", "mixed"}:
        raise ValueError("Taskgen output has invalid verification type")
    value["verification_policy"] = policy
    reward = value.get("reward_offer") or {}
    reward["amount_estimate_pft"] = _normalize_reference_reward(reward.get("amount_estimate_pft"))
    value["reward_offer"] = reward
    deadline = value.get("deadline") or {}
    if "accept_by" not in deadline or "deadline_at" not in deadline:
        raise ValueError("Taskgen output missing deadline fields")
    value["deadline"] = deadline
    return value


def generate_task(
    config: PftlConfig,
    task_input: dict[str, Any],
    *,
    provider: str = "frontier",
    model: str | None = None,
    benchmark_high_reasoning: bool = False,
) -> TaskgenResult:
    provider_name = str(provider or "frontier").strip().lower()
    model_name = model or (config.private_taskgen_model if provider_name == "private" else config.taskgen_model)
    system_prompt_digest = prompt_digest(MINIMAL_TASKGEN_SYSTEM)
    input_digest = sha256_hex(task_input)
    provider_configured = (
        bool(config.openrouter_api_key) if provider_name == "private" else bool(config.openai_api_key)
    )
    if not provider_configured:
        required = "OPENROUTER_API_KEY" if provider_name == "private" else "OPENAI_API_KEY"
        raise RuntimeError(f"{required} is required for {provider_name} task generation")

    user_prompt = (
        "Generate a minimal Task Node task from this input packet. "
        "Return JSON matching schema pf.taskgen.output.v1.\n\n"
        + canonical_json(task_input)
    )
    started = time.time()
    try:
        body = _structured_chat_completion(
            config=config,
            provider=provider_name,
            model=model_name,
            messages=[
                {"role": "system", "content": MINIMAL_TASKGEN_SYSTEM},
                {"role": "user", "content": user_prompt},
            ],
            response_format=TASKGEN_RESPONSE_FORMAT,
            timeout=45,
        )
        content = body["choices"][0]["message"]["content"]
        output = _validate_taskgen_output(_parse_json_object(content))
        latency_ms = int((time.time() - started) * 1000)
        metadata = {
            "provider": provider_name,
            "model": model_name,
            "prompt_version": TASKGEN_PROMPT_VERSION,
            "prompt_digest": system_prompt_digest,
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
        raise RuntimeError(f"{provider_name} task generation failed: {type(exc).__name__}: {exc}") from exc


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
                "response_format": TASKGEN_RESPONSE_FORMAT,
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


def build_verification_request(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
    raise RuntimeError(
        "build_verification_request was removed from runtime use. "
        "Use tasknode_pftl.engine.scoring.generate_verification_request so verification requests are prompt-backed."
    )
