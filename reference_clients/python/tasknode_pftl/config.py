from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable


TASKNODE_REPO_ROOT = Path(__file__).resolve().parents[3]
WORKSPACE_ROOT = TASKNODE_REPO_ROOT.parent

# Later files win. PFTasks envs are legacy reference inputs; Task Node-local
# env files and the user-provided workspace dump must be able to override them.
DEFAULT_ENV_FILES = [
    WORKSPACE_ROOT / "pftasks/worker/.env",
    WORKSPACE_ROOT / "pftasks/api/.env",
    WORKSPACE_ROOT / "env_dump.txt",
    TASKNODE_REPO_ROOT / ".env",
    TASKNODE_REPO_ROOT / ".env.local",
]


def _strip_quotes(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        return value[1:-1]
    return value


def parse_env_file(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    out: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        out[key.strip()] = _strip_quotes(value)
    return out


def load_env(paths: Iterable[Path] = DEFAULT_ENV_FILES) -> dict[str, str]:
    merged: dict[str, str] = {}
    for path in paths:
        merged.update(parse_env_file(path))
    merged.update({k: v for k, v in os.environ.items() if v is not None})
    return merged


def _csv(value: str | None) -> list[str]:
    return [part.strip() for part in str(value or "").split(",") if part.strip()]


def _rpc_from_wss(value: str | None) -> str | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    if raw.startswith("ws://"):
        return raw.replace("ws://", "http://", 1).replace(":6005", ":5005")
    if raw.startswith("wss://") and "178.156.143.199:6005" in raw:
        return "http://178.156.143.199:5005"
    return None


@dataclass
class PftlConfig:
    network_name: str = "pftl-testnet"
    rpc_url: str = "http://178.156.143.199:5005"
    archive_wss_url: str = "wss://ws-archive.testnet.postfiat.org"
    faucet_seed: str | None = None
    reward_wallet_seeds: list[str] = field(default_factory=list)
    pinata_api_key: str | None = None
    pinata_api_secret: str | None = None
    pinata_base_url: str = "https://api.pinata.cloud"
    ipfs_gateway_urls: list[str] = field(default_factory=lambda: [
        "https://gateway.pinata.cloud/ipfs/",
        "https://ipfs.io/ipfs/",
    ])
    openai_api_key: str | None = None
    openai_base_url: str = "https://api.openai.com/v1"
    taskgen_model: str = "chat-latest"
    high_reasoning_model: str = "gpt-5.5"
    tasknode_encryption_pubkey: str | None = None

    @classmethod
    def from_env(cls) -> "PftlConfig":
        env = load_env()
        rpc_url = (
            env.get("PFTL_RPC_URL")
            or env.get("PFTL_JSON_RPC_URL")
            or _rpc_from_wss(env.get("PFTL_WSS_URL"))
            or "http://178.156.143.199:5005"
        )
        gateways = ["https://gateway.pinata.cloud/ipfs/"]
        gateways.extend(_csv(env.get("IPFS_GATEWAY_FALLBACKS")))
        primary_gateway = env.get("IPFS_GATEWAY_URL") or env.get("PINATA_GATEWAY_URL")
        if primary_gateway:
            gateways.append(primary_gateway)
        gateways.append("https://ipfs.io/ipfs/")
        normalized_gateways = []
        for gateway in gateways:
            value = gateway.rstrip("/") + "/"
            if not value.endswith("/ipfs/"):
                value = value.rstrip("/") + "/ipfs/"
            if value not in normalized_gateways:
                normalized_gateways.append(value)
        return cls(
            network_name=env.get("PFTL_NETWORK_NAME") or "pftl-testnet",
            rpc_url=rpc_url,
            archive_wss_url=env.get("PFTL_ARCHIVE_WSS_URL") or env.get("PFTL_HISTORY_WSS_URL") or "wss://ws-archive.testnet.postfiat.org",
            faucet_seed=env.get("FAUCET_SEED"),
            reward_wallet_seeds=_csv(env.get("REWARD_WALLET_SEEDS")),
            pinata_api_key=env.get("PINATA_API_KEY"),
            pinata_api_secret=env.get("PINATA_API_SECRET"),
            ipfs_gateway_urls=normalized_gateways,
            openai_api_key=env.get("OPENAI_API_KEY"),
            openai_base_url=(env.get("OPENAI_BASE_URL") or "https://api.openai.com/v1").rstrip("/"),
            taskgen_model=env.get("TASKNODE_TASKGEN_MODEL") or "chat-latest",
            high_reasoning_model=env.get("TASKNODE_TASKGEN_HIGH_REASONING_MODEL") or "gpt-5.5",
            tasknode_encryption_pubkey=env.get("TASKNODE_ENCRYPTION_PUBKEY"),
        )

    def require_live(self) -> None:
        missing = []
        if not self.rpc_url:
            missing.append("PFTL_RPC_URL")
        if not self.faucet_seed:
            missing.append("FAUCET_SEED")
        if not self.pinata_api_key:
            missing.append("PINATA_API_KEY")
        if not self.pinata_api_secret:
            missing.append("PINATA_API_SECRET")
        if missing:
            raise RuntimeError(f"Missing live config: {', '.join(missing)}")
