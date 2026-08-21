from __future__ import annotations

import json
import time
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Any

import requests

from tasknode_pftl.codec import canonical_json, sha256_hex
from tasknode_pftl.config import PftlConfig
from tasknode_pftl.prompt_registry import load_prompt, prompt_digest


VERIFICATION_PROMPT_VERSION = "verification_request_v1"
VERIFICATION_PROMPT_PATH = "task_engine/verification_request_v1.md"
SCORING_PROMPT_VERSION = "reward_scoring_v1"
SCORING_PROMPT_PATH = "task_engine/reward_scoring_v1.md"
PRIVATE_PROVIDER_ORDER = ["novita", "atlas-cloud", "siliconflow", "deepinfra"]


@dataclass
class ModelJsonResult:
    output: dict[str, Any]
    metadata: dict[str, Any]


VERIFICATION_RESPONSE_FORMAT = {
    "type": "json_schema",
    "json_schema": {
        "name": "verification_request",
        "strict": True,
        "schema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "assessment": {"type": "string", "enum": ["legitimate", "suspicious", "incomplete"]},
                "verification_ask": {"type": "string"},
                "verification_type": {
                    "type": "string",
                    "enum": ["text", "url", "github_commit", "screenshot", "file", "mixed"],
                },
                "reason": {"type": "string"},
            },
            "required": ["assessment", "verification_ask", "verification_type", "reason"],
        },
    },
}


SCORING_RESPONSE_FORMAT = {
    "type": "json_schema",
    "json_schema": {
        "name": "reward_scoring",
        "strict": True,
        "schema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "decision": {"type": "string", "enum": ["reward", "partial_reward", "reject"]},
                "reward_pft": {"type": "string"},
                "completion": {"type": "integer", "minimum": 0, "maximum": 100},
                "evidence_quality": {"type": "integer", "minimum": 0, "maximum": 100},
                "reason": {"type": "string"},
                "user_feedback": {"type": "string"},
            },
            "required": ["decision", "reward_pft", "completion", "evidence_quality", "reason", "user_feedback"],
        },
    },
}


def generate_verification_request(
    *,
    config: PftlConfig,
    task_offer: dict[str, Any],
    initial_submission: dict[str, Any],
    processed_evidence: dict[str, Any],
    context: dict[str, Any] | None = None,
    provider: str = "frontier",
    model: str | None = None,
) -> ModelJsonResult:
    prompt = load_prompt(VERIFICATION_PROMPT_PATH)
    packet = {
        "task_offer": task_offer,
        "initial_submission": initial_submission,
        "processed_evidence": processed_evidence,
        "context": context or {},
    }
    return call_json_model(
        config=config,
        provider=provider,
        model=model or provider_default_model(config, provider),
        system_prompt=prompt,
        user_packet=packet,
        response_format=VERIFICATION_RESPONSE_FORMAT,
        prompt_version=VERIFICATION_PROMPT_VERSION,
        timeout=60,
    )


def score_submission(
    *,
    config: PftlConfig,
    task_offer: dict[str, Any],
    initial_submission: dict[str, Any],
    verification_request: dict[str, Any],
    verification_response: dict[str, Any],
    processed_evidence: dict[str, Any],
    provider: str = "frontier",
    model: str | None = None,
) -> ModelJsonResult:
    prompt = load_prompt(SCORING_PROMPT_PATH)
    packet = {
        "task_offer": task_offer,
        "initial_submission": initial_submission,
        "verification_request": verification_request,
        "verification_response": verification_response,
        "processed_evidence": processed_evidence,
    }
    result = call_json_model(
        config=config,
        provider=provider,
        model=model or provider_default_model(config, provider),
        system_prompt=prompt,
        user_packet=packet,
        response_format=SCORING_RESPONSE_FORMAT,
        prompt_version=SCORING_PROMPT_VERSION,
        timeout=60,
    )
    result.output = validate_score(result.output, task_offer)
    result.metadata["output_digest"] = sha256_hex(result.output)
    return result


def provider_default_model(config: PftlConfig, provider: str) -> str:
    return config.private_taskgen_model if str(provider).strip().lower() == "private" else config.taskgen_model


def call_json_model(
    *,
    config: PftlConfig,
    provider: str,
    model: str,
    system_prompt: str,
    user_packet: dict[str, Any],
    response_format: dict[str, Any],
    prompt_version: str,
    timeout: int,
) -> ModelJsonResult:
    provider_name = str(provider or "frontier").strip().lower()
    input_digest = sha256_hex(user_packet)
    started = time.time()
    body = completion_request(
        config=config,
        provider=provider_name,
        model=model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": canonical_json(user_packet)},
        ],
        response_format=response_format,
        timeout=timeout,
    )
    output = parse_model_json(body)
    return ModelJsonResult(
        output=output,
        metadata={
            "provider": provider_name,
            "model": model,
            "prompt_version": prompt_version,
            "prompt_digest": prompt_digest(system_prompt),
            "input_packet_digest": input_digest,
            "output_digest": sha256_hex(output),
            "latency_ms": int((time.time() - started) * 1000),
            "parse_status": "ok",
            "provider_response_id": body.get("id"),
        },
    )


def completion_request(
    *,
    config: PftlConfig,
    provider: str,
    model: str,
    messages: list[dict[str, str]],
    response_format: dict[str, Any],
    timeout: int,
) -> dict[str, Any]:
    if provider == "frontier":
        if not config.openai_api_key:
            raise RuntimeError("OPENAI_API_KEY is required")
        response = requests.post(
            f"{config.openai_base_url}/chat/completions",
            headers={
                "Authorization": f"Bearer {config.openai_api_key}",
                "Content-Type": "application/json",
            },
            json={"model": model, "messages": messages, "response_format": response_format},
            timeout=timeout,
        )
    elif provider == "private":
        if not config.openrouter_api_key:
            raise RuntimeError("OPENROUTER_API_KEY is required")
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
                "provider": {
                    "zdr": True,
                    "data_collection": "deny",
                    "require_parameters": True,
                    "order": PRIVATE_PROVIDER_ORDER,
                    "only": PRIVATE_PROVIDER_ORDER,
                },
            },
            timeout=timeout,
        )
    else:
        raise RuntimeError(f"Unsupported provider: {provider}")
    if hasattr(response, "ok") and not response.ok:
        raise RuntimeError(f"{provider} provider HTTP {response.status_code}: {response.text[:500]}")
    if hasattr(response, "raise_for_status"):
        response.raise_for_status()
    return response.json()


def parse_model_json(body: dict[str, Any]) -> dict[str, Any]:
    content = body["choices"][0]["message"]["content"]
    text = str(content or "").strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:].strip()
    return json.loads(text)


def validate_score(output: dict[str, Any], task_offer: dict[str, Any]) -> dict[str, Any]:
    out = dict(output)
    if out.get("decision") not in {"reward", "partial_reward", "reject"}:
        out["decision"] = "reject"
    max_reward = decimal_amount((task_offer.get("reward_offer") or {}).get("amount_estimate_pft") or "0")
    reward = decimal_amount(out.get("reward_pft") or "0")
    if out["decision"] == "reject":
        reward = Decimal("0")
    if max_reward > 0 and reward > max_reward:
        reward = max_reward
    if reward < 0:
        reward = Decimal("0")
    out["reward_pft"] = f"{reward:.2f}"
    out["completion"] = int(max(0, min(100, int(out.get("completion") or 0))))
    out["evidence_quality"] = int(max(0, min(100, int(out.get("evidence_quality") or 0))))
    out["reason"] = str(out.get("reason") or "").strip()[:1200]
    out["user_feedback"] = str(out.get("user_feedback") or "").strip()[:800]
    return out


def decimal_amount(value: Any) -> Decimal:
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return Decimal("0")
