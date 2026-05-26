# Jobs pgvector Chat Injection Verification - 2026-05-25

## Current State

Task Node chat is using real pgvector-backed Jobs corpus retrieval.

Fly dev is attached to a pgvector-enabled MPG cluster:

- App: `tasknodeofficial-dev`
- Cluster: `tasknodeofficial-dev-pgvector-202605252246`
- Cluster ID: `3x9jv02yd3dr6qp7`
- Database: `tasknodeofficial`
- Active table: `jobs_corpus_chunks`
- Removed runtime fallback: `jobs_corpus_chunk_arrays`

The previous array-storage fallback code path was rolled back. `server/jobs-corpus.js` now queries only `jobs_corpus_chunks` using pgvector distance:

```sql
chunk.embedding <=> $1::vector
```

## Deployed Fly Verification

Verified from inside deployed app version `91` on `2026-05-25T23:06Z`:

```json
{
  "db": {
    "vector_extension": true,
    "vector_table": "jobs_corpus_chunks",
    "array_table": null,
    "database_name": "tasknodeofficial",
    "db_user": "schema_admin",
    "migration_048_present": false
  },
  "counts": {
    "chunks": 259,
    "embedding_model": "text-embedding-3-small",
    "embedding_dimensions": 1536
  },
  "retrieval": {
    "ok": true,
    "reason": null,
    "chunkCount": 3,
    "hasStorageMode": false
  },
  "injection": {
    "steveJobsXmlCount": 1,
    "jobsRetrievalContextCount": 1,
    "placeholderPresent": false,
    "allChunkIdsIncluded": true
  }
}
```

## Runtime Path

1. `server/chat-router.js` calls `jobsRetrievalForChat(...)` for chat turns when `jobsEssence` is not manually overridden.
2. `server/jobs-corpus.js` embeds the retrieval query.
3. `server/jobs-corpus.js` searches `jobs_corpus_chunks` with pgvector distance.
4. `server/jobs-corpus.js` formats the top chunks into `<jobs_retrieval_context>`.
5. `server/chat-memory-context.js` passes that retrieval text into `formatChatSpiritContext(...)`.
6. `server/chat-spirit-context.js` renders it into `RELEVANT_JOBS_ESSENCE_FROM_VECTOR_DB` in `prompts/chat/jobs_chat_os_v1.xml`.

## Rollback Completed

Removed:

- `TASKNODE_JOBS_STORAGE_MODE`
- `double precision[]` Jobs corpus storage
- `jobs_corpus_chunk_arrays` runtime query path
- `048_jobs_corpus_array_fallback.sql`
- array fallback assertions in `scripts/jobs-corpus-pgvector-smoke.mjs`

Kept:

- Real pgvector MPG cluster `3x9jv02yd3dr6qp7`
- `jobs_corpus_chunks`
- pgvector smoke coverage
- Fly data bridge default pointing at the pgvector cluster

## Focused Checks

```text
DATABASE_URL=(Fly pgvector MPG proxy URL) TASKNODE_DATABASE_ENABLED=true npm run db:jobs-corpus-smoke
npm run chat-spirit-prompt-smoke
npm run format-check
npm run lint
git diff --check
```
