import { readFileSync } from "node:fs";
import { loadPrompt, renderPromptTemplate } from "./prompt-registry.js";
import { taskNodeInstructions } from "./chat-memory-context.js";

const helpModePrompt = loadPrompt("chat/help_mode_v1.md");
const userGuideMarkdown = readUserGuideMarkdown();

export const helpChatModeLabel = "Help";

function formatHelpAccountState(deliveryContext = null) {
  const status = String(deliveryContext?.accountStatus || "").trim();
  if (status === "signed_in") {
    return [
      "## Current Account State",
      "The user is signed in.",
      "You may explain account-scoped surfaces such as Context, Tasks, Hive, Wallet, Profile, Memory, billing, and chat history when relevant.",
      "Still do not claim to press buttons or mutate app state for the user.",
    ].join("\n");
  }

  if (status === "signed_out") {
    return [
      "## Current Account State",
      "The user is signed out and is using anonymous Help mode.",
      "They can ask product-help questions, but they do not have persisted chat history, account memory, a saved Context document, Tasks, Hive state, Wallet state, Profile, daily airdrops, recommended connections, billing credit, or profile NFTs available yet.",
      "When they ask what this app is, what to do first, how to start, or any vague first-use question, make account creation the first concrete step.",
      "Account creation happens through the `Log in or sign up` control in the profile/account area. The user can continue with an enabled provider such as email, GitHub, X, Telegram, or another configured provider. Email sign-in asks for an email address and then a code.",
      "After sign-in, the normal first-session order is: choose a Hive handle, link or create a PFT wallet, back up the seed phrase if a wallet is created, write Context, then request or accept tasks.",
      "Do not talk as if the user already has a wallet, Context, tasks, rewards, airdrop eligibility, or profile NFTs unless the runtime context explicitly says so.",
    ].join("\n");
  }

  return [
    "## Current Account State",
    "The user's sign-in state was not provided. If the user appears to be starting fresh, tell them to use `Log in or sign up` before account-scoped features.",
  ].join("\n");
}

function readUserGuideMarkdown() {
  try {
    return readFileSync(
      new URL("../docs/wiki/surfaces/user-guide.md", import.meta.url),
      "utf8"
    ).trim();
  } catch (error) {
    console.warn(`help mode user guide load failed: ${error?.message || error}`);
    return [
      "# User Guide",
      "",
      "Task Node is a chat-first work system where people keep a live context document, request or receive tasks, submit evidence, earn PFT, and help coordinate shared Post Fiat network work.",
      "It is AI-assisted: models help explain app state, generate tasks, summarize context, route network work, score some outputs, and make recommendations, while the user still controls account actions through explicit app surfaces.",
      "",
      "Use Chat for reasoning and drafting. Use the `+` button for task requests and context edits. Use Tasks to accept, refuse, submit evidence, and track rewards. Use Hive for network work. Use Wallet for PFT wallet actions and top-up state. Use Profile for public identity, daily airdrop, recommended connections, and profile NFTs.",
    ].join("\n");
  }
}

export function isHelpChatMode(mode = "") {
  return String(mode || "").trim() === helpChatModeLabel;
}

export function helpModeInstructions({
  contextDocument = null,
  memoryContext = null,
  taskContext = null,
  jobsEssence = "",
  deliveryContext = null,
} = {}) {
  return renderPromptTemplate(helpModePrompt, {
    BASE_TASK_NODE_INSTRUCTIONS: taskNodeInstructions({
      contextDocument,
      memoryContext,
      taskContext,
      jobsEssence,
      deliveryContext,
    }),
    HELP_ACCOUNT_STATE: formatHelpAccountState(deliveryContext),
    TASK_NODE_USER_GUIDE: userGuideMarkdown,
  });
}
