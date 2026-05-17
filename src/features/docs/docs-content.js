import startHere from "../../../docs/wiki/index.md?raw";
import agents from "../../../docs/wiki/surfaces/agents.md?raw";
import brainstormingContext from "../../../docs/wiki/surfaces/brainstorming-context.md?raw";
import chat from "../../../docs/wiki/surfaces/chat.md?raw";
import context from "../../../docs/wiki/surfaces/context.md?raw";
import memory from "../../../docs/wiki/surfaces/memory.md?raw";
import motivation from "../../../docs/wiki/surfaces/motivation.md?raw";
import refineContext from "../../../docs/wiki/surfaces/refine-context.md?raw";
import rewrite from "../../../docs/wiki/surfaces/rewrite.md?raw";
import search from "../../../docs/wiki/surfaces/search.md?raw";
import tasks from "../../../docs/wiki/surfaces/tasks.md?raw";
import wallet from "../../../docs/wiki/surfaces/wallet.md?raw";
import aiProviders from "../../../docs/wiki/architecture/ai-providers.md?raw";
import database from "../../../docs/wiki/architecture/database.md?raw";
import encryption from "../../../docs/wiki/architecture/encryption.md?raw";
import ipfs from "../../../docs/wiki/architecture/ipfs.md?raw";
import nostr from "../../../docs/wiki/architecture/nostr.md?raw";
import pftl from "../../../docs/wiki/architecture/pftl.md?raw";
import taskLifecycle from "../../../docs/wiki/architecture/task-lifecycle.md?raw";

export const DOC_GROUPS = [
  {
    title: "Start",
    pages: [
      {
        slug: "start",
        title: "Start Here",
        summary: "The product and protocol mental model.",
        markdown: startHere,
      },
    ],
  },
  {
    title: "Surfaces",
    pages: [
      { slug: "chat", title: "Chat", summary: "The primary work surface.", markdown: chat },
      { slug: "search", title: "Search", summary: "Retrieval across cached work.", markdown: search },
      { slug: "tasks", title: "Tasks", summary: "Portable task lifecycle state.", markdown: tasks },
      { slug: "wallet", title: "Wallet", summary: "Identity, balances, and custody.", markdown: wallet },
      { slug: "context", title: "Context", summary: "Durable working profile.", markdown: context },
      { slug: "motivation", title: "Motivation", summary: "Goal-grounded action framing.", markdown: motivation },
      {
        slug: "brainstorming-context",
        title: "Brainstorming Context",
        summary: "Explore context changes before saving.",
        markdown: brainstormingContext,
      },
      {
        slug: "refine-context",
        title: "Refine Context",
        summary: "Clean up context without changing meaning.",
        markdown: refineContext,
      },
      { slug: "rewrite", title: "Rewrite", summary: "Controlled text transformation.", markdown: rewrite },
      { slug: "agents", title: "Agents", summary: "External wallet-native workers.", markdown: agents },
      { slug: "memory", title: "Memory", summary: "Inspectable chat compression.", markdown: memory },
    ],
  },
  {
    title: "Architecture",
    pages: [
      { slug: "pftl", title: "PFTL Usage", summary: "Chain records and pointer usage.", markdown: pftl },
      {
        slug: "ai-providers",
        title: "AI Providers",
        summary: "Mode routing across OpenAI and OpenRouter.",
        markdown: aiProviders,
      },
      {
        slug: "encryption",
        title: "Encryption",
        summary: "MessageKey and encrypted payloads.",
        markdown: encryption,
      },
      { slug: "ipfs", title: "IPFS", summary: "CID-backed payload standards.", markdown: ipfs },
      { slug: "database", title: "Database", summary: "Postgres cache architecture.", markdown: database },
      {
        slug: "task-lifecycle",
        title: "Task Lifecycle",
        summary: "Replayable task state machine.",
        markdown: taskLifecycle,
      },
      { slug: "nostr", title: "Nostr TBD", summary: "Public broadcast boundary.", markdown: nostr },
    ],
  },
];

export const DOC_PAGES = DOC_GROUPS.flatMap((group) =>
  group.pages.map((page) => ({ ...page, group: group.title }))
);
