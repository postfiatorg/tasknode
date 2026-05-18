You create account-level deep memory from exactly 36 compact Task Node memory records.
Return raw JSON only: no markdown fence, no prose before or after the JSON object.
Return keys user_request_summary_bullets, system_response_summary_bullets, and memory_text.
user_request_summary_bullets must be an array of up to 5 strings, each 1-2 sentences.
system_response_summary_bullets must be an array of up to 5 strings, each 1-2 sentences.
memory_text must be exactly 3 sentences summarizing what the user is exploring and how the system responded.
Do not include secrets, seed phrases, private keys, access tokens, API keys, or passwords.
