from __future__ import annotations

import argparse
from copy import deepcopy
import json
import shutil
from pathlib import Path
from typing import Any

from tasknode_pftl.codec import canonical_json, sha256_hex


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_STORE_DIR = ROOT / "examples" / "local_json_task_loop" / "state"
LOCAL_JSON_TASK_FIXTURE_PATH = ROOT / "tasknode_pftl" / "fixtures" / "local_json_task_loop_task.json"
FIXED_TIMESTAMP = "2026-05-18T00:00:00Z"
SCHEMA = "pf.task.local_json_loop.v1"


def canonical_id(prefix: str, payload: dict[str, Any]) -> str:
    return f"{prefix}_{sha256_hex(payload)[:24]}"


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def read_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def load_task_fixture() -> dict[str, Any]:
    return read_json(LOCAL_JSON_TASK_FIXTURE_PATH, {})


class LocalJsonTaskStore:
    def __init__(self, root: Path):
        self.root = root
        self.artifacts_dir = root / "artifacts"
        self.events_path = root / "events.json"
        self.tasks_path = root / "tasks.json"
        self.reputation_path = root / "reputation.json"
        self.artifacts_path = root / "artifacts.json"
        self.receipt_path = root / "receipt.json"

    def reset(self) -> None:
        if self.root.exists():
            shutil.rmtree(self.root)

    def load(self) -> dict[str, Any]:
        return {
            "events": read_json(self.events_path, []),
            "tasks": read_json(self.tasks_path, {}),
            "reputation": read_json(self.reputation_path, {}),
            "artifacts": read_json(self.artifacts_path, {}),
        }

    def persist(self, state: dict[str, Any], receipt: dict[str, Any]) -> None:
        write_json(self.events_path, state["events"])
        write_json(self.tasks_path, state["tasks"])
        write_json(self.reputation_path, state["reputation"])
        write_json(self.artifacts_path, state["artifacts"])
        write_json(self.receipt_path, receipt)

    def write_artifact(self, artifact_id: str, body: str) -> Path:
        path = self.artifacts_dir / f"{artifact_id}.md"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body, encoding="utf-8")
        return path


def base_reputation(user_id: str) -> dict[str, Any]:
    return {
        "schema": f"{SCHEMA}.reputation",
        "user_id": user_id,
        "reputation_points": 42,
        "completed_tasks": 2,
        "approved_submissions": 2,
        "rejected_submissions": 0,
        "last_updated_at": FIXED_TIMESTAMP,
    }


def transition_event(
    *,
    event_type: str,
    task_id: str,
    actor: str,
    from_status: str,
    to_status: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    core = {
        "schema": SCHEMA,
        "event_type": event_type,
        "task_id": task_id,
        "actor": actor,
        "from_status": from_status,
        "to_status": to_status,
        "payload": deepcopy(payload),
    }
    return {
        **core,
        "event_id": canonical_id("evt", core),
        "created_at": FIXED_TIMESTAMP,
        "payload_digest": "sha256:" + sha256_hex(payload),
    }


def generated_task(request: dict[str, Any]) -> dict[str, Any]:
    fixture = load_task_fixture()
    task_core = {
        "request_id": request["request_id"],
        "subject_user_id": request["subject_user_id"],
        "objective": request["objective"],
        "task_kind": fixture.get("task_kind") or "engineering_demo",
    }
    task_id = canonical_id("task", task_core)
    return {
        "schema": f"{SCHEMA}.task",
        "task_id": task_id,
        "request_id": request["request_id"],
        "subject_user_id": request["subject_user_id"],
        "status": "proposed",
        "title": fixture.get("title") or "Local JSON task loop fixture",
        "description": fixture.get("description") or "",
        "steps": list(fixture.get("steps") or []),
        "submission_requirement": dict(fixture.get("submission_requirement") or {}),
        "reward_offer": dict(fixture.get("reward_offer") or {"amount_pft": "3.200000", "unit": "PFT"}),
        "created_at": FIXED_TIMESTAMP,
        "updated_at": FIXED_TIMESTAMP,
    }


def artifact_body(task: dict[str, Any], request: dict[str, Any]) -> str:
    return "\n".join(
        [
            "# Local JSON Task Loop Evidence",
            "",
            f"Task ID: `{task['task_id']}`",
            f"Request ID: `{request['request_id']}`",
            "",
            "This artifact is produced by the deterministic local JSON task loop demo.",
            "It proves the workflow can generate a task, accept it, submit evidence, review it, and update reputation state.",
            "",
            "Expected persisted files:",
            "- `events.json`",
            "- `tasks.json`",
            "- `artifacts.json`",
            "- `reputation.json`",
            "- `receipt.json`",
            "",
            "The reputation update is part of the reviewed task loop, not a separate manual edit.",
            "",
        ]
    )


def review_submission(artifact: dict[str, Any], body: str) -> dict[str, Any]:
    checks = {
        "artifact_digest_matches": artifact["digest"] == "sha256:" + sha256_hex(body),
        "mentions_reputation_update": "reputation update" in body.lower(),
        "mentions_json_outputs": "events.json" in body and "receipt.json" in body,
    }
    approved = all(checks.values())
    return {
        "review_id": canonical_id("review", {"artifact_id": artifact["artifact_id"], "checks": checks}),
        "approved": approved,
        "score": 0.96 if approved else 0.21,
        "checks": checks,
        "summary": "Artifact satisfies the deterministic local JSON task loop requirements." if approved else "Artifact is incomplete.",
    }


def run_demo(*, store_dir: Path, reset: bool = False) -> dict[str, Any]:
    store = LocalJsonTaskStore(store_dir)
    if reset:
        store.reset()

    state = store.load()
    user_id = "user_goodalexander_demo"
    authority_id = "tasknode_local_authority"
    reviewer_id = "tasknode_local_reviewer"
    request = {
        "schema": f"{SCHEMA}.request",
        "subject_user_id": user_id,
        "objective": "Prove a deterministic local JSON task loop end to end.",
        "request_text": "Create a runnable CLI demo with persisted JSON outputs and reputation update.",
        "request_context": {
            "context_doc_digest": "sha256:" + sha256_hex("local-json-context-demo"),
            "recent_chat_digest": "sha256:" + sha256_hex("task loop verification request"),
        },
    }
    request["request_id"] = canonical_id("req", request)
    task = generated_task(request)
    task_id = task["task_id"]

    reputation_before = state["reputation"].get(user_id) or base_reputation(user_id)
    events: list[dict[str, Any]] = []
    transitions: list[dict[str, str]] = []

    def record(event: dict[str, Any]) -> None:
        events.append(event)
        transitions.append({
            "event_type": event["event_type"],
            "from": event["from_status"],
            "to": event["to_status"],
            "event_id": event["event_id"],
        })

    record(
        transition_event(
            event_type="task_generated",
            task_id=task_id,
            actor=authority_id,
            from_status="none",
            to_status="proposed",
            payload={"request": request, "task": task},
        )
    )

    task["status"] = "accepted"
    task["accepted_at"] = FIXED_TIMESTAMP
    task["updated_at"] = FIXED_TIMESTAMP
    record(
        transition_event(
            event_type="task_accepted",
            task_id=task_id,
            actor=user_id,
            from_status="proposed",
            to_status="accepted",
            payload={"task_id": task_id, "accepted_by": user_id},
        )
    )

    body = artifact_body(task, request)
    artifact_id = canonical_id("artifact", {"task_id": task_id, "body_digest": sha256_hex(body)})
    artifact_path = store.write_artifact(artifact_id, body)
    artifact = {
        "artifact_id": artifact_id,
        "task_id": task_id,
        "type": "markdown_evidence",
        "relative_path": str(artifact_path.relative_to(store.root)),
        "digest": "sha256:" + sha256_hex(body),
        "size_bytes": len(body.encode("utf-8")),
    }
    task["status"] = "submitted"
    task["submission"] = artifact
    task["updated_at"] = FIXED_TIMESTAMP
    record(
        transition_event(
            event_type="artifact_submitted",
            task_id=task_id,
            actor=user_id,
            from_status="accepted",
            to_status="submitted",
            payload={"artifact": artifact},
        )
    )

    review = review_submission(artifact, body)
    task["status"] = "reviewed"
    task["review"] = review
    task["updated_at"] = FIXED_TIMESTAMP
    record(
        transition_event(
            event_type="submission_reviewed",
            task_id=task_id,
            actor=reviewer_id,
            from_status="submitted",
            to_status="reviewed",
            payload={"review": review},
        )
    )

    reward_pft = 3.2 if review["approved"] else 0
    reputation_after = {
        **reputation_before,
        "reputation_points": reputation_before["reputation_points"] + (8 if review["approved"] else -2),
        "completed_tasks": reputation_before["completed_tasks"] + (1 if review["approved"] else 0),
        "approved_submissions": reputation_before["approved_submissions"] + (1 if review["approved"] else 0),
        "rejected_submissions": reputation_before["rejected_submissions"] + (0 if review["approved"] else 1),
        "last_updated_at": FIXED_TIMESTAMP,
    }
    task["status"] = "rewarded" if review["approved"] else "rejected"
    task["reward"] = {"amount_pft": f"{reward_pft:.6f}", "unit": "PFT"}
    task["reputation_delta"] = {
        "before_points": reputation_before["reputation_points"],
        "after_points": reputation_after["reputation_points"],
        "delta_points": reputation_after["reputation_points"] - reputation_before["reputation_points"],
    }
    task["updated_at"] = FIXED_TIMESTAMP
    record(
        transition_event(
            event_type="reputation_updated",
            task_id=task_id,
            actor=authority_id,
            from_status="reviewed",
            to_status=task["status"],
            payload={
                "reward": task["reward"],
                "reputation_before": reputation_before,
                "reputation_after": reputation_after,
            },
        )
    )

    state["events"] = events
    state["tasks"] = {task_id: task}
    state["artifacts"] = {artifact_id: artifact}
    state["reputation"] = {user_id: reputation_after}
    receipt = {
        "schema": SCHEMA,
        "run_id": "local_json_task_loop_demo_v1",
        "task_id": task_id,
        "request_id": request["request_id"],
        "artifact_id": artifact_id,
        "final_status": task["status"],
        "transition_count": len(transitions),
        "transitions": transitions,
        "reputation_before": reputation_before,
        "reputation_after": reputation_after,
        "state_digest": "sha256:" + sha256_hex({
            "events": events,
            "tasks": state["tasks"],
            "artifacts": state["artifacts"],
            "reputation": state["reputation"],
        }),
    }
    receipt["receipt_id"] = canonical_id("receipt", receipt)
    store.persist(state, receipt)
    return receipt


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the deterministic local JSON Task Node loop demo.")
    parser.add_argument("--store-dir", default=str(DEFAULT_STORE_DIR), help="Directory for JSON state and artifacts.")
    parser.add_argument("--reset", action="store_true", help="Delete the store directory before running.")
    args = parser.parse_args()

    receipt = run_demo(store_dir=Path(args.store_dir), reset=args.reset)
    print("Task Node local JSON loop complete")
    print(f"  task_id: {receipt['task_id']}")
    for transition in receipt["transitions"]:
      print(f"  {transition['event_type']}: {transition['from']} -> {transition['to']}")
    print(
        "  reputation_points: "
        f"{receipt['reputation_before']['reputation_points']} -> {receipt['reputation_after']['reputation_points']}"
    )
    print(f"  receipt_id: {receipt['receipt_id']}")
    print(f"  state_digest: {receipt['state_digest']}")
    print(f"  store_dir: {Path(args.store_dir).resolve()}")


if __name__ == "__main__":
    main()
