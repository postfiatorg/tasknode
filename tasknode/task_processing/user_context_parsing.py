import pandas as pd
from nodetools.protocols.generic_pft_utilities import GenericPFTUtilities
from tasknode.task_processing.constants import (
    TaskType,
    MessageType,
    MAX_CHUNK_MESSAGES_IN_CONTEXT,
    MAX_PENDING_PROPOSALS_IN_CONTEXT,
    MAX_ACCEPTANCES_IN_CONTEXT,
    MAX_VERIFICATIONS_IN_CONTEXT,
    MAX_REWARDS_IN_CONTEXT,
    MAX_REFUSALS_IN_CONTEXT,
)
from nodetools.configuration.constants import SystemMemoType, UNIQUE_ID_PATTERN_V1, UNIQUE_ID_VERSION
from nodetools.configuration.configuration import NodeConfig
from nodetools.protocols.credentials import CredentialManager
from nodetools.protocols.encryption import MessageEncryption
from nodetools.models.memo_processor import MemoProcessor
from nodetools.models.models import MemoGroup
from typing import Optional, Union, TYPE_CHECKING, List
from loguru import logger
import traceback
import re
import json
import requests
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal

@dataclass
class Task:
    """Represents a task and its complete lifecycle state.
    
    Each field corresponds to a specific TaskType and contains the message content
    for that state, if it exists. The task progresses through these states in order,
    though some states may be skipped (e.g., a task might be refused instead of accepted).
    """
    task_id: str
    task_request: str
    request_datetime: datetime

    proposal: Optional[str] = None
    proposal_datetime: Optional[datetime] = None
    acceptance: Optional[str] = None
    acceptance_datetime: Optional[datetime] = None
    refusal: Optional[str] = None
    refusal_datetime: Optional[datetime] = None
    task_completion: Optional[str] = None
    task_completion_datetime: Optional[datetime] = None
    verification_prompt: Optional[str] = None
    verification_prompt_datetime: Optional[datetime] = None
    verification_response: Optional[str] = None
    verification_response_datetime: Optional[datetime] = None
    reward: Optional[str] = None
    reward_datetime: Optional[datetime] = None
    pft_amount: Decimal = Decimal(0)

    @property
    def current_state(self) -> TaskType:
        """Determine the current state of the task based on which fields are populated"""
        if self.reward:
            return TaskType.REWARD
        if self.verification_response:
            return TaskType.VERIFICATION_RESPONSE
        if self.verification_prompt:
            return TaskType.VERIFICATION_PROMPT
        if self.task_completion:
            return TaskType.TASK_COMPLETION
        if self.refusal:
            return TaskType.REFUSAL
        if self.acceptance:
            return TaskType.ACCEPTANCE
        if self.proposal:
            return TaskType.PROPOSAL
        return TaskType.TASK_REQUEST
    
    @classmethod
    async def from_memo_groups(cls, memo_groups: List[MemoGroup]) -> 'Task':
        """Create a Task from a list of MemoGroups.
        
        Args:
            memo_groups: List of MemoGroups related to this task
            
        Returns:
            Task: Constructed task object
            
        Raises:
            ValueError: If no TASK_REQUEST is found in the memo groups
        """
        sorted_groups = sorted(memo_groups, key=lambda g: g.memos[0].datetime, reverse=True)

        request_group = next(
            (g for g in sorted_groups if g.group_id.endswith(TaskType.TASK_REQUEST.value)),
            None
        )
        if not request_group:
            raise ValueError("No TASK_REQUEST found in memo groups")
        
        task_id = cls.extract_task_id(request_group.group_id)
        request = await MemoProcessor.parse_group(request_group)
        if not request:
            raise ValueError(f"Could not parse request from group {request_group.group_id}")
        
        # Initialize task with required fields
        task = cls(
            task_id=task_id,
            task_request=request,
            request_datetime=request_group.memos[0].datetime
        )

        # Process all other groups
        for group in sorted_groups:
            if group == request_group:
                continue

            content = await MemoProcessor.parse_group(group)
            if not content:
                continue

            # Get state type from memo_type suffix
            state_type = TaskType(group.group_id.split('__')[-1])
            datetime = group.memos[0].datetime

            # Set the appropriate field based on state type
            match state_type:
                case TaskType.PROPOSAL:
                    task.proposal = content
                    task.proposal_datetime = datetime
                case TaskType.ACCEPTANCE:
                    task.acceptance = content
                    task.acceptance_datetime = datetime
                case TaskType.REFUSAL:
                    task.refusal = content
                    task.refusal_datetime = datetime
                case TaskType.TASK_COMPLETION:
                    task.task_completion = content
                    task.completion_datetime = datetime
                case TaskType.VERIFICATION_PROMPT:
                    task.verification_prompt = content
                    task.verification_prompt_datetime = datetime
                case TaskType.VERIFICATION_RESPONSE:
                    task.verification_response = content
                    task.verification_response_datetime = datetime
                case TaskType.REWARD:
                    task.reward = content
                    task.reward_response_datetime = datetime
                    task.pft_amount = group.pft_amount

        return task
    
    @staticmethod
    def extract_task_id(memo_type: str) -> str:
        """Extract the task ID from a memo type string"""
        match = UNIQUE_ID_PATTERN_V1.match(memo_type)
        if not match:
            raise ValueError(f"Invalid memo_type format: {memo_type}")
        return match.group()

class UserTaskParser:
    _instance = None
    _initialized = False

    def __new__(cls, *args, **kwargs):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    def __init__(
            self,
            generic_pft_utilities: GenericPFTUtilities,
            node_config: NodeConfig,
            credential_manager: CredentialManager
        ):
        """Initialize UserTaskParser with GenericPFTUtilities for core functionality"""
        if not self.__class__._initialized:
            self.generic_pft_utilities = generic_pft_utilities
            self.message_encryption: MessageEncryption = generic_pft_utilities.message_encryption
            self.node_config = node_config
            self.cred_manager = credential_manager
            self.__class__._initialized = True

    async def get_tasks(self, account_address: str) -> List[Task]:
        """Get all tasks and their current states for an account.
        
        Args:
            account_address: XRPL account address
            
        Returns:
            List[Task]: List of tasks with their complete state history
        """
        try:
            # First get all task requests
            request_history = await self.generic_pft_utilities.get_account_memo_history(
                account_address=account_address,
                memo_type_filter=f'v{UNIQUE_ID_VERSION}.%__{TaskType.TASK_REQUEST.value}'
            )

            if request_history.empty:
                return []
            
            tasks = []
            # Get all task requests as MemoGroups
            request_groups = await self.generic_pft_utilities.get_latest_valid_memo_groups(
                memo_history=request_history,
                num_groups=0  # Get all groups
            )
 
            if not request_groups:
                return []
            
            if not isinstance(request_groups, list):
                request_groups = [request_groups]
            
            tasks = []
            for request_group in request_groups:
                try:
                    task_id = Task.extract_task_id(request_group.group_id)

                    # Get all state changes for this task
                    task_history = await self.generic_pft_utilities.get_account_memo_history(
                        account_address=account_address,
                        memo_type_filter=f'{task_id}__%'  # Match any state change for this task
                    )

                    if task_history.empty:
                        continue

                    # Get all memo groups for this task
                    memo_groups = await self.generic_pft_utilities.get_latest_valid_memo_groups(
                        memo_history=task_history,
                        num_groups=0  # Get all groups
                    )
                    
                    if not memo_groups:
                        continue
                        
                    if not isinstance(memo_groups, list):
                        memo_groups = [memo_groups]
                    
                    # Create task from all its memo groups
                    task = await Task.from_memo_groups(memo_groups)
                    tasks.append(task)
                    
                except Exception as e:
                    logger.warning(f"Error processing task from request {request_group.group_id}: {e}")
                    continue

            return tasks

        except Exception as e:
            logger.error(f"Error getting task state pairs for {account_address}: {e}")
            logger.error(traceback.format_exc())
            return []

    async def get_proposals_by_state(
            self, 
            account_address: str, 
            state_type: TaskType,
            limit: Optional[int] = None
        ) -> pd.DataFrame:
        """Get proposals filtered by their state.
        
        Args:
            account_address: XRPL account address
            state_type: TaskType enum value to filter by
            limit: Optional int limiting number of tasks to return.
            
        Returns:
            DataFrame with columns based on state_type:
                - For PROPOSAL: ['proposal']
                - For REWARD: ['proposal', 'task_request', 'reward', 'pft_amount']
                - For others: ['proposal', state_type.value.lower()]
            Indexed by task_id
        """
        try:
            # Get all tasks for the account
            tasks = await self.get_tasks(account_address)
            if not tasks:
                return pd.DataFrame()

            # Filter tasks by state and sort by datetime descending
            filtered_tasks = sorted(
                [task for task in tasks if task.current_state == state_type],
                key=lambda t: getattr(t, f"{state_type.value.lower()}_datetime") or datetime.min,
                reverse=True
            )

            # Apply limit if specified
            if limit is not None and limit > 0:
                filtered_tasks = filtered_tasks[:limit]

            if not filtered_tasks:
                return pd.DataFrame()
            
            match state_type:
                case TaskType.PROPOSAL:
                    # For pending proposals, we only need the proposal text
                    df = pd.DataFrame([
                        {'proposal': task.proposal}
                        for task in filtered_tasks
                        if task.proposal  # Filter out None proposals
                    ], index=[task.task_id for task in filtered_tasks if task.proposal])

                case TaskType.REWARD:
                    # For rewards, include original request, reward message, and PFT amount
                    df = pd.DataFrame([
                        {
                            'proposal': task.proposal,
                            'task_request': task.task_request,
                            'reward': task.reward,
                            'pft_amount': task.pft_amount
                        }
                        for task in filtered_tasks
                        if task.proposal and task.reward  # Filter out None values
                    ], index=[task.task_id for task in filtered_tasks if task.proposal])

                case _:
                    # For other states, include both proposal and state message
                    state_field = state_type.value.lower()
                    df = pd.DataFrame([
                        {
                            'proposal': task.proposal,
                            state_field: getattr(task, state_field)  # Get the corresponding field from Task
                        }
                        for task in filtered_tasks
                        if task.proposal and getattr(task, state_field)  # Filter out None values
                    ], index=[task.task_id for task in filtered_tasks if task.proposal])

            return df

        except Exception as e:
            logger.error(f"Error getting proposals by state for {account_address}: {e}")
            logger.error(traceback.format_exc())
            return pd.DataFrame()

    async def get_pending_tasks(self, account: str):
        """Get tasks that have not yet been accepted or refused."""
        return await self.get_proposals_by_state(account, state_type=TaskType.PROPOSAL)

    async def get_accepted_tasks(self, account: str):
        """Get tasks that have been accepted"""
        return await self.get_proposals_by_state(account, state_type=TaskType.ACCEPTANCE)
    
    async def get_verification_tasks(self, account: str):
        """Get tasks that are pending verification"""
        return await self.get_proposals_by_state(account, state_type=TaskType.VERIFICATION_PROMPT)

    async def get_rewarded_tasks(self, account: str, limit: Optional[int] = None):
        """Get tasks that have been rewarded"""
        return await self.get_proposals_by_state(account, state_type=TaskType.REWARD, limit=limit)

    async def get_refused_tasks(self, account: str):
        """Get tasks that have been refused"""
        return await self.get_proposals_by_state(account, state_type=TaskType.REFUSAL)
    
    async def get_refuseable_tasks(self, account: str):
        """Get all tasks that are in a valid state to be refused.
        
        This includes:
        - Pending tasks
        - Accepted tasks
        - Verification tasks
        
        Does not include tasks that have already been refused or rewarded.
        
        Args:
            account: Either an XRPL account address string or a DataFrame containing memo history.
                
        Returns:
            DataFrame with columns:
                - proposal: The proposed task text
            Indexed by task_id.
        """
        try:
            # Get all refuseable proposals
            pending = await self.get_pending_tasks(account)
            accepted = await self.get_accepted_tasks(account)
            verification = await self.get_verification_tasks(account)
            
            if pending.empty and accepted.empty and verification.empty:
                return pd.DataFrame()
            
            # Keep only the proposal column from each DataFrame
            proposals = pd.concat([
                pending[['proposal']],
                accepted[['proposal']],
                verification[['proposal']]
            ])
            
            return proposals.drop_duplicates()

        except Exception as e:
            logger.error(f"Error getting refusable proposals for {account}: {e}")
            logger.error(traceback.format_exc())
            return pd.DataFrame()

    # TODO: Not currently used
    # TODO: Update to calculate enhanced stats that include average time to accept, average time to verify, etc.
    async def get_task_statistics(self, account_address):
        """
        Get statistics about user's tasks.
        
        Args:
            account_address: XRPL account address to get stats for
            
        Returns:
            dict containing:
                - total_tasks: Total number of tasks
                - accepted_tasks: Number of accepted tasks
                - pending_tasks: Number of pending tasks
                - acceptance_rate: Percentage of tasks accepted
        """
        account_memo_detail_df = await self.generic_pft_utilities.get_account_memo_history(account_address)

        pending_proposals = await self.get_pending_tasks(account_memo_detail_df)
        accepted_proposals = await self.get_accepted_tasks(account_memo_detail_df)
        refused_proposals = await self.get_refused_tasks(account_memo_detail_df)
        verification_proposals = await self.get_verification_tasks(account_memo_detail_df)
        rewarded_proposals = await self.get_rewarded_tasks(account_memo_detail_df)

        # Calculate total accepted tasks
        total_accepted = len(accepted_proposals) + len(verification_proposals) + len(rewarded_proposals)

        # Total tasks excluding pending
        total_ended_tasks = total_accepted + len(refused_proposals)

        # Total tasks
        total_tasks = total_ended_tasks + len(pending_proposals)
            
        # Calculate rates
        acceptance_rate = (total_accepted / total_tasks * 100) if total_tasks > 0 else 0
        completion_rate = (len(rewarded_proposals) / total_ended_tasks * 100) if total_ended_tasks > 0 else 0
        
        return {
            'total_tasks': total_tasks,
            'total_ended_tasks': total_ended_tasks,
            'total_completed_tasks': len(rewarded_proposals),
            'total_pending_tasks': len(pending_proposals),
            'acceptance_rate': acceptance_rate,
            'completion_rate': completion_rate
        }
    
    async def get_recent_memos(
        self,
        account_address: str,
        num_messages: Optional[int] = 1,
        pft_only: bool = False
    ) -> Optional[Union[MemoGroup, list[MemoGroup]]]:
        """Get recent memos for an account matching the "MEMO" memo_type pattern.
        
        Args:
            account_address: XRPL account address
            memo_type_filter: String to filter memo_types using LIKE (e.g. '%MEMO%')
            num_messages: Optional int limiting number of messages to return.
                         If 1 (default), returns a single MemoGroup.
                         If > 1, returns a list of up to num_messages MemoGroups.
                         If 0 or None, returns all matching memo groups.
            pft_only: If True, only return PFT transactions
            
        Returns:
            Optional[Union[MemoGroup, list[MemoGroup]]]: Recent memo group(s) or None if none found
        """
        try:
            memo_history = await self.generic_pft_utilities.get_account_memo_history(
                account_address=account_address,
                pft_only=pft_only,
                memo_type_filter='%' + MessageType.MEMO.value + '%'  # wildcards on both sides to include ODV messages
            )

            if memo_history.empty or len(memo_history) == 0:
                return None
            
            return await self.generic_pft_utilities.get_latest_valid_memo_groups(
                memo_history=memo_history,
                num_groups=num_messages
            )

        except Exception as e:
            logger.error(f"UserTaskParser.get_recent_memos: Error getting recent memos for {account_address}: {e}")
            logger.error(traceback.format_exc())
            return None
        
    async def format_memo_groups_to_json(
        self,
        memo_groups: Optional[Union[MemoGroup, list[MemoGroup]]]
    ) -> str:
        """Format MemoGroups into a datetime-indexed JSON string.
        
        Args:
            memo_groups: Single MemoGroup or list of MemoGroups
            
        Returns:
            str: JSON string with datetime-indexed messages, or empty string if no messages
        """
        if not memo_groups:
            return ''
        
        # Ensure we're working with a list
        if not isinstance(memo_groups, list):
            memo_groups = [memo_groups]
            
        messages = {}
        for group in memo_groups:
            try:
                # Process the group to get the message content
                content = await MemoProcessor.parse_group(
                    group=group,
                    credential_manager=self.cred_manager,
                    message_encryption=self.message_encryption,
                    node_config=self.node_config
                )
                
                if content:
                    # Use the first memo's datetime as the timestamp for the whole group
                    timestamp = group.memos[0].datetime.isoformat()
                    messages[timestamp] = content
                    
            except Exception as e:
                logger.warning(f"Error processing memo group {group.group_id}: {e}")
                continue
                
        return json.dumps(messages, sort_keys=True)  # sort_keys=True ensures chronological order
            
    async def get_full_user_context_string(
        self,
        account_address: str,
        get_google_doc: bool = True,
        get_historical_memos: bool = True,
        n_memos_in_context: int = MAX_CHUNK_MESSAGES_IN_CONTEXT,
        n_pending_proposals_in_context: int = MAX_PENDING_PROPOSALS_IN_CONTEXT,
        n_acceptances_in_context: int = MAX_ACCEPTANCES_IN_CONTEXT,
        n_verification_in_context: int = MAX_VERIFICATIONS_IN_CONTEXT,
        n_rewards_in_context: int = MAX_REWARDS_IN_CONTEXT,
        n_refusals_in_context: int = MAX_REFUSALS_IN_CONTEXT,
    ) -> str:
        """Get complete user context including task states and optional content.
        
        Args:
            account_address: XRPL account address
            memo_history: Optional pre-fetched memo history DataFrame to avoid requerying
            get_google_doc: Whether to fetch Google doc content
            get_historical_memos: Whether to fetch historical memos
            n_task_context_history: Number of historical items to include
        """

        # Handle proposals section (pending + accepted)
        try:
            pending_proposals = await self.get_pending_tasks(account_address)
            accepted_proposals = await self.get_accepted_tasks(account_address)

            # Combine and limit
            all_proposals = pd.concat([pending_proposals, accepted_proposals]).tail(
                n_acceptances_in_context + n_pending_proposals_in_context
            )

            if all_proposals.empty:
                proposal_string = "No pending or accepted proposals found."
            else:
                proposal_string = self.format_task_section(all_proposals, TaskType.PROPOSAL)
        
        except Exception as e:
            logger.error(f"UserTaskParser.get_full_user_context_string: Failed to get pending or accepted proposals: {e}")
            logger.error(traceback.format_exc())
            proposal_string = "Error retrieving pending or accepted proposals."

        # Handle refusals
        try:
            refused_proposals = await self.get_refused_tasks(account_address)
            refused_proposals = refused_proposals.tail(n_refusals_in_context)
            if refused_proposals.empty:
                refusal_string = "No refused proposals found."
            else:
                refusal_string = self.format_task_section(refused_proposals, TaskType.REFUSAL)
        except Exception as e:
            logger.error(f"UserTaskParser.get_full_user_context_string: Failed to get refused proposals: {e}")
            logger.error(traceback.format_exc())
            refusal_string = "Error retrieving refused proposals."
            
        # Handle verifications
        try:
            verification_proposals = await self.get_verification_tasks(account_address)
            verification_proposals = verification_proposals.tail(n_verification_in_context)
            if verification_proposals.empty:
                verification_string = "No tasks pending verification."
            else:
                verification_string = self.format_task_section(verification_proposals, TaskType.VERIFICATION_PROMPT)
        except Exception as e:
            logger.error(f'UserTaskParser.get_full_user_context_string: Exception while retrieving verifications for {account_address}: {e}')
            logger.error(traceback.format_exc())
            verification_string = "Error retrieving verifications."    

        # Handle rewards
        try:
            rewarded_proposals = await self.get_rewarded_tasks(account_address)
            rewarded_proposals = rewarded_proposals.tail(n_rewards_in_context)
            if rewarded_proposals.empty:
                reward_string = "No rewarded tasks found."
            else:
                reward_string = self.format_task_section(rewarded_proposals, TaskType.REWARD)
        except Exception as e:
            logger.error(f'UserTaskParser.get_full_user_context_string: Exception while retrieving rewards for {account_address}: {e}')
            logger.error(traceback.format_exc())
            reward_string = "Error retrieving rewards."

        # Get optional context elements
        if get_google_doc:
            try:
                google_url = await self.get_latest_outgoing_context_doc_link(account_address=account_address)
                core_element__google_doc_text = await self.get_google_doc_text(google_url)
            except Exception as e:
                logger.error(f"Failed retrieving user google doc: {e}")
                logger.error(traceback.format_exc())
                core_element__google_doc_text = 'Error retrieving google doc'

        if get_historical_memos:
            try:
                recent_memos = await self.get_recent_memos(
                    account_address=account_address,
                    num_messages=n_memos_in_context
                )
                core_element__user_log_history = await self.format_memo_groups_to_json(recent_memos)
            except Exception as e:
                logger.error(f"Failed retrieving user memo history: {e}")
                logger.error(traceback.format_exc())
                core_element__user_log_history = 'Error retrieving user memo history'

        core_elements = f"""
***<<< ALL TASK GENERATION CONTEXT STARTS HERE >>>***

These are the proposed and accepted tasks that the user has. This is their
current work queue
<<PROPOSED AND ACCEPTED TASKS START HERE>>
{proposal_string}
<<PROPOSED AND ACCEPTED TASKS END HERE>>

These are the tasks that the user has been proposed and has refused.
The user has provided a refusal reason with each one. Only their most recent
{n_refusals_in_context} refused tasks are showing 
<<REFUSED TASKS START HERE >>
{refusal_string}
<<REFUSED TASKS END HERE>>

These are the tasks that the user has for pending verification.
They need to submit details
<<VERIFICATION TASKS START HERE>>
{verification_string}
<<VERIFICATION TASKS END HERE>>

<<REWARDED TASKS START HERE >>
{reward_string}
<<REWARDED TASKS END HERE >>
"""

        optional_elements = ''
        if get_google_doc:
            optional_elements += f"""
The following is the user's full planning document that they have assembled
to inform task generation and planning
<<USER PLANNING DOC STARTS HERE>>
{core_element__google_doc_text}
<<USER PLANNING DOC ENDS HERE>>
"""

        if get_historical_memos:
            optional_elements += f"""
The following is the users own comments regarding everything
<<< USER COMMENTS AND LOGS START HERE>>
{core_element__user_log_history}
<<< USER COMMENTS AND LOGS END HERE>>
"""

        footer = f"""
***<<< ALL TASK GENERATION CONTEXT ENDS HERE >>>***
"""

        return core_elements + optional_elements + footer
    
    def format_task_section(self, task_df: pd.DataFrame, state_type: TaskType) -> str:
        """Format tasks for display based on their state type.
        
        Args:
            task_df: DataFrame containing tasks with columns:
                - proposal: The proposed task text
                - acceptance/refusal/verification/reward: The state-specific text
                - datetime: Optional timestamp of state change
            state_type: TaskType enum indicating the state to format for
            
        Returns:
            JSON-formatted string containing tasks with their details
        """
        if task_df.empty:
            return json.dumps({"tasks": []})

        # Map state types to their column names and expected status text
        state_column_map = {
            TaskType.PROPOSAL: ('acceptance', lambda x: "Pending response" if not pd.notna(x) else x),
            TaskType.ACCEPTANCE: ('acceptance', lambda x: f"Accepted: {x}"),
            TaskType.REFUSAL: ('refusal', lambda x: f"Refused: {x}"),
            TaskType.VERIFICATION_PROMPT: ('verification', lambda x: f"User submitted for verification: {x}"),
            TaskType.REWARD: ('reward', lambda x: f"Rewarded: {x}")
        }
        
        column_name, status_formatter = state_column_map[state_type]

        # Build list of task dictionaries
        tasks = []
        for task_id, row in task_df.iterrows():
            # For proposals without a status column, default to "Pending response"
            status = (
                "Pending response" 
                if state_type == TaskType.PROPOSAL and column_name not in row 
                else status_formatter(row.get(column_name, None))
            )
    
            task = {
                "task_id": task_id,
                "proposal": row['proposal'],
                "status": status
            }
            tasks.append(task)
        
        return json.dumps({"tasks": tasks})
    
    async def get_latest_outgoing_context_doc_link(
            self, 
            account_address: str
        ) -> Optional[str]:
        """Get the most recent Google Doc context link sent by this wallet.
        Handles both encrypted and unencrypted links using the MemoGroup system. 
            
        Args:
            account_address: Account address
            
        Returns:
            str or None: Most recent Google Doc link or None if not found
        """
        try:
            memo_history = await self.generic_pft_utilities.get_account_memo_history(
                account_address=account_address, 
                memo_type_filter='%google_doc_context_link'
            )

            if memo_history.empty or len(memo_history) == 0:
                logger.debug(f"UserTaskParser.get_latest_outgoing_context_doc_link: No memo history found for {account_address}. Returning None")
                return None
        
            # Get the latest valid memo group
            memo_group = await self.generic_pft_utilities.get_latest_valid_memo_groups(memo_history=memo_history)

            if not memo_group:
                logger.debug(f"UserTaskParser.get_latest_outgoing_context_doc_link: No valid memo groups found for {account_address}")
                return None
            
            # Process the group through MemoProcessor
            result = await MemoProcessor.parse_group(
                group=memo_group,
                credential_manager=self.cred_manager,
                message_encryption=self.message_encryption,
                node_config=self.node_config
            )

            return result
            
        except Exception as e:
            logger.error(f"UserTaskParser.get_latest_outgoing_context_doc_link: Error getting latest context doc link: {e}")
            logger.error(traceback.format_exc())
            return None

    @staticmethod
    async def get_google_doc_text(share_link: str) -> str:
        """Get the plain text content of a Google Doc.
        
        Args:
            share_link: Google Doc share link
            
        Returns:
            str: Plain text content of the Google Doc
        """ 
        # Extract doc ID using regex
        doc_id_match = re.search(r'docs\.google\.com/document/d/([a-zA-Z0-9_-]+)', str(share_link))
        if not doc_id_match:
            logger.error(f"UserTaskParser.get_google_doc_text: Could not extract doc ID from link: {share_link}")
            return "Failed to retrieve the document. Invalid Google Doc link."
        
        # Construct the Google Docs API URL
        url = f"https://docs.google.com/document/d/{doc_id_match.group(1)}/export?format=txt"
    
        # Send a GET request to the API URL
        response = requests.get(url)
    
        # Check if the request was successful
        if response.status_code == 200:
            # Return the plain text content of the document
            return response.text
        else:
            # Return an error message if the request was unsuccessful
            # DON'T CHANGE THIS STRING, IT'S USED FOR GOOGLE DOC VALIDATION
            return f"Failed to retrieve the document. Status code: {response.status_code}"