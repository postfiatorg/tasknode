import unittest

from tasknode_pftl.wallets import wallet_from_seed


SMOKE_MNEMONIC = (
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon "
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art"
)


class MnemonicWalletTests(unittest.TestCase):
    def test_bip39_wallet_matches_app_derivation_vector(self):
        wallet = wallet_from_seed("user", SMOKE_MNEMONIC)

        self.assertEqual(wallet.address, "rKxpJQ6hLWYbo7p1oo7WHjrcrRFv1TUQeC")
        self.assertEqual(
            wallet.wallet.public_key,
            "03543B859FF40BF433302D20A322DB4EAD92D112F6C20F52864468262E083DC9EE",
        )
        self.assertEqual(wallet.encryption.public_key_b64, "VCaEXCXOqr8KyyV1XUy9RNRieGecrgPKzhTldJjSIR0=")


if __name__ == "__main__":
    unittest.main()
