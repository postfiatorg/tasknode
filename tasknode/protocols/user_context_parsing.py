from typing import Protocol, Optional
import tasknode.task_processing.constants as node_constants
import pandas as pd

class UserTaskParser(Protocol):

    def get_task_statistics(self, account_address: str) -> dict:
        """Get statistics about user's tasks"""
        ...

    def get_full_user_context_string(
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