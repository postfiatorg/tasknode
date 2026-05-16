# PFTL Verification Evidence

Task Node verification evidence should be portable across the web app, Codex,
and any wallet-capable agent. The canonical unit is a normalized
`pf.task.evidence.v1` payload that can be encrypted, pinned to IPFS, and
referenced by a `pf.task.verification_response.v1` pointer.

## PFTasks Reference Surface

The Python implementation follows the production PFTasks verification shape:

- `pftasks/api/src/services/verification_service.js`
  - builds verification prompt inputs from stored evidence artifacts;
  - fetches public URL evidence;
  - aggregates GitHub gist text files;
  - describes screenshots/images before reward verification;
  - includes `___IMAGE_DESCRIPTION_REPLACED_HERE___` and
    `___URL_CONTENT_REPLACED_HERE___` in verification prompts.
- `pftasks/api/src/services/document_evidence_service.js`
  - extracts PDF text;
  - extracts DOCX text;
  - preserves parser provenance, source MIME type, byte size, hash, and
    warnings;
  - separates sensitive evidence redaction from normal document extraction.
- `pftasks/api/src/lib/evidence_url_policy.js`
  - rejects private collaboration hosts as URL evidence;
  - rejects binary/download URLs as URL evidence so PDFs/DOCX files go through
    file evidence instead.

## Canonical Python Surface

Implementation:

```text
reference_clients/python/tasknode_pftl/verification.py
```

Runnable examples:

```text
reference_clients/python/tasknode_pftl/scenarios/verification_evidence_examples.py
```

Supported evidence inputs:

- `screenshot`: OpenAI Responses vision reads PNG/JPEG/WebP/GIF screenshot
  evidence and returns verification-relevant visible text and state.
- `file` PDF: `pypdf` extraction when installed, with a conservative literal
  fallback for simple PDFs.
- `file` DOCX: direct OOXML extraction with Python standard library ZIP/XML
  parsing.
- `url`: bounded public HTTP(S) text/HTML fetch. GitHub gists use the gist API
  and aggregate text files with a manifest.

## Example Command

```bash
cd /home/pfrpc/repos/tasknodeofficial/reference_clients/python
python3 -m tasknode_pftl.scenarios.verification_evidence_examples
```

The scenario writes:

- sample screenshot, PDF, and DOCX inputs;
- one `pf.task.evidence.v1` packet per evidence type;
- one mixed `pf.task.verification_response.v1` wrapper;
- a human-readable markdown receipt.

Screenshot reads require `OPENAI_API_KEY`. The config loader reads the same
PFTasks env files and workspace `env_dump.txt` used by the PFTL lifecycle
harness.

## Boundary Rules

- Do not pass raw wallet seed, private key, or wallet password material into
  evidence readers.
- URL evidence must be public text/HTML. Binary URLs are file evidence, not URL
  evidence.
- Store hashes, parser provenance, source metadata, and bounded excerpts with
  every evidence packet.
- Treat databases as caches. The replayable source remains the encrypted IPFS
  payload referenced by PFTL pointer events.
