from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from .codec import sha256_hex
from .encryption import X25519Identity, decrypt_json_bytes
from .ipfs import IpfsClient


def event_sort_key(event: dict[str, Any]) -> tuple:
    ledger = event.get("ledger_index")
    return (
        0 if ledger is not None else 1,
        int(ledger or 0),
        str(event.get("tx_hash") or ""),
        int(event.get("memo_index") or 0),
    )


@dataclass
class ReplayEvent:
    pointer: dict[str, Any]
    payload: dict[str, Any]
    source_tx_hash: str
    event_type: str


@dataclass
class TaskProjection:
    task_id: str
    status: str = "unknown"
    title: str | None = None
    description: str | None = None
    task_kind: str | None = None
    reward_offer_pft: str | None = None
    reward_actual_pft: str | None = None
    request_bundle_cid: str | None = None
    events: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "task_id": self.task_id,
            "status": self.status,
            "title": self.title,
            "description": self.description,
            "task_kind": self.task_kind,
            "reward_offer_pft": self.reward_offer_pft,
            "reward_actual_pft": self.reward_actual_pft,
            "request_bundle_cid": self.request_bundle_cid,
            "events": self.events,
        }


def hydrate_event(event: dict[str, Any], ipfs: IpfsClient, identity: X25519Identity) -> ReplayEvent:
    blob = ipfs.fetch_json(event["cid"])
    plaintext = decrypt_json_bytes(blob, identity)
    payload = json.loads(plaintext.decode("utf-8"))
    event_type = payload.get("schema") or event.get("kind")
    return ReplayEvent(
        pointer=event,
        payload=payload,
        source_tx_hash=event.get("tx_hash"),
        event_type=event_type,
    )


def reduce_task_events(events: list[ReplayEvent]) -> dict[str, TaskProjection]:
    projections: dict[str, TaskProjection] = {}

    def get_task(task_id: str) -> TaskProjection:
        if task_id not in projections:
            projections[task_id] = TaskProjection(task_id=task_id)
        return projections[task_id]

    for replay_event in events:
        payload = replay_event.payload
        pointer = replay_event.pointer
        task_id = payload.get("task_id") or pointer.get("task_id")
        schema = str(payload.get("schema") or "")
        if not task_id and schema == "pf.task.request.v1":
            continue
        if not task_id:
            continue
        projection = get_task(task_id)
        projection.events.append({
            "schema": schema,
            "kind": pointer.get("kind"),
            "tx_hash": replay_event.source_tx_hash,
            "cid": pointer.get("cid"),
            "event_digest": sha256_hex(payload),
        })

        if schema == "pf.task.offer.v1":
            projection.status = "proposed"
            projection.title = payload.get("title")
            projection.description = payload.get("description")
            projection.task_kind = payload.get("task_kind")
            projection.reward_offer_pft = str((payload.get("reward_offer") or {}).get("amount_estimate_pft") or "")
            projection.request_bundle_cid = (payload.get("generation") or {}).get("request_bundle_cid")
        elif schema == "pf.task.update.v1":
            transition = payload.get("transition")
            if transition == "accepted":
                projection.status = "accepted"
            elif transition == "rejected":
                projection.status = "rejected"
            elif transition == "expired":
                projection.status = "expired"
            elif transition == "cancelled":
                projection.status = "cancelled"
            elif transition == "verification_requested":
                projection.status = "verification_requested"
        elif schema == "pf.task.submission.v1":
            if payload.get("phase") == "verification_response":
                projection.status = "verification_response_submitted"
            else:
                projection.status = "submitted"
        elif schema == "pf.task.verification_response.v1":
            projection.status = "verification_response_submitted"
        elif schema == "pf.reward.v1":
            projection.status = "rewarded"
            projection.reward_actual_pft = str(payload.get("reward_pft") or "")

    return projections


def hydrate_and_reduce(events: list[dict[str, Any]], ipfs: IpfsClient, identity: X25519Identity) -> tuple[list[ReplayEvent], dict[str, TaskProjection]]:
    hydrated = []
    seen = set()
    for event in sorted(events, key=event_sort_key):
        dedupe_key = (event.get("tx_hash"), event.get("memo_index"), event.get("cid"))
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        try:
            hydrated.append(hydrate_event(event, ipfs, identity))
        except Exception as exc:
            hydrated.append(ReplayEvent(
                pointer=event,
                payload={
                    "schema": "hydrate_failed",
                    "error": f"{type(exc).__name__}: {exc}",
                    "task_id": event.get("task_id"),
                },
                source_tx_hash=event.get("tx_hash"),
                event_type="hydrate_failed",
            ))
    return hydrated, reduce_task_events([event for event in hydrated if event.event_type != "hydrate_failed"])

