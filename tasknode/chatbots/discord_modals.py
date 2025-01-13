import discord
from discord.ui import Modal, TextInput
from tasknode.protocols.tasknode_utilities import TaskNodeUtilities
from nodetools.protocols.generic_pft_utilities import GenericPFTUtilities
from nodetools.protocols.transaction_repository import TransactionRepository
from decimal import Decimal
from xrpl.wallet import Wallet
from typing import TYPE_CHECKING, Optional
from loguru import logger
import nodetools.configuration.constants as global_constants
import nodetools.configuration.configuration as config
from tasknode.task_processing.constants import MAX_COMMITMENT_SENTENCE_LENGTH
import traceback
import re

if TYPE_CHECKING:
    from tasknode.chatbots.pft_discord import TaskNodeDiscordBot

class VerifyAddressModal(discord.ui.Modal, title='Verify XRP Address'):
    def __init__(self, client: 'TaskNodeDiscordBot'):
        super().__init__()
        self.client = client

        self.address = discord.ui.TextInput(
            label='XRP Address to Verify',
            placeholder='rXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
            style=discord.TextStyle.short,
            required=True,
            min_length=25,
            max_length=35
        )
        self.add_item(self.address)

    async def on_submit(self, interaction: discord.Interaction):
        address = self.address.value.strip()
        user_id = str(interaction.user.id)
        
        try:
            # Validate XRP address format
            if not re.match('^r[1-9A-HJ-NP-Za-km-z]{25,34}$', address):
                await interaction.response.send_message(
                    "Invalid XRP address format. Please try again.",
                    ephemeral=True
                )
                return
            
            # Check if user has active flags
            if not await self.client.check_user_flag_status(
                interaction=interaction,
                action="verify new addresses"
            ):
                return

            # Store authorization in database
            await self.client.transaction_repository.authorize_address(
                address=address,
                auth_source='discord',
                auth_source_user_id=str(user_id)
            )

            await interaction.response.send_message(
                f"Successfully verified address {address}. You can now use Post-Fiat features with this address.",
                ephemeral=True
            )

        except Exception as e:
            logger.error(f"Error verifying address: {e}")
            await interaction.response.send_message(
                "An error occurred while verifying your address. Please try again later.",
                ephemeral=True
            )

class WalletInfoModal(discord.ui.Modal, title='New XRP Wallet'):
    def __init__(
            self, 
            classic_address: str,
            wallet_seed: str,
            client: 'TaskNodeDiscordBot'
        ):
        super().__init__()
        self.classic_address = classic_address
        self.wallet_seed = wallet_seed
        self.client = client

        self.address = discord.ui.TextInput(
            label='Address (Do not modify)',
            default=self.classic_address,
            style=discord.TextStyle.short,
            required=True
        )
        self.seed = discord.ui.TextInput(
            label='Secret - Submit Stores. Cancel (Exit)',
            default=self.wallet_seed,
            style=discord.TextStyle.short,
            required=True
        )
        self.add_item(self.address)
        self.add_item(self.seed)

    async def on_submit(self, interaction: discord.Interaction):
        user_id = interaction.user.id
        logger.debug(f"WalletInfoModal.on_submit: Storing seed for user {interaction.user.name} (ID: {user_id})")
        self.client.user_seeds[user_id] = self.seed.value

        # Check if user has active flags
        if not await self.client.check_user_flag_status(
            interaction=interaction,
            action="create a new wallet"
        ):
            return

        # Automatically authorize the address
        await self.client.transaction_repository.authorize_address(
            address=self.address.value,
            auth_source='discord',
            auth_source_user_id=str(user_id)
        )

        await interaction.response.send_message(
            f"Wallet created successfully. You must fund the wallet with {global_constants.MIN_XRP_BALANCE} XRP to use as a Post Fiat Wallet. "
            "The seed is stored to Discord Hot Wallet. To store different seed use /pf_store_seed. "
            "We recommend you often sweep the wallet to a cold wallet. Use the /pf_send command to do so",
            ephemeral=True
        )

class SeedModal(discord.ui.Modal, title='Store Your Seed'):
    seed = discord.ui.TextInput(label='Seed', style=discord.TextStyle.long)

    def __init__(self, client: 'TaskNodeDiscordBot'):
        super().__init__()
        self.client = client  # Save the client reference

    async def on_submit(self, interaction: discord.Interaction):
        user_id = interaction.user.id

        # Test seed for validity
        try:
            wallet = self.client.generic_pft_utilities.spawn_wallet_from_seed(self.seed.value.strip())
        except Exception as e:
            await interaction.response.send_message(f"An error occurred while storing your seed: {str(e)}", ephemeral=True)
            return
        
        self.client.user_seeds[user_id] = self.seed.value.strip()  # Store the seed

        # Check if user has active flags
        if not await self.client.check_user_flag_status(
            interaction=interaction,
            action="store a new seed"
        ):
            return

        # Automatically authorize the address
        await self.client.transaction_repository.authorize_address(
            address=wallet.classic_address,
            auth_source='discord',
            auth_source_user_id=str(user_id)
        )
        await interaction.response.send_message(
            f'Seed stored and address {wallet.classic_address} authorized for user {interaction.user.name}.', 
            ephemeral=True
        )

class PFTTransactionModal(discord.ui.Modal, title='Send PFT'):
    address = discord.ui.TextInput(label='Recipient Address')
    amount = discord.ui.TextInput(label='Amount')
    message = discord.ui.TextInput(label='Message', style=discord.TextStyle.long, required=False)

    def __init__(
            self, 
            client: 'TaskNodeDiscordBot',
            wallet: Wallet,
            generic_pft_utilities: GenericPFTUtilities
        ):
        super().__init__(title='Send PFT')
        self.client = client
        self.wallet = wallet
        self.generic_pft_utilities = generic_pft_utilities

    async def on_submit(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)

        # Validate not sending to self
        destination_address = self.address.value
        if destination_address.lower() == self.wallet.address.lower():
            await interaction.followup.send("Error: Cannot send PFT to your own address", ephemeral=True)
            return
        
        amount = self.amount.value
        message = self.message.value

        try:
            response = await self.generic_pft_utilities.send_memo(
                wallet_seed_or_wallet=self.wallet,
                destination=destination_address,
                memo_type='PFT_SEND',
                memo_data=message,
                pft_amount=Decimal(amount)
            )

            if not self.generic_pft_utilities.verify_transaction_response(response):
                raise Exception(f"Failed to send PFT transaction: {response.result}")
            
            await self.client.display_transaction_results(interaction, response)

        except Exception as e:
            logger.error(f"PFTTransactionModal.on_submit: Error sending memo: {e}")
            logger.error(traceback.format_exc())
            await interaction.followup.send(f"An error occurred: {str(e)}", ephemeral=True)
            return

class XRPTransactionModal(discord.ui.Modal, title='XRP Transaction Details'):
    address = discord.ui.TextInput(label='Recipient Address')
    amount = discord.ui.TextInput(label='Amount (in XRP)')
    message = discord.ui.TextInput(
        label='Message', 
        style=discord.TextStyle.long, 
        required=False,
        placeholder='Insert an optional message'
    )
    destination_tag = discord.ui.TextInput(
        label='Destination Tag',
        required=False,
        placeholder='Required for most exchanges'
    )

    def __init__(
            self, 
            client: 'TaskNodeDiscordBot',
            wallet: Wallet,
            generic_pft_utilities: GenericPFTUtilities
        ):
        super().__init__(title="Send XRP")
        self.client = client
        self.wallet = wallet
        self.generic_pft_utilities = generic_pft_utilities

    async def on_submit(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=True)

        # Validate not sending to self
        destination_address = self.address.value
        if destination_address.lower() == self.wallet.address.lower():
            await interaction.followup.send("Error: Cannot send XRP to your own address", ephemeral=True)
            return

        amount = self.amount.value
        message = self.message.value
        destination_tag = self.destination_tag.value

        # Create the memo
        memo = self.generic_pft_utilities.construct_memo(
            memo_data=message,
            memo_format=interaction.user.name,
            memo_type="XRP_SEND"
        )

        try:
            # Convert destination_tag to integer if it exists
            dt = int(destination_tag) if destination_tag else None

            try:
                response = await self.generic_pft_utilities.send_xrp(
                    wallet_seed_or_wallet=self.wallet,
                    amount=Decimal(amount),
                    destination=destination_address,
                    memo=memo,
                    destination_tag=dt
                )

                if not self.generic_pft_utilities.verify_transaction_response(response):
                    raise Exception(f"Failed to send XRP transaction: {response.result}")

            except Exception as e:
                logger.error(f"XRPTransactionModal.on_submit: Error sending XRP transaction: {e}")
                logger.error(traceback.format_exc())
                await interaction.followup.send(f"An error occurred: {str(e)}", ephemeral=True)
                return

            # Extract transaction information using the improved function
            await self.client.display_transaction_results(interaction, response)
            
        except Exception as e:
            logger.error(f"XRPTransactionModal.on_submit: Error sending XRP transaction: {e}")
            logger.error(traceback.format_exc())
            await interaction.followup.send(f"An error occurred: {str(e)}", ephemeral=True)
            return

class InitiationModal(discord.ui.Modal, title='Initiation Rite'):

    google_doc_link = discord.ui.TextInput(
        label='Please enter your Google Doc Link', 
        style=discord.TextStyle.long,
        placeholder="Your link will be encrypted but the node operator retains access for effective task generation."
    )
    commitment_sentence = discord.ui.TextInput(
        label='Commit to a Long-Term Objective',
        style=discord.TextStyle.long,
        max_length=MAX_COMMITMENT_SENTENCE_LENGTH,
        placeholder="A 1-sentence commitment to a long-term objective"
    )

    def __init__(
        self,
        seed: str,
        username: str,
        client_instance: 'TaskNodeDiscordBot',
        tasknode_utilities: TaskNodeUtilities,
        ephemeral_setting: bool = True
    ):
        super().__init__(title='Initiation Rite')
        self.seed = seed
        self.username = username
        self.client = client_instance
        self.tasknode_utilities = tasknode_utilities
        self.ephemeral_setting = ephemeral_setting

    async def on_submit(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=self.ephemeral_setting)
        
        try:
            handshake_success, user_key, node_key, message_obj = await self.client._ensure_handshake(
                interaction=interaction,
                seed=self.seed,
                counterparty=self.client.generic_pft_utilities.node_address,
                username=self.username,
                command_name="pf_initiate"
            )
            
            if not handshake_success:
                return
            
            await message_obj.edit(content="Sending commitment and encrypted google doc link to node...")

            try:
                await self.tasknode_utilities.discord__initiation_rite(
                    user_seed=self.seed, 
                    initiation_rite=self.commitment_sentence.value, 
                    google_doc_link=self.google_doc_link.value, 
                    username=self.username
                )
            except Exception as e:
                logger.error(f"InitiationModal.on_submit: Error during initiation: {str(e)}")
                logger.error(traceback.format_exc())
                await message_obj.edit(content=f"An error occurred during initiation: {str(e)}")
                return
            
            mode = "(TEST MODE)" if config.RuntimeConfig.USE_TESTNET else ""
            await message_obj.edit(
                content=f"Initiation complete! {mode}\nCommitment: {self.commitment_sentence.value}\nGoogle Doc: {self.google_doc_link.value}"
            )

        except Exception as e:
            logger.error(f"InitiationModal.on_submit: Error during initiation: {str(e)}")
            logger.error(traceback.format_exc())
            await message_obj.edit(content=f"An error occurred during initiation: {str(e)}")

class UpdateLinkModal(discord.ui.Modal, title='Update Google Doc Link'):
    def __init__(
            self,
            seed: str,
            username: str,
            client_instance: 'TaskNodeDiscordBot',
            tasknode_utilities: TaskNodeUtilities,
            ephemeral_setting: bool = True
        ):
        super().__init__(title='Update Google Doc Link')
        self.seed = seed
        self.username = username
        self.client: 'TaskNodeDiscordBot' = client_instance
        self.tasknode_utilities = tasknode_utilities
        self.ephemeral_setting = ephemeral_setting

    google_doc_link = discord.ui.TextInput(
        label='Please enter new Google Doc Link', 
        style=discord.TextStyle.long,
        placeholder="Your link will be encrypted but the node operator retains access for effective task generation."
    )

    async def on_submit(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=self.ephemeral_setting)

        try:
            handshake_success, user_key, node_key, message_obj = await self.client._ensure_handshake(
                interaction=interaction,
                seed=self.seed,
                counterparty=self.client.generic_pft_utilities.node_address,
                username=self.username,
                command_name="pf_update_link"
            )

            if not handshake_success:
                return

            await message_obj.edit(content="Sending encrypted google doc link to node...")

            await self.tasknode_utilities.discord__update_google_doc_link(
                user_seed=self.seed,
                google_doc_link=self.google_doc_link.value,
                username=self.username
            )

            await message_obj.edit(content=f"Google Doc link updated to {self.google_doc_link.value}")

        except Exception as e:
            logger.error(f"UpdateLinkModal.on_submit: Error during update: {str(e)}")
            await interaction.followup.send(f"An error occurred during update: {str(e)}", ephemeral=self.ephemeral_setting)

class AcceptanceModal(Modal):
    """Modal for accepting a task"""
    def __init__(
            self, 
            task_id: str, 
            task_text: str, 
            seed: str, 
            user_name: str,
            client: 'TaskNodeDiscordBot',
            tasknode_utilities: 'TaskNodeUtilities',
            ephemeral_setting: bool = True
        ):
        super().__init__(title="Accept Task")
        self.task_id = task_id
        self.seed = seed
        self.user_name = user_name
        self.client = client
        self.tasknode_utilities = tasknode_utilities
        self.ephemeral_setting = ephemeral_setting

        # Add a label to display the full task description
        self.task_description = discord.ui.TextInput(
            label="Task Description (Do not modify)",
            default=task_text,
            style=discord.TextStyle.paragraph,
            required=False
        )
        self.add_item(self.task_description)
        
        # Add the acceptance string input
        self.acceptance_string = TextInput(
            label="Acceptance String", 
            placeholder="Type your acceptance string here",
            style=discord.TextStyle.paragraph
        )
        self.add_item(self.acceptance_string)

    async def on_submit(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=self.ephemeral_setting)

        acceptance_string = self.acceptance_string.value
        
        response = await self.tasknode_utilities.discord__task_acceptance(
            user_seed=self.seed,
            user_name=self.user_name,
            task_id_to_accept=self.task_id,
            acceptance_string=acceptance_string
        )
        
        await self.client.display_transaction_results(interaction, response, ephemeral=self.ephemeral_setting)

class RefusalModal(Modal):
    def __init__(
            self, 
            task_id: str, 
            task_text: str, 
            seed: str, 
            user_name: str,
            client: 'TaskNodeDiscordBot',
            tasknode_utilities: 'TaskNodeUtilities',
            ephemeral_setting: bool = True
        ):
        super().__init__(title="Refuse Task")
        self.task_id = task_id
        self.seed = seed
        self.user_name = user_name
        self.client = client
        self.tasknode_utilities = tasknode_utilities
        self.ephemeral_setting = ephemeral_setting
        
        # Add a label to display the full task description
        self.task_description = discord.ui.TextInput(
            label="Task Description (Do not modify)",
            default=task_text,
            style=discord.TextStyle.paragraph,
            required=False
        )
        self.add_item(self.task_description)
        
        # Add the refusal string input
        self.refusal_string = TextInput(
            label="Refusal Reason", 
            placeholder="Type your reason for refusing this task",
            style=discord.TextStyle.paragraph
        )
        self.add_item(self.refusal_string)

    async def on_submit(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=self.ephemeral_setting)
        
        refusal_string = self.refusal_string.value
        
        response = await self.tasknode_utilities.discord__task_refusal(
            user_seed=self.seed,
            user_name=self.user_name,
            task_id_to_refuse=self.task_id,
            refusal_string=refusal_string
        )
        
        await self.client.display_transaction_results(interaction, response, ephemeral=self.ephemeral_setting)

class CompletionModal(Modal):
    def __init__(
            self, 
            task_id: str, 
            task_text: str, 
            seed: str, 
            user_name: str,
            client: 'TaskNodeDiscordBot',
            tasknode_utilities: 'TaskNodeUtilities',
            ephemeral_setting: bool = True
        ):
        super().__init__(title="Submit Task for Verification")
        self.task_id = task_id
        self.seed = seed
        self.user_name = user_name
        self.client = client
        self.tasknode_utilities = tasknode_utilities
        self.ephemeral_setting = ephemeral_setting
        
        # Add a label to display the full task description
        self.task_description = discord.ui.TextInput(
            label="Task Description (Do not modify)",
            default=task_text,
            style=discord.TextStyle.paragraph,
            required=False
        )
        self.add_item(self.task_description)
        
        # Add the completion justification input
        self.completion_justification = TextInput(
            label="Completion Justification", 
            placeholder="Explain how you completed the task",
            style=discord.TextStyle.paragraph
        )
        self.add_item(self.completion_justification)

    async def on_submit(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=self.ephemeral_setting)

        completion_string = self.completion_justification.value
        
        response = await self.tasknode_utilities.discord__initial_submission(
            user_seed=self.seed,
            user_name=self.user_name,
            task_id_to_accept=self.task_id,
            initial_completion_string=completion_string
        )
        
        await self.client.display_transaction_results(interaction, response, ephemeral=self.ephemeral_setting)

class VerificationModal(Modal):
    def __init__(
            self, 
            task_id: str, 
            task_text: str, 
            seed: str, 
            user_name: str,
            client: 'TaskNodeDiscordBot',
            tasknode_utilities: 'TaskNodeUtilities',
            ephemeral_setting: bool = True
        ):
        super().__init__(title="Submit Final Verification")
        self.task_id = task_id
        self.seed = seed
        self.user_name = user_name
        self.client = client
        self.tasknode_utilities = tasknode_utilities
        self.ephemeral_setting = ephemeral_setting
        
        # Add a label to display the full task description
        self.task_description = discord.ui.TextInput(
            label="Task Description (Do not modify)",
            default=task_text,
            style=discord.TextStyle.paragraph,
            required=False
        )
        self.add_item(self.task_description)
        
        # Add the verification justification input
        self.verification_justification = TextInput(
            label="Verification Justification", 
            placeholder="Explain how you verified the task completion",
            style=discord.TextStyle.paragraph
        )
        self.add_item(self.verification_justification)

    async def on_submit(self, interaction: discord.Interaction):
        await interaction.response.defer(ephemeral=self.ephemeral_setting)
        
        justification_string = self.verification_justification.value
        
        response = await self.tasknode_utilities.discord__final_submission(
            user_seed=self.seed,
            user_name=self.user_name,
            task_id_to_submit=self.task_id,
            justification_string=justification_string
        )
        
        await self.client.display_transaction_results(interaction, response, ephemeral=self.ephemeral_setting)