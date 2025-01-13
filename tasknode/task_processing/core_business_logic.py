"""
This module defines the business logic rules for processing TaskNode XRPL transactions.
There are two distinct layers of validation:

1. Pattern Matching (handled by TransactionGraph):
   - Validates the structure of memos (memo_type, memo_data, and memo_format)
   - Matches transactions to their correct workflow type
   - Determines valid response patterns for request transactions
   - Example: Checking if a memo matches the pattern for a proposal (PROPOSED PF ___)

2. Business Rule Validation (handled by Rule classes):
   - Enforces content-specific rules (e.g., minimum length for initiation rites)
   - Checking that a transaction is addressed to the node address or remembrancer address
   - Example: Checking if an initiation rite contains meaningful content

Example Flow:
1. Transaction received: memo_type="2024-03-20_14:30", memo_data="REQUEST_POST_FIAT ___ Can i get a task to do?"
2. TransactionGraph matches this to the "request_post_fiat" pattern
3. RequestPostFiatRule then used to validate that the transaction was addressed to the node
4. After validation, node will check against its database to see if the request already has a valid response, 
    according to the valid_responses set in the TransactionGraph
5. If no valid response is found, node will conclude that the request is unfulfilled and will call the response rule's generator
6. The response rule's generator will generate a response
7. The node will send the response back to the user and mark it for re-review
8. The node will queue the response for re-review and confirm that the response was sent
9. The node will then mark the request as fulfilled
10. The interaction is complete

When adding new rules, remember:
- A request requires a single valid response 
- Pattern matching logic belongs in create_business_logic()
- Only transaction-specific validation logic belongs in InteractionRule.validate()
- NodeTools ignores failed transactions by default, so explicitly checking for transaction success is not necessary
"""
# Standard library imports
from typing import Dict, Any, Optional
import re
from decimal import Decimal
import traceback
from enum import Enum

# Third-party imports
from loguru import logger
from xrpl.models import Memo

# NodeTools imports
from nodetools.utilities.exceptions import HandshakeRequiredException
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
    MemoConstructionParameters,
    Dependencies,
    ValidationResult,
    MemoTransaction
)
from nodetools.models.memo_processor import generate_custom_id
from nodetools.configuration.constants import UNIQUE_ID_PATTERN_V1

# Task node imports
from tasknode.task_processing.user_context_parsing import UserTaskParser
from tasknode.chatbots.personas.odv import odv_system_prompt
from tasknode.prompts.initiation_rite import phase_4__system, phase_4__user
from tasknode.prompts.rewards_manager import (
    verification_system_prompt,
    verification_user_prompt,
    reward_system_prompt,
    reward_user_prompt
)
from tasknode.task_processing.task_creation import NewTaskGeneration
from tasknode.task_processing.constants import TaskType

REQUIRE_AUTHORIZATION = False  # Disable for testing only
BASE_PFT_COST = 1

##############################################################################
############################### MEMO PATTERNS ###############################
##############################################################################

# System memo patterns
INITIATION_RITE_PATTERN = MemoPattern(
    memo_type=re.compile(f"^{UNIQUE_ID_PATTERN_V1.pattern}__{SystemMemoType.INITIATION_RITE.value}$")
)
INITIATION_REWARD_PATTERN = MemoPattern(
    memo_type=re.compile(f"^{UNIQUE_ID_PATTERN_V1.pattern}__{SystemMemoType.INITIATION_REWARD.value}$")
)
HANDSHAKE_PATTERN = MemoPattern(
    memo_type=re.compile(f"^{UNIQUE_ID_PATTERN_V1.pattern}__{SystemMemoType.HANDSHAKE.value}$")
)
HANDSHAKE_RESPONSE_PATTERN = MemoPattern(
    memo_type=re.compile(f"^{UNIQUE_ID_PATTERN_V1.pattern}__{SystemMemoType.HANDSHAKE_RESPONSE.value}$")
)

GOOGLE_DOC_LINK_PATTERN = MemoPattern(
    memo_type=re.compile(f"^{UNIQUE_ID_PATTERN_V1.pattern}__{SystemMemoType.GOOGLE_DOC_CONTEXT_LINK.value}$")
)

# Request patterns
REQUEST_POST_FIAT_PATTERN = MemoPattern(memo_type=re.compile(f'^{UNIQUE_ID_PATTERN_V1.pattern}__{TaskType.TASK_REQUEST.value}$'))

# Proposal patterns
PROPOSAL_PATTERN = MemoPattern(memo_type=re.compile(f'^{UNIQUE_ID_PATTERN_V1.pattern}__{TaskType.PROPOSAL.value}$'))

# Acceptance patterns
ACCEPTANCE_PATTERN = MemoPattern(memo_type=re.compile(f'^{UNIQUE_ID_PATTERN_V1.pattern}__{TaskType.ACCEPTANCE.value}$'))

# Refusal patterns
REFUSAL_PATTERN = MemoPattern(memo_type=re.compile(f'^{UNIQUE_ID_PATTERN_V1.pattern}__{TaskType.REFUSAL.value}$'))

# Task completion patterns
TASK_COMPLETION_PATTERN = MemoPattern(memo_type=re.compile(f'^{UNIQUE_ID_PATTERN_V1.pattern}__{TaskType.TASK_COMPLETION.value}$'))

# Verification patterns
VERIFICATION_PROMPT_PATTERN = MemoPattern(memo_type=re.compile(f'^{UNIQUE_ID_PATTERN_V1.pattern}__{TaskType.VERIFICATION_PROMPT.value}$'))

# Verification response patterns
VERIFICATION_RESPONSE_PATTERN = MemoPattern(memo_type=re.compile(f'^{UNIQUE_ID_PATTERN_V1.pattern}__{TaskType.VERIFICATION_RESPONSE.value}$'))

# Reward patterns
REWARD_PATTERN = MemoPattern(memo_type=re.compile(f'^{UNIQUE_ID_PATTERN_V1.pattern}__{TaskType.REWARD.value}$'))

# ODV message patterns
ODV_REQUEST = "ODV_REQUEST"
ODV_REQUEST_PATTERN = MemoPattern(memo_type=re.compile(f'^{UNIQUE_ID_PATTERN_V1.pattern}__{ODV_REQUEST}$'))

ODV_RESPONSE = "ODV_RESPONSE"
ODV_RESPONSE_PATTERN = MemoPattern(memo_type=re.compile(f'^{UNIQUE_ID_PATTERN_V1.pattern}__{ODV_RESPONSE}$'))

# Misc Patterns
CORBANU_REWARD_PATTERN = MemoPattern(
    memo_format="Corbanu",
    memo_type=UNIQUE_ID_PATTERN_V1,
    memo_data="Corbanu Reward"
)

##########################################################################
####################### BUSINESS LOGIC PROVIDER ##########################
##########################################################################

class TaskManagementRules(BusinessLogicProvider):
    """Business logic for task management"""

    @classmethod
    def create(cls) -> 'TaskManagementRules':
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
            "odv_response": ODVResponseRule(),
            "corbanu_reward": CorbanuRewardRule()
        }

        # Add initiation rite patterns to graph
        graph.add_pattern(
            pattern_id="initiation_rite",
            memo_pattern=INITIATION_RITE_PATTERN,
            transaction_type=InteractionType.REQUEST,
            valid_responses={INITIATION_REWARD_PATTERN},
            notify=True
        )
        graph.add_pattern(
            pattern_id="initiation_reward",
            memo_pattern=INITIATION_REWARD_PATTERN,
            transaction_type=InteractionType.RESPONSE,
            notify=True
        )

        # Add google doc link patterns to graph
        graph.add_pattern(
            pattern_id="google_doc_link",
            memo_pattern=GOOGLE_DOC_LINK_PATTERN,
            transaction_type=InteractionType.STANDALONE,
            notify=True
        )

        # Add handshake patterns to graph
        graph.add_pattern(
            pattern_id="handshake_request",
            memo_pattern=HANDSHAKE_PATTERN,
            transaction_type=InteractionType.REQUEST,
            valid_responses={HANDSHAKE_RESPONSE_PATTERN},
        )
        graph.add_pattern(
            pattern_id="handshake_response",
            memo_pattern=HANDSHAKE_RESPONSE_PATTERN,
            transaction_type=InteractionType.RESPONSE,
        )

        # Add request post fiat patterns to graph
        graph.add_pattern(
            pattern_id="request_post_fiat",
            memo_pattern=REQUEST_POST_FIAT_PATTERN,
            transaction_type=InteractionType.REQUEST,
            valid_responses={PROPOSAL_PATTERN},
            notify=True
        )

        # Add proposal patterns to graph
        graph.add_pattern(
            pattern_id="proposal",
            memo_pattern=PROPOSAL_PATTERN,
            transaction_type=InteractionType.RESPONSE,
            notify=True
        )

        # Add acceptance patterns to graph
        graph.add_pattern(
            pattern_id="acceptance",
            memo_pattern=ACCEPTANCE_PATTERN,
            transaction_type=InteractionType.STANDALONE,
            notify=True
        )

        # Add refusal patterns to graph
        graph.add_pattern(
            pattern_id="refusal",
            memo_pattern=REFUSAL_PATTERN,
            transaction_type=InteractionType.STANDALONE,
            notify=True
        )

        # Add task completion patterns to graph
        graph.add_pattern(
            pattern_id="task_output",
            memo_pattern=TASK_COMPLETION_PATTERN,
            transaction_type=InteractionType.REQUEST,
            valid_responses={VERIFICATION_PROMPT_PATTERN},
            notify=True
        )

        # Add verification patterns to graph
        graph.add_pattern(
            pattern_id="verification_prompt",
            memo_pattern=VERIFICATION_PROMPT_PATTERN,
            transaction_type=InteractionType.RESPONSE,
            notify=True
        )

        # Add verification response patterns to graph
        graph.add_pattern(
            pattern_id="verification_response",
            memo_pattern=VERIFICATION_RESPONSE_PATTERN,
            transaction_type=InteractionType.REQUEST,
            valid_responses={REWARD_PATTERN},
            notify=True
        )

        # Add reward patterns to graph
        graph.add_pattern(
            pattern_id="reward",
            memo_pattern=REWARD_PATTERN,
            transaction_type=InteractionType.RESPONSE,
            notify=True
        )

        # Add ODV request patterns to graph
        graph.add_pattern(
            pattern_id="odv_request",
            memo_pattern=ODV_REQUEST_PATTERN,
            transaction_type=InteractionType.REQUEST,
            valid_responses={ODV_RESPONSE_PATTERN}
        )

        # Add ODV response patterns to graphs
        graph.add_pattern(
            pattern_id="odv_response",
            memo_pattern=ODV_RESPONSE_PATTERN,
            transaction_type=InteractionType.RESPONSE,
        )

        # Add corbanu reward pattern to graph
        graph.add_pattern(
            pattern_id="corbanu_reward",
            memo_pattern=CORBANU_REWARD_PATTERN,
            transaction_type=InteractionType.STANDALONE,
            notify=True
        )

        return cls(
            transaction_graph=graph,
            pattern_rule_map=rules
        )

##########################################################################
########################## HELPER FUNCTIONS ##############################
##########################################################################

def regex_to_sql_pattern(pattern: re.Pattern) -> str:
    """
    Convert a regex pattern to SQL LIKE pattern
    WARNING: This is a very limited version of the regex pattern
    """
    pattern_str = pattern.pattern
    
    # First remove the optional whitespace pattern completely
    pattern_str = re.sub(r'\\s\?', '', pattern_str)
    
    # Then extract the core content between .* markers
    if match := re.match(r'\.\*(.*?)\.\*', pattern_str):
        clean_text = match.group(1).replace('\\', '')
        return f'%{clean_text}%'
    
    return f'%{pattern_str}%'

def derive_response_memo_type(request_memo_type: str, response_memo_type: str) -> str:
    """
    Derives a response memo_type from a request memo_type.
    Example: "v1.0.2025-01-13_06:53__QQ74__TASK_REQUEST" -> "v1.0.2025-01-13_06:53__QQ74__PROPOSAL"
    
    Args:
        request_memo_type: Original memo_type from request
        response_type: Type of response (e.g., "PROPOSAL", "VERIFICATION_PROMPT")
        
    Returns:
        Unique memo_type for the response
        
    Raises:
        ValueError: If task_id cannot be extracted from request_memo_type
    """
    task_id_match = UNIQUE_ID_PATTERN_V1.search(request_memo_type)
    if not task_id_match:
        raise ValueError(f"Could not extract task_id from memo_type: {request_memo_type}")
        
    task_id = task_id_match.group(1)
    return f"{task_id}__{response_memo_type}"

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
            tx: MemoTransaction,
            dependencies: Dependencies
        ) -> ValidationResult:
        """
        Validate business rules for an initiation rite.
        Pattern matching is handled by TransactionGraph.
        Must:
        1. Have valid rite text
        2. Be sent to the node address
        3. Be a verified address associated with an active Discord user
        """
        if tx.destination != dependencies.node_config.node_address:
            return ValidationResult(valid=False, notes="Destination is not the node address")
        
        if REQUIRE_AUTHORIZATION:
            is_authorized = await dependencies.transaction_repository.is_address_authorized(tx.account)
            if not is_authorized:
                # logger.debug(f"InitiationRiteRule.validate: Address {tx.account} is not authorized")
                return ValidationResult(valid=False, notes="Address is not authorized")

        if not self.is_valid_initiation_rite(tx.memo_data):
            return ValidationResult(valid=False, notes="Invalid initiation rite")
        
        return ValidationResult(valid=True)
    
    def _should_require_after_request(self) -> bool:
        """Determine if responses must come after requests based on runtime config"""
        return RuntimeConfig.USE_TESTNET and RuntimeConfig.ENABLE_REINITIATIONS
    
    async def find_response(
            self,
            request_tx: MemoTransaction,
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
            'account': request_tx.account,
            'destination': request_tx.destination,
            'request_time': request_tx.datetime,
            'response_memo_type': f'%{SystemMemoType.INITIATION_REWARD.value}',
            'require_after_request': self._should_require_after_request()
        }
            
        return ResponseQuery(query=query, params=params)
    
class InitiationRewardRule(ResponseRule):
    """Pure business logic for handling initiation rewards"""

    async def validate(self, *args, **kwargs) -> ValidationResult:
        return ValidationResult(valid=True)
    
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
        rite_text = request_tx.memo_data
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
            request_tx: MemoTransaction,
            evaluation_result: Dict[str, Any]
        ) -> Dict[str, Any]:
        """Construct reward memo and parameters"""
        try:

            return MemoConstructionParameters.construct_standardized_memo(
                source=self.node_config.node_name,  # indicate which node to send reward from
                memo_data=evaluation_result['justification'],
                memo_type=generate_custom_id() + "__" +SystemMemoType.INITIATION_REWARD.value,
                destination=request_tx.account,
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
    async def validate(self, *args, **kwargs) -> ValidationResult:
        return ValidationResult(valid=True)
    
##########################################################################
########################## HANDSHAKE RULES ###############################
##########################################################################

class HandshakeRequestRule(RequestRule):
    """Pure business logic for handling handshake requests"""

    async def validate(
            self, 
            tx: MemoTransaction,
            dependencies: Dependencies
        ) -> ValidationResult:
        """
        Validate business rules for a handshake request.
        Pattern matching is handled by TransactionGraph.
        Must:
        1. Be sent to an address in the node's auto-handshake addresses
        2. Be a valid ECDH public key
        3. Be a verified address associated with an active Discord user
        """
        if tx.destination not in dependencies.node_config.auto_handshake_addresses:
            return ValidationResult(valid=False, notes="Destination is not in auto-handshake addresses")
        
        if REQUIRE_AUTHORIZATION:
            is_authorized = await dependencies.transaction_repository.is_address_authorized(tx.account)
            if not is_authorized:
                # logger.debug(f"HandshakeRequestRule.validate: Address {tx.account} is not authorized")
                return ValidationResult(valid=False, notes="Address is not authorized")
        
        try:
            # Determine which secret type to use based on receiving address
            secret_type = SecretType.NODE if tx['destination'] == dependencies.node_config.node_address else SecretType.REMEMBRANCER
            
            # Try to derive shared secret - this will fail if the public key is invalid
            received_key = tx.memo_data
            dependencies.credential_manager.get_shared_secret(
                received_key=received_key,
                secret_type=secret_type
            )
            return ValidationResult(valid=True)

        except Exception as e:
            return ValidationResult(valid=False, notes="Invalid ECDH public key")

    async def find_response(
            self,
            request_tx: MemoTransaction,
        ) -> Optional[ResponseQuery]:
        """
        Get query information for finding a handshake response.
        The response must be:
        1. Sent to the same account
        2. Sent from the account that received the handshake request
        3. Have HANDSHAKE_RESPONSE in the memo_type
        4. Successful transaction (handled by find_transaction_response)
        """
        query = """
            SELECT * FROM find_transaction_response(
                request_account := %(account)s,
                request_destination := %(destination)s,
                request_time := %(request_time)s,
                response_memo_type := %(response_memo_type)s,
                require_after_request := TRUE  -- Check for ANY existing response
            );
        """

        params = {
            'account': request_tx.account,
            'destination': request_tx.destination,
            'request_time': request_tx.datetime,
            'response_memo_type': f'%{SystemMemoType.HANDSHAKE_RESPONSE.value}'
        }
            
        return ResponseQuery(query=query, params=params)

class HandshakeResponseRule(ResponseRule):
    """Pure business logic for handling handshake responses"""

    async def validate(self, *args, **kwargs) -> ValidationResult:
        return ValidationResult(valid=True)
    
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

    async def evaluate_request(self, request_tx: MemoTransaction) -> Dict[str, Any]:
        """Evaluate handshake request and determine response parameters"""
        destination_address = request_tx.account
        request_destination = request_tx.destination  # The node address that received the request

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
            request_tx: MemoTransaction,
            evaluation_result: Dict[str, Any]
        ) -> Dict[str, Any]:
        """Construct handshake response parameters"""
        try:
            # Get the appropriate source name
            source_name = self._get_source_name(evaluation_result['secret_type'])

            return MemoConstructionParameters.construct_standardized_memo(
                source=source_name,
                memo_data=evaluation_result['ecdh_key'],
                memo_type=generate_custom_id() + "__" + SystemMemoType.HANDSHAKE_RESPONSE.value,
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
            tx: MemoTransaction,
            dependencies: Dependencies
        ) -> ValidationResult:
        """
        Validate business rules for a post-fiat request.
        Pattern matching is handled by TransactionGraph.
        Must:
        1. Be addressed to the node address
        2. Be a verified address associated with an active Discord user
        3. Request includes 1 PFT
        """
        if tx.destination != dependencies.node_config.node_address:
            return ValidationResult(valid=False, notes="Destination is not the node address")
        
        if REQUIRE_AUTHORIZATION:
            is_authorized = await dependencies.transaction_repository.is_address_authorized(tx.account)
            if not is_authorized:
                # logger.debug(f"RequestPostFiatRule.validate: Address {tx.account} is not authorized")
                return ValidationResult(valid=False, notes="Address is not authorized")
        
        # Check if user is sending BASE_PFT_COST PFT
        if tx.pft_amount < BASE_PFT_COST:
            return ValidationResult(valid=False, notes="PFT amount is less than BASE_PFT_COST")

        return ValidationResult(valid=True)
    
    async def find_response(
            self,
            request_tx: MemoTransaction,
        ) -> Optional[ResponseQuery]:
        """Get query information for finding a response to a task request, which is a proposal."""
        query = """
            SELECT * FROM find_transaction_response(
                request_account := %(account)s,
                request_destination := %(destination)s,
                request_time := %(request_time)s,
                response_memo_type := %(response_memo_type)s,
                require_after_request := TRUE
            );
        """

        response_memo_type = derive_response_memo_type(
            request_memo_type=request_tx.memo_type,
            response_memo_type=TaskType.PROPOSAL.value
        )
        
        params = {
            'account': request_tx.account,
            'destination': request_tx.destination,
            'request_time': request_tx.datetime,
            'response_memo_type': response_memo_type
        }
            
        return ResponseQuery(query=query, params=params)
    
############################################################################
########################## TASK PROPOSALS ##################################
############################################################################
    
class ProposalRule(ResponseRule):
    """Pure business logic for handling proposals"""

    async def validate(self, *args, **kwargs) -> ValidationResult:
        return ValidationResult(valid=True)
    
    def get_response_generator(self, dependencies: Dependencies) -> ResponseGenerator:
        """Get response generator for proposals with all dependencies"""
        user_task_parser = UserTaskParser(
            node_config=dependencies.node_config,
            credential_manager=dependencies.credential_manager,
            generic_pft_utilities=dependencies.generic_pft_utilities
        )
        task_generator = NewTaskGeneration(
            generic_pft_utilities=dependencies.generic_pft_utilities,
            openrouter_tool=dependencies.openrouter,
            user_task_parser=user_task_parser
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

    async def evaluate_request(self, request_tx: MemoTransaction) -> Dict[str, Any]:
        """Evaluate the proposal request and get response parameters"""
        account_id = request_tx.account
        task_id = request_tx.memo_type
        user_request = request_tx.memo_data
        
        # Create single-item task map
        task_key = self.task_generator.create_task_key(account_id, task_id)
        task_map = {task_key: user_request}

        # Process using task generation system
        result_df = await self.task_generator.process_task_map_to_proposed_pf(
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
            request_tx: MemoTransaction,
            evaluation_result: Dict[str, Any],
        ) -> MemoConstructionParameters:
        """Construct the proposal response parameters"""
        try:
            # Must be a unique memo_type, different from the request memo_type
            response_memo_type = derive_response_memo_type(
                request_memo_type=request_tx.memo_type,
                response_memo_type=TaskType.PROPOSAL.value
            )

            return MemoConstructionParameters.construct_standardized_memo(
                source=self.node_config.node_name,
                destination=request_tx.account,
                memo_data=evaluation_result['pf_proposal_string'],
                memo_type=response_memo_type
            )
        except Exception as e:
            raise Exception(f"Failed to construct proposal response: {e}")
        
############################################################################
#################### TASK ACCEPTANCE AND REFUSAL ###########################
############################################################################

class AcceptanceRule(StandaloneRule):
    """
    Pure business logic for handling acceptances
    Currently, this rule is a placeholder and does not perform any validation.
    """
    async def validate(self, *args, **kwargs) -> ValidationResult:
        return ValidationResult(valid=True)
    
class RefusalRule(StandaloneRule):
    """
    Pure business logic for handling refusals
    Currently, this rule is a placeholder and does not perform any validation.
    """
    async def validate(self, *args, **kwargs) -> ValidationResult:
        return ValidationResult(valid=True)

##############################################################################
############################# TASK COMPLETION ################################
##############################################################################

class TaskOutputRule(RequestRule):
    """Pure business logic for handling task outputs"""

    async def validate(
            self, 
            tx: MemoTransaction,
            dependencies: Dependencies
        ) -> ValidationResult:
        """
        Validate business rules for a task output.
        Pattern matching is handled by TransactionGraph.
        Must:
        1. Be addressed to the node address
        2. Be a verified address associated with an active Discord user
        3. Request includes 1 PFT
        """
        if tx.destination != dependencies.node_config.node_address:
            return ValidationResult(valid=False, notes="Destination is not the node address")
        
        if REQUIRE_AUTHORIZATION:
            is_authorized = await dependencies.transaction_repository.is_address_authorized(tx.account)
            if not is_authorized:
                # logger.debug(f"TaskOutputRule.validate: Address {tx.account} is not authorized")
                return ValidationResult(valid=False, notes="Address is not authorized")
            
        # Check if user is sending BASE_PFT_COST PFT
        if tx.pft_amount < BASE_PFT_COST:
            return ValidationResult(valid=False, notes="PFT amount is less than BASE_PFT_COST")
        
        return ValidationResult(valid=True)
    
    async def find_response(
            self,
            request_tx: MemoTransaction,
        ) -> Optional[ResponseQuery]:
        """Get query information for finding a response to a task output, which is a verification prompt."""
        query = """
            SELECT * FROM find_transaction_response(
                request_account := %(account)s,
                request_destination := %(destination)s,
                request_time := %(request_time)s,
                response_memo_type := %(response_memo_type)s,
                require_after_request := TRUE
            );
        """

        response_memo_type = derive_response_memo_type(
            request_memo_type=request_tx.memo_type,
            response_memo_type=TaskType.VERIFICATION_PROMPT.value
        )

        params = {
            'account': request_tx.account,
            'destination': request_tx.destination,
            'request_time': request_tx.datetime,
            'response_memo_type': response_memo_type
        }
            
        return ResponseQuery(query=query, params=params)
    
############################################################################
########################## VERIFICATION PROMPTS ############################
############################################################################
    
class VerificationPromptRule(ResponseRule):
    """Pure business logic for handling verification prompts"""

    async def validate(self, *args, **kwargs) -> ValidationResult:
        return ValidationResult(valid=True)
    
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
            FROM transaction_memos 
            WHERE memo_type = %(memo_type)s
            AND transaction_result = 'tesSUCCESS'
            ORDER BY datetime DESC
            LIMIT 1;
        """

        params = {'memo_type': memo_type}

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
            request_tx: MemoTransaction,
            evaluation_result: Dict[str, Any]
        ) -> MemoConstructionParameters:
        """Construct verification prompt response"""
        try:
            # Must be a unique memo_type, different from the request memo_type
            response_memo_type = derive_response_memo_type(
                request_memo_type=request_tx.memo_type,
                response_memo_type=TaskType.VERIFICATION_PROMPT.value
            )

            return MemoConstructionParameters.construct_standardized_memo(
                source=self.node_config.node_name,
                destination=request_tx.account,
                memo_data=evaluation_result['verification_question'],
                memo_type=response_memo_type
            )

        except Exception as e:
            raise Exception(f"Failed to construct verification prompt: {e}")

##############################################################################
########################## VERIFICATION RESPONSES ############################
##############################################################################

class VerificationResponseRule(RequestRule):
    """
    Pure business logic for handling verification responses.
    This is not to be confused with ResponseRules, which are system responses.
    These are user responses to verification prompts.
    """

    async def validate(
            self,
            tx: MemoTransaction,
            dependencies: Dependencies
        ) -> ValidationResult:
        """
        Validate business rules for a verification response.
        Pattern matching is handled by TransactionGraph.
        Must:
        1. Be addressed to the node address
        2. Be a verified address associated with an active Discord user
        3. Request includes 1 PFT
        """
        if tx.destination != dependencies.node_config.node_address:
            return ValidationResult(valid=False, notes="Destination is not the node address")
        
        if REQUIRE_AUTHORIZATION:
            is_authorized = await dependencies.transaction_repository.is_address_authorized(tx.account)
            if not is_authorized:
                # logger.debug(f"VerificationResponseRule.validate: Address {tx.account} is not authorized")
                return ValidationResult(valid=False, notes="Address is not authorized")
            
        # Check if user is sending BASE_PFT_COST PFT
        if tx.pft_amount < BASE_PFT_COST:
            return ValidationResult(valid=False, notes="PFT amount is less than BASE_PFT_COST")
            
        return ValidationResult(valid=True)
    
    async def find_response(
            self,
            request_tx: MemoTransaction,
        ) -> Optional[ResponseQuery]:
        """Get query information for finding a response to a verification response, which is a reward."""
        query = """
            SELECT * FROM find_transaction_response(
                request_account := %(account)s,
                request_destination := %(destination)s,
                request_time := %(request_time)s,
                response_memo_type := %(response_memo_type)s,
                require_after_request := TRUE
            );
        """

        response_memo_type = derive_response_memo_type(
            request_memo_type=request_tx.memo_type,
            response_memo_type=TaskType.REWARD.value
        )
        
        params = {
            'account': request_tx.account,
            'destination': request_tx.destination,
            'request_time': request_tx.datetime,
            'response_memo_type': response_memo_type
        }
            
        return ResponseQuery(query=query, params=params)
    
##############################################################################
################################# REWARDS ####################################
##############################################################################

class RewardRule(ResponseRule):
    """Pure business logic for handling rewards"""

    async def validate(self, *args, **kwargs) -> ValidationResult:
        return ValidationResult(valid=True)

    def get_response_generator(self, dependencies: Dependencies) -> ResponseGenerator:
        """Get response generator for rewards with all dependencies"""
        return RewardResponseGenerator(
            node_config=dependencies.node_config,
            generic_pft_utilities=dependencies.generic_pft_utilities,
            openrouter=dependencies.openrouter,
            transaction_repository=dependencies.transaction_repository,
            credential_manager=dependencies.credential_manager
        )
    
class RewardResponseGenerator(ResponseGenerator):
    """Generates reward responses for completed verifications"""

    MIN_REWARD_AMOUNT = 1
    MAX_REWARD_AMOUNT = 1200
    REWARD_EVALUATION_WINDOW = 35 
    
    def __init__(
            self,
            node_config: NodeConfig,
            generic_pft_utilities: GenericPFTUtilities,
            openrouter: OpenRouterTool,
            transaction_repository: TransactionRepository,
            credential_manager: CredentialManager
        ):
        self.node_config = node_config
        self.generic_pft_utilities = generic_pft_utilities
        self.user_task_parser = UserTaskParser(
            generic_pft_utilities=self.generic_pft_utilities,
            node_config=self.node_config,
            credential_manager=credential_manager
        )
        self.openrouter = openrouter
        self.transaction_repository = transaction_repository

    async def _get_task_context(self, request_tx: MemoTransaction) -> Dict[str, str]:
        """
        Retrieve all necessary context for reward generation, including:
        - Original task proposal
        - Verification prompt
        - Reward history
        - Proposed reward from original task
        """
        memo_type = request_tx.memo_type

        # Get original task proposal
        proposal_query = """
            SELECT memo_data 
            FROM transaction_memos 
            WHERE memo_type = %(memo_type)s
            AND transaction_result = 'tesSUCCESS'
            ORDER BY datetime DESC
            LIMIT 1;
        """
        proposal_params = {'memo_type': regex_to_sql_pattern(PROPOSAL_PATTERN.memo_type)}
        proposal_results = await self.transaction_repository.execute_query(proposal_query, proposal_params)
        if not proposal_results:
            raise ValueError(f"No original proposal found for memo_type: {memo_type}")
        initial_task = proposal_results[0]['memo_data']

        # Get verification prompt
        prompt_query = """
            SELECT memo_data 
            FROM transaction_memos 
            WHERE memo_type = %(memo_type)s
            AND transaction_result = 'tesSUCCESS'
            AND destination = %(destination)s
            ORDER BY datetime DESC
            LIMIT 1;
        """
        prompt_params = {
            'memo_type': regex_to_sql_pattern(VERIFICATION_PROMPT_PATTERN.memo_type),
            'destination': request_tx.account
        }
        prompt_results = await self.transaction_repository.execute_query(prompt_query, prompt_params)
        if not prompt_results:
            raise ValueError(f"No verification prompt found for memo_type: {memo_type}")
        verification_prompt = prompt_results[0]['memo_data']

        # Get recent rewards history
        rewards_query = """
            SELECT memo_data, pft_amount
            FROM transaction_memos 
            WHERE account = $1
            AND memo_type = $2
            AND transaction_result = 'tesSUCCESS'
            AND datetime >= NOW() - INTERVAL '$3 days'
            ORDER BY datetime DESC;
        """
        rewards_params = [
            request_tx.account,
            regex_to_sql_pattern(REWARD_PATTERN.memo_type),
            self.REWARD_EVALUATION_WINDOW
        ]
        rewards_results = await self.transaction_repository.execute_query(rewards_query, rewards_params)
        
        # Format reward history
        reward_history = []
        for reward in rewards_results:
            reward_amount = abs(Decimal(reward['pft_amount']))
            reward_history.append(f"{reward['memo_data']} REWARD {reward_amount}")
        reward_history_str = "\n".join(reward_history)
        
        # Extract proposed reward from initial task
        proposed_reward = initial_task.split('..')[-1].strip()
        
        return {
            'initial_task': initial_task,
            'verification_prompt': verification_prompt,
            'verification_response': request_tx.memo_data,  # Current request is the verification response
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
            link = await self.user_task_parser.get_latest_outgoing_context_doc_link(account)
            if not link:
                return "No Google Document Uploaded - please instruct user that Google Document has not been uploaded in response"
            
            raw_text = await self.user_task_parser.get_google_doc_text(share_link=link)
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

    async def evaluate_request(self, request_tx: MemoTransaction) -> Dict[str, Any]:
        """Evaluate verification response and determine reward"""
        account = request_tx.account

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

        # logger.debug(f"system_prompt: {system_prompt}")
        # logger.debug(f"user_prompt: {user_prompt}")

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
            request_tx: MemoTransaction,
            evaluation_result: Dict[str, Any]
        ) -> MemoConstructionParameters:
        """Construct reward response parameters"""
        try:
            # Check for flags in the reward string and apply them against the account
            if 'RED FLAG' in evaluation_result['summary']:
                await self.transaction_repository.flag_address(
                    address=request_tx.account,
                    flag_type='RED'
                )
            elif 'YELLOW FLAG' in evaluation_result['summary']:
                await self.transaction_repository.flag_address(
                    address=request_tx.account,
                    flag_type='YELLOW'
                )

            # Must be a unique memo_type, different from the request memo_type
            response_memo_type = derive_response_memo_type(
                request_memo_type=request_tx.memo_type,
                response_memo_type=TaskType.REWARD.value
            )

            return MemoConstructionParameters.construct_standardized_memo(
                source=self.node_config.node_name,
                memo_data=evaluation_result['summary'],
                memo_type=response_memo_type,
                destination=request_tx.account,
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
            tx: MemoTransaction,
            dependencies: Dependencies
        ) -> ValidationResult:
        """
        Validates that:
        1. Request is sent to remembrancer address
        2. User has minimum required PFT balance (2000)
        3. User is an authorized address associated with an active Discord user
        4. Request includes 1 PFT
        """
        try:
            # Check destination is remembrancer
            if tx.destination != dependencies.node_config.remembrancer_address:
                return ValidationResult(valid=False, notes="Destination is not the remembrancer address")
            
            # Check user's PFT balance
            balance = dependencies.generic_pft_utilities.get_pft_balance(tx.account)
            if balance < 2000:
                return ValidationResult(valid=False, notes="PFT balance is less than 2000")
            
            # Check if user is an authorized address associated with an active Discord user
            if REQUIRE_AUTHORIZATION:
                is_authorized = await dependencies.transaction_repository.is_address_authorized(tx.account)
                if not is_authorized:
                    # logger.debug(f"ODVRequestRule.validate: Address {tx.account} is not authorized")
                    return ValidationResult(valid=False, notes="Address is not authorized")
            
            # Check if user is sending BASE_PFT_COST PFT
            if tx.pft_amount < BASE_PFT_COST:
                return ValidationResult(valid=False, notes="PFT amount is less than BASE_PFT_COST")

            return ValidationResult(valid=True)
        except Exception as e:
            logger.error(f"Error validating ODV request for {tx.hash}: {e}")
            logger.error(traceback.format_exc())
            return ValidationResult(valid=False, notes="Error validating ODV request")
        
    async def find_response(
        self,
        request_tx: MemoTransaction,
    ) -> ResponseQuery:
        """Get query information for finding an ODV response."""
        query = """
            SELECT * FROM find_transaction_response(
                request_account := %(account)s,
                request_destination := %(destination)s,
                request_time := %(request_time)s,
                response_memo_type := %(response_memo_type_odv)s,
                require_after_request := TRUE
            )
            ORDER BY datetime ASC
            LIMIT 1;
        """

        response_memo_type = derive_response_memo_type(
            request_memo_type=request_tx.memo_type,
            response_memo_type=ODV_RESPONSE
        )
        
        params = {
            'account': request_tx.account,
            'destination': request_tx.destination,
            'request_time': request_tx.datetime,
            'response_memo_type_odv': response_memo_type
        }
            
        return ResponseQuery(query=query, params=params)
    
class ODVResponseRule(ResponseRule):
    """Pure business logic for handling ODV responses"""

    async def validate(self, *args, **kwargs) -> ValidationResult:
        return ValidationResult(valid=True)
    
    def get_response_generator(self, dependencies: Dependencies) -> ResponseGenerator:
        """Get response generator for ODV responses with all dependencies"""
        user_task_parser = UserTaskParser(
            generic_pft_utilities=dependencies.generic_pft_utilities,
            node_config=dependencies.node_config,
            credential_manager=dependencies.credential_manager
        )
        return ODVResponseGenerator(
            openrouter=dependencies.openrouter,
            node_config=dependencies.node_config,
            generic_pft_utilities=dependencies.generic_pft_utilities,
            message_encryption=dependencies.message_encryption,
            credential_manager=dependencies.credential_manager,
            user_task_parser=user_task_parser
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
            credential_manager: CredentialManager,
            user_task_parser: UserTaskParser
        ):
        self.openrouter = openrouter
        self.node_config = node_config
        self.generic_pft_utilities = generic_pft_utilities
        self.user_task_parser = user_task_parser
        self.message_encryption = message_encryption
        self.credential_manager = credential_manager

    async def evaluate_request(self, request_tx: MemoTransaction) -> Dict[str, Any]:
        """Evaluate ODV submission"""
        account = request_tx.account
        model = "openai/o1-preview-2024-09-12"
        odv_text = request_tx.memo_data
        logger.debug(f"ODVResponseGenerator.evaluate_request: Evaluating ODV submission: {odv_text}")

        user_context = await self._get_user_context(account)
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

        logger.debug(f"ODVResponseGenerator.evaluate_request: ODV response: {content}")

        return {'odv_response': "ODV SYSTEM: " + content}
    
    async def _get_user_context(self, account_address: str) -> str:
        """Get context string for an account.
    
        Args:
            account_address: Account address
            
        Returns:
            Context string for the account
        """
        return await self.user_task_parser.get_full_user_context_string(account_address)
    
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
            request_tx: MemoTransaction,
            evaluation_result: Dict[str, Any]
        ) -> MemoConstructionParameters:
        """Construct ODV response parameters"""
        try:
            account = request_tx.account
            destination = request_tx.destination
            memo_data = request_tx.memo_data
            was_encrypted = '[Decrypted]' in memo_data
            response_memo_data = evaluation_result['odv_response']

            if was_encrypted:
                channel_key, counterparty_key = await self.message_encryption.get_handshake_for_address(
                    channel_address=destination,
                    channel_counterparty=account
                )
                if not (channel_key and counterparty_key):
                    raise HandshakeRequiredException(account, destination)
                
                shared_secret = self.credential_manager.get_shared_secret(
                    received_key=counterparty_key,
                    secret_type=SecretType.REMEMBRANCER
                )
                response_memo_data = MessageEncryption.encrypt_message(
                    message=response_memo_data,
                    shared_secret=shared_secret
                )

            # Must be a unique memo_type, different from the request memo_type
            response_memo_type = derive_response_memo_type(
                request_memo_type=request_tx.memo_type,
                response_memo_type=ODV_RESPONSE
            )

            return MemoConstructionParameters.construct_standardized_memo(
                source=self.node_config.remembrancer_name,
                destination=request_tx.account,
                memo_data=response_memo_data,
                memo_type=response_memo_type,
                should_encrypt=was_encrypted,
                should_compress=True
            )

        except Exception as e:
            raise Exception(f"Failed to construct ODV response: {e}")

############################################################################
########################### Corbanu Reward #################################
############################################################################

class CorbanuRewardRule(StandaloneRule):
    """
    Pure business logic for handling corbanu rewards
    Currently, this rule is a placeholder and does not perform any validation.
    """
    async def validate(self, *args, **kwargs) -> ValidationResult:
        return ValidationResult(valid=True)
