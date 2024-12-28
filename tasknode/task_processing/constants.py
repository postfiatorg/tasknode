from enum import Enum

MAX_PENDING_PROPOSALS_IN_CONTEXT = 5
MAX_ACCEPTANCES_IN_CONTEXT = 5
MAX_REFUSALS_IN_CONTEXT = 5
MAX_VERIFICATIONS_IN_CONTEXT = 5
MAX_REWARDS_IN_CONTEXT = 5
MAX_CHUNK_MESSAGES_IN_CONTEXT = 10

# Task types where the memo_type = task_id, requiring further disambiguation in the memo_data
class TaskType(Enum):
    """Task-related memo types for workflow management"""
    REQUEST_POST_FIAT = 'REQUEST_POST_FIAT ___ '
    PROPOSAL = 'PROPOSED PF ___ '
    ACCEPTANCE = 'ACCEPTANCE REASON ___ '
    REFUSAL = 'REFUSAL REASON ___ '
    TASK_OUTPUT = 'COMPLETION JUSTIFICATION ___ '
    VERIFICATION_PROMPT = 'VERIFICATION PROMPT ___ '
    VERIFICATION_RESPONSE = 'VERIFICATION RESPONSE ___ '
    REWARD = 'REWARD RESPONSE __ '

# Additional patterns for specific task types
TASK_PATTERNS = {
    TaskType.PROPOSAL: [" .. ", TaskType.PROPOSAL.value],  # Include both patterns
    # Add any other task types that might have multiple patterns
}

# Default patterns for other task types
for task_type in TaskType:
    if task_type not in TASK_PATTERNS:
        TASK_PATTERNS[task_type] = [task_type.value]

# Helper to get all task indicators
TASK_INDICATORS = [task_type.value for task_type in TaskType]

class MessageType(Enum):
    ODV_REQUEST = 'ODV'
