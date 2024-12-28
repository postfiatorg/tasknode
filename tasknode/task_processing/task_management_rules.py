"""
This module defines the business logic rules for processing XRPL transactions in NodeTools.
There are two distinct layers of validation:

1. Pattern Matching (handled by TransactionGraph):
   - Validates the structure of memos (memo_type, memo_data, and memo_format)
   - Matches transactions to their correct workflow type
   - Determines valid response patterns for request transactions
   - Example: Checking if a memo matches the pattern for a proposal (PROPOSED PF ___)

2. Business Rule Validation (handled by Rule classes):
   - Validates transaction-level requirements (e.g., transaction success)
   - Enforces content-specific rules (e.g., minimum length for initiation rites)
   - Validates contextual requirements (e.g., proper sequencing)
   - Example: Checking if an initiation rite contains meaningful content

Example Flow:
1. Transaction received: memo_type="2024-03-20_14:30", memo_data="REQUEST_POST_FIAT ___ Can i get a task to do?"
2. TransactionGraph matches this to the "request_post_fiat" pattern
3. RequestPostFiatRule then used to validate that:
   - The transaction was successful
   - Any other request_post_fiat-specific business rules

When adding new rules, remember:
- Pattern matching logic belongs in create_business_logic()
- Only transaction-specific validation logic belongs in Rule.validate()
"""
# Standard library imports
from typing import Dict, Any, Optional
import re
from decimal import Decimal
import traceback

# Third-party imports
from loguru import logger

# NodeTools imports
from nodetools.utilities.exceptions import HandshakeRequiredException
from nodetools.task_processing.constants import TaskType, MessageType
from nodetools.task_processing.user_context_parsing import UserTaskParser
from nodetools.utilities.credentials import SecretType
from nodetools.protocols.transaction_repository import TransactionRepository
from nodetools.protocols.generic_pft_utilities import GenericPFTUtilities
from nodetools.utilities.encryption import MessageEncryption
from nodetools.ai.openrouter import OpenRouterTool
from nodetools.protocols.credentials import CredentialManager
from nodetools.configuration.configuration import NodeConfig, RuntimeConfig
from nodetools.configuration.constants import (
    DEFAULT_OPENROUTER_MODEL,
    SystemMemoType
)
from nodetools.models.models import (
    InteractionGraph,
    MemoPattern,
    ResponseQuery,
    BusinessLogicProvider,
    RequestRule,
    ResponseRule,
    StandaloneRule,
    InteractionType,
    ResponseGenerator,
    ResponseParameters,
    Dependencies
)

# Task management node imports
from nodetools.chatbots.personas.odv import odv_system_prompt
from nodetools.prompts.initiation_rite import phase_4__system, phase_4__user
from nodetools.prompts.rewards_manager import (
    verification_system_prompt,
    verification_user_prompt,
    reward_system_prompt,
    reward_user_prompt
)
from nodetools.task_processing.task_creation import NewTaskGeneration

##############################################################################
############################## MEMO PATTERNS #################################
##############################################################################

TASK_ID_PATTERN = re.compile(r'(\d{4}-\d{2}-\d{2}_\d{2}:\d{2}(?:__[A-Z0-9]{4})?)')

# System memo patterns
INITIATION_RITE_PATTERN = MemoPattern(memo_type=SystemMemoType.INITIATION_RITE.value)
INITIATION_REWARD_PATTERN = MemoPattern(memo_type=SystemMemoType.INITIATION_REWARD.value)
HANDSHAKE_PATTERN = MemoPattern(memo_type=SystemMemoType.HANDSHAKE.value)
GOOGLE_DOC_LINK_PATTERN = MemoPattern(memo_type=SystemMemoType.GOOGLE_DOC_CONTEXT_LINK.value)

# Define task memo patterns
REQUEST_POST_FIAT_PATTERN = MemoPattern(
    memo_type=TASK_ID_PATTERN,
    memo_data=re.compile(f'.*{re.escape(TaskType.REQUEST_POST_FIAT.value)}.*')
)
PROPOSAL_PATTERN = MemoPattern(
    memo_type=TASK_ID_PATTERN,
    # rstrip() removes trailing space from enum value, \s? makes space optional
    # This handles historical data where trailing spaces were inconsistent
    memo_data=re.compile(f'.*{re.escape(TaskType.PROPOSAL.value.rstrip())}\\s?.*')
)
ACCEPTANCE_PATTERN = MemoPattern(
    memo_type=TASK_ID_PATTERN,
    memo_data=re.compile(f'.*{re.escape(TaskType.ACCEPTANCE.value)}.*')
)
REFUSAL_PATTERN = MemoPattern(
    memo_type=TASK_ID_PATTERN,
    memo_data=re.compile(f'.*{re.escape(TaskType.REFUSAL.value)}.*')
)
TASK_OUTPUT_PATTERN = MemoPattern(
    memo_type=TASK_ID_PATTERN,
    memo_data=re.compile(f'.*{re.escape(TaskType.TASK_OUTPUT.value)}.*')
)
VERIFICATION_PROMPT_PATTERN = MemoPattern(
    memo_type=TASK_ID_PATTERN,
    memo_data=re.compile(f'.*{re.escape(TaskType.VERIFICATION_PROMPT.value)}.*')
)
VERIFICATION_RESPONSE_PATTERN = MemoPattern(
    memo_type=TASK_ID_PATTERN,
    memo_data=re.compile(f'.*{re.escape(TaskType.VERIFICATION_RESPONSE.value)}.*')
)
REWARD_PATTERN = MemoPattern(
    memo_type=TASK_ID_PATTERN,
    memo_data=re.compile(f'.*{re.escape(TaskType.REWARD.value)}.*')
)

# Message patterns
TASK_RESPONSE_ID_PATTERN = re.compile(r'(\d{4}-\d{2}-\d{2}_\d{2}:\d{2}(?:__[A-Z0-9]{4})?_response)')

ODV_REQUEST_PATTERN = MemoPattern(
    memo_type=TASK_ID_PATTERN,
    memo_data=re.compile(f'.*{re.escape(MessageType.ODV_REQUEST.value)}.*')
)
ODV_RESPONSE_PATTERN = MemoPattern(
    memo_type=TASK_RESPONSE_ID_PATTERN  # this is the only way to pattern match ODV responses at this time
)

##########################################################################
####################### BUSINESS LOGIC PROVIDER ##########################
##########################################################################

def create_business_logic() -> BusinessLogicProvider:
    """Factory function to create all business logic components"""
    # Setup transaction graph
    graph = InteractionGraph()

    # Create rules so we can map them to patterns
    rules = {
        "initiation_rite": InitiationRiteRule(),
        "initiation_reward": InitiationRewardRule(),
        "google_doc_link": GoogleDocLinkRule(),
        "handshake_request": HandshakeRequestRule(),
        "handshake_response": HandshakeResponseRule(),
        "request_post_fiat": RequestPostFiatRule(),
        "proposal": ProposalRule(),
        "acceptance": AcceptanceRule(),
        "refusal": RefusalRule(),
        "task_output": TaskOutputRule(),
        "verification_prompt": VerificationPromptRule(),
        "verification_response": VerificationResponseRule(),
        "reward": RewardRule(),
        "odv_request": ODVRequestRule(),
        "odv_response": ODVResponseRule()
    }

    # Add initiation rite patterns to graph
    graph.add_pattern(
        pattern_id="initiation_rite",
        memo_pattern=INITIATION_RITE_PATTERN,
        transaction_type=InteractionType.REQUEST,
        valid_responses={INITIATION_REWARD_PATTERN}
    )
    graph.add_pattern(
        pattern_id="initiation_reward",
        memo_pattern=INITIATION_REWARD_PATTERN,
        transaction_type=InteractionType.RESPONSE,
    )

    # Add google doc link patterns to graph
    graph.add_pattern(
        pattern_id="google_doc_link",
        memo_pattern=GOOGLE_DOC_LINK_PATTERN,
        transaction_type=InteractionType.STANDALONE,
    )

    # Add handshake patterns to graph
    graph.add_pattern(
        pattern_id="handshake_request",
        memo_pattern=HANDSHAKE_PATTERN,
        transaction_type=InteractionType.REQUEST,
        valid_responses={HANDSHAKE_PATTERN}
    )
    graph.add_pattern(
        pattern_id="handshake_response",
        memo_pattern=HANDSHAKE_PATTERN,
        transaction_type=InteractionType.RESPONSE,
    )

    # Add patterns to graph
    graph.add_pattern(
        pattern_id="request_post_fiat",
        memo_pattern=REQUEST_POST_FIAT_PATTERN,
        transaction_type=InteractionType.REQUEST,
        valid_responses={PROPOSAL_PATTERN}
    )
    graph.add_pattern(
        pattern_id="proposal",
        memo_pattern=PROPOSAL_PATTERN,
        transaction_type=InteractionType.RESPONSE,
    )
    graph.add_pattern(
        pattern_id="acceptance",
        memo_pattern=ACCEPTANCE_PATTERN,
        transaction_type=InteractionType.STANDALONE,
    )
    graph.add_pattern(
        pattern_id="refusal",
        memo_pattern=REFUSAL_PATTERN,
        transaction_type=InteractionType.STANDALONE,
    )
    graph.add_pattern(
        pattern_id="task_output",
        memo_pattern=TASK_OUTPUT_PATTERN,
        transaction_type=InteractionType.REQUEST,
        valid_responses={VERIFICATION_PROMPT_PATTERN}
    )
    graph.add_pattern(
        pattern_id="verification_prompt",
        memo_pattern=VERIFICATION_PROMPT_PATTERN,
        transaction_type=InteractionType.RESPONSE
    )
    graph.add_pattern(
        pattern_id="verification_response",
        memo_pattern=VERIFICATION_RESPONSE_PATTERN,
        transaction_type=InteractionType.REQUEST,
        valid_responses={REWARD_PATTERN}
    )
    graph.add_pattern(
        pattern_id="reward",
        memo_pattern=REWARD_PATTERN,
        transaction_type=InteractionType.RESPONSE
    )

    # Add ODV patterns to graph
    graph.add_pattern(
        pattern_id="odv_request",
        memo_pattern=ODV_REQUEST_PATTERN,
        transaction_type=InteractionType.REQUEST,
        valid_responses={ODV_RESPONSE_PATTERN}
    )
    graph.add_pattern(
        pattern_id="odv_response",
        memo_pattern=ODV_RESPONSE_PATTERN,
        transaction_type=InteractionType.RESPONSE,
    )

    return BusinessLogicProvider(
        transaction_graph=graph,
        pattern_rule_map=rules
    )

##########################################################################
########################## HELPER FUNCTIONS ##############################
##########################################################################

def is_valid_task_id(memo_type: str) -> bool:
    """Check if a memo type is a valid task ID"""
    return bool(TASK_ID_PATTERN.match(memo_type)) if memo_type else False

def regex_to_sql_pattern(pattern: re.Pattern) -> str:
    """Convert a regex pattern to SQL LIKE pattern"""
    pattern_str = pattern.pattern
    
    # First remove the optional whitespace pattern completely
    pattern_str = re.sub(r'\\s\?', '', pattern_str)
    
    # Then extract the core content between .* markers
    if match := re.match(r'\.\*(.*?)\.\*', pattern_str):
        clean_text = match.group(1).replace('\\', '')
        return f'%{clean_text}%'
    
    return f'%{pattern_str}%'

##########################################################################
###################### INITIATION RITES AND REWARDS ######################
##########################################################################

class InitiationRiteRule(RequestRule):
    """Pure business logic for handling initiation rites"""

    @staticmethod
    def is_valid_initiation_rite(rite_text: str) -> bool:
        """Validate if the initiation rite meets basic requirements"""
        if not rite_text or not isinstance(rite_text, str):
            return False
        
        # Remove whitespace
        cleaned_rite = str(rite_text).strip()

        # Check minimum length
        if len(cleaned_rite) < 10:
            return False
        
        return True
    
    async def validate(
            self, 
            tx: Dict[str, Any],
            dependencies: Dependencies
        ) -> bool:
        """
        Validate business rules for an initiation rite.
        Pattern matching is handled by TransactionGraph.
        Must:
        1. Have valid rite text
        2. Be sent to the node address
        """
        if tx.get('destination') != dependencies.node_config.node_address:
            return False

        return self.is_valid_initiation_rite(tx.get('memo_data', ''))
    
    def _should_require_after_request(self) -> bool:
        """Determine if responses must come after requests based on runtime config"""
        return RuntimeConfig.USE_TESTNET and RuntimeConfig.ENABLE_REINITIATIONS
    
    async def find_response(
            self,
            request_tx: Dict[str, Any],
        ) -> Optional[ResponseQuery]:
        """
        Get query information for finding an initiation rite response.
        The response must be:
        1. Sent to the same account
        2. Sent from the account that received the initiation rite
        3. Have INITIATION_REWARD memo type
        4. Successful transaction (handled by find_transaction_response)
        """
        query = """
            SELECT * FROM find_transaction_response(
                request_account := %(account)s,
                request_destination := %(destination)s,
                request_time := %(request_time)s,
                response_memo_type := %(response_memo_type)s,
                require_after_request := %(require_after_request)s
            );
        """

        params = {
            # Attempt to retrieve account and destination from top level of tx or tx_json_parsed
            'account': request_tx['account'],
            'destination': request_tx['destination'],
            'request_time': request_tx['close_time_iso'],
            'response_memo_type': SystemMemoType.INITIATION_REWARD.value,
            'require_after_request': self._should_require_after_request()
        }
            
        return ResponseQuery(query=query, params=params)
    
class InitiationRewardRule(ResponseRule):
    """Pure business logic for handling initiation rewards"""

    async def validate(self, *args, **kwargs) -> bool:
        return True
    
    def get_response_generator(self, dependencies: Dependencies) -> ResponseGenerator:
        """Get response generator for initiation rewards with all dependencies"""
        return InitiationRewardGenerator(
            openrouter=dependencies.openrouter,
            node_config=dependencies.node_config,
            generic_pft_utilities=dependencies.generic_pft_utilities
        )
    
class InitiationRewardGenerator(ResponseGenerator):
    """Evaluates initiation rites and generates reward response parameters.
    
    Handles the evaluation of user initiation rites using AI and determines 
    appropriate reward amounts and justifications for node responses.
    """
    def __init__(
            self,
            openrouter: OpenRouterTool,
            node_config: NodeConfig,
            generic_pft_utilities: GenericPFTUtilities
        ):
        self.openrouter = openrouter
        self.node_config = node_config
        self.generic_pft_utilities = generic_pft_utilities
    
    async def evaluate_request(self, request_tx: Dict[str, Any]) -> Dict[str, Any]:
        """Evaluate initiation rite and determine reward"""
        rite_text = request_tx.get('memo_data')
        logger.debug(f"InitiationRewardGenerator.evaluate_request: Evaluating initiation rite: {rite_text}")

        # Use single chat completion
        response = await self.openrouter.create_single_chat_completion(
            model=DEFAULT_OPENROUTER_MODEL,
            system_prompt=phase_4__system,
            user_prompt=phase_4__user.replace('___USER_INITIATION_RITE___', rite_text)
        )
        content = response['choices'][0]['message']['content']

        # Extract reward amount and justification
        try:
            reward = int(content.split('| Reward |')[-1:][0].replace('|','').strip())
        except Exception as e:
            raise Exception(f"Failed to extract reward: {e}")
        
        try:
            justification = content.split('| Justification |')[-1:][0].split('|')[0].strip()
        except Exception as e:
            raise Exception(f"Failed to extract justification: {e}")
        
        return {'reward': reward, 'justification': justification}
    
    async def construct_response(
            self,
            request_tx: Dict[str, Any],
            evaluation_result: Dict[str, Any]
        ) -> Dict[str, Any]:
        """Construct reward memo and parameters"""
        try:
            # Construct reward memo
            memo = self.generic_pft_utilities.construct_standardized_xrpl_memo(
                memo_data=evaluation_result['justification'],
                memo_type=SystemMemoType.INITIATION_REWARD.value,
                memo_format=self.node_config.node_name
            )

            return ResponseParameters(
                source=self.node_config.node_name,  # indicate which node to send reward from
                memo=memo,
                destination=request_tx['account'],
                pft_amount=evaluation_result['reward']
            )

        except Exception as e:
            raise Exception(f"Failed to construct response: {e}")
        
##########################################################################
########################## Google Doc Link ###############################
##########################################################################

class GoogleDocLinkRule(StandaloneRule):
    """
    Pure business logic for handling google doc links
    Currently, this rule is a placeholder and does not perform any validation.
    """
    async def validate(self, *args, **kwargs) -> bool:
        return True
    
##########################################################################
########################## HANDSHAKE RULES ###############################
##########################################################################

class HandshakeRequestRule(RequestRule):
    """Pure business logic for handling handshake requests"""

    async def validate(
            self, 
            tx: Dict[str, Any],
            dependencies: Dependencies
        ) -> bool:
        """
        Validate business rules for a handshake request.
        Pattern matching is handled by TransactionGraph.
        Must:
        1. Be sent an address in the node's auto-handshake addresses
        2. Be a valid ECDH public key
        """
        if tx.get('destination') not in dependencies.node_config.auto_handshake_addresses:
            return False
        
        try:
            # Determine which secret type to use based on receiving address
            secret_type = SecretType.NODE if tx['destination'] == dependencies.node_config.node_address else SecretType.REMEMBRANCER
            
            # Try to derive shared secret - this will fail if the public key is invalid
            received_key = tx.get('memo_data', '')
            dependencies.credential_manager.get_shared_secret(
                received_key=received_key,
                secret_type=secret_type
            )
            return True

        except Exception as e:
            return False

    async def find_response(
            self,
            request_tx: Dict[str, Any],
        ) -> Optional[ResponseQuery]:
        """
        Get query information for finding a handshake response.
        The response must be:
        1. Sent to the same account
        2. Sent from the account that received the handshake request
        3. Have HANDSHAKE memo type
        4. Successful transaction (handled by find_transaction_response)
        """
        query = """
            SELECT * FROM find_transaction_response(
                request_account := %(account)s,
                request_destination := %(destination)s,
                request_time := %(request_time)s,
                response_memo_type := %(response_memo_type)s,
                require_after_request := FALSE  -- Check for ANY existing response
            );
        """

        params = {
            # Attempt to retrieve account and destination from top level of tx or tx_json_parsed
            'account': request_tx['account'],
            'destination': request_tx['destination'],
            'request_time': request_tx['close_time_iso'],
            'response_memo_type': SystemMemoType.HANDSHAKE.value
        }
            
        return ResponseQuery(query=query, params=params)

class HandshakeResponseRule(ResponseRule):
    """Pure business logic for handling handshake responses"""

    async def validate(self, *args, **kwargs) -> bool:
        return True
    
    def get_response_generator(self, dependencies: Dependencies) -> ResponseGenerator:
        """Get response generator for handshake response with all dependencies"""
        return HandshakeResponseGenerator(
            node_config=dependencies.node_config,
            generic_pft_utilities=dependencies.generic_pft_utilities,
            cred_manager=dependencies.credential_manager
        )
    
class HandshakeResponseGenerator(ResponseGenerator):
    """Evaluates handshake requests and generates response parameters."""
    def __init__(
            self,
            node_config: NodeConfig,
            generic_pft_utilities: GenericPFTUtilities,
            cred_manager: CredentialManager
        ):
        self.node_config = node_config
        self.generic_pft_utilities = generic_pft_utilities
        self.cred_manager = cred_manager

    def _determine_secret_type(self, address: str) -> SecretType:
        """Determines SecretType based on address"""
        if address == self.node_config.node_address:
            return SecretType.NODE
        elif address == self.node_config.remembrancer_address:
            return SecretType.REMEMBRANCER
        else:
            raise ValueError(f"No SecretType found for address: {address}")
        
    def _get_source_name(self, secret_type: SecretType) -> str:
        """Returns the appropriate source name based on SecretType"""
        match secret_type:
            case SecretType.NODE:
                return self.node_config.node_name
            case SecretType.REMEMBRANCER:
                return self.node_config.remembrancer_name

    async def evaluate_request(self, request_tx: Dict[str, Any]) -> Dict[str, Any]:
        """Evaluate handshake request and determine response parameters"""
        destination_address = request_tx['account']
        request_destination = request_tx['destination']  # The node address that received the request

        # Determine SecretType for ECDH key retrieval
        secret_type = self._determine_secret_type(request_destination)
        
        # Get ECDH public key for the responding node address
        ecdh_key = self.cred_manager.get_ecdh_public_key(secret_type)
        
        return {
            'destination': destination_address,
            'ecdh_key': ecdh_key,
            'source': request_destination,
            'secret_type': secret_type
        }
    
    async def construct_response(
            self,
            request_tx: Dict[str, Any],
            evaluation_result: Dict[str, Any]
        ) -> Dict[str, Any]:
        """Construct handshake response parameters"""
        try:
            # Get the appropriate source name
            source_name = self._get_source_name(evaluation_result['secret_type'])

            # Construct handshake memo
            memo = self.generic_pft_utilities.construct_handshake_memo(
                user=evaluation_result['destination'],
                ecdh_public_key=evaluation_result['ecdh_key']
            )

            return ResponseParameters(
                source=source_name,
                memo=memo,
                destination=evaluation_result['destination'],
                pft_amount=None  # No PFT amount for handshake responses
            )

        except Exception as e:
            raise Exception(f"Failed to construct handshake response: {e}")
    
############################################################################
########################## TASK REQUESTS ###################################
############################################################################

class RequestPostFiatRule(RequestRule):
    """Pure business logic for handling post-fiat requests"""

    async def validate(
            self, 
            tx: Dict[str, Any],
            dependencies: Dependencies
        ) -> bool:
        """
        Validate business rules for a post-fiat request.
        Pattern matching is handled by TransactionGraph.
        Must:
        1. Be addressed to the node address
        """
        return tx.get('destination') == dependencies.node_config.node_address
    
    async def find_response(
            self,
            request_tx: Dict[str, Any],
        ) -> Optional[ResponseQuery]:
        """Get query information for finding a proposal response."""
        query = """
            SELECT * FROM find_transaction_response(
                request_account := %(account)s,
                request_destination := %(destination)s,
                request_time := %(request_time)s,
                response_memo_type := %(response_memo_type)s,
                response_memo_data := %(response_memo_data)s,
                require_after_request := TRUE
            );
        """
        
        params = {
            'account': request_tx['account'],
            'destination': request_tx['destination'],
            'request_time': request_tx['close_time_iso'],
            'response_memo_type': request_tx['memo_type'],
            'response_memo_data': regex_to_sql_pattern(PROPOSAL_PATTERN.memo_data)
        }
            
        return ResponseQuery(query=query, params=params)
    
class ProposalRule(ResponseRule):
    """Pure business logic for handling proposals"""

    async def validate(self, *args, **kwargs) -> bool:
        return True
    
    def get_response_generator(self, dependencies: Dependencies) -> ResponseGenerator:
        """Get response generator for proposals with all dependencies"""
        task_generator = NewTaskGeneration(
            generic_pft_utilities=dependencies.generic_pft_utilities,
            openrouter_tool=dependencies.openrouter
        )
        return ProposalResponseGenerator(
            node_config=dependencies.node_config,
            generic_pft_utilities=dependencies.generic_pft_utilities,
            task_generator=task_generator
        )
    
class ProposalResponseGenerator(ResponseGenerator):
    """Generates proposal responses using NewTaskGeneration system"""
    
    def __init__(
            self,
            node_config: NodeConfig,
            generic_pft_utilities: GenericPFTUtilities,
            task_generator: NewTaskGeneration
        ):
        self.node_config = node_config
        self.generic_pft_utilities = generic_pft_utilities
        self.task_generator = task_generator

    async def evaluate_request(self, request_tx: Dict[str, Any]) -> Dict[str, Any]:
        """Evaluate the proposal request and get response parameters"""
        account_id = request_tx['account']
        task_id = request_tx['memo_type']
        user_request = request_tx['memo_data'].replace(TaskType.REQUEST_POST_FIAT.value, '').strip()
        
        # Create single-item task map
        task_key = self.task_generator.create_task_key(account_id, task_id)
        task_map = {task_key: user_request}

        # Process using task generation system
        result_df = self.task_generator.process_task_map_to_proposed_pf(
            task_map=task_map,
            model=DEFAULT_OPENROUTER_MODEL,
            get_google_doc=True,
            get_historical_memos=True
        )

        if result_df.empty:
            raise ValueError("No valid task generated")

        # Return first (and only) result
        return {
            'pf_proposal_string': result_df['pf_proposal_string'].iloc[0]
        }

    async def construct_response(
            self,
            request_tx: Dict[str, Any],
            evaluation_result: Dict[str, Any]
        ) -> ResponseParameters:
        """Construct the proposal response parameters"""
        try:
            memo = self.generic_pft_utilities.construct_standardized_xrpl_memo(
                memo_data=evaluation_result['pf_proposal_string'],
                memo_format=self.node_config.node_name,
                memo_type=request_tx['memo_type']
            )

            return ResponseParameters(
                source=self.node_config.node_name,
                memo=memo,
                destination=request_tx['account'],
                pft_amount=Decimal(1)
            )

        except Exception as e:
            raise Exception(f"Failed to construct proposal response: {e}")  
    
class AcceptanceRule(StandaloneRule):
    """
    Pure business logic for handling acceptances
    Currently, this rule is a placeholder and does not perform any validation.
    """
    async def validate(self, *args, **kwargs) -> bool:
        return True
    
class RefusalRule(StandaloneRule):
    """
    Pure business logic for handling refusals
    Currently, this rule is a placeholder and does not perform any validation.
    """
    async def validate(self, *args, **kwargs) -> bool:
        return True
    
##############################################################################
########################## INITIAL VERIFICATION ##############################
##############################################################################

class TaskOutputRule(RequestRule):
    """Pure business logic for handling task outputs"""

    async def validate(
            self, 
            tx: Dict[str, Any],
            dependencies: Dependencies
        ) -> bool:
        """
        Validate business rules for a task output.
        Pattern matching is handled by TransactionGraph.
        Must:
        1. Be addressed to the node address
        """
        return tx.get('destination') == dependencies.node_config.node_address
    
    async def find_response(
            self,
            request_tx: Dict[str, Any],
        ) -> Optional[ResponseQuery]:
        """Get query information for finding a verification prompt response."""
        query = """
            SELECT * FROM find_transaction_response(
                request_account := %(account)s,
                request_destination := %(destination)s,
                request_time := %(request_time)s,
                response_memo_type := %(response_memo_type)s,
                response_memo_data := %(response_memo_data)s,
                require_after_request := TRUE
            );
        """
        
        params = {
            'account': request_tx['account'],
            'destination': request_tx['destination'],
            'request_time': request_tx['close_time_iso'],
            'response_memo_type': request_tx['memo_type'],
            'response_memo_data': regex_to_sql_pattern(VERIFICATION_PROMPT_PATTERN.memo_data)
        }
            
        return ResponseQuery(query=query, params=params)
    
class VerificationPromptRule(ResponseRule):
    """Pure business logic for handling verification prompts"""

    async def validate(self, *args, **kwargs) -> bool:
        return True
    
    def get_response_generator(self, dependencies: Dependencies) -> ResponseGenerator:
        """Get response generator for verification prompts with all dependencies"""
        return VerificationPromptGenerator(
            node_config=dependencies.node_config,
            openrouter=dependencies.openrouter,
            generic_pft_utilities=dependencies.generic_pft_utilities,
            transaction_repository=dependencies.transaction_repository
        )
    
class VerificationPromptGenerator(ResponseGenerator):
    """Generates verification prompts for completed tasks"""
    
    def __init__(
            self,
            node_config: NodeConfig,
            generic_pft_utilities: GenericPFTUtilities,
            openrouter: OpenRouterTool,
            transaction_repository: TransactionRepository
        ):
        self.node_config = node_config
        self.generic_pft_utilities = generic_pft_utilities
        self.openrouter = openrouter
        self.transaction_repository = transaction_repository

    async def _get_original_task_description(self, memo_type: str) -> str:
        """Retrieve original proposal from transaction history"""
        query = """
            SELECT memo_data 
            FROM decoded_memos 
            WHERE memo_type = %(memo_type)s
            AND transaction_result = 'tesSUCCESS'
            AND memo_data LIKE %(proposal_pattern)s
            ORDER BY datetime DESC
            LIMIT 1;
        """
        
        params = {
            'memo_type': memo_type,
            'proposal_pattern': regex_to_sql_pattern(PROPOSAL_PATTERN.memo_data)
        }

        results = await self.transaction_repository.execute_query(query, params)
        
        if not results:
            logger.warning(f"Results: {results}")
            logger.warning(f"Used query: {query}\nwith params: {params}")
            raise ValueError(f"No original proposal found for memo_type: {memo_type}")
            
        return results[0]['memo_data']
    
    def _construct_api_arg_for_verification(self, original_task: str, completion_justification: str) -> Dict[str, Any]:
        """Construct API arguments for generating verification questions."""
        user_prompt = verification_user_prompt.replace(
            '___COMPLETION_STRING_REPLACEMENT_STRING___',
            completion_justification
        )
        user_prompt = user_prompt.replace(
            '___TASK_REQUEST_REPLACEMENT_STRING___',
            original_task
        )
        return {
            "model": DEFAULT_OPENROUTER_MODEL,
            "temperature": 0,
            "messages": [
                {"role": "system", "content": verification_system_prompt},
                {"role": "user", "content": user_prompt}
            ]
        }

    async def evaluate_request(self, request_tx: Dict[str, Any]) -> Dict[str, Any]:
        """Generate verification question based on task completion"""
        memo_type = request_tx['memo_type']
        completion_justification = request_tx['memo_data']
        
        # Get original task description
        original_task = await self._get_original_task_description(memo_type)
        
        # Prepare API request
        api_args = self._construct_api_arg_for_verification(
            original_task=original_task,
            completion_justification=completion_justification
        )
        
        # Generate verification question using single chat completion
        response = await self.openrouter.create_single_chat_completion(
            model=api_args['model'],
            system_prompt=api_args['messages'][0]['content'],
            user_prompt=api_args['messages'][1]['content']
        )
        content = response['choices'][0]['message']['content']
        
        # Extract question from response
        verification_question = content.split('Verifying Question |')[-1:][0].replace('|','').strip()
        
        return {
            'verification_question': verification_question
        }

    async def construct_response(
            self,
            request_tx: Dict[str, Any],
            evaluation_result: Dict[str, Any]
        ) -> ResponseParameters:
        """Construct verification prompt response"""
        try:
            # Format verification prompt
            verification_string = (
                TaskType.VERIFICATION_PROMPT.value + 
                evaluation_result['verification_question']
            )
            
            # Construct memo
            memo = self.generic_pft_utilities.construct_standardized_xrpl_memo(
                memo_data=verification_string,
                memo_format=self.node_config.node_name,
                memo_type=request_tx['memo_type']
            )

            return ResponseParameters(
                source=self.node_config.node_name,
                memo=memo,
                destination=request_tx['account'],
                pft_amount=1  # Fixed amount for verification prompts
            )

        except Exception as e:
            raise Exception(f"Failed to construct verification prompt: {e}")

############################################################################
########################## FINAL VERIFICATION ##############################
############################################################################

class VerificationResponseRule(RequestRule):
    """
    Pure business logic for handling verification responses.
    This is not to be confused with ResponseRules, which are system responses.
    These are user responses to verification prompts.
    """

    async def validate(
            self,
            tx: Dict[str, Any],
            dependencies: Dependencies
        ) -> bool:
        """
        Validate business rules for a verification response.
        Pattern matching is handled by TransactionGraph.
        Must:
        1. Be addressed to the node address
        """
        return tx.get('destination') == dependencies.node_config.node_address
    
    async def find_response(
            self,
            request_tx: Dict[str, Any],
        ) -> Optional[ResponseQuery]:
        """Get query information for finding a verification prompt response."""
        query = """
            SELECT * FROM find_transaction_response(
                request_account := %(account)s,
                request_destination := %(destination)s,
                request_time := %(request_time)s,
                response_memo_type := %(response_memo_type)s,
                response_memo_data := %(response_memo_data)s,
                require_after_request := TRUE
            );
        """
        
        params = {
            'account': request_tx['account'],
            'destination': request_tx['destination'],
            'request_time': request_tx['close_time_iso'],
            'response_memo_type': request_tx['memo_type'],
            'response_memo_data': regex_to_sql_pattern(REWARD_PATTERN.memo_data)
        }
            
        return ResponseQuery(query=query, params=params)
    
class RewardRule(ResponseRule):
    """Pure business logic for handling rewards"""

    async def validate(self, *args, **kwargs) -> bool:
        return True

    def get_response_generator(self, dependencies: Dependencies) -> ResponseGenerator:
        """Get response generator for rewards with all dependencies"""
        return RewardResponseGenerator(
            node_config=dependencies.node_config,
            generic_pft_utilities=dependencies.generic_pft_utilities,
            openrouter=dependencies.openrouter,
            transaction_repository=dependencies.transaction_repository
        )
    
class RewardResponseGenerator(ResponseGenerator):
    """Generates reward responses for completed verifications"""

    MIN_REWARD_AMOUNT = 1
    MAX_REWARD_AMOUNT = 1200
    REWARD_PROCESSING_WINDOW = 35 
    
    def __init__(
            self,
            node_config: NodeConfig,
            generic_pft_utilities: GenericPFTUtilities,
            openrouter: OpenRouterTool,
            transaction_repository: TransactionRepository
        ):
        self.node_config = node_config
        self.generic_pft_utilities = generic_pft_utilities
        self.openrouter = openrouter
        self.transaction_repository = transaction_repository

    async def _get_task_context(self, request_tx: Dict[str, Any]) -> Dict[str, str]:
        """
        Retrieve all necessary context for reward generation, including:
        - Original task proposal
        - Verification prompt
        - Reward history
        - Proposed reward from original task
        """
        memo_type = request_tx['memo_type']

        # Get original task proposal
        proposal_query = """
            SELECT memo_data 
            FROM decoded_memos 
            WHERE memo_type = %(memo_type)s
            AND transaction_result = 'tesSUCCESS'
            AND memo_data LIKE %(proposal_pattern)s
            ORDER BY datetime DESC
            LIMIT 1;
        """
        proposal_params = {
            'memo_type': memo_type,
            'proposal_pattern': regex_to_sql_pattern(PROPOSAL_PATTERN.memo_data)
        }
        proposal_results = await self.transaction_repository.execute_query(proposal_query, proposal_params)
        if not proposal_results:
            raise ValueError(f"No original proposal found for memo_type: {memo_type}")
        initial_task = proposal_results[0]['memo_data']

        # Get verification prompt
        prompt_query = """
            SELECT memo_data 
            FROM decoded_memos 
            WHERE memo_type = %(memo_type)s
            AND transaction_result = 'tesSUCCESS'
            AND memo_data LIKE %(prompt_pattern)s
            AND destination = %(destination)s
            ORDER BY datetime DESC
            LIMIT 1;
        """
        prompt_params = {
            'memo_type': memo_type,
            'prompt_pattern': regex_to_sql_pattern(VERIFICATION_PROMPT_PATTERN.memo_data),
            'destination': request_tx['account']
        }
        prompt_results = await self.transaction_repository.execute_query(prompt_query, prompt_params)
        if not prompt_results:
            raise ValueError(f"No verification prompt found for memo_type: {memo_type}")
        verification_prompt = prompt_results[0]['memo_data']

        # Get recent rewards history
        rewards_query = """
            SELECT memo_data, pft_absolute_amount
            FROM decoded_memos 
            WHERE account = %(account)s
            AND transaction_result = 'tesSUCCESS'
            AND memo_data LIKE %(reward_pattern)s
            AND datetime >= NOW() - INTERVAL '%(window)s days'
            ORDER BY datetime DESC;
        """
        rewards_params = {
            'account': request_tx['account'],
            'reward_pattern': regex_to_sql_pattern(REWARD_PATTERN.memo_data),
            'window': self.REWARD_PROCESSING_WINDOW
        }
        rewards_results = await self.transaction_repository.execute_query(rewards_query, rewards_params)
        
        # Format reward history
        reward_history = []
        for reward in rewards_results:
            reward_amount = abs(Decimal(reward['pft_absolute_amount']))
            reward_history.append(f"{reward['memo_data']} REWARD {reward_amount}")
        reward_history_str = "\n".join(reward_history)
        
        # Extract proposed reward from initial task
        proposed_reward = initial_task.split('..')[-1].strip()
        
        return {
            'initial_task': initial_task,
            'verification_prompt': verification_prompt,
            'verification_response': request_tx['memo_data'],  # Current request is the verification response
            'reward_history': reward_history_str,
            'proposed_reward': proposed_reward
        }

    def _extract_verification_text(self, content: str) -> str:
        """Extracts text between task verification markers."""
        pattern = r'TASK VERIFICATION SECTION START(.*?)TASK VERIFICATION SECTION END'
        
        try:
            # Use re.DOTALL to make . match newlines as well
            match = re.search(pattern, content, re.DOTALL)
            return match.group(1).strip() if match else ""
        except Exception as e:
            logger.error(f"PostFiatTaskManagement.extract_verification_text: Error extracting text: {e}")
            return ""

    async def _get_verification_details(self, account: str) -> str:
        """Get verification details from Google Doc"""
        try:
            link = self.generic_pft_utilities.get_latest_outgoing_context_doc_link(account)
            if not link:
                return "No Google Document Uploaded - please instruct user that Google Document has not been uploaded in response"
            
            raw_text = self.generic_pft_utilities.get_google_doc_text(share_link=link)
            return self._extract_verification_text(raw_text)
        except Exception as e:
            logger.error(f"Error getting Google Doc details for {account}: {e}")
            return "No Populated Verification Section"

    def _augment_user_prompt_with_key_attributes(self, sample_user_prompt: str, **replacements) -> str:
        """Augment user prompt with context values"""
        augmented_prompt = sample_user_prompt
        for key, value in replacements.items():
            placeholder = f"___{key.upper()}_REPLACEMENT___"
            augmented_prompt = augmented_prompt.replace(placeholder, str(value))
        return augmented_prompt

    def _extract_pft_reward(self, content: str) -> int:
        """Extract PFT reward amount from AI response"""
        try:
            reward = int(content.split('| Total PFT Rewarded |')[-1:][0].replace('|','').strip())
            return min(max(abs(reward), self.MIN_REWARD_AMOUNT), self.MAX_REWARD_AMOUNT)
        except Exception as e:
            logger.error(f"Error extracting PFT reward: {e}")
            return self.MIN_REWARD_AMOUNT

    def _extract_summary_judgement(self, content: str) -> str:
        """Extract summary judgment from AI response"""
        try:
            return content.split('| Summary Judgment |')[-1:][0].split('|')[0].strip()
        except Exception as e:
            logger.error(f"Error extracting summary judgment: {e}")
            return 'Summary Judgment'

    async def evaluate_request(self, request_tx: Dict[str, Any]) -> Dict[str, Any]:
        """Evaluate verification response and determine reward"""
        account = request_tx['account']

        # Get all necessary context
        context = await self._get_task_context(request_tx)

        logger.debug(f"context: {context}")

        verification_details = await self._get_verification_details(account)

        logger.debug(f"verification_details: {verification_details}")

        # Prepare prompts
        system_prompt = reward_system_prompt.replace(
            '___PROPOSED_REWARD_REPLACEMENT___',
            context['proposed_reward']
        )

        user_prompt = self._augment_user_prompt_with_key_attributes(
            reward_user_prompt,
            task_proposal=context['initial_task'],
            verification_question=context['verification_prompt'],
            task_verification=context['verification_response'],
            verification_details=verification_details,
            reward_data=context['reward_history'],
            proposed_reward=context['proposed_reward']
        )

        logger.debug(f"system_prompt: {system_prompt}")
        logger.debug(f"user_prompt: {user_prompt}")

        # Generate reward response
        response = await self.openrouter.create_single_chat_completion(
            model=DEFAULT_OPENROUTER_MODEL,
            system_prompt=system_prompt,
            user_prompt=user_prompt
        )

        content = response['choices'][0]['message']['content']
        
        return {
            'reward_amount': self._extract_pft_reward(content),
            'summary': self._extract_summary_judgement(content)
        }

    async def construct_response(
            self,
            request_tx: Dict[str, Any],
            evaluation_result: Dict[str, Any]
        ) -> ResponseParameters:
        """Construct reward response parameters"""
        try:
            reward_string = (
                TaskType.REWARD.value + 
                evaluation_result['summary']
            )

            memo = self.generic_pft_utilities.construct_standardized_xrpl_memo(
                memo_data=reward_string,
                memo_format=self.node_config.node_name,
                memo_type=request_tx['memo_type']
            )

            return ResponseParameters(
                source=self.node_config.node_name,
                memo=memo,
                destination=request_tx['account'],
                pft_amount=evaluation_result['reward_amount']
            )

        except Exception as e:
            raise Exception(f"Failed to construct reward response: {e}")


############################################################################
################################# ODV ######################################
############################################################################

class ODVRequestRule(RequestRule):
    """Rule for validating ODV requests to the remembrancer"""

    async def validate(
            self,
            tx: Dict[str, Any],
            dependencies: Dependencies
        ) -> bool:
        """
        Validates that:
        1. Request is sent to remembrancer address
        2. User has minimum required PFT balance (2000)
        """
        try:
            # Check destination is remembrancer
            if tx['destination'] != dependencies.node_config.remembrancer_address:
                return False
            
            # Check user's PFT balance
            balance = dependencies.generic_pft_utilities.get_pft_balance(tx['account'])
            if balance < 2000:
                return False
            
            return True
        except Exception as e:
            logger.error(f"Error validating ODV request: {e}")
            logger.error(traceback.format_exc())
            return False
        
    async def find_response(
        self,
        request_tx: Dict[str, Any],
    ) -> ResponseQuery:
        """Get query information for finding an ODV response."""
        query = """
            SELECT * FROM find_transaction_response(
                request_account := %(account)s,
                request_destination := %(destination)s,
                request_time := %(request_time)s,
                response_memo_type := %(response_memo_type)s,
                require_after_request := TRUE
            );
        """
        
        params = {
            'account': request_tx['account'],
            'destination': request_tx['destination'],
            'request_time': request_tx['close_time_iso'],
            'response_memo_type': f"{request_tx['memo_type']}_response"
        }
            
        return ResponseQuery(query=query, params=params)
    
class ODVResponseRule(ResponseRule):
    """Pure business logic for handling ODV responses"""

    async def validate(self, *args, **kwargs) -> bool:
        return True
    
    def get_response_generator(self, dependencies: Dependencies) -> ResponseGenerator:
        """Get response generator for ODV responses with all dependencies"""
        return ODVResponseGenerator(
            openrouter=dependencies.openrouter,
            node_config=dependencies.node_config,
            generic_pft_utilities=dependencies.generic_pft_utilities,
            message_encryption=dependencies.message_encryption,
            credential_manager=dependencies.credential_manager
        )

class ODVResponseGenerator(ResponseGenerator):
    """Evaluates ODV submissions and generates response parameters.
    
    Handles the evaluation of user ODV responses using AI and determines 
    appropriate feedback and response parameters.
    """
    def __init__(
            self,
            openrouter: OpenRouterTool,
            node_config: NodeConfig,
            generic_pft_utilities: GenericPFTUtilities,
            message_encryption: MessageEncryption,
            credential_manager: CredentialManager
        ):
        self.openrouter = openrouter
        self.node_config = node_config
        self.generic_pft_utilities = generic_pft_utilities
        self.user_task_parser = UserTaskParser(
            generic_pft_utilities=self.generic_pft_utilities
        )
        self.message_encryption = message_encryption
        self.credential_manager = credential_manager

    async def evaluate_request(self, request_tx: Dict[str, Any]) -> Dict[str, Any]:
        """Evaluate ODV submission"""
        account = request_tx['account']
        model = "openai/o1-preview-2024-09-12"
        odv_text = request_tx.get('memo_data')
        # logger.debug(f"ODVResponseGenerator.evaluate_request: Evaluating ODV submission: {odv_text}")

        user_context = self._get_user_context(account)
        system_prompt = odv_system_prompt
        user_prompt = self._construct_user_prompt(
            user_context=user_context,
            user_query=odv_text
        )

        # Use AI to evaluate the ODV response
        response = await self.openrouter.create_single_chat_completion(
            model=model,
            system_prompt=system_prompt,
            user_prompt=user_prompt
        )
        content = response['choices'][0]['message']['content']

        return {'odv_response': "ODV SYSTEM: " + content}
    
    def _get_user_context(self, account_address: str) -> str:
        """Get context string for an account.
    
        Args:
            account_address: Account address
            
        Returns:
            Context string for the account
        """
        return self.user_task_parser.get_full_user_context_string(
            account_address,
            memo_history=self.generic_pft_utilities.get_account_memo_history(account_address)
        )
    
    @staticmethod
    def _construct_user_prompt(user_context: str, user_query: str) -> str:
        """Construct the prompt for the AI model."""
        return f"""You are to ingest the User's context below
    
        <<< USER FULL CONTEXT STARTS HERE>>>
        {user_context}
        <<< USER FULL CONTEXT ENDS HERE>>>
        
        And consider what the user has asked below
        <<<USER QUERY STARTS HERE>>>
        {user_query}
        <<<USER QUERY ENDS HERE>>>
        
        Output a response that is designed for the user to ACHIEVE MASSIVE RESULTS IN LINE WITH ODVS MANDATE
        WHILE AT THE SAME TIME SPECIFICALLY MAXIMIZING THE USERS AGENCY AND STATED OBJECTIVES 
        Keep your response to below 4 paragraphs."""

    async def construct_response(
            self,
            request_tx: Dict[str, Any],
            evaluation_result: Dict[str, Any]
        ) -> ResponseParameters:
        """Construct ODV response parameters"""
        try:
            account = request_tx['account']
            destination = request_tx['destination']
            memo_data = request_tx['memo_data']
            was_encrypted = '[Decrypted]' in memo_data
            response_memo_data = evaluation_result['odv_response']

            if was_encrypted:
                channel_key, counterparty_key = self.message_encryption.get_handshake_for_address(
                    channel_address=destination,
                    channel_counterparty=account
                )
                if not (channel_key and counterparty_key):
                    raise HandshakeRequiredException(account, destination)
                
                shared_secret = self.credential_manager.get_shared_secret(
                    received_key=counterparty_key,
                    secret_type=SecretType.REMEMBRANCER
                )
                response_memo_data = MessageEncryption.process_encrypted_message(
                    message=response_memo_data,
                    shared_secret=shared_secret
                )

            # Construct response memo
            memo = self.generic_pft_utilities.construct_standardized_xrpl_memo(
                memo_data=response_memo_data,
                memo_type=f"{request_tx.get('memo_type')}_response",  # Uses request memo_type + _response
                memo_format="odv"
            )

            return ResponseParameters(
                source=self.node_config.remembrancer_name,
                memo=memo,
                destination=request_tx['account'],
                pft_amount=None  # Assuming no PFT transfer for ODV responses
            )

        except Exception as e:
            raise Exception(f"Failed to construct ODV response: {e}")