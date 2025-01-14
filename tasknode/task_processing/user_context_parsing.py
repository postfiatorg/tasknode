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

@dataclass
class Task:
    """Represents a task and its current state in the task lifecycle."""
    task_id: str
    proposal: Optional[str] = None
    current_state: TaskType = TaskType.PROPOSAL
    state_message: Optional[str] = None
    state_datetime: Optional[datetime] = None

    @classmethod
    async def from_memo_groups(cls, proposal_group: MemoGroup, state_groups: Union[MemoGroup, List[MemoGroup]] = None) -> 'Task':
        """Create a Task from a proposal MemoGroup and optional state change MemoGroups"""
        # Extract task_id from the proposal group's memo_type
        task_id = cls.extract_task_id(proposal_group.group_id)

        # Process proposal content
        proposal = await MemoProcessor.parse_group(proposal_group)
        
        task = cls(task_id=task_id, proposal=proposal)

        # Process state changes if any exist
        if state_groups:

            if not isinstance(state_groups, list):
                state_groups = [state_groups]
            
            # Sort by datetime to get the latest state
            latest_state = sorted(
                state_groups,
                key=lambda g: g.memos[0].datetime,
                reverse=True
            )[0]

            state_content = await MemoProcessor.parse_group(latest_state)
            if state_content:
                task.current_state = TaskType(latest_state.group_id.split('__')[-1])
                task.state_message = state_content
                task.state_datetime = latest_state.memos[0].datetime

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

    async def get_task_state_pairs(self, account_address: str):
        """Get all tasks and their current states for an account.
        
        Args:
            account_address: XRPL account address
            
        Returns:
            List[Task]: List of tasks with their current states
        """
        try:
            # First get all proposals
            proposal_history = await self.generic_pft_utilities.get_account_memo_history(
                account_address=account_address,
                memo_type_filter=f'v{UNIQUE_ID_VERSION}.%__{TaskType.PROPOSAL.value}'
            )

            if proposal_history.empty:
                return []
            
            # Get proposal MemoGroups
            proposal_groups = await self.generic_pft_utilities.get_latest_valid_memo_groups(
                memo_history=proposal_history,
                num_groups=0  # Get all groups
            )

            if not proposal_groups:
                return []
            
            if not isinstance(proposal_groups, list):
                proposal_groups = [proposal_groups]
            
            tasks = []
            for proposal_group in proposal_groups:

                try:
                    task_id = Task.extract_task_id(proposal_group.group_id)

                    # Get all state changes for this task
                    state_history = await self.generic_pft_utilities.get_account_memo_history(
                        account_address=account_address,
                        memo_type_filter=f'{task_id}__%'  # Match any state change for this task
                    )

                    if not state_history.empty:
                        state_groups = await self.generic_pft_utilities.get_latest_valid_memo_groups(
                            memo_history=state_history,
                            num_groups=0  # Get all groups
                        )

                    else:
                        state_groups = None

                    task = await Task.from_memo_groups(proposal_group, state_groups)
                    tasks.append(task)

                except Exception as e:
                    logger.warning(f"Error processing task from proposal group {proposal_group.group_id}: {e}")
                    continue

            return tasks

        except Exception as e:
            logger.error(f"Error getting task state pairs for {account_address}: {e}")
            logger.error(traceback.format_exc())
            return []

    async def get_proposals_by_state(
            self, 
            account_address: str, 
            state_type: TaskType
        ):
        """Get proposals filtered by their state.
        
        Args:
            account_address: XRPL account address
            state_type: TaskType enum value to filter by
            
        Returns:
            DataFrame with columns based on state_type:
                - For PROPOSAL: ['proposal']
                - For others: ['proposal', state_type.value.lower()]
            Indexed by task_id
        """
        try:
            # Get all tasks for the account
            tasks = await self.get_task_state_pairs(account_address)

            if not tasks:
                return pd.DataFrame()

            # Filter tasks by state
            filtered_tasks = [task for task in tasks if task.current_state == state_type]

            if not filtered_tasks:
                return pd.DataFrame()
            
            if state_type == TaskType.PROPOSAL:
                # For pending proposals, we only need the proposal text
                df = pd.DataFrame([
                    {
                        'proposal': task.proposal
                    }
                    for task in filtered_tasks
                    if task.proposal  # Filter out None proposals
                ], index=[task.task_id for task in filtered_tasks if task.proposal])

            else:
                # For other states, include both proposal and state message
                df = pd.DataFrame([
                    {
                        'proposal': task.proposal,
                        state_type.value.lower(): task.state_message
                    }
                    for task in filtered_tasks
                    if task.proposal and task.state_message  # Filter out None values
                ], index=[task.task_id for task in filtered_tasks if task.proposal and task.state_message])

            return df

        except Exception as e:
            logger.error(f"Error getting proposals by state for {account_address}: {e}")
            logger.error(traceback.format_exc())
            return pd.DataFrame()

    async def get_pending_proposals(self, account: str):
        """Get proposals that have not yet been accepted or refused."""
        return await self.get_proposals_by_state(account, state_type=TaskType.PROPOSAL)

    async def get_accepted_proposals(self, account: str):
        """Get accepted proposals"""
        return await self.get_proposals_by_state(account, state_type=TaskType.ACCEPTANCE)
    
    async def get_verification_proposals(self, account: str):
        """Get verification proposals"""
        return await self.get_proposals_by_state(account, state_type=TaskType.VERIFICATION_PROMPT)

    async def get_rewarded_proposals(self, account: str):
        """Get rewarded proposals"""
        return await self.get_proposals_by_state(account, state_type=TaskType.REWARD)

    async def get_refused_proposals(self, account: str):
        """Get refused proposals"""
        return await self.get_proposals_by_state(account, state_type=TaskType.REFUSAL)
    
    async def get_refuseable_proposals(self, account: str):
        """Get all proposals that are in a valid state to be refused.
        
        This includes:
        - Pending proposals
        - Accepted proposals
        - Verification proposals
        
        Does not include proposals that have already been refused or rewarded.
        
        Args:
            account: Either an XRPL account address string or a DataFrame containing memo history.
                
        Returns:
            DataFrame with columns:
                - proposal: The proposed task text
            Indexed by task_id.
        """
        try:
            # Get all refuseable proposals
            pending = await self.get_pending_proposals(account)
            accepted = await self.get_accepted_proposals(account)
            verification = await self.get_verification_proposals(account)
            
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

        pending_proposals = await self.get_pending_proposals(account_memo_detail_df)
        accepted_proposals = await self.get_accepted_proposals(account_memo_detail_df)
        refused_proposals = await self.get_refused_proposals(account_memo_detail_df)
        verification_proposals = await self.get_verification_proposals(account_memo_detail_df)
        rewarded_proposals = await self.get_rewarded_proposals(account_memo_detail_df)

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
            pending_proposals = await self.get_pending_proposals(account_address)
            accepted_proposals = await self.get_accepted_proposals(account_address)

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
            refused_proposals = await self.get_refused_proposals(account_address)
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
            verification_proposals = await self.get_verification_proposals(account_address)
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
            rewarded_proposals = await self.get_rewarded_proposals(account_address)
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