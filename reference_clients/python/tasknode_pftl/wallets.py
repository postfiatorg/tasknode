from __future__ import annotations

from dataclasses import dataclass

from xrpl.wallet import Wallet

from .encryption import X25519Identity, generate_identity
from .pftl import PftlClient, pft_to_drops


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
        encryption=generate_identity(role=role, wallet_address=wallet.address),
    )


def wallet_from_seed(role: str, seed: str) -> ProtocolWallet:
    wallet = Wallet.from_seed(seed)
    return ProtocolWallet(
        role=role,
        wallet=wallet,
        encryption=generate_identity(role=role, wallet_address=wallet.address),
    )


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

