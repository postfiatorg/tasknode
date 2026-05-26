import { listTelegramBotEvents } from "../server/repositories/telegram-bot-events.js";
import { closePool } from "../server/db/pool.js";

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  if (index === -1 || index + 1 >= process.argv.length) return fallback;
  return process.argv[index + 1];
}

function hasFlag(name) {
  return process.argv.includes(name);
}

const accountId = argValue("--account-id");
const providerUserId = argValue("--provider-user-id");
const chatId = argValue("--chat-id");
const limit = Number(argValue("--limit", "50")) || 50;
const json = hasFlag("--json");

if (hasFlag("--help") || (!accountId && !providerUserId && !chatId)) {
  console.log([
    "Usage: npm run telegram-bot-events -- [options]",
    "",
    "Options:",
    "  --account-id <id>           Filter by Task Node account id.",
    "  --provider-user-id <id>     Filter by Telegram user id.",
    "  --chat-id <id>              Filter by Telegram chat id.",
    "  --limit <n>                 Maximum events to print. Default: 50.",
    "  --json                      Print raw JSON.",
  ].join("\n"));
  process.exit(hasFlag("--help") ? 0 : 1);
}

const result = await listTelegramBotEvents({
  accountId,
  providerUserId,
  chatId,
  limit,
});

if (json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  for (const event of result.events || []) {
    const parts = [
      event.createdAt,
      event.direction,
      event.eventType,
      event.status,
      event.action,
      event.mode,
      event.error && `error=${event.error}`,
      event.textPreview && `text=${JSON.stringify(event.textPreview)}`,
    ].filter(Boolean);
    console.log(parts.join(" | "));
  }
}

await closePool();
