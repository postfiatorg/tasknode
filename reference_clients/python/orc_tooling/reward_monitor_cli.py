from __future__ import annotations

import argparse
import json
import sys

from .reward_monitor import run_duplicate_reward_monitor


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="orc-reward-monitor",
        description="Run read-only Orc reward outcome monitors and cache JSON output.",
    )
    parser.add_argument("--database-url", default="", help="Override database URL.")
    parser.add_argument("--output-dir", default="runs/orc_reward_monitor", help="Directory for cached JSON output.")
    parser.add_argument("--limit", type=int, default=100, help="Maximum flagged task rows to include.")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = run_duplicate_reward_monitor(
            database_url=args.database_url or None,
            output_dir=args.output_dir,
            limit=args.limit,
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
