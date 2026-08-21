# Jobs PGVector Corpus

The Jobs PGVector Corpus is the global retrieval store for the Jobs-style chat
context. It is not a separate Fly process group. Locally it runs inside the
Docker Postgres service using the `pgvector/pgvector:pg16` image. On Fly dev it
uses the configured Postgres database behind `DATABASE_URL`; the app, worker,
and board-manager machines all read the same database.

System Status row: `jobs_pgvector_corpus`

## Runtime Boundary

- Migration: `server/db/migrations/014_jobs_corpus_pgvector.sql`.
- Source tables: `jobs_corpus_sources` and `jobs_corpus_chunks`.
- Ingestion script: `scripts/jobs-corpus-ingest.mjs`.
- Smoke script: `scripts/jobs-corpus-pgvector-smoke.mjs`.
- Retrieval module: `server/jobs-corpus.js`.
- Embedding module: `server/embedding-provider.js`.
- Default embedding model: `text-embedding-3-small` with 1536 dimensions.

The corpus is global product style/context material. It is not account-private
memory, and it is not the future semantic search index for user chat, context, or
tasks.

## Shared Vector Infrastructure

Jobs retrieval is the first live pgvector use case, but the vector extension,
database connection, and `server/embedding-provider.js` are shared app
infrastructure. Future member discovery, including recommended connections,
should reuse this Postgres pgvector setup while keeping its own tables and
privacy rules.

Recommended connections must not write member profiles into
`jobs_corpus_sources` or `jobs_corpus_chunks`. The planned member-discovery
tables are `recommended_connection_profiles`, `recommended_connection_runs`,
`recommended_connections`, and `recommended_connection_events`.

The critical privacy boundary is stricter than normal retrieval filtering: if a
profile is private or not discoverable, it should not be embedded, indexed,
retrieved, or sent to a reranking model. Private profiles stay outside the
recommendation compute path entirely. Discoverable profiles can be vector
retrieved up to a top-50 candidate cap, then reranked by the planned weekly
DeepSeek V4 Pro recommendation run.

## Chat Injection Path

1. `server/chat-router.js` calls `jobsRetrievalForChat(...)` for chat turns when
   `jobsEssence` is not manually overridden.
2. `server/jobs-corpus.js` embeds the retrieval query.
3. `server/jobs-corpus.js` searches `jobs_corpus_chunks` with pgvector distance:

   ```sql
   chunk.embedding <=> $1::vector
   ```

4. `server/jobs-corpus.js` formats the top chunks into
   `<jobs_retrieval_context>`.
5. `server/chat-memory-context.js` passes that retrieval text into
   `formatChatSpiritContext(...)`.
6. `server/chat-spirit-context.js` renders it into
   `RELEVANT_JOBS_ESSENCE_FROM_VECTOR_DB` in
   `prompts/chat/jobs_standard_chat_codex_style_draft.md`.

## Fly Deployment Shape

PGVector does not have its own `tasknodeofficial-dev` Fly machine. The live app
currently has these process groups:

- `app`: serves web/API requests and performs request-time Jobs retrieval.
- `worker`: runs background queues.
- `board-manager`: runs Hive Board Manager jobs.

The vector extension and corpus tables live in the shared Fly Postgres database.
If a separate database app or MPG cluster is provisioned by Fly, it should be
documented here by database name/cluster ID, but it still is not a Task Node
application process group.

Fly dev verification on May 25, 2026 showed the app attached to pgvector-enabled
database cluster `tasknodeofficial-dev-pgvector-202605252246` with cluster ID
`3x9jv02yd3dr6qp7`, database `tasknodeofficial`, active table
`jobs_corpus_chunks`, 259 chunks, embedding model `text-embedding-3-small`, and
1536 dimensions.

The previous array-storage fallback was removed. Do not reintroduce:

- `TASKNODE_JOBS_STORAGE_MODE`;
- `double precision[]` Jobs corpus storage;
- `jobs_corpus_chunk_arrays` runtime query path;
- `048_jobs_corpus_array_fallback.sql`;
- array fallback assertions in `scripts/jobs-corpus-pgvector-smoke.mjs`.

## Status Derivation

Green means:

- database access is enabled;
- the `vector` extension is installed;
- `jobs_corpus_sources` and `jobs_corpus_chunks` exist;
- at least one source and chunk exist; and
- chunks exist for the runtime embedding model and dimensions.

Amber means chat can still answer, but Jobs retrieval is degraded because the
corpus is empty or chunks exist only for a non-runtime embedding model.

Red means the runtime database is missing the `vector` extension or the corpus
tables. That means the retrieval query cannot perform the intended pgvector
search path.

Disabled means `TASKNODE_JOBS_RETRIEVAL_ENABLED=false` or
`TASKNODE_CHAT_SPIRIT_ENABLED=false`.

Unknown means the database is disabled or status cannot read a durable source.

## Debug And Repair

Check the live System Status row first:

```bash
curl -fsS https://tasknode.postfiat.org/api/system/status
```

Verify Fly process groups when the user expects a machine:

```bash
fly machines list -a tasknodeofficial-dev
fly status -a tasknodeofficial-dev
```

Run the local Postgres/pgvector smoke against the configured database:

```bash
npm run db:jobs-corpus-smoke
```

Focused chat injection checks:

```bash
npm run chat-spirit-prompt-smoke
npm run format-check
npm run lint
git diff --check
```

If the corpus is empty or model-mismatched, ingest it:

```bash
npm run jobs-corpus-ingest
```

If `vector` is missing, the database needs the pgvector extension installed by a
database role that can create extensions. Do not work around the failure with a
separate vector database file; the intended store is Postgres so every Fly app
machine reads the same corpus rows.
