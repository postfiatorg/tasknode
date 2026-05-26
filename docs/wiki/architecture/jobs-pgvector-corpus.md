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
curl -fsS https://tasknodeofficial-dev.fly.dev/api/system/status
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

If the corpus is empty or model-mismatched, ingest it:

```bash
npm run jobs-corpus-ingest
```

If `vector` is missing, the database needs the pgvector extension installed by a
database role that can create extensions. Do not work around the failure with a
separate vector database file; the intended store is Postgres so every Fly app
machine reads the same corpus rows.
