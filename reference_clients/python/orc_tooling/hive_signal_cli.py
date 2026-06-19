from __future__ import annotations

import argparse
import json
import sys

from .hive_followup import DEFAULT_TASKNODE_REPO
from .hive_signal import run_hive_signal


def _load_metadata_json(value: str) -> dict:
    if not value:
        return {}
    parsed = json.loads(value)
    if not isinstance(parsed, dict):
        raise argparse.ArgumentTypeError("--metadata-json must be a JSON object")
    return parsed


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="orc-hive-signal",
        description="Send direct Orc-authored Hive Chat signals without using Board Manager actions.",
    )
    parser.add_argument("--task-id", required=True, help="Task whose owner should receive the signal.")
    parser.add_argument("--message", required=True, help="Message body to deliver.")
    parser.add_argument("--account-id", default="", help="Override resolved task owner account.")
    parser.add_argument("--conversation-id", default="", help="Override target Hive conversation.")
    parser.add_argument("--reviewer-handle", default="", help="Reviewer handle stored in metadata.")
    parser.add_argument("--reviewer-wallet", default="", help="Reviewer wallet stored in metadata.")
    parser.add_argument("--reason", default="", help="Audit reason stored in metadata.")
    parser.add_argument("--metadata-json", type=_load_metadata_json, default={}, help="Extra metadata object.")
    parser.add_argument("--execute", action="store_true", help="Actually send. Default is dry-run.")
    parser.add_argument("--tasknode-repo", default=DEFAULT_TASKNODE_REPO)
    parser.add_argument("--database-url", default=None)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = run_hive_signal(
            task_id=args.task_id,
            message=args.message,
            execute=args.execute,
            tasknode_repo=args.tasknode_repo,
            account_id=args.account_id,
            conversation_id=args.conversation_id,
            reviewer_handle=args.reviewer_handle,
            reviewer_wallet=args.reviewer_wallet,
            reason=args.reason,
            metadata=args.metadata_json,
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
