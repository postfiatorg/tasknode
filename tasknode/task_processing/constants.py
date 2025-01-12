from enum import Enum
import re

MAX_PENDING_PROPOSALS_IN_CONTEXT = 5
MAX_ACCEPTANCES_IN_CONTEXT = 5
MAX_REFUSALS_IN_CONTEXT = 5
MAX_VERIFICATIONS_IN_CONTEXT = 5
MAX_REWARDS_IN_CONTEXT = 5
MAX_CHUNK_MESSAGES_IN_CONTEXT = 10

# Maximum length for a commitment sentence
MAX_COMMITMENT_SENTENCE_LENGTH = 950

INITIATION_RITE_XRP_COST = 5

# DEATH MARCH
DEATH_MARCH_COST_PER_CHECKIN = 30  # 30 PFT per check-in

# Super Users
DISCORD_SUPER_USER_IDS = [402536023483088896, 471510026696261632, 574582345248800778]

# Unique ID pattern for memo types
UNIQUE_ID_PATTERN_V1 = re.compile(r'(\d{4}-\d{2}-\d{2}_\d{2}:\d{2}(?:__[A-Z0-9]{4})?)')

class TaskType(Enum):
    TASK_REQUEST = "TASK_REQUEST"
    PROPOSAL = "PROPOSAL"
    ACCEPTANCE = "ACCEPTANCE"
    REFUSAL = "REFUSAL"
    TASK_COMPLETION = "TASK_COMPLETION"
    VERIFICATION_PROMPT = "VERIFICATION_PROMPT"
    VERIFICATION_RESPONSE = "VERIFICATION_RESPONSE"
    REWARD = "REWARD"