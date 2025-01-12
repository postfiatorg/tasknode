from typing import Protocol, Union, List
from xrpl.models import Response

class TaskNodeUtilities(Protocol):
    """Protocol defining the interface for TaskNodeUtilities implementations"""

    async def discord__initiation_rite(
        self, 
        user_seed: str, 
        initiation_rite: str, 
        google_doc_link: str, 
        username: str,
    ):
        """
        Process an initiation rite for a new user. Will raise exceptions if there are any issues.
        Immediately initiates handshake protocol with the node to enable encrypted memo communication.
        
        Args:
            user_seed (str): The user's wallet seed
            initiation_rite (str): The commitment message
            google_doc_link (str): Link to user's Google doc
            username (str): Discord username
        """
        ...

    async def discord__update_google_doc_link(self, user_seed: str, google_doc_link: str, username: str):
        """Update the user's Google Doc link."""
        ...

    async def discord__final_submission(
            self, 
            user_seed: str, 
            user_name: str, 
            task_id_to_submit: str, 
            justification_string: str
        ) -> Union[Response, List[Response]]:
        """Submit final verification response for a task via Discord interface.
        
        Args:
            user_seed (str): Wallet seed for transaction signing
            user_name (str): Discord username (format: '.username')
            task_id_to_submit (str): Task ID to submit verification for (format: 'YYYY-MM-DD_HH:MM__XXNN')
            justification_string (str): User's verification response/evidence
            
        Returns:
            Union[str, Response, List[Response]]: Transaction result or error message if submission fails
        """
        ...

    async def discord__initial_submission(
            self, 
            user_seed: str, 
            user_name: str, 
            task_id_to_accept: str, 
            initial_completion_string: str
        ) -> Union[Response, List[Response]]:
        """Submit initial task completion via Discord interface.
        
        Args:
            user_seed (str): Wallet seed for transaction signing
            user_name (str): Discord username (format: '.username')
            task_id_to_accept (str): Task ID to submit completion for (format: 'YYYY-MM-DD_HH:MM__XXNN')
            initial_completion_string (str): User's completion justification/evidence
            
        Returns:
            Union[str, Response, List[Response]]: Transaction result or error message if submission fails
        """
        ...

    async def discord__task_refusal(
            self, 
            user_seed: str, 
            user_name: str, 
            task_id_to_refuse: str, 
            refusal_string: str
        ) -> Union[str, Response, List[Response]]:
        """Refuse a proposed task via Discord.
        
        Args:
            user_seed (str): Wallet seed for transaction signing
            user_name (str): Discord username for memo formatting
            task_id_to_refuse (str): Task ID to refuse (format: YYYY-MM-DD_HH:MM__XXNN)
            refusal_string (str): Refusal reason/message
            
        Returns:
            Union[str, Response, List[Response]]: Transaction result or error message
        """
        ... 

    async def discord__task_acceptance(
            self, 
            user_seed: str, 
            user_name: str, 
            task_id_to_accept: str, 
            acceptance_string: str
        ) -> Union[str, Response, List[Response]]:
        """Accept a proposed task via Discord.
        
        Args:
            user_seed (str): Wallet seed for transaction signing
            user_name (str): Discord username for memo formatting
            task_id_to_accept (str): Task ID to accept (format: YYYY-MM-DD_HH:MM__XXNN)
            acceptance_string (str): Acceptance reason/message
            
        Returns:
            Union[str, Response, List[Response]]: Transaction result or error message
        """
        ...