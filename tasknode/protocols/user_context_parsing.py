from typing import Protocol, Optional
import tasknode.task_processing.constants as node_constants
import pandas as pd

class UserTaskParser(Protocol):

    async def get_task_statistics(self, account_address: str) -> dict:
        """Get statistics about user's tasks"""
        ...

    async def get_full_user_context_string(
        self,
        account_address: str,
        memo_history: Optional[pd.DataFrame] = None,
        get_google_doc: bool = True,
        get_historical_memos: bool = True,
        n_task_context_history: int = node_constants.MAX_CHUNK_MESSAGES_IN_CONTEXT,
        n_pending_proposals_in_context: int = node_constants.MAX_PENDING_PROPOSALS_IN_CONTEXT,
        n_acceptances_in_context: int = node_constants.MAX_ACCEPTANCES_IN_CONTEXT,
        n_verification_in_context: int = node_constants.MAX_VERIFICATIONS_IN_CONTEXT,
        n_rewards_in_context: int = node_constants.MAX_REWARDS_IN_CONTEXT,
        n_refusals_in_context: int = node_constants.MAX_REFUSALS_IN_CONTEXT,
    ) -> str:
        ...

    async def get_latest_outgoing_context_doc_link(
            self, 
            account_address: str
        ) -> Optional[str]:
        """Get the most recent Google Doc context link sent by this wallet.
        Handles both encrypted and unencrypted links for backwards compatibility.
            
        Args:
            account_address: Account address
            
        Returns:
            str or None: Most recent Google Doc link or None if not found
        """
        ...

    @staticmethod
    async def get_google_doc_text(share_link):
        """Get the plain text content of a Google Doc.
        
        Args:
            share_link: Google Doc share link
            
        Returns:
            str: Plain text content of the Google Doc
        """
        ...