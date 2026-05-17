# Chat

Chat is the primary work surface. Users should be able to speak naturally, attach files, request web search on frontier models, and continue prior conversations without losing state.

## User Flow

1. The user opens a new or recent chat.
2. The user selects a mode such as Private Instant, Private Thinking, Frontier Instant, or Frontier Thinking.
3. The user sends text and optional attachments.
4. The server routes the request to the correct provider.
5. The assistant response is streamed back when available.
6. Usage is billed to the user-facing balance, while background memory writes are not user-billed.

## Technical Architecture

The chat composer and thread live in `ChatSurface` in `src/main.jsx`. Provider routing is handled by `server/chat-router.js`. Billing and conversation persistence flow through `server/repositories/chat-billing.js` and migration `server/db/migrations/001_chat_billing.sql`. Attachment text extraction is handled by `server/chat-attachment-utils.js` and migration `server/db/migrations/002_chat_attachments.sql`.

Memory context is injected by `server/chat-memory-context.js`. The memory worker runs after a successful assistant response and must not block the user response.

## Chat Modes

The model picker is not cosmetic. Each option maps to a provider, model default, reasoning policy, privacy posture, attachment path, and web-search policy in `server/chat-router.js`.

| Mode | Provider | Default model | Selection and override rules | Tools and attachments | Intended use |
| --- | --- | --- | --- | --- | --- |
| Private Instant | OpenRouter `/chat/completions` | `deepseek/deepseek-v4-flash` | Uses `CHAT_MODEL_PRIVATE_INSTANT` if set, then `OPENROUTER_MODEL`, then the default. Requires `OPENROUTER_API_KEY` or `OPENROUTER`. | Text, image, PDF, and file parts are sent through OpenRouter chat content. PDF parsing uses the `file-parser` plugin with `OPENROUTER_PDF_ENGINE` or `cloudflare-ai`. Web search is intentionally disabled. | Fast private open-source chat. |
| Private Thinking | OpenRouter `/chat/completions` | `deepseek/deepseek-v4-pro` | Uses `CHAT_MODEL_PRIVATE_THINKING` if set, then `OPENROUTER_MODEL`, then the default. Requires `OPENROUTER_API_KEY` or `OPENROUTER`. | Same attachment path as Private Instant. Adds `reasoning.effort="high"` and `provider.require_parameters=true`. Web search is intentionally disabled. | Slower private open-source reasoning. |
| Frontier Instant | OpenAI `/responses` | `chat-latest` | Uses `CHAT_MODEL_FRONTIER_INSTANT` if set, otherwise the pinned default. Does not use `OPENAI_MODEL` as a broad override. Requires `OPENAI_API_KEY`. | Text, image, and file inputs are mapped to Responses API input parts. Web search is enabled only when the user asks for current or external information. | Fast frontier chat with optional web and file understanding. |
| Frontier Thinking | OpenAI `/responses` | `gpt-5.5` | Uses `CHAT_MODEL_FRONTIER_THINKING` if set, otherwise the pinned default. Requires `OPENAI_API_KEY`. | Same attachment path as Frontier Instant. Adds `reasoning.effort="high"`. Web search is enabled only when the user asks for current or external information. | Deeper frontier reasoning, especially when web or files matter. |

Unknown mode strings are normalized to Private Instant. The app default prefers Frontier Instant when it is enabled; otherwise it chooses the first enabled mode.

## Provider Policies

Private modes use OpenRouter with `provider.zdr=true` and `provider.data_collection="deny"`. They also set `provider.order` and `provider.only` to the code-defined provider allowlist for the selected mode, so private requests do not route through arbitrary cheapest-provider selection. OpenRouter can support web search through server tools, but Task Node deliberately leaves that off for private modes right now.

Frontier modes use the OpenAI Responses API with `store=false`. Task Node passes durable app history from Postgres instead of relying on OpenAI-hosted conversation state. When web search is needed, the server adds the hosted `web_search` tool and counts resulting search calls in usage billing.

## Web Search Selection

Web search is currently deterministic and conservative. `server/chat-search-tools.js` enables OpenAI `web_search` only when the message includes current-information signals such as `search`, `look up`, `today`, `current`, `latest`, `recent`, `news`, or `what is going on`. If those signals are absent, Frontier modes answer without web search. Private modes never add OpenRouter web search.

## Billing And Persistence

Before execution, `server/product-contracts.js` checks login, provider readiness, estimated cost, and available chat credit. After execution, `server/repositories/chat-billing.js` persists the user message, assistant message, provider, model, response ID, token usage, web-search calls, model cost, tool cost, and ledger entry. Memory summarization is queued afterward and is not billed to the user.

## External References

- [OpenAI Responses API migration guide](https://developers.openai.com/api/docs/guides/migrate-to-responses)
- [OpenAI web search tool](https://developers.openai.com/api/docs/guides/tools-web-search)
- [OpenAI images and vision guide](https://developers.openai.com/api/docs/guides/images-vision)
- [OpenRouter provider routing](https://openrouter.ai/docs/guides/routing/provider-selection)
- [OpenRouter PDF inputs](https://openrouter.ai/docs/guides/overview/multimodal/pdfs)

## Data Model

- Conversations are cached in Postgres.
- Messages are cached in Postgres.
- Extracted attachment text is part of the user interaction record.
- Token usage and cost are recorded against the signup identity account.
- Memory summaries are separate from ordinary chat history.

## Diagram

```mermaid
sequenceDiagram
  participant U as User
  participant UI as Chat UI
  participant API as /api/chat/send
  participant R as Chat Router
  participant DB as Postgres
  participant M as Memory Worker
  U->>UI: Send text and attachments
  UI->>API: conversationId, mode, attachments
  API->>DB: Save user turn
  API->>R: Execute provider request
  R-->>API: Assistant response and usage
  API->>DB: Save assistant turn and bill usage
  API-->>UI: Response
  API->>M: Queue memory write
```

## Failure Modes

- Provider failure should show an explicit error turn.
- Billing failure should not silently show stale credit.
- Attachment parsing failure should be visible before the request is sent.
- Memory failure should not fail the chat.
