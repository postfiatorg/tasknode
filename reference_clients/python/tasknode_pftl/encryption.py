from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Iterable

from nacl import bindings

from .codec import b64d, b64e, sha256_hex

ENC_SUITE = "ENC_X25519_XCHACHA20P1305"


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

    def public_descriptor(self) -> dict:
        return {
            "role": self.role,
            "wallet_address": self.wallet_address,
            "public_key": self.public_key_b64,
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


def identity_from_private_descriptor(data: dict) -> X25519Identity:
    return X25519Identity(
        role=str(data["role"]),
        wallet_address=data.get("wallet_address"),
        public_key=b64d(data["public_key"]),
        private_key=b64d(data["private_key"]),
    )


def tasknode_identity_from_seed(seed: str, role: str = "task_node_service") -> X25519Identity:
    seed_bytes = hashlib.sha256(seed.encode("utf-8")).digest()
    public_key, private_key = bindings.crypto_box_seed_keypair(seed_bytes)
    return X25519Identity(role=role, public_key=public_key, private_key=private_key)


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

