from __future__ import annotations

import argparse
import json
import sys

from tasknode_pftl.agent_client import TaskNodeApiError

from .client import build_client
from .payload import VISIBLE_TASK_GROUPS, task_payload, visible_task_payloads


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="orc-task-payload",
        description="Show executable Task Node payloads visible to the assigned Orc wallet.",
    )
    parser.add_argument("task_ids", nargs="*", help="Task IDs to inspect.")
    parser.add_argument(
        "--all-visible",
        action="store_true",
        help="Inspect every task in visible task groups instead of specific IDs.",
    )
    parser.add_argument(
        "--network-only",
        action="store_true",
        help="With --all-visible, include only visible Network tasks.",
    )
    parser.add_argument(
        "--groups",
        default=",".join(VISIBLE_TASK_GROUPS),
        help="Comma-separated visible groups for --all-visible.",
    )
    parser.add_argument(
        "--raw-detail",
        action="store_true",
        help="Include the redacted raw /api/tasks/detail response.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if not args.all_visible and not args.task_ids:
        print("Provide at least one task ID or pass --all-visible.", file=sys.stderr)
        return 2

    try:
        client = build_client()
        if args.all_visible:
            groups = tuple(group.strip() for group in args.groups.split(",") if group.strip())
            result = visible_task_payloads(
                client=client,
                groups=groups,
                network_only=args.network_only,
                include_raw_detail=args.raw_detail,
            )
        else:
            payloads = [
                task_payload(task_id, client=client, include_raw_detail=args.raw_detail)
                for task_id in args.task_ids
            ]
            result = payloads[0] if len(payloads) == 1 else {"ok": True, "count": len(payloads), "payloads": payloads}
    except TaskNodeApiError as exc:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": "TaskNodeApiError",
                    "status": exc.status_code,
                    "body": exc.body,
                    "secretPrinted": False,
                },
                indent=2,
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 1
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

    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
