from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Iterable

from nacl import bindings

from .codec import b64d, b64e, sha256_hex

ENC_SUITE = "ENC_X25519_XCHACHA20P1305"
MESSAGE_KEY_PREFIX = "ED"
X25519_DERIVATION_DOMAIN = "tasknode.pftl.x25519.v1"


@dataclass
class X25519Identity:
    role: str
    public_key: bytes
    private_key: bytes
    wallet_address: str | None = None

    @property
    def public_key_b64(self) -> str:
        return b64e(self.public_key)

    @property
    def private_key_b64(self) -> str:
        return b64e(self.private_key)

    @property
    def recipient_id(self) -> str:
        return sha256_hex(self.public_key)

    @property
    def public_key_hex(self) -> str:
        return self.public_key.hex()

    @property
    def message_key(self) -> str:
        return message_key_from_x25519_public_key(self.public_key)

    def public_descriptor(self) -> dict:
        return {
            "role": self.role,
            "wallet_address": self.wallet_address,
            "public_key": self.public_key_b64,
            "public_key_hex": self.public_key_hex,
            "message_key": self.message_key,
            "recipient_id": self.recipient_id,
        }

    def private_descriptor(self) -> dict:
        return {
            **self.public_descriptor(),
            "private_key": self.private_key_b64,
        }


def generate_identity(role: str, wallet_address: str | None = None) -> X25519Identity:
    public_key, private_key = bindings.crypto_box_keypair()
    return X25519Identity(role=role, public_key=public_key, private_key=private_key, wallet_address=wallet_address)


def identity_from_seed_material(role: str, seed_material: str, wallet_address: str | None = None) -> X25519Identity:
    if not seed_material:
        raise ValueError("seed_material is required")
    seed_bytes = hashlib.sha256(f"{X25519_DERIVATION_DOMAIN}:{seed_material}".encode("utf-8")).digest()
    public_key, private_key = bindings.crypto_box_seed_keypair(seed_bytes)
    return X25519Identity(role=role, public_key=public_key, private_key=private_key, wallet_address=wallet_address)


def identity_from_wallet_seed(role: str, wallet_seed: str, wallet_address: str | None = None) -> X25519Identity:
    return identity_from_seed_material(role=role, seed_material=wallet_seed, wallet_address=wallet_address)


def identity_from_private_descriptor(data: dict) -> X25519Identity:
    return X25519Identity(
        role=str(data["role"]),
        wallet_address=data.get("wallet_address"),
        public_key=b64d(data["public_key"]),
        private_key=b64d(data["private_key"]),
    )


def tasknode_identity_from_seed(seed: str, role: str = "task_node_service") -> X25519Identity:
    return identity_from_seed_material(role=role, seed_material=seed)


def message_key_from_x25519_public_key(public_key: bytes | str) -> str:
    raw = b64d(public_key) if isinstance(public_key, str) else public_key
    if len(raw) != bindings.crypto_box_PUBLICKEYBYTES:
        raise ValueError("X25519 public key must be 32 bytes")
    return f"{MESSAGE_KEY_PREFIX}{raw.hex()}".upper()


def x25519_public_key_from_message_key(message_key: str) -> bytes:
    normalized = str(message_key or "").strip().upper()
    if normalized.startswith(MESSAGE_KEY_PREFIX) and len(normalized) == 66:
        normalized = normalized[2:]
    if len(normalized) != 64:
        raise ValueError("PFTL MessageKey must be ED + 32 byte X25519 public key hex")
    try:
        raw = bytes.fromhex(normalized)
    except ValueError as exc:
        raise ValueError("PFTL MessageKey must be hex") from exc
    if len(raw) != bindings.crypto_box_PUBLICKEYBYTES:
        raise ValueError("PFTL MessageKey must decode to 32 bytes")
    return raw


def x25519_public_key_b64_from_message_key(message_key: str) -> str:
    return b64e(x25519_public_key_from_message_key(message_key))


def _public_key_bytes(value: X25519Identity | str | bytes) -> bytes:
    if isinstance(value, X25519Identity):
        return value.public_key
    if isinstance(value, bytes):
        return value
    return b64d(value)


def encrypt_json_bytes(plaintext: bytes, recipients: Iterable[X25519Identity | str | bytes]) -> dict:
    file_key = bindings.randombytes(bindings.crypto_aead_xchacha20poly1305_ietf_KEYBYTES)
    nonce = bindings.randombytes(bindings.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES)
    ciphertext = bindings.crypto_aead_xchacha20poly1305_ietf_encrypt(
        plaintext,
        aad=None,
        nonce=nonce,
        key=file_key,
    )

    shards = []
    for recipient in recipients:
        recipient_key = _public_key_bytes(recipient)
        eph_public, eph_private = bindings.crypto_box_keypair()
        wrap_nonce = bindings.randombytes(bindings.crypto_box_NONCEBYTES)
        encrypted_file_key = bindings.crypto_box(file_key, wrap_nonce, recipient_key, eph_private)
        role = recipient.role if isinstance(recipient, X25519Identity) else None
        wallet_address = recipient.wallet_address if isinstance(recipient, X25519Identity) else None
        shard = {
            "recipient_id": sha256_hex(recipient_key),
            "ephemeral_pubkey": b64e(eph_public),
            "wrap_nonce": b64e(wrap_nonce),
            "encrypted_file_key": b64e(encrypted_file_key),
        }
        if role:
            shard["role"] = role
        if wallet_address:
            shard["wallet_address"] = wallet_address
        shards.append(shard)

    return {
        "enc": ENC_SUITE,
        "nonce": b64e(nonce),
        "ciphertext": b64e(ciphertext),
        "recipients": shards,
    }


def decrypt_json_bytes(blob: dict, identity: X25519Identity) -> bytes:
    if blob.get("enc") != ENC_SUITE:
        raise ValueError(f"Unsupported encryption suite: {blob.get('enc')}")
    recipient_id = identity.recipient_id
    shard = next((entry for entry in blob.get("recipients", []) if entry.get("recipient_id") == recipient_id), None)
    if not shard:
        raise ValueError(f"Recipient shard missing for {identity.role}")
    file_key = bindings.crypto_box_open(
        b64d(shard["encrypted_file_key"]),
        b64d(shard["wrap_nonce"]),
        b64d(shard["ephemeral_pubkey"]),
        identity.private_key,
    )
    return bindings.crypto_aead_xchacha20poly1305_ietf_decrypt(
        b64d(blob["ciphertext"]),
        aad=None,
        nonce=b64d(blob["nonce"]),
        key=file_key,
    )
