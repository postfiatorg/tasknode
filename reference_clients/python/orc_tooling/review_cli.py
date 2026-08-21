from __future__ import annotations

import argparse
import json
import sys

from .review import build_rewarded_network_task_review_packet


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="orc-review-payloads",
        description="Resolve a person/account/wallet/task and show rewarded Network Task submissions and review payloads.",
    )
    parser.add_argument("--handle", default="", help="Public Hive handle, with or without @.")
    parser.add_argument("--account-id", default="", help="Task Node account id.")
    parser.add_argument("--wallet", default="", help="PFTL wallet address.")
    parser.add_argument("--task-id", default="", help="Specific task id.")
    parser.add_argument("--status", default="rewarded", help="Task status filter; pass empty string for any status.")
    parser.add_argument("--limit", type=int, default=20, help="Maximum tasks to return.")
    parser.add_argument("--text-limit", type=int, default=5000, help="Maximum characters per evidence text field.")
    parser.add_argument("--raw-events", action="store_true", help="Include redacted raw task event payloads.")
    parser.add_argument("--database-url", default="", help="Override database URL. Defaults to TaskNode env or local Docker DB.")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if not any([args.handle, args.account_id, args.wallet, args.task_id]):
        print("Provide --handle, --account-id, --wallet, or --task-id.", file=sys.stderr)
        return 2
    try:
        packet = build_rewarded_network_task_review_packet(
            handle=args.handle,
            account_id=args.account_id,
            wallet=args.wallet,
            task_id=args.task_id,
            status=args.status,
            limit=args.limit,
            text_limit=args.text_limit,
            include_raw_events=args.raw_events,
            database_url=args.database_url or None,
        )
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
    print(json.dumps(packet, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
