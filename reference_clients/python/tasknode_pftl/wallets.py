from __future__ import annotations

from dataclasses import dataclass
import hmac
import hashlib

from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from mnemonic import Mnemonic
from xrpl.wallet import Wallet

from .encryption import X25519Identity, identity_from_mnemonic, identity_from_wallet_seed, is_bip39_mnemonic, normalize_mnemonic
from .pftl import PftlClient, pft_to_drops

DEFAULT_DERIVATION_PATH = "m/44'/144'/0'/0/0"
SECP256K1_ORDER = int("FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141", 16)
_MNEMONIC = Mnemonic("english")


@dataclass
class ProtocolWallet:
    role: str
    wallet: Wallet
    encryption: X25519Identity

    @property
    def address(self) -> str:
        return self.wallet.address

    @property
    def public_seedless(self) -> dict:
        return {
            "role": self.role,
            "address": self.wallet.address,
            "public_key": self.wallet.public_key,
            "x25519": self.encryption.public_descriptor(),
        }

    @property
    def private_descriptor(self) -> dict:
        return {
            "role": self.role,
            "address": self.wallet.address,
            "seed": self.wallet.seed,
            "public_key": self.wallet.public_key,
            "private_key": self.wallet.private_key,
            "x25519": self.encryption.private_descriptor(),
        }


def create_protocol_wallet(role: str) -> ProtocolWallet:
    wallet = Wallet.create()
    return ProtocolWallet(
        role=role,
        wallet=wallet,
        encryption=identity_from_wallet_seed(role=role, wallet_seed=wallet.seed, wallet_address=wallet.address),
    )


def wallet_from_seed(role: str, seed: str) -> ProtocolWallet:
    if is_bip39_mnemonic(seed):
        return wallet_from_mnemonic(role, seed)
    wallet = Wallet.from_seed(seed)
    return ProtocolWallet(
        role=role,
        wallet=wallet,
        encryption=identity_from_wallet_seed(role=role, wallet_seed=wallet.seed, wallet_address=wallet.address),
    )


def wallet_from_mnemonic(role: str, mnemonic: str, derivation_path: str = DEFAULT_DERIVATION_PATH) -> ProtocolWallet:
    normalized = normalize_mnemonic(mnemonic)
    if not is_bip39_mnemonic(normalized):
        raise ValueError("valid 24-word BIP39 mnemonic is required")
    wallet = wallet_from_bip39_mnemonic(normalized, derivation_path=derivation_path)
    return ProtocolWallet(
        role=role,
        wallet=wallet,
        encryption=identity_from_mnemonic(role=role, mnemonic=normalized, wallet_address=wallet.address),
    )


def wallet_from_bip39_mnemonic(mnemonic: str, derivation_path: str = DEFAULT_DERIVATION_PATH) -> Wallet:
    seed = _MNEMONIC.to_seed(normalize_mnemonic(mnemonic))
    private_int, _chain_code = derive_bip32_private_key(seed, derivation_path)
    private_key_hex = f"{private_int:064x}".upper()
    public_key_hex = compressed_public_key_hex(private_int)
    return Wallet(public_key_hex, f"00{private_key_hex}", seed=None)


def derive_bip32_private_key(seed: bytes, derivation_path: str) -> tuple[int, bytes]:
    digest = hmac.new(b"Bitcoin seed", seed, hashlib.sha512).digest()
    private_int = int.from_bytes(digest[:32], "big")
    chain_code = digest[32:]
    if private_int <= 0 or private_int >= SECP256K1_ORDER:
        raise ValueError("invalid BIP32 master private key")
    for index in parse_derivation_path(derivation_path):
        private_int, chain_code = child_private_key(private_int, chain_code, index)
    return private_int, chain_code


def parse_derivation_path(path: str) -> list[int]:
    parts = str(path or "").split("/")
    if not parts or parts[0] != "m":
        raise ValueError("derivation path must start with m")
    indexes = []
    for part in parts[1:]:
        hardened = part.endswith("'")
        value = int(part[:-1] if hardened else part)
        if value < 0 or value >= 0x80000000:
            raise ValueError("invalid derivation path index")
        indexes.append(value + (0x80000000 if hardened else 0))
    return indexes


def child_private_key(parent_private: int, parent_chain_code: bytes, index: int) -> tuple[int, bytes]:
    if index >= 0x80000000:
        data = b"\x00" + parent_private.to_bytes(32, "big") + index.to_bytes(4, "big")
    else:
        data = bytes.fromhex(compressed_public_key_hex(parent_private)) + index.to_bytes(4, "big")
    digest = hmac.new(parent_chain_code, data, hashlib.sha512).digest()
    child_int = (int.from_bytes(digest[:32], "big") + parent_private) % SECP256K1_ORDER
    if child_int == 0:
        raise ValueError("invalid BIP32 child private key")
    return child_int, digest[32:]


def compressed_public_key_hex(private_int: int) -> str:
    private_key = ec.derive_private_key(private_int, ec.SECP256K1())
    return private_key.public_key().public_bytes(Encoding.X962, PublicFormat.CompressedPoint).hex().upper()


def fund_wallets(
    client: PftlClient,
    faucet_seed: str,
    wallets: list[ProtocolWallet],
    *,
    target_pft: float,
) -> list[dict]:
    faucet = Wallet.from_seed(faucet_seed)
    out = []
    target_drops = int(pft_to_drops(target_pft))
    for protocol_wallet in wallets:
        current = client.account_balance_drops(protocol_wallet.address)
        if current >= target_drops:
            out.append({
                "address": protocol_wallet.address,
                "funded": False,
                "balance_drops": current,
            })
            continue
        delta = target_drops - current
        tx = client.submit_payment(faucet, protocol_wallet.address, str(delta))
        out.append({
            "address": protocol_wallet.address,
            "funded": True,
            "funded_drops": str(delta),
            "tx_hash": tx.tx_hash,
            "balance_drops": client.account_balance_drops(protocol_wallet.address),
        })
    return out


def publish_wallet_message_keys(
    client: PftlClient,
    wallets: list[ProtocolWallet],
) -> list[dict]:
    out = []
    for protocol_wallet in wallets:
        expected = protocol_wallet.encryption.message_key
        current = client.account_message_key(protocol_wallet.address)
        if current == expected:
            out.append({
                "role": protocol_wallet.role,
                "address": protocol_wallet.address,
                "published": False,
                "already_published": True,
                "message_key": expected,
                "x25519_public_key": protocol_wallet.encryption.public_key_b64,
                "x25519_public_key_hex": protocol_wallet.encryption.public_key_hex,
            })
            continue

        tx = client.submit_message_key(protocol_wallet.wallet, expected)
        resolved = client.account_message_key(protocol_wallet.address)
        out.append({
            "role": protocol_wallet.role,
            "address": protocol_wallet.address,
            "published": True,
            "already_published": False,
            "prior_message_key": current,
            "message_key": expected,
            "resolved_message_key": resolved,
            "x25519_public_key": protocol_wallet.encryption.public_key_b64,
            "x25519_public_key_hex": protocol_wallet.encryption.public_key_hex,
            "tx_hash": tx.tx_hash,
            "ledger_index": tx.ledger_index,
            "result": tx.result,
        })
    return out
