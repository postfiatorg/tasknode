import { chatContextDocumentLoadForAccount } from "./chat-account-context.js";
import { chatMemoryContextLoadForAccount } from "./chat-memory-context.js";
import { chatTaskContextLoadForAccount } from "./chat-task-context.js";
import { buildChatContextStatus } from "./chat-context-status.js";

export async function loadChatExecutionContext(accountId = "") {
  const [contextDocumentLoad, memoryLoad, taskLoad] = await Promise.all([
    chatContextDocumentLoadForAccount(accountId),
    chatMemoryContextLoadForAccount(accountId),
    chatTaskContextLoadForAccount(accountId),
  ]);

  return {
    contextDocument: contextDocumentLoad.context,
    memoryContext: memoryLoad.context,
    taskContext: taskLoad.context,
    contextStatus: buildChatContextStatus({
      contextDocument: contextDocumentLoad.context,
      contextDocumentStatus: contextDocumentLoad.status,
      memoryContext: memoryLoad.context,
      memoryStatus: memoryLoad.status,
      taskContext: taskLoad.context,
      taskStatus: taskLoad.status,
    }),
  };
}
