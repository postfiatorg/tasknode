from __future__ import annotations

import argparse
import json
import sys

from .review_state import (
    REVIEW_DISPOSITIONS,
    ensure_review_state_schema,
    get_review_state,
    list_review_states,
    normalize_review_state_record,
    review_queue,
    review_state_ontology,
    review_state_summary,
    upsert_review_state,
)


def _load_metadata_json(value: str) -> dict:
    if not value:
        return {}
    parsed = json.loads(value)
    if not isinstance(parsed, dict):
        raise argparse.ArgumentTypeError("--metadata-json must be a JSON object")
    return parsed


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="orc-review-state",
        description="Persist and read shared orc review dispositions for rewarded Network Tasks.",
    )
    parser.add_argument("--database-url", default="", help="Override database URL. Defaults to TaskNode env or local Docker DB.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("init", help="Create or update the shared review-state table and queue view.")
    subparsers.add_parser("ontology", help="Print the review-state ontology.")
    subparsers.add_parser("summary", help="Count rewarded Network Tasks by review disposition.")

    get_parser = subparsers.add_parser("get", help="Read one task review state.")
    get_parser.add_argument("task_id")

    list_parser = subparsers.add_parser("list", help="List persisted review-state rows.")
    list_parser.add_argument("--disposition", choices=sorted(REVIEW_DISPOSITIONS), default="")
    list_parser.add_argument("--limit", type=int, default=50)

    queue_parser = subparsers.add_parser("queue", help="List rewarded Network Tasks with coalesced review state.")
    queue_parser.add_argument("--disposition", choices=sorted(REVIEW_DISPOSITIONS), default="")
    queue_parser.add_argument("--limit", type=int, default=50)

    set_parser = subparsers.add_parser("set", help="Upsert a task review state.")
    set_parser.add_argument("task_id")
    set_parser.add_argument("--disposition", choices=sorted(REVIEW_DISPOSITIONS), required=True)
    set_parser.add_argument("--summary", default="")
    set_parser.add_argument("--recommended-action", default="")
    set_parser.add_argument("--action-owner", default="")
    set_parser.add_argument("--confidence", choices=["low", "medium", "high"], default="medium")
    set_parser.add_argument("--category", action="append", default=[])
    set_parser.add_argument("--integrity-signal", action="append", default=[])
    set_parser.add_argument("--reviewer-handle", default="")
    set_parser.add_argument("--reviewer-wallet", default="")
    set_parser.add_argument("--source-task-id", action="append", default=[])
    set_parser.add_argument("--source-cid", action="append", default=[])
    set_parser.add_argument("--source-tx-hash", action="append", default=[])
    set_parser.add_argument("--metadata-json", type=_load_metadata_json, default={})
    set_parser.add_argument("--action-required", action=argparse.BooleanOptionalAction, default=None)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    database_url = args.database_url or None
    try:
        if args.command == "init":
            payload = ensure_review_state_schema(database_url=database_url)
        elif args.command == "ontology":
            payload = review_state_ontology()
        elif args.command == "summary":
            payload = review_state_summary(database_url=database_url)
        elif args.command == "get":
            payload = get_review_state(args.task_id, database_url=database_url)
        elif args.command == "list":
            payload = list_review_states(
                disposition=args.disposition,
                limit=args.limit,
                database_url=database_url,
            )
        elif args.command == "queue":
            payload = review_queue(
                disposition=args.disposition,
                limit=args.limit,
                database_url=database_url,
            )
        elif args.command == "set":
            record = normalize_review_state_record(
                task_id=args.task_id,
                disposition=args.disposition,
                action_required=args.action_required,
                action_owner=args.action_owner,
                confidence=args.confidence,
                categories=args.category,
                integrity_signals=args.integrity_signal,
                summary=args.summary,
                recommended_action=args.recommended_action,
                reviewer_handle=args.reviewer_handle,
                reviewer_wallet=args.reviewer_wallet,
                source_task_ids=args.source_task_id,
                source_cids=args.source_cid,
                source_tx_hashes=args.source_tx_hash,
                metadata=args.metadata_json,
            )
            payload = upsert_review_state(record, database_url=database_url)
        else:
            raise RuntimeError(f"Unhandled command: {args.command}")
    except Exception as exc:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": type(exc).__name__,
                    "message": str(exc),
                    "secretPrinted": False,
                },
                indent=2,
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 1
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
