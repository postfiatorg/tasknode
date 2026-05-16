from __future__ import annotations

import json
from typing import Any

import requests

from .codec import canonical_json, sha256_hex
from .config import PftlConfig


class IpfsClient:
    def __init__(self, config: PftlConfig, timeout: int = 30):
        self.config = config
        self.timeout = timeout

    def upload_json(self, payload: dict[str, Any], *, name: str, keyvalues: dict[str, str] | None = None) -> dict[str, Any]:
        if not self.config.pinata_api_key or not self.config.pinata_api_secret:
            raise RuntimeError("Pinata API credentials are required for live IPFS upload")
        body = canonical_json(payload).encode("utf-8")
        metadata = {
            "name": name,
            "keyvalues": keyvalues or {},
        }
        response = requests.post(
            f"{self.config.pinata_base_url.rstrip('/')}/pinning/pinFileToIPFS",
            headers={
                "pinata_api_key": self.config.pinata_api_key,
                "pinata_secret_api_key": self.config.pinata_api_secret,
            },
            files={
                "file": (f"{name}.json", body, "application/json"),
            },
            data={
                "pinataMetadata": json.dumps(metadata, separators=(",", ":")),
            },
            timeout=self.timeout,
        )
        response.raise_for_status()
        data = response.json()
        cid = data.get("IpfsHash")
        if not cid:
            raise RuntimeError(f"Pinata response missing IpfsHash: {data}")
        return {
            "cid": cid,
            "sha256": sha256_hex(body),
            "size_bytes": len(body),
            "provider": "pinata",
            "response": data,
        }

    def fetch_json(self, cid: str) -> dict[str, Any]:
        errors = []
        for gateway in self.config.ipfs_gateway_urls:
            url = f"{gateway.rstrip('/')}/{cid}"
            try:
                response = requests.get(url, timeout=self.timeout)
                response.raise_for_status()
                return response.json()
            except Exception as exc:
                errors.append(f"{url}: {exc}")
        raise RuntimeError(f"Unable to fetch IPFS CID {cid}: {'; '.join(errors)}")

