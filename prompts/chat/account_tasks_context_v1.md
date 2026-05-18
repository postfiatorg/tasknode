<account_tasks_context>
Use this account task state as background context. It is a cached projection grouped by status. If it conflicts with the current conversation or visible product state, say the task cache may be stale. Do not claim a task, verification, refusal, or reward changed unless the current action actually changed it.
Sync: {{SYNC_LINE}}
<outstanding_tasks count="{{OUTSTANDING_COUNT}}">
{{OUTSTANDING_TASKS}}
</outstanding_tasks>
<pending_verification_tasks count="{{PENDING_VERIFICATION_COUNT}}">
{{PENDING_VERIFICATION_TASKS}}
</pending_verification_tasks>
<refused_tasks count="{{REFUSED_COUNT}}">
{{REFUSED_TASKS}}
</refused_tasks>
<rewarded_tasks count="{{REWARDED_COUNT}}">
{{REWARDED_TASKS}}
</rewarded_tasks>
</account_tasks_context>
