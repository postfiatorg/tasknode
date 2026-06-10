import assert from "node:assert/strict";

import {
  chatSurfaceDisplayState,
  loginProviderDisplayState,
} from "../src/features/chat/chat-ui-state.js";

assert.equal(
  chatSurfaceDisplayState({
    activeChat: { id: "chat_1", source: "server", title: "Existing chat" },
    turns: [],
    historyLoading: true,
  }),
  "loading",
  "selected server chat should show a loading state while history is loading"
);

assert.equal(
  chatSurfaceDisplayState({
    activeChat: null,
    turns: [],
    historyLoading: true,
  }),
  "empty",
  "new chat can still show the empty composer"
);

assert.equal(
  chatSurfaceDisplayState({
    activeChat: { id: "chat_1", source: "server" },
    turns: [{ role: "user", text: "hello" }],
    historyLoading: false,
  }),
  "thread",
  "hydrated conversations should show the thread"
);

assert.equal(
  loginProviderDisplayState({ authLoading: true, providers: [] }),
  "loading",
  "login dialog must not fall back to email-only UI while auth state is loading"
);

assert.equal(
  loginProviderDisplayState({
    authLoading: false,
    providers: [{ id: "github", enabled: true }],
  }),
  "providers",
  "loaded providers should render provider buttons"
);

assert.equal(
  loginProviderDisplayState({ authLoading: false, providers: [] }),
  "fallback",
  "email-only fallback is only valid after auth state has loaded"
);

console.log("chat auth loading state smoke ok");
