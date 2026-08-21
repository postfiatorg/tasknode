from __future__ import annotations

import argparse
import json
import sys

from tasknode_pftl.agent_client import DEFAULT_SESSION_STORE, TaskNodeApiError

from .client import DEFAULT_EXPECTED_WALLET_ADDRESS, DEFAULT_ORC_AGENT, DEFAULT_TASKNODE_BASE_URL, request_personal_task


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="orc-request-task",
        description="Request a Task Node personal task as an Orc operator wallet.",
    )
    parser.add_argument("text", nargs="+", help="Personal task text to request.")
    parser.add_argument("--submit", action="store_true", help="Publish the signed on-ledger request pointer.")
    parser.add_argument("--agent", default=DEFAULT_ORC_AGENT, help="Assigned Orc agent handle.")
    parser.add_argument("--expected-wallet-address", default=DEFAULT_EXPECTED_WALLET_ADDRESS, help="Optional assigned wallet assertion.")
    parser.add_argument("--session-store", default=DEFAULT_SESSION_STORE, help="0600 session cache JSON path.")
    parser.add_argument("--base-url", default=DEFAULT_TASKNODE_BASE_URL, help="Task Node API base URL.")
    parser.add_argument("--kind", default="personal", help="Requested task kind.")
    parser.add_argument("--conversation-id", default="", help="Optional source conversation id.")
    parser.add_argument(
        "--no-refresh-tasks",
        action="store_true",
        help="Skip the follow-up /api/tasks read after requesting.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        summary = request_personal_task(
            " ".join(args.text),
            submit=args.submit,
            agent=args.agent,
            expected_wallet_address=args.expected_wallet_address,
            base_url=args.base_url,
            session_store_path=args.session_store,
            requested_task_kind=args.kind,
            conversation_id=args.conversation_id,
            refresh_tasks=not args.no_refresh_tasks,
        )
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
    print(json.dumps(summary, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
