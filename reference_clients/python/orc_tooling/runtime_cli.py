from __future__ import annotations

import argparse
import json
import sys

from .runtime import (
    DEFAULT_ORC_RUNTIME_DIR,
    claim_next_runtime_directive,
    complete_runtime_directive,
    enqueue_runtime_directive,
    run_runtime_once,
    runtime_status,
)


def _load_json_object(value: str) -> dict:
    if not value:
        return {}
    parsed = json.loads(value)
    if not isinstance(parsed, dict):
        raise argparse.ArgumentTypeError("value must be a JSON object")
    return parsed


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="orc-runtime",
        description="Prototype durable Orc runtime mailbox. No tmux injection.",
    )
    parser.add_argument("--runtime-dir", default=DEFAULT_ORC_RUNTIME_DIR)
    subparsers = parser.add_subparsers(dest="command", required=True)

    enqueue = subparsers.add_parser("enqueue", help="Append a durable directive for an Orc.")
    enqueue.add_argument("--orc", required=True)
    enqueue.add_argument("--task-id", default="")
    enqueue.add_argument("--source", default="manual")
    enqueue.add_argument("--metadata-json", type=_load_json_object, default={})
    enqueue.add_argument("directive", nargs=argparse.REMAINDER)

    claim = subparsers.add_parser("claim", help="Claim the next queued directive for one Orc.")
    claim.add_argument("--orc", required=True)
    claim.add_argument("--worker-id", default="")

    complete = subparsers.add_parser("complete", help="Mark a claimed directive terminal.")
    complete.add_argument("directive_id")
    complete.add_argument("--status", default="completed")
    complete.add_argument("--worker-id", default="")
    complete.add_argument("--result-json", type=_load_json_object, default={})

    run_once = subparsers.add_parser("run-once", help="Claim and complete one directive with the prototype executor.")
    run_once.add_argument("--orc", required=True)
    run_once.add_argument("--worker-id", default="")

    status = subparsers.add_parser("status", help="Show reconstructed runtime state.")
    status.add_argument("--orc", default="")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "enqueue":
            payload = enqueue_runtime_directive(
                orc=args.orc,
                directive=" ".join(args.directive).strip(),
                task_id=args.task_id,
                source=args.source,
                metadata=args.metadata_json,
                runtime_dir=args.runtime_dir,
            )
        elif args.command == "claim":
            payload = claim_next_runtime_directive(
                orc=args.orc,
                worker_id=args.worker_id,
                runtime_dir=args.runtime_dir,
            )
        elif args.command == "complete":
            payload = complete_runtime_directive(
                directive_id=args.directive_id,
                status=args.status,
                worker_id=args.worker_id,
                result=args.result_json,
                runtime_dir=args.runtime_dir,
            )
        elif args.command == "run-once":
            payload = run_runtime_once(
                orc=args.orc,
                worker_id=args.worker_id,
                runtime_dir=args.runtime_dir,
            )
        elif args.command == "status":
            payload = runtime_status(runtime_dir=args.runtime_dir, orc=args.orc)
        else:  # pragma: no cover - argparse prevents this
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
    return 0 if payload.get("ok", True) else 1


if __name__ == "__main__":
    raise SystemExit(main())
