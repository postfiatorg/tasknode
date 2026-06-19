from __future__ import annotations

import argparse
import json
import sys

from tasknode_pftl.agent_client import TaskNodeApiError

from .tasks import outstanding_task_briefs


def build_parser() -> argparse.ArgumentParser:
    return argparse.ArgumentParser(
        prog="orc-tasks",
        description="List outstanding Orc Task Node task briefs with steps and submission requirements.",
    )


def main(argv: list[str] | None = None) -> int:
    build_parser().parse_args(argv)
    try:
        summary = outstanding_task_briefs()
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
