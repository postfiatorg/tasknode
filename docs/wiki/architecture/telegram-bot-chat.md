# Telegram Bot Chat

Task Node can accept private Telegram bot messages from Telegram accounts that are already linked to a Task Node account.

## Flow

1. The user links Telegram through Task Node's connected-account flow.
2. Telegram stores the provider identity as `provider = telegram` and `provider_user_id = <telegram user id>`.
3. The bot webhook receives a private Telegram message at `/api/integrations/telegram/webhook`.
4. The webhook validates `X-Telegram-Bot-Api-Secret-Token` against `TELEGRAM_BOT_WEBHOOK_SECRET`.
5. The webhook resolves `message.from.id` through the linked Telegram identity.
6. The message is sent through the existing account-scoped chat path.
7. The assistant response is sent back to the same private Telegram chat with `sendMessage`.

Group chats are rejected with a privacy message. This prevents a linked account chat from leaking into a shared Telegram room.

## Environment

```sh
TELEGRAM_BOT_TOKEN=<telegram bot token>
TELEGRAM_BOT_WEBHOOK_SECRET=<random webhook secret>
TELEGRAM_BOT_CHAT_MODE=<optional Task Node chat mode>
```

`TELEGRAM_AUTH_BOT_TOKEN` can be reused instead of `TELEGRAM_BOT_TOKEN` when the login widget and chat bot are the same bot.

Production requires a webhook secret. Local development can omit the secret, but real Fly deployment should not.

## Webhook Setup

For Fly dev:

```sh
fly secrets set TELEGRAM_BOT_WEBHOOK_SECRET=<random secret> -a tasknodeofficial-dev
curl -sS "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H "content-type: application/json" \
  -d '{"url":"https://tasknodeofficial-dev.fly.dev/api/integrations/telegram/webhook","secret_token":"<random secret>","allowed_updates":["message","edited_message"]}'
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

Unlinked Telegram user:

- The bot replies with instructions to link Telegram in Task Node Settings.
- No Task Node chat request is executed.

Deleted account:

- Account deletion removes the Telegram provider identity mapping.
- The same Telegram user is treated as unlinked until they link again.

## Verification

```sh
npm run telegram-bot-webhook-smoke
```

The smoke covers linked private chat routing, unlinked user handling, and group-chat rejection without calling Telegram or a model provider.
