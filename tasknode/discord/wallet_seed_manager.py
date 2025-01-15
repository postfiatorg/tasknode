from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
import base64
from typing import Optional, List
from nodetools.protocols.credentials import CredentialManager
from nodetools.protocols.transaction_repository import TransactionRepository
from nodetools.configuration.configuration import NodeConfig
from nodetools.sql.sql_manager import SQLManager
from xrpl.wallet import Wallet
from loguru import logger
from asyncpg.exceptions import UniqueViolationError
from dataclasses import dataclass
import json

@dataclass
class EncryptedData:
    version: int
    data: str

    def to_string(self) -> str:
        return json.dumps({'version': self.version, 'data': self.data})

    @staticmethod
    def from_string(s: str) -> 'EncryptedData':
        data = json.loads(s)
        return EncryptedData(version=int(data['version']), data=data['data'])

class WalletSeedManager:
    def __init__(
        self,
        credential_manager: CredentialManager,
        tx_repo: TransactionRepository,
        node_config: NodeConfig
    ):
        self.credential_manager = credential_manager
        self.tx_repo = tx_repo
        self.node_config = node_config
        self.sql_manager = SQLManager('tasknode/sql')
        self._current_key_version = self._get_current_key_version()
        self._fernet = self._initialize_encryption(self._current_key_version)
        
    def _get_current_key_version(self) -> int:
        """Get the current key version from credentials"""
        try:
            return int(self.credential_manager.get_credential(f"{self.node_config.node_name}__key_version"))
        except:
            # Initialize with version 1 if not found
            self.credential_manager.enter_and_encrypt_credential({
                f"{self.node_config.node_name}__key_version": "1"
            })
            return 1

    def _initialize_encryption(self, version: int) -> Fernet:
        """Initialize Fernet encryption using node operator's seed as key"""
        # Use PBKDF2 to derive a key from the operator's seed
        kdf = PBKDF2HMAC(
            algorithm=hashes.SHA256(),
            length=32,
            salt=f'postfiat_wallet_seed_manager_v{version}'.encode(),  # Seed is source of entropy
            iterations=100000
        )
        key = base64.urlsafe_b64encode(
            kdf.derive(
                self.credential_manager.get_credential(f"{self.node_config.node_name}__v1xrpsecret").encode()
            )
        )
        return Fernet(key)
    
    def _encrypt_seed(self, seed: str) -> str:
        """Encrypt a seed using the current key version"""
        encrypted = EncryptedData(
            version=self._current_key_version,
            data=self._fernet.encrypt(seed.encode()).decode()
        )
        return encrypted.to_string()

    def _decrypt_seed(self, encrypted_str: str) -> str:
        encrypted = EncryptedData.from_string(encrypted_str)
        if encrypted.version != self._current_key_version:
            fernet = self._initialize_encryption(encrypted.version)
        else:
            fernet = self._fernet
        return fernet.decrypt(encrypted.data.encode()).decode()
    
    async def rotate_encryption_key(self) -> bool:
        """Rotate the encryption key and re-encrypt all stored seeds"""
        logger.info(f"Rotating encryption key for {self.node_config.node_name}. This may take a few moments...")
        try:
            # Get all wallet seeds
            query = self.sql_manager.load_query('discord', 'get_all_wallet_seeds')
            wallets = await self.tx_repo.execute_query(query)

            # Create new key version
            new_version = self._current_key_version + 1
            new_fernet = self._initialize_encryption(new_version)

            # Re-encrypt all seeds with new key
            for wallet in wallets:
                # Decrypt with old key
                encrypted_data = EncryptedData.from_string(wallet['encrypted_seed'])
                old_fernet = self._initialize_encryption(encrypted_data.version)
                seed = old_fernet.decrypt(encrypted_data.data.encode()).decode()

                # Encrypt with new key
                new_encrypted = EncryptedData(
                    version=new_version,
                    data=new_fernet.encrypt(seed.encode()).decode()
                )

                # Update database
                query = self.sql_manager.load_query('discord', 'update_wallet_seed')
                params = [wallet['discord_user_id'], wallet['wallet_label'], new_encrypted.to_string()]
                await self.tx_repo.execute_query(query, params)

            # Update current version
            self.credential_manager.enter_and_encrypt_credential({
                f"{self.node_config.node_name}__key_version": str(new_version)
            })
            self._current_key_version = new_version
            self._fernet = new_fernet
            
            logger.info(f"Encryption key rotated successfully for {self.node_config.node_name}")
            return True
        except Exception as e:
            logger.error(f"Key rotation failed: {e}")
            return False

    async def store_wallet_seed(
        self,
        discord_user_id: int,
        seed: str,
        label: Optional[str] = None
    ) -> tuple[bool, str]:
        """Store an encrypted wallet seed for a user"""
        if label is None or label == '':
            # Get count of existing wallets to generate default label
            query = self.sql_manager.load_query('discord', 'count_user_wallets')
            params = [discord_user_id]
            result = await self.tx_repo.execute_query(query, params)
            count = result[0]['count'] if result else 0
            label = f"Wallet {count + 1}"

        encrypted_seed = self._encrypt_seed(seed)

        query = self.sql_manager.load_query('discord', 'insert_wallet_seed')
        params = [discord_user_id, label, encrypted_seed]
        try:
            result = await self.tx_repo.execute_query(query, params)
        except UniqueViolationError:
            return False, "A wallet with this label already exists"

        if len(result) > 0:
            # Then set it as active
            query = self.sql_manager.load_query('discord', 'set_active_wallet')
            params = [discord_user_id, label]
            await self.tx_repo.execute_query(query, params)
            return True, "Wallet created successfully"
            
        return False, "An error occurred while storing your seed"

    async def get_active_seed(
        self,
        discord_user_id: int
    ) -> Optional[str]:
        """Get the active seed for a user"""
        query = self.sql_manager.load_query('discord', 'get_active_seed')
        params = [discord_user_id]
        result = await self.tx_repo.execute_query(query, params)

        if result and result[0].get('encrypted_seed'):
            encrypted_seed = result[0]['encrypted_seed']
            return self._decrypt_seed(encrypted_seed)
        return None
    
    async def set_active_wallet(
        self,
        discord_user_id: int,
        label: str
    ) -> bool:
        """Set the active wallet for a user"""
        query = self.sql_manager.load_query('discord', 'set_active_wallet')
        params = [discord_user_id, label]
        
        result = await self.tx_repo.execute_query(query, params)
        return len(result) > 0
    
    # NOTE: Not used yet
    async def delete_wallet_seed(
        self,
        discord_user_id: int,
        label: str
    ) -> bool:
        """Delete a wallet seed for a user"""
        query = self.sql_manager.load_query('discord', 'delete_wallet_seed')
        params = [discord_user_id, label]
        
        result = await self.tx_repo.execute_query(query, params)
        return len(result) > 0
    
    async def get_wallet_details(self, discord_user_id: int) -> List[dict]:
        """Get wallet labels, active status, and derived XRP addresses"""
        query = self.sql_manager.load_query('discord', 'get_wallet_details')
        params = [discord_user_id]
        wallets = await self.tx_repo.execute_query(query, params)
        
        wallet_details = []
        for w in wallets:
            seed = self._decrypt_seed(w['encrypted_seed'])
            xrp_wallet = Wallet.from_seed(seed)
            
            wallet_details.append({
                'label': w['wallet_label'],
                'is_active': w['is_active'],
                'address': xrp_wallet.classic_address
            })
            
        return wallet_details