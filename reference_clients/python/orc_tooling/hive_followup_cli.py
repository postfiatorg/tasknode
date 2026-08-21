from __future__ import annotations

import argparse
import json
import sys

from .hive_followup import (
    DEFAULT_DUPLICATE_REWARD_TASK_ID,
    DEFAULT_TASKNODE_REPO,
    duplicate_reward_followup_message,
    run_duplicate_reward_followup,
    run_hive_followup,
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="orc-hive-followup",
        description="Send audited Hive Chat follow-ups through the Task Node Board Manager message hook.",
    )
    subparsers = parser.add_subparsers(dest="command")

    send = subparsers.add_parser("send", help="Send an arbitrary task-owner follow-up.")
    send.add_argument("--task-id", required=True, help="Task whose owner should receive the message.")
    send.add_argument("--message", required=True, help="Message body to deliver.")
    send.add_argument("--account-id", default="", help="Override resolved task owner account.")
    send.add_argument("--conversation-id", default="", help="Override target Hive conversation.")
    send.add_argument("--followup-required", action="store_true", help="Open a Board Manager follow-up awaiting response.")
    send.add_argument("--execute", action="store_true", help="Actually send. Default is dry-run.")
    send.add_argument("--tasknode-repo", default=DEFAULT_TASKNODE_REPO)
    send.add_argument("--database-url", default=None)

    duplicate = subparsers.add_parser("duplicate-reward", help="Send the duplicate-reward reconciliation follow-up.")
    duplicate.add_argument("--task-id", default=DEFAULT_DUPLICATE_REWARD_TASK_ID)
    duplicate.add_argument("--message", default="", help="Override the default duplicate-reward message.")
    duplicate.add_argument("--execute", action="store_true", help="Actually send. Default is dry-run.")
    duplicate.add_argument("--tasknode-repo", default=DEFAULT_TASKNODE_REPO)
    duplicate.add_argument("--database-url", default=None)
    duplicate.add_argument("--print-message", action="store_true", help="Print the generated message and exit.")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not args.command:
        parser.print_help(sys.stderr)
        return 2

    try:
        if args.command == "duplicate-reward":
            message = args.message or duplicate_reward_followup_message(task_id=args.task_id)
            if args.print_message:
                print(message)
                return 0
            result = run_duplicate_reward_followup(
                task_id=args.task_id,
                message=message,
                execute=args.execute,
                tasknode_repo=args.tasknode_repo,
                database_url=args.database_url,
            )
        else:
            result = run_hive_followup(
                task_id=args.task_id,
                message=args.message,
                execute=args.execute,
                tasknode_repo=args.tasknode_repo,
                account_id=args.account_id,
                conversation_id=args.conversation_id,
                followup_required=args.followup_required,
                database_url=args.database_url,
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

    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
