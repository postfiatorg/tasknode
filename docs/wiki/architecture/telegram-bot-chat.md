# Telegram Bot Chat

Task Node can accept private Telegram bot messages from Telegram accounts that are already linked to a Task Node account.

## Flow

1. The user links Telegram through Task Node's connected-account flow.
2. Telegram stores the provider identity as `provider = telegram` and `provider_user_id = <telegram user id>`.
3. The bot webhook receives a private Telegram message at `/api/integrations/telegram/webhook`.
4. The webhook validates `X-Telegram-Bot-Api-Secret-Token` against `TELEGRAM_BOT_WEBHOOK_SECRET`.
5. The webhook records the Telegram `update_id` in a short in-process duplicate guard and acknowledges Telegram immediately.
6. The background handler resolves `message.from.id` through the linked Telegram identity.
7. The message is sent through the existing account-scoped chat path with the Telegram chat's selected mode.
8. The assistant response is sent back to the same private Telegram chat with `sendMessage`.

Group chats are rejected with a privacy message. This prevents a linked account chat from leaking into a shared Telegram room.

## Modes And Billing

Telegram exposes the same chat modes as the web chat surface:

- Private Instant
- Private Thinking
- Discount Thinking
- Frontier Instant
- Frontier Thinking

The bot sends an inline keyboard with these modes. Selecting a mode stores a per-account, per-Telegram-chat preference in the runtime store, then future Telegram messages use that mode.

The bot calls the same `chatSend` path as the web UI. That means model execution is billed against the Task Node account balance, and low-balance requests are rejected before provider execution. `/balance` or the Balance button returns current credit, spend, and available credit.

Telegram marks bot-originated chat requests as `source=telegram_bot` before they
enter the shared chat route. Discount Thinking uses a longer Telegram-specific
provider timeout because direct DeepSeek reasoning can take longer than the web
chat default:

- `TELEGRAM_BOT_DISCOUNT_THINKING_TIMEOUT_MS`
- `TELEGRAM_DISCOUNT_THINKING_TIMEOUT_MS`
- `TASKNODE_TELEGRAM_DISCOUNT_THINKING_TIMEOUT_MS`

If none are set, Telegram Discount Thinking waits up to 120 seconds before Task
Node aborts the provider request. Other Telegram modes, and web Discount
Thinking calls, keep the normal chat provider timeout unless their own provider
timeout environment variable is configured.

## Environment

```sh
TELEGRAM_BOT_TOKEN=<telegram bot token>
TELEGRAM_BOT_WEBHOOK_SECRET=<random webhook secret>
TELEGRAM_BOT_CHAT_MODE=<optional Task Node chat mode>
TELEGRAM_BOT_DISCOUNT_THINKING_TIMEOUT_MS=<optional; defaults to 120000>
```

`TELEGRAM_AUTH_BOT_TOKEN` can be reused instead of `TELEGRAM_BOT_TOKEN` when the login widget and chat bot are the same bot.

Production requires a webhook secret. Local development can omit the secret, but real Fly deployment should not.

## Webhook Setup

For Fly dev:

```sh
fly secrets set TELEGRAM_BOT_WEBHOOK_SECRET=<random secret> -a tasknodeofficial-dev
curl -sS "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H "content-type: application/json" \
  -d '{"url":"https://tasknodeofficial-dev.fly.dev/api/integrations/telegram/webhook","secret_token":"<random secret>","allowed_updates":["message","callback_query"]}'
```

Check readiness:

```sh
curl -sS https://tasknodeofficial-dev.fly.dev/api/integrations/telegram/status
```

## User Behavior

Linked Telegram user, private chat:

- Text messages become Task Node chat messages on that account.
- The conversation id is scoped under the account and Telegram chat id.
- Billing, memory, context, tasks, and provider selection follow the normal chat route.
- Bot-originated model calls include the Telegram delivery contract in the
  system prompt: reply concisely for phone use, reference one relevant
  context/memory/task/Hive fact when available, avoid generic praise, and end
  with exactly one next step or clarifying question.

Unlinked Telegram user:

- The bot replies with instructions to link Telegram in Task Node Settings.
- No Task Node chat request is executed.

Deleted account:

- Account deletion removes the Telegram provider identity mapping.
- The same Telegram user is treated as unlinked until they link again.

Deleted chat conversation:

- Telegram uses a deterministic account-scoped conversation id for each linked private chat.
- If that conversation was deleted from the web UI, the next Telegram message starts with empty history and revives the same conversation id instead of failing the bot response.
- Read APIs should still hide deleted conversations until a new write revives them.

## Verification

```sh
npm run telegram-bot-webhook-smoke
npm run db:chat-billing-smoke
```

The Telegram smoke covers linked private chat routing, unlinked user handling, and group-chat rejection without calling Telegram or a model provider. The Postgres smoke covers the deleted-conversation read/write boundary: normal reads reject deleted conversations, while write history returns empty so the next chat write can revive the owned conversation.
