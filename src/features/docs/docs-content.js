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
import executionMandate from "../../../docs/wiki/architecture/execution-mandate.md?raw";
import ipfs from "../../../docs/wiki/architecture/ipfs.md?raw";
import nostr from "../../../docs/wiki/architecture/nostr.md?raw";
import pftl from "../../../docs/wiki/architecture/pftl.md?raw";
import pftlTransactionCache from "../../../docs/wiki/architecture/pftl-transaction-cache.md?raw";
import taskAsyncEngine from "../../../docs/wiki/architecture/task-async-engine.md?raw";
import taskLifecycle from "../../../docs/wiki/architecture/task-lifecycle.md?raw";
import codeReviewBurndown from "../../../docs/wiki/plans/code-review-burndown.md?raw";
import gettingTasksOverLine from "../../../docs/wiki/plans/getting-tasks-over-line.md?raw";
import jobsChatSpirit from "../../../docs/wiki/plans/jobs-chat-spirit.md?raw";
import pftlTransactionCacheMilestone from "../../../docs/wiki/plans/pftl-transaction-cache-milestone.md?raw";
import pythonicTaskEngineSpeedrun from "../../../docs/wiki/plans/pythonic-task-engine-speedrun.md?raw";
import taskEngineUxIntegrationPlan from "../../../docs/wiki/plans/task-engine-ux-integration-plan.md?raw";
import taskNodeInstructionsPrompt from "../../../prompts/chat/task_node_instructions_v1.md?raw";
import accountMemoryContextPrompt from "../../../prompts/chat/account_memory_context_v1.md?raw";
import accountTasksContextPrompt from "../../../prompts/chat/account_tasks_context_v1.md?raw";
import chatMemoryPrompt from "../../../prompts/memory/chat_memory_v1.md?raw";
import deepMemoryPrompt from "../../../prompts/memory/deep_memory_v1.md?raw";
import blockContractPrompt from "../../../prompts/task_engine/block_contract_v1.md?raw";
import evidenceScreenshotPrompt from "../../../prompts/task_engine/evidence_screenshot_read_v1.md?raw";
import rewardScoringPrompt from "../../../prompts/task_engine/reward_scoring_v1.md?raw";
import taskgenPrompt from "../../../prompts/task_engine/taskgen_minimal_v1.md?raw";
import taskgenRepairPrompt from "../../../prompts/task_engine/taskgen_repair_v1.md?raw";
import verificationRequestPrompt from "../../../prompts/task_engine/verification_request_v1.md?raw";

const PROMPT_SOURCES = [
  {
    family: "Chat",
    title: "Task Node Instructions",
    path: "prompts/chat/task_node_instructions_v1.md",
    summary: "Base chat system instructions for OpenAI Frontier modes and OpenRouter Private modes.",
    status: "Active",
    usedBy: [
      "server/chat-memory-context.js::taskNodeInstructions",
      "server/chat-router.js::openRouterMessages",
      "server/chat-router.js::openAiResponseRequest",
    ],
    content: taskNodeInstructionsPrompt,
  },
  {
    family: "Chat",
    title: "Account Memory Context",
    path: "prompts/chat/account_memory_context_v1.md",
    summary: "Template around deep memory and recent memory injected into chat instructions.",
    status: "Active when memory exists",
    usedBy: [
      "server/chat-memory-context.js::formatChatMemoryContext",
      "server/chat-memory-context.js::taskNodeInstructions",
    ],
    content: accountMemoryContextPrompt,
  },
  {
    family: "Chat",
    title: "Account Tasks Context",
    path: "prompts/chat/account_tasks_context_v1.md",
    summary: "Task projection context grouped as Outstanding, Pending Verification, Refused, and Rewarded.",
    status: "Active when account task state exists",
    usedBy: [
      "server/chat-task-context.js::formatChatTaskContext",
      "server/chat-task-context.js::taskContextForAccount",
      "server/chat-memory-context.js::taskNodeInstructions",
    ],
    content: accountTasksContextPrompt,
  },
  {
    family: "Memory",
    title: "Turn Memory Summary",
    path: "prompts/memory/chat_memory_v1.md",
    summary: "Async summary prompt for one user/assistant exchange.",
    status: "Active async worker",
    usedBy: [
      "server/chat-memory-worker.js::memorySystemPrompt",
      "server/chat-memory-worker.js::fetchMemorySummary",
      "server/repositories/chat-memory.js::completeChatMemoryJob",
    ],
    content: chatMemoryPrompt,
  },
  {
    family: "Memory",
    title: "Deep Memory Summary",
    path: "prompts/memory/deep_memory_v1.md",
    summary: "Async summary prompt that compresses 36 turn memories into account-level memory.",
    status: "Active async worker",
    usedBy: [
      "server/chat-memory-worker.js::deepMemorySystemPrompt",
      "server/chat-memory-worker.js::fetchDeepMemorySummary",
      "server/repositories/chat-memory.js::completeDeepMemoryJob",
    ],
    content: deepMemoryPrompt,
  },
  {
    family: "Task Engine",
    title: "Task Generation",
    path: "prompts/task_engine/taskgen_minimal_v1.md",
    summary: "Generates one concise PFTL task from request, context, memory, chat, wallet, and policy blocks.",
    status: "Active app worker and Python reference",
    usedBy: [
      "server/task-generation-worker.js::generateTaskWithOpenAi",
      "reference_clients/python/tasknode_pftl/taskgen.py::generate_task",
      "reference_clients/python/tasknode_pftl/taskgen.py::benchmark_taskgen",
      "reference_clients/python/tasknode_pftl/taskgen.py::TASKGEN_RESPONSE_FORMAT",
    ],
    content: taskgenPrompt,
  },
  {
    family: "Task Engine",
    title: "Task Block Contract",
    path: "prompts/task_engine/block_contract_v1.md",
    summary: "Human-readable contract for taskgen input blocks.",
    status: "Documentation contract",
    usedBy: [
      "reference_clients/python/tasknode_pftl/taskgen.py::project_taskgen_input",
      "reference_clients/python/tasknode_pftl/app_data.py::build_request_bundle_from_fixture",
    ],
    content: blockContractPrompt,
  },
  {
    family: "Task Engine",
    title: "Task JSON Repair",
    path: "prompts/task_engine/taskgen_repair_v1.md",
    summary: "Reserved repair prompt for malformed task generation JSON.",
    status: "Reserved",
    usedBy: ["No runtime caller yet"],
    content: taskgenRepairPrompt,
  },
  {
    family: "Verification",
    title: "Verification Request",
    path: "prompts/task_engine/verification_request_v1.md",
    summary: "Policy for a single follow-up verification ask after initial task submission.",
    status: "Active app worker and Python reference",
    usedBy: [
      "server/task-review-worker.js::processSubmittedTask",
      "reference_clients/python/tasknode_pftl/engine/scoring.py::build_verification_request",
    ],
    content: verificationRequestPrompt,
  },
  {
    family: "Verification",
    title: "Screenshot Evidence Read",
    path: "prompts/task_engine/evidence_screenshot_read_v1.md",
    summary: "Vision prompt for describing screenshot evidence without inventing hidden state.",
    status: "Active",
    usedBy: [
      "server/task-evidence-processing.js::processEvidenceFileForSubmission",
      "reference_clients/python/tasknode_pftl/verification.py::describe_screenshot_with_openai",
    ],
    content: evidenceScreenshotPrompt,
  },
  {
    family: "Reward",
    title: "Reward Scoring",
    path: "prompts/task_engine/reward_scoring_v1.md",
    summary: "Scores verification evidence and produces reward, partial reward, or zero-reward decisions.",
    status: "Active app worker and Python reference",
    usedBy: [
      "server/task-review-worker.js::processVerificationResponse",
      "reference_clients/python/tasknode_pftl/engine/scoring.py::score_reward",
    ],
    content: rewardScoringPrompt,
  },
];

const PROMPT_PAGES = [
  {
    slug: "prompts-index",
    title: "Prompt Index",
    summary: "Source-controlled prompts and runtime call sites.",
    markdown: promptIndexMarkdown(),
  },
  promptFamilyPage({
    slug: "prompts-chat",
    title: "Chat Prompts",
    summary: "System instructions and account memory context used by chat.",
    family: "Chat",
  }),
  promptFamilyPage({
    slug: "prompts-memory",
    title: "Memory Prompts",
    summary: "Async memory compression prompts.",
    family: "Memory",
  }),
  promptFamilyPage({
    slug: "prompts-task-engine",
    title: "Task Engine Prompts",
    summary: "Task generation and input block prompt contracts.",
    family: "Task Engine",
  }),
  promptFamilyPage({
    slug: "prompts-verification",
    title: "Verification Prompts",
    summary: "Follow-up verification and evidence reading prompts.",
    family: "Verification",
  }),
  promptFamilyPage({
    slug: "prompts-reward",
    title: "Reward Prompts",
    summary: "Reward scoring prompt policy.",
    family: "Reward",
  }),
];

function promptIndexMarkdown() {
  const entries = PROMPT_SOURCES.flatMap((source) => [
    `### ${source.family}: ${source.title}`,
    `- Prompt file: \`${source.path}\``,
    `- Status: ${source.status}`,
    `- Summary: ${source.summary}`,
    `- Used by: ${source.usedBy.map((item) => `\`${item}\``).join(", ")}`,
  ]).join("\n\n");
  return [
    "# Prompt Index",
    "Prompt text shown in this Help section is imported directly from files under `prompts/` using Vite raw imports. Do not paste prompt text into docs by hand; update the prompt file and this page will change on the next build.",
    "Runtime code should record prompt version and prompt digest whenever prompt output becomes part of a PFTL payload, database cache, or audit trail.",
    "## Runtime Map",
    entries,
  ].join("\n\n");
}

function promptFamilyPage({ slug, title, summary, family }) {
  const sources = PROMPT_SOURCES.filter((source) => source.family === family);
  return {
    slug,
    title,
    summary,
    markdown: [
      `# ${title}`,
      summary,
      "These prompt blocks are rendered from the source files listed below. Editing a prompt file changes the Help rendering on the next frontend build.",
      ...sources.flatMap((source) => promptSourceSections(source)),
    ].join("\n\n"),
  };
}

function promptSourceSections(source) {
  return [
    `## ${source.title}`,
    `Source file: \`${source.path}\``,
    `Runtime status: ${source.status}`,
    ["Used by:", ...source.usedBy.map((item) => `- \`${item}\``)].join("\n"),
    ["Prompt text:", "```text", source.content.trim(), "```"].join("\n"),
  ];
}

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
        slug: "pftl-transaction-cache",
        title: "PFTL Transaction Cache",
        summary: "Wallet transaction mirror and sync strategy.",
        markdown: pftlTransactionCache,
      },
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
        slug: "execution-mandate",
        title: "Execution Mandate",
        summary: "Verification rules for repo work and claims of completion.",
        markdown: executionMandate,
      },
      {
        slug: "task-lifecycle",
        title: "Task Lifecycle",
        summary: "Replayable task state machine.",
        markdown: taskLifecycle,
      },
      {
        slug: "task-async-engine",
        title: "Task Async Engine",
        summary: "Wallet queues, worker ownership, and request edge states.",
        markdown: taskAsyncEngine,
      },
      { slug: "nostr", title: "Nostr TBD", summary: "Public broadcast boundary.", markdown: nostr },
    ],
  },
  {
    title: "Prompts",
    pages: PROMPT_PAGES,
  },
  {
    title: "Plans",
    pages: [
      {
        slug: "code-review-burndown",
        title: "Code Review Burndown",
        summary: "Doc-driven review queue for visible app promises.",
        markdown: codeReviewBurndown,
      },
      {
        slug: "getting-tasks-over-line",
        title: "Getting Tasks Over The Line",
        summary: "Plan to make task requests, submissions, rewards, and projections real.",
        markdown: gettingTasksOverLine,
      },
      {
        slug: "task-engine-ux-integration-plan",
        title: "Task Engine UX Integration Plan",
        summary: "Audit plan for porting the backend task engine into the visible app lifecycle.",
        markdown: taskEngineUxIntegrationPlan,
      },
      {
        slug: "jobs-chat-spirit",
        title: "Jobs Chat Spirit",
        summary: "Plan for the Jobs XML chat prompt and later pgvector retrieval over Jobs notes.",
        markdown: jobsChatSpirit,
      },
      {
        slug: "pythonic-task-engine-speedrun",
        title: "Pythonic Task Engine Speedrun",
        summary: "Review plan for the raw Python multi-wallet task lifecycle proof.",
        markdown: pythonicTaskEngineSpeedrun,
      },
      {
        slug: "pftl-transaction-cache-milestone",
        title: "PFTL Transaction Cache Milestone",
        summary: "Milestone for the wallet transaction mirror, sync workers, and cache consumers.",
        markdown: pftlTransactionCacheMilestone,
      },
    ],
  },
];

export const DOC_PAGES = DOC_GROUPS.flatMap((group) =>
  group.pages.map((page) => ({ ...page, group: group.title }))
);
