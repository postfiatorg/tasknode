import startHere from "../../../docs/wiki/index.md?raw";
import agents from "../../../docs/wiki/surfaces/agents.md?raw";
import chat from "../../../docs/wiki/surfaces/chat.md?raw";
import context from "../../../docs/wiki/surfaces/context.md?raw";
import dailyAirdrop from "../../../docs/wiki/surfaces/daily-airdrop.md?raw";
import hive from "../../../docs/wiki/surfaces/hive.md?raw";
import memory from "../../../docs/wiki/surfaces/memory.md?raw";
import profile from "../../../docs/wiki/surfaces/profile.md?raw";
import refineContext from "../../../docs/wiki/surfaces/refine-context.md?raw";
import search from "../../../docs/wiki/surfaces/search.md?raw";
import tasks from "../../../docs/wiki/surfaces/tasks.md?raw";
import wallet from "../../../docs/wiki/surfaces/wallet.md?raw";
import aiProviders from "../../../docs/wiki/architecture/ai-providers.md?raw";
import authAndConnectedAccounts from "../../../docs/wiki/architecture/auth-and-connected-accounts.md?raw";
import authWalletBoundary from "../../../docs/wiki/architecture/auth-wallet-boundary.md?raw";
import bootup from "../../../docs/wiki/architecture/bootup.md?raw";
import boardManagerArchitecture from "../../../docs/wiki/architecture/board-manager.md?raw";
import boardManagerSecretaryPacket from "../../../docs/wiki/architecture/board-manager-secretary-packet.md?raw";
import contextHistoryRestore from "../../../docs/wiki/architecture/context-history-restore.md?raw";
import codexComputerControlQa from "../../../docs/wiki/architecture/codex-computer-control-qa.md?raw";
import currentSystem from "../../../docs/wiki/architecture/current-system.md?raw";
import database from "../../../docs/wiki/architecture/database.md?raw";
import databaseArchitecture from "../../../docs/wiki/architecture/database-architecture.md?raw";
import dailyAirdropWorker from "../../../docs/wiki/architecture/daily-airdrop-worker.md?raw";
import deathmarch from "../../../docs/wiki/architecture/deathmarch.md?raw";
import deepMemoryWorker from "../../../docs/wiki/architecture/deep-memory-worker.md?raw";
import deployment from "../../../docs/wiki/architecture/deployment.md?raw";
import encryption from "../../../docs/wiki/architecture/encryption.md?raw";
import ethereumDepositRpc from "../../../docs/wiki/architecture/ethereum-deposit-rpc.md?raw";
import hiveActiveProjectsHelper from "../../../docs/wiki/architecture/hive-active-projects-helper.md?raw";
import hiveSecretaryWorker from "../../../docs/wiki/architecture/hive-secretary-worker.md?raw";
import executionMandate from "../../../docs/wiki/architecture/execution-mandate.md?raw";
import ipfs from "../../../docs/wiki/architecture/ipfs.md?raw";
import jobsPgvectorCorpus from "../../../docs/wiki/architecture/jobs-pgvector-corpus.md?raw";
import nostr from "../../../docs/wiki/architecture/nostr.md?raw";
import networkTaskRecovery from "../../../docs/wiki/architecture/network-task-recovery.md?raw";
import networkTaskGenerationWorker from "../../../docs/wiki/architecture/network-task-generation-worker.md?raw";
import networkTaskProfileWorker from "../../../docs/wiki/architecture/network-task-profile-worker.md?raw";
import pftl from "../../../docs/wiki/architecture/pftl.md?raw";
import pftlArchiveWalletSync from "../../../docs/wiki/architecture/pftl-archive-wallet-sync.md?raw";
import pftlCacheReducer from "../../../docs/wiki/architecture/pftl-cache-reducer.md?raw";
import pftlCacheRetention from "../../../docs/wiki/architecture/pftl-cache-retention.md?raw";
import pftlCurrentRpcAndWss from "../../../docs/wiki/architecture/pftl-current-rpc-and-wss.md?raw";
import pftlHistoryRpcAndArchiveWss from "../../../docs/wiki/architecture/pftl-history-rpc-and-archive-wss.md?raw";
import pftlHotWalletSync from "../../../docs/wiki/architecture/pftl-hot-wallet-sync.md?raw";
import pftlLiveTaskReplay from "../../../docs/wiki/architecture/pftl-live-task-replay.md?raw";
import pftlTransactionCache from "../../../docs/wiki/architecture/pftl-transaction-cache.md?raw";
import pftlWssWatcher from "../../../docs/wiki/architecture/pftl-wss-watcher.md?raw";
import resettableSignupTesting from "../../../docs/wiki/architecture/resettable-signup-testing.md?raw";
import styleGuide from "../../../docs/wiki/architecture/style-guide.md?raw";
import systemStatus from "../../../docs/wiki/architecture/system-status.md?raw";
import taskAsyncEngine from "../../../docs/wiki/architecture/task-async-engine.md?raw";
import taskGenerationWorker from "../../../docs/wiki/architecture/task-generation-worker.md?raw";
import taskLifecycle from "../../../docs/wiki/architecture/task-lifecycle.md?raw";
import taskReviewRewardWorker from "../../../docs/wiki/architecture/task-review-reward-worker.md?raw";
import telegramBotChat from "../../../docs/wiki/architecture/telegram-bot-chat.md?raw";
import turnMemoryWorker from "../../../docs/wiki/architecture/turn-memory-worker.md?raw";
import taskNodeProductionScope from "../../../docs/wiki/plans/task-node-production-scope.md?raw";
import taskNodeInstructionsPrompt from "../../../prompts/chat/task_node_instructions_v1.md?raw";
import jobsStandardChatPrompt from "../../../prompts/chat/jobs_standard_chat_codex_style_draft.md?raw";
import contextEditJobsPrompt from "../../../prompts/context/context_edit_jobs_v1.xml?raw";
import accountMemoryContextPrompt from "../../../prompts/chat/account_memory_context_v1.md?raw";
import accountTasksContextPrompt from "../../../prompts/chat/account_tasks_context_v1.md?raw";
import chatMemoryPrompt from "../../../prompts/memory/chat_memory_v1.md?raw";
import deepMemoryPrompt from "../../../prompts/memory/deep_memory_v1.md?raw";
import networkTaskProfilePrompt from "../../../prompts/memory/network_task_profile_v2.md?raw";
import boardManagerPrompt from "../../../prompts/hive/board_manager_v1.md?raw";
import boardManagerSecretaryPrompt from "../../../prompts/hive/board_manager_secretary_v1.md?raw";
import hiveSecretaryPrompt from "../../../prompts/hive/hive_secretary_v1.md?raw";
import hiveActiveProjectsPrompt from "../../../prompts/hive/hive_active_projects_v1.md?raw";
import dailyAirdropPrompt from "../../../prompts/profile/daily_airdrop_v1.md?raw";
import publicProfileSnapshotPrompt from "../../../prompts/profile/public_profile_snapshot_v1.md?raw";
import evidenceScreenshotPrompt from "../../../prompts/task_engine/evidence_screenshot_read_v1.md?raw";
import rewardScoringPrompt from "../../../prompts/task_engine/reward_scoring_v1.md?raw";
import taskgenNetworkPrompt from "../../../prompts/task_engine/taskgen_network_v1.md?raw";
import taskgenPersonalPrompt from "../../../prompts/task_engine/taskgen_personal_v1.md?raw";
import verificationRequestPrompt from "../../../prompts/task_engine/verification_request_v1.md?raw";
import profileNftImagePrompt from "../../../prompts/non_production/profile_nft_dev/profile_nft_image.placeholder.md?raw";

const PROMPT_SOURCES = [
  {
    family: "Profile",
    title: "Daily Airdrop Scoring",
    path: "prompts/profile/daily_airdrop_v1.md",
    summary: "Scores the recent positive-reward task packet into the daily PFT airdrop amount and explanatory bullets.",
    status: "Active for scoring and operator-triggered live issuance",
    usedBy: [
      "server/profile-daily-airdrop.js::runDailyAirdropScore",
      "scripts/profile-daily-airdrop-score.mjs",
      "scripts/profile-daily-airdrop-issue.mjs",
      "GET /api/profile/daily-airdrop",
    ],
    content: dailyAirdropPrompt,
  },
  {
    family: "Profile",
    title: "Profile NFT Image",
    path: "prompts/non_production/profile_nft_dev/profile_nft_image.placeholder.md",
    summary: "Dev/test fallback template for profile NFT image generation. Production requires PROFILE_NFT_PROMPT_B64 or PROFILE_NFT_PROMPT_TEXT.",
    status: "Non-production fallback; production route fails closed without a private prompt",
    usedBy: [
      "server/profile-nft-prompts.js::renderProfileNftPrompt",
      "server/profile-nft-generation.js::profileNftGenerateStart",
    ],
    content: profileNftImagePrompt,
  },
  {
    family: "Profile",
    title: "Public Profile Snapshot",
    path: "prompts/profile/public_profile_snapshot_v1.md",
    summary: "Generates role title, role summary, skills, and archetype from deterministic public profile metrics.",
    status: "Active for public profile snapshot regeneration",
    usedBy: [
      "server/profile-public-snapshot.js::runPublicProfileSnapshot",
      "scripts/profile-public-snapshot.mjs",
      "POST /api/profile/public/regenerate",
    ],
    content: publicProfileSnapshotPrompt,
  },
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
    title: "Jobs Chat Spirit",
    path: "prompts/chat/jobs_standard_chat_codex_style_draft.md",
    summary: "Shared Markdown operating prompt that gives all exposed chat modes the Jobs-calibrated product voice while preserving Task Node context, memory, task awareness, and pgvector Jobs retrieval.",
    status: "Active by default; disabled only when TASKNODE_CHAT_SPIRIT_ENABLED=false",
    usedBy: [
      "server/chat-spirit-context.js::formatChatSpiritContext",
      "server/chat-memory-context.js::taskNodeInstructions",
      "server/chat-router.js::openRouterMessages",
      "server/chat-router.js::openAiResponseRequest",
    ],
    content: jobsStandardChatPrompt,
  },
  {
    family: "Chat",
    title: "Context Refine Jobs",
    path: "prompts/context/context_edit_jobs_v1.xml",
    summary: "Dedicated structured-output prompt for Chat Context Refine mode.",
    status: "Active for Context Refine",
    usedBy: [
      "server/context-edit-prompts.js::renderContextEditPrompt",
      "server/context-edit-chat.js::executeContextEditChat",
    ],
    content: contextEditJobsPrompt,
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
    family: "Memory",
    title: "Network Task Profile",
    path: "prompts/memory/network_task_profile_v2.md",
    summary: "Async diagnostic profile prompt over context, memory, profile, and Network Context Inputs.",
    status: "Active async worker",
    usedBy: [
      "server/chat-memory-worker.js::fetchNetworkTaskProfile",
      "server/repositories/network-task-profile.js::completeNetworkTaskProfileJob",
      "GET /api/memory/network-task-profile",
    ],
    content: networkTaskProfilePrompt,
  },
  {
    family: "Hive",
    title: "Board Manager",
    path: "prompts/hive/board_manager_v1.md",
    summary: "Operating prompt for the single leased Board Manager action registry.",
    status: "Active for persistent Board Manager Codex Exec runs and first action hooks",
    usedBy: [
      "docs/wiki/architecture/board-manager.md",
      "scripts/board-manager-codex-exec.mjs",
      "server/repositories/board-manager.js::formatBoardManagerCodexPrompt",
      "server/board-manager-actions.js::executeBoardManagerDecision",
    ],
    content: boardManagerPrompt,
  },
  {
    family: "Hive",
    title: "Board Manager Secretary Packet",
    path: "prompts/hive/board_manager_secretary_v1.md",
    summary: "Direct DeepSeek V4 Pro prompt that compresses raw Hive board state into compact packets for Qwen Board Manager decisions.",
    status: "Active for Board Manager secretary packet generation",
    usedBy: [
      "server/board-manager-secretary-packets.js::fetchBoardManagerSecretaryPacket",
      "server/board-manager-secretary-packets.js::ensureBoardManagerSecretaryPacket",
      "scripts/board-manager-model-exec.mjs",
    ],
    content: boardManagerSecretaryPrompt,
  },
  {
    family: "Hive",
    title: "Hive Secretary",
    path: "prompts/hive/hive_secretary_v1.md",
    summary: "Updates the network context report from validated-wallet Hive chat entries.",
    status: "Active async worker",
    usedBy: [
      "server/hive-secretary-worker.js::fetchHiveSecretaryReport",
      "server/repositories/hive-context.js::completeHiveSecretaryJob",
      "GET /api/hive/context",
    ],
    content: hiveSecretaryPrompt,
  },
  {
    family: "Hive",
    title: "Hive Active Projects",
    path: "prompts/hive/hive_active_projects_v1.md",
    summary: "Determines the active network project set from the latest Hive Secretary report and current project registry.",
    status: "Active async worker",
    usedBy: [
      "server/hive-project-worker.js::fetchHiveActiveProjects",
      "server/repositories/hive-project-planning.js::completeHiveProjectPlanningJob",
      "GET /api/hive/projects",
    ],
    content: hiveActiveProjectsPrompt,
  },
  {
    family: "Task Engine",
    title: "Task Generation Personal",
    path: "prompts/task_engine/taskgen_personal_v1.md",
    summary: "Generates one concise personal PFTL task from request, context, memory, chat, wallet, policy, and task queue blocks.",
    status: "Active app worker and Python reference for personal task requests",
    usedBy: [
      "server/task-generation-worker.js::generateTaskWithOpenAi",
      "server/task-generation-worker.js::taskgenPromptForInput",
      "reference_clients/python/tasknode_pftl/taskgen.py::generate_task",
      "reference_clients/python/tasknode_pftl/taskgen.py::taskgen_prompt_for_input",
    ],
    content: taskgenPersonalPrompt,
  },
  {
    family: "Task Engine",
    title: "Task Generation Network",
    path: "prompts/task_engine/taskgen_network_v1.md",
    summary: "Generates one concrete Network or Alpha Task from structured Board Manager routing context.",
    status: "Active app worker, Network Task worker handoff, and Python reference",
    usedBy: [
      "server/network-task-generation-worker.js::createTaskRequestForNetworkJob",
      "server/task-generation-worker.js::taskgenPromptForInput",
      "server/task-generation-worker.js::generateTaskWithOpenAi",
      "reference_clients/python/tasknode_pftl/taskgen.py::taskgen_prompt_for_input",
      "reference_clients/python/tasknode_pftl/taskgen.py::generate_task",
    ],
    content: taskgenNetworkPrompt,
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
    summary: "Scores verification evidence and produces reward, partial reward, or zero-reward outcomes.",
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
    slug: "prompts-profile",
    title: "Profile Prompts",
    summary: "Daily airdrop scoring and profile generation prompts.",
    family: "Profile",
  }),
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
    slug: "prompts-hive",
    title: "Hive Prompts",
    summary: "Network context synthesis prompts.",
    family: "Hive",
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

export const SYSTEM_STATUS_DOC_LINKS = {
  board_manager: { slug: "board-manager-architecture", label: "Architecture: Board Manager" },
  board_manager_secretary_packets: {
    slug: "board-manager-secretary-packet",
    label: "Architecture: Board Manager Secretary Packet",
  },
  hive_secretary: { slug: "hive-secretary-worker", label: "Architecture: Hive Secretary Worker" },
  hive_active_projects: { slug: "hive-active-projects-helper", label: "Architecture: Hive Active Projects Helper" },
  network_task_generation: {
    slug: "network-task-generation-worker",
    label: "Architecture: Network Task Generation Worker",
  },
  task_generation: { slug: "task-generation-worker", label: "Architecture: Task Generation Worker" },
  task_review: { slug: "task-review-reward-worker", label: "Architecture: Task Review And Reward Worker" },
  pftl_hot_sync: { slug: "pftl-hot-wallet-sync", label: "Architecture: PFTL Hot Wallet Sync" },
  pftl_archive_sync: { slug: "pftl-archive-wallet-sync", label: "Architecture: PFTL Archive Wallet Sync" },
  pftl_wss_watcher: { slug: "pftl-wss-watcher", label: "Architecture: PFTL WSS Watcher" },
  pftl_cache_reducer: { slug: "pftl-cache-reducer", label: "Architecture: PFTL Cache Reducer" },
  pftl_cache_retention: { slug: "pftl-cache-retention", label: "Architecture: PFTL Cache Retention" },
  pftl_current_rpc: { slug: "pftl-current-rpc-and-wss", label: "Architecture: PFTL Current RPC And WSS" },
  pftl_history_rpc: {
    slug: "pftl-history-rpc-and-archive-wss",
    label: "Architecture: PFTL History RPC And Archive WSS",
  },
  ethereum_deposit_rpc: { slug: "ethereum-deposit-rpc", label: "Architecture: Ethereum Deposit RPC" },
  jobs_pgvector_corpus: { slug: "jobs-pgvector-corpus", label: "Architecture: Jobs PGVector Corpus" },
  chat_turn_memory: { slug: "turn-memory-worker", label: "Architecture: Turn Memory Worker" },
  deep_memory: { slug: "deep-memory-worker", label: "Architecture: Deep Memory Worker" },
  network_task_profile: {
    slug: "network-task-profile-worker",
    label: "Architecture: Network Task Profile Worker",
  },
  daily_airdrop_worker: { slug: "daily-airdrop-worker", label: "Architecture: Daily Airdrop Worker" },
};

export const DOC_GROUPS = [
  {
    title: "Start",
    pages: [
      {
        slug: "system-status-home",
        title: "System Status",
        summary: "Live audit view for schedulers, workers, and RPC dependencies.",
        markdown: systemStatus,
        component: "system-status",
      },
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
      { slug: "hive", title: "Hive", summary: "Network project routing and operator coordination.", markdown: hive },
      { slug: "wallet", title: "Wallet", summary: "Identity, balances, and custody.", markdown: wallet },
      { slug: "profile", title: "Profile", summary: "Member trust surface and daily airdrop state.", markdown: profile },
      {
        slug: "daily-airdrop",
        title: "Daily Airdrop",
        summary: "Account-level contributor scoring and identity-cloud recipient selection.",
        markdown: dailyAirdrop,
      },
      { slug: "context", title: "Context", summary: "Durable working profile.", markdown: context },
      {
        slug: "refine-context",
        title: "Refine Context",
        summary: "Clean up context without changing meaning.",
        markdown: refineContext,
      },
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
        slug: "auth-and-connected-accounts",
        title: "Auth And Connected Accounts",
        summary: "Email, GitHub, Telegram, X, wallet identity, and out-of-scope Discord notes.",
        markdown: authAndConnectedAccounts,
      },
      {
        slug: "auth-wallet-boundary",
        title: "Auth And Wallet Boundary",
        summary: "Account auth, wallet proof, local vault unlock, and seed custody guardrails.",
        markdown: authWalletBoundary,
      },
      {
        slug: "resettable-signup-testing",
        title: "Resettable Signup Testing",
        summary: "QA reset workflow for reusable email signup and funded wallet tests.",
        markdown: resettableSignupTesting,
      },
      {
        slug: "telegram-bot-chat",
        title: "Telegram Bot Chat",
        summary: "Linked Telegram identity webhook chat path.",
        markdown: telegramBotChat,
      },
      {
        slug: "deployment",
        title: "Deployment",
        summary: "Fly dev, Docker, data stores, secrets, auth, top-up, and verification commands.",
        markdown: deployment,
      },
      {
        slug: "bootup",
        title: "Bootup",
        summary: "Local setup, smoke checks, startup guards, and first failure triage.",
        markdown: bootup,
      },
      {
        slug: "current-system",
        title: "Current System",
        summary: "Current product boundary, routes, enabled surfaces, deferrals, and near-term build path.",
        markdown: currentSystem,
      },
      {
        slug: "deathmarch",
        title: "Deathmarch Local Harness",
        summary: "Local-only Discord posting harness for Task Node task events.",
        markdown: deathmarch,
      },
      {
        slug: "system-status",
        title: "System Status",
        summary: "Live audit view for schedulers, workers, and RPC dependencies.",
        markdown: systemStatus,
        component: "system-status",
      },
      {
        slug: "codex-computer-control-qa",
        title: "Browser-Control QA Protocol",
        summary: "Browser automation QA protocol for beta release verification.",
        markdown: codexComputerControlQa,
      },
      {
        slug: "board-manager-architecture",
        title: "Board Manager",
        summary: "Leased Hive decision worker, scheduler state, and repair path.",
        markdown: boardManagerArchitecture,
      },
      {
        slug: "board-manager-secretary-packet",
        title: "Board Manager Secretary Packet",
        summary: "DeepSeek packet compression before Board Manager decisions.",
        markdown: boardManagerSecretaryPacket,
      },
      {
        slug: "hive-secretary-worker",
        title: "Hive Secretary Worker",
        summary: "Structured Hive report generation and worker status derivation.",
        markdown: hiveSecretaryWorker,
      },
      {
        slug: "hive-active-projects-helper",
        title: "Hive Active Projects Helper",
        summary: "Active project derivation, freshness rules, and repair commands.",
        markdown: hiveActiveProjectsHelper,
      },
      {
        slug: "network-task-generation-worker",
        title: "Network Task Generation Worker",
        summary: "Board Manager allocation handoff into the standard task engine.",
        markdown: networkTaskGenerationWorker,
      },
      {
        slug: "task-generation-worker",
        title: "Task Generation Worker",
        summary: "Signed request to PFTL task offer worker path.",
        markdown: taskGenerationWorker,
      },
      {
        slug: "task-review-reward-worker",
        title: "Task Review And Reward Worker",
        summary: "Review, verification, reward progression, and repair path.",
        markdown: taskReviewRewardWorker,
      },
      {
        slug: "pftl-hot-wallet-sync",
        title: "PFTL Hot Wallet Sync",
        summary: "Current-ledger wallet sync status and repair path.",
        markdown: pftlHotWalletSync,
      },
      {
        slug: "pftl-archive-wallet-sync",
        title: "PFTL Archive Wallet Sync",
        summary: "Historical wallet backfill status and repair path.",
        markdown: pftlArchiveWalletSync,
      },
      {
        slug: "pftl-wss-watcher",
        title: "PFTL WSS Watcher",
        summary: "Websocket checkpoint freshness and reconnect checks.",
        markdown: pftlWssWatcher,
      },
      {
        slug: "pftl-cache-reducer",
        title: "PFTL Cache Reducer",
        summary: "Pointer reducer queue health and projection repair.",
        markdown: pftlCacheReducer,
      },
      {
        slug: "pftl-cache-retention",
        title: "PFTL Cache Retention",
        summary: "Cache maintenance freshness and safe cleanup rules.",
        markdown: pftlCacheRetention,
      },
      {
        slug: "pftl-current-rpc-and-wss",
        title: "PFTL Current RPC And WSS",
        summary: "Current ledger endpoint health for submissions and hot sync.",
        markdown: pftlCurrentRpcAndWss,
      },
      {
        slug: "pftl-history-rpc-and-archive-wss",
        title: "PFTL History RPC And Archive WSS",
        summary: "Archive endpoint health for historical backfill and context restore.",
        markdown: pftlHistoryRpcAndArchiveWss,
      },
      {
        slug: "ethereum-deposit-rpc",
        title: "Ethereum Deposit RPC",
        summary: "Deposit top-up RPC configuration and request-time status.",
        markdown: ethereumDepositRpc,
      },
      {
        slug: "jobs-pgvector-corpus",
        title: "Jobs PGVector Corpus",
        summary: "Postgres pgvector retrieval corpus, Fly shape, and repair path.",
        markdown: jobsPgvectorCorpus,
      },
      {
        slug: "turn-memory-worker",
        title: "Turn Memory Worker",
        summary: "Chat turn memory queue health and recovery.",
        markdown: turnMemoryWorker,
      },
      {
        slug: "deep-memory-worker",
        title: "Deep Memory Worker",
        summary: "Deep account memory queue health and recovery.",
        markdown: deepMemoryWorker,
      },
      {
        slug: "network-task-profile-worker",
        title: "Network Task Profile Worker",
        summary: "Routing profile queue health and repair commands.",
        markdown: networkTaskProfileWorker,
      },
      {
        slug: "daily-airdrop-worker",
        title: "Daily Airdrop Worker",
        summary: "Airdrop scoring, issuance status, and money-path recovery.",
        markdown: dailyAirdropWorker,
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
        slug: "database-architecture",
        title: "Database Architecture",
        summary: "Target Postgres account, billing, context, task, and pgvector architecture.",
        markdown: databaseArchitecture,
      },
      {
        slug: "execution-mandate",
        title: "Execution Mandate",
        summary: "Verification rules for repo work and claims of completion.",
        markdown: executionMandate,
      },
      {
        slug: "style-guide",
        title: "Style Guide",
        summary: "Visual system, colors, typography, and surface-level UX rules.",
        markdown: styleGuide,
      },
      {
        slug: "task-lifecycle",
        title: "Task Lifecycle",
        summary: "Replayable task state machine.",
        markdown: taskLifecycle,
      },
      {
        slug: "pftl-live-task-replay",
        title: "PFTL Live Task Replay",
        summary: "Successful live PFTL/IPFS lifecycle replay from request through reward.",
        markdown: pftlLiveTaskReplay,
      },
      {
        slug: "context-history-restore",
        title: "Context History Restore",
        summary: "PFTL cache projection path for historical context restore.",
        markdown: contextHistoryRestore,
      },
      {
        slug: "network-task-recovery",
        title: "Network Task Recovery",
        summary: "Restart recovery for active Network Tasks and Hive mirrors.",
        markdown: networkTaskRecovery,
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
        slug: "task-node-production-scope",
        title: "Task Node Production Scope",
        summary: "Single active beta plan: acceptance gates, completed work, and remaining P0/P1 launch scope.",
        markdown: taskNodeProductionScope,
      },
    ],
  },
];

export const DOC_PAGES = DOC_GROUPS.flatMap((group) =>
  group.pages.map((page) => ({ ...page, group: group.title }))
);
