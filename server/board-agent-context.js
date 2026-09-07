import { AsyncLocalStorage } from "node:async_hooks";

const context = new AsyncLocalStorage();
export const withBoardAgent = (identity, work) => context.run(identity, work);
export const boardAgentIdentity = () => context.getStore() || null;
export const boardAgentActor = () => boardAgentIdentity()?.actor || process.env.BM_ACTOR || "board_manager_agent";

export function assertBoardAgentScope(boardId) {
  const identity = boardAgentIdentity();
  if (identity && !identity.boards.includes(boardId)) {
    throw Object.assign(new Error("board_agent_scope_denied"), { status: 403 });
  }
}
