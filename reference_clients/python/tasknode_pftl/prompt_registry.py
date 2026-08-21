from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from .codec import sha256_hex


PROMPTS_ENV = "TASKNODE_PROMPTS_DIR"


class PromptNotFoundError(FileNotFoundError):
    pass


def repo_root() -> Path:
    current = Path(__file__).resolve()
    for parent in current.parents:
        if (parent / "prompts").is_dir() and (parent / "reference_clients").is_dir():
            return parent
    return current.parents[3]


def prompts_dir() -> Path:
    configured = os.environ.get(PROMPTS_ENV)
    if configured:
        return Path(configured).expanduser().resolve()
    return repo_root() / "prompts"


def prompt_path(relative_path: str | Path) -> Path:
    raw = Path(relative_path)
    if raw.is_absolute():
        return raw
    parts = raw.parts
    if parts and parts[0] == "prompts":
        return repo_root() / raw
    return prompts_dir() / raw


def load_prompt(relative_path: str | Path) -> str:
    path = prompt_path(relative_path)
    if not path.exists() or not path.is_file():
        raise PromptNotFoundError(f"Prompt file not found: {path}")
    return path.read_text(encoding="utf-8").strip()


def prompt_digest(prompt_text: str) -> str:
    return sha256_hex(prompt_text)


def render_prompt(prompt_text: str, variables: dict[str, Any]) -> str:
    rendered = prompt_text
    for key, value in variables.items():
        rendered = rendered.replace("{{" + key + "}}", str(value or ""))
    return rendered.strip()
