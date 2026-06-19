from __future__ import annotations

from typing import Any

from .payload import redact_secrets


EXECUTABLE_REWARD_CLAWBACK_SIGNAL = "executable_reward_clawback_artifact"
NO_SIGNING_NO_FUND_MOVEMENT_MARKER = "no_signing_no_fund_movement"
INTEGRITY_CONTROL_SCHEMA = "pf.orc.integrity_control.executable_reward_clawback.v1"

LEDGER_ADJACENT_CATEGORIES = {"reward_accounting", "security"}

EXECUTABLE_ARTIFACT_TERMS = {
    ".js",
    ".mjs",
    ".cjs",
    ".ts",
    ".py",
    ".sh",
    ".sql",
    "bash",
    "cli",
    "command",
    "executable",
    "gist.github.com",
    "node ",
    "npm run",
    "psql",
    "python ",
    "script",
    "shell",
    "sql",
}

REWARD_CLAWBACK_TERMS = {
    "airdrop",
    "claw back",
    "claw-back",
    "clawback",
    "distribution",
    "fund",
    "funds",
    "issuance",
    "payment",
    "pft",
    "pftl",
    "payout",
    "reward",
    "rewards",
}

MUTATING_TERMS = {
    "adjust",
    "alter",
    "apply",
    "claw back",
    "claw-back",
    "clawback",
    "delete",
    "execute",
    "fund movement",
    "grant",
    "insert",
    "mutate",
    "pay",
    "publish",
    "reconcile",
    "refund",
    "repair",
    "rollback",
    "run",
    "send",
    "set ",
    "submit payment",
    "submit_payment",
    "transfer",
    "update",
    "write",
}


def _safe_text(value: Any, limit: int = 4000) -> str:
    return str(value or "").replace("\n", " ").strip()[:limit]


def _safe_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _safe_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _normalized_labels(values: list[str] | tuple[str, ...] | None) -> list[str]:
    labels: list[str] = []
    for value in values or []:
        for part in str(value or "").split(","):
            label = part.strip().lower().replace(" ", "_")
            if label and label not in labels:
                labels.append(label)
    return labels


def _collect_text(value: Any, *, limit: int = 60000) -> str:
    parts: list[str] = []

    def visit(item: Any) -> None:
        if len(" ".join(parts)) > limit:
            return
        if isinstance(item, str):
            text = _safe_text(item, 8000)
            if text:
                parts.append(text)
        elif isinstance(item, dict):
            for key, child in item.items():
                key_text = _safe_text(key, 200)
                if key_text:
                    parts.append(key_text)
                visit(child)
        elif isinstance(item, (list, tuple)):
            for child in item:
                visit(child)
        elif item is not None:
            text = _safe_text(item, 200)
            if text:
                parts.append(text)

    visit(value)
    return " ".join(parts).lower()[:limit]


def _contains_any(text: str, terms: set[str]) -> bool:
    return any(term in text for term in terms)


def classify_executable_reward_clawback_artifact(
    review_item: dict[str, Any] | None = None,
    *,
    categories: list[str] | tuple[str, ...] | None = None,
) -> dict[str, Any]:
    labels = _normalized_labels(categories)
    text = _collect_text(review_item or {})
    category_match = bool(LEDGER_ADJACENT_CATEGORIES.intersection(labels)) or _contains_any(
        text,
        {"reward_accounting", "reward accounting", "security", "reward integrity", "payout integrity"},
    )
    executable_match = _contains_any(text, EXECUTABLE_ARTIFACT_TERMS)
    reward_match = _contains_any(text, REWARD_CLAWBACK_TERMS)
    mutation_match = _contains_any(text, MUTATING_TERMS)
    detected = bool(category_match and executable_match and reward_match and mutation_match)
    return redact_secrets({
        "schema": INTEGRITY_CONTROL_SCHEMA,
        "detected": detected,
        "integritySignal": EXECUTABLE_REWARD_CLAWBACK_SIGNAL if detected else "",
        "controlMarker": NO_SIGNING_NO_FUND_MOVEMENT_MARKER if detected else "",
        "independentOrcReviewRequired": detected,
        "humanSignerAuthorization": "none_recorded" if detected else "",
        "operationalUseAllowed": False if detected else None,
        "contributorAccusation": False,
        "reason": (
            "Ledger-adjacent executable artifact requires independent Orc review; no signing or fund movement is authorized by this review state."
            if detected
            else ""
        ),
        "evidence": {
            "categoryMatch": category_match,
            "executableArtifact": executable_match,
            "rewardOrClawback": reward_match,
            "mutatingOperation": mutation_match,
        },
    })


def apply_reward_clawback_integrity_policy(
    *,
    categories: list[str] | tuple[str, ...] | None = None,
    integrity_signals: list[str] | tuple[str, ...] | None = None,
    metadata: dict[str, Any] | None = None,
    review_item: dict[str, Any] | None = None,
) -> dict[str, Any]:
    normalized_categories = _normalized_labels(categories)
    normalized_integrity = _normalized_labels(integrity_signals)
    clean_metadata = dict(_safe_dict(metadata))
    classification = classify_executable_reward_clawback_artifact(
        review_item or clean_metadata.get("reviewItem") or clean_metadata.get("sourceEvidence") or clean_metadata,
        categories=normalized_categories,
    )
    explicit_signal = EXECUTABLE_REWARD_CLAWBACK_SIGNAL in normalized_integrity
    if classification["detected"] or explicit_signal:
        if EXECUTABLE_REWARD_CLAWBACK_SIGNAL not in normalized_integrity:
            normalized_integrity.append(EXECUTABLE_REWARD_CLAWBACK_SIGNAL)
        clean_metadata["integrityControl"] = {
            "schema": INTEGRITY_CONTROL_SCHEMA,
            "signal": EXECUTABLE_REWARD_CLAWBACK_SIGNAL,
            "controlMarker": NO_SIGNING_NO_FUND_MOVEMENT_MARKER,
            "independentOrcReviewRequired": True,
            "humanSignerAuthorization": "none_recorded",
            "operationalUseAllowed": False,
            "contributorAccusation": False,
            "classification": classification,
        }
    return redact_secrets({
        "categories": normalized_categories,
        "integritySignals": normalized_integrity,
        "metadata": clean_metadata,
        "classification": classification,
        "secretPrinted": False,
    })


def review_item_integrity_policy(
    review_item: dict[str, Any] | None = None,
    *,
    categories: list[str] | tuple[str, ...] | None = None,
) -> dict[str, Any]:
    applied = apply_reward_clawback_integrity_policy(
        categories=categories,
        metadata={},
        review_item=review_item or {},
    )
    return _safe_dict(applied.get("metadata")).get("integrityControl") or _safe_dict(applied.get("classification"))
