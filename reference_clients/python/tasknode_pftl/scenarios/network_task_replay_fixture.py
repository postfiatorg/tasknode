from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from tasknode_pftl.codec import sha256_hex
from tasknode_pftl.reducer import ReplayEvent, event_sort_key, reduce_task_events, status_from_reward_amount


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_FIXTURE_DIR = ROOT / "tasknode_pftl" / "fixtures" / "network_task_lifecycle_replay"

ALLOWED_TRANSITIONS: dict[str, set[str]] = {
    "none": {"proposed"},
    "proposed": {"accepted", "refused", "expired"},
    "accepted": {"submitted", "cancelled"},
    "submitted": {"verification_requested", "reward_decided", "rewarded", "rejected", "cancelled"},
    "verification_requested": {"verification_response_submitted", "cancelled"},
    "verification_response_submitted": {"reward_decided", "rewarded", "rejected", "cancelled"},
    "reward_decided": {"rewarded"},
    "rewarded": set(),
    "refused": set(),
    "rejected": set(),
    "expired": set(),
    "cancelled": set(),
}


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def status_after_event(payload: dict[str, Any]) -> str | None:
    schema = str(payload.get("schema") or "")
    if schema == "pf.task.offer.v1":
        return "proposed"
    if schema == "pf.task.update.v1":
        transition = str(payload.get("transition") or "")
        if transition in ALLOWED_TRANSITIONS:
            return transition
    if schema == "pf.task.submission.v1":
        return "verification_response_submitted" if payload.get("phase") == "verification_response" else "submitted"
    if schema == "pf.task.verification_response.v1":
        return "verification_response_submitted"
    if schema == "pf.task.reward_decision.v1":
        score = payload.get("score") or {}
        return status_from_reward_amount(str(score.get("reward_pft") or payload.get("reward_pft") or "0"))
    if schema == "pf.reward.v1":
        return "rewarded"
    return None


def load_fixture_events(fixture_dir: Path) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, Any]]:
    manifest = read_json(fixture_dir / "manifest.json")
    events = []
    for event_file in manifest["events"]:
        event = read_json(fixture_dir / event_file)
        if not event.get("pointer") or not event.get("payload"):
            raise ValueError(f"{event_file} must include pointer and payload")
        events.append(event)
    expected_projection = read_json(fixture_dir / manifest["expected_projection"])
    return manifest, sorted(events, key=lambda event: event_sort_key(event["pointer"])), expected_projection


def to_replay_event(event: dict[str, Any]) -> ReplayEvent:
    payload = event["payload"]
    pointer = event["pointer"]
    return ReplayEvent(
        pointer=pointer,
        payload=payload,
        source_tx_hash=pointer["tx_hash"],
        event_type=payload["schema"],
    )


def validate_transition_path(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    current_status = "none"
    transitions = []
    for event in events:
        payload = event["payload"]
        next_status = status_after_event(payload)
        if not next_status:
            raise ValueError(f"unsupported lifecycle payload schema: {payload.get('schema')}")
        allowed = ALLOWED_TRANSITIONS.get(current_status, set())
        if next_status not in allowed:
            raise ValueError(
                f"invalid lifecycle transition for {payload.get('event_id')}: "
                f"{current_status} -> {next_status}; allowed: {sorted(allowed)}"
            )
        transitions.append({
            "stage": event.get("stage") or next_status,
            "event_id": payload.get("event_id"),
            "schema": payload.get("schema"),
            "from_status": current_status,
            "to_status": next_status,
            "ledger_index": event["pointer"].get("ledger_index"),
            "tx_hash": event["pointer"].get("tx_hash"),
            "cid": event["pointer"].get("cid"),
        })
        current_status = next_status
    return transitions


def verify_projection(projection: dict[str, Any], expected: dict[str, Any]) -> None:
    expected_fields = {
        "task_id",
        "status",
        "title",
        "description",
        "task_kind",
        "reward_offer_pft",
        "reward_actual_pft",
        "request_bundle_cid",
    }
    for key in expected_fields:
        if projection.get(key) != expected.get(key):
            raise ValueError(f"projection mismatch for {key}: expected {expected.get(key)!r}, got {projection.get(key)!r}")
    if len(projection.get("events") or []) != expected.get("event_count"):
        raise ValueError(
            f"projection event count mismatch: expected {expected.get('event_count')}, "
            f"got {len(projection.get('events') or [])}"
        )


def replay_fixture(fixture_dir: Path = DEFAULT_FIXTURE_DIR) -> dict[str, Any]:
    manifest, events, expected_projection = load_fixture_events(fixture_dir)
    transitions = validate_transition_path(events)
    replay_events = [to_replay_event(event) for event in events]
    projections = reduce_task_events(replay_events)
    task_id = manifest["task_id"]
    if task_id not in projections:
        raise ValueError(f"fixture task {task_id} was not projected")
    projection = projections[task_id].to_dict()
    verify_projection(projection, expected_projection)
    actual_path = [transition["to_status"] for transition in transitions]
    expected_path = manifest.get("expected_transition_path") or []
    if actual_path != expected_path:
        raise ValueError(f"transition path mismatch: expected {expected_path}, got {actual_path}")
    state_digest = "sha256:" + sha256_hex({
        "fixture_id": manifest["fixture_id"],
        "projection": projection,
        "transitions": transitions,
    })
    return {
        "fixture_id": manifest["fixture_id"],
        "task_id": task_id,
        "final_status": projection["status"],
        "reward_actual_pft": projection["reward_actual_pft"],
        "transition_count": len(transitions),
        "state_digest": state_digest,
        "transitions": transitions,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Replay the canonical Network Task lifecycle fixture.")
    parser.add_argument("--fixture-dir", type=Path, default=DEFAULT_FIXTURE_DIR)
    parser.add_argument("--json", action="store_true", help="Print the verification receipt as JSON.")
    args = parser.parse_args()

    receipt = replay_fixture(args.fixture_dir)
    if args.json:
        print(json.dumps(receipt, indent=2, sort_keys=True))
        return

    print("Network Task lifecycle fixture replay ok")
    print(f"  fixture: {receipt['fixture_id']}")
    print(f"  task_id: {receipt['task_id']}")
    for transition in receipt["transitions"]:
        print(
            f"  {transition['stage']}: {transition['from_status']} -> {transition['to_status']} "
            f"(ledger {transition['ledger_index']}, event {transition['event_id']})"
        )
    print(f"  final_status: {receipt['final_status']}")
    print(f"  reward_actual_pft: {receipt['reward_actual_pft']}")
    print(f"  state_digest: {receipt['state_digest']}")


if __name__ == "__main__":
    main()
