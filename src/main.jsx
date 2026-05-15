import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const initialConfig = window.__TASKNODE_CONFIG__ || {};

const recents = [
  "Ship Task Node dev baseline",
  "Review seed wallet flow",
  "Draft usage ledger",
];

function App() {
  const [view, setView] = useState("chat");
  const [loginOpen, setLoginOpen] = useState(false);
  const [runtimeConfig, setRuntimeConfig] = useState(initialConfig);
  const navItems = useMemo(
    () => [
      ["chat", "Chat"],
      ["tasks", "Tasks"],
      ["wallet", "Wallet"],
      ["context", "Context"],
    ],
    []
  );

  useEffect(() => {
    let active = true;
    fetch("/runtime-config.json", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (active && body) setRuntimeConfig(body);
      })
      .catch(() => {});

    return () => {
      active = false;
    };
  }, []);

  return (
    <main className="app-shell">
      <aside className="sidebar" aria-label="Primary">
        <button className="new-chat" onClick={() => setView("chat")}>
          <span aria-hidden="true">+</span>
          New chat
        </button>

        <nav className="nav-list">
          {navItems.map(([key, label]) => (
            <button
              key={key}
              className={view === key ? "active" : ""}
              onClick={() => setView(key)}
            >
              {label}
            </button>
          ))}
        </nav>

        <section className="recents" aria-label="Recent chats">
          <div className="section-label">Recent</div>
          {recents.map((item) => (
            <button key={item}>{item}</button>
          ))}
        </section>

        <div className="sidebar-footer">
          <div className="balance-pill">
            <span>PFT</span>
            <strong>0</strong>
          </div>
          <button className="profile-button" onClick={() => setLoginOpen(true)}>
            Log in or sign up
          </button>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <div className="eyebrow">Task Node</div>
            <h1>{titleForView(view)}</h1>
          </div>
          <button className="login-button" onClick={() => setLoginOpen(true)}>
            Log in
          </button>
        </header>

        {view === "chat" && <ChatSurface config={runtimeConfig} />}
        {view === "tasks" && <Placeholder title="Tasks" body="Personal tasks will be requested here. Routed network and alpha tasks will arrive here when assigned." />}
        {view === "wallet" && <Placeholder title="Wallet" body="Seed-based PFTL wallet status, external funding rails, and usage ledger will live here." />}
        {view === "context" && <Placeholder title="Context" body="Context documents, imports, edits, and optional PFTL pointer manifests will live here." />}
      </section>

      {loginOpen && <LoginDialog onClose={() => setLoginOpen(false)} />}
    </main>
  );
}

function titleForView(view) {
  if (view === "tasks") return "Tasks";
  if (view === "wallet") return "Wallet";
  if (view === "context") return "Context";
  return "What are we executing?";
}

function ChatSurface({ config }) {
  return (
    <div className="chat-surface">
      <div className="message-list" aria-live="polite">
        <article className="assistant-message">
          <div className="avatar">TN</div>
          <div>
            <p>
              Task Node dev baseline is running. Next up: wire login, runtime
              config, and the seed-wallet onboarding path.
            </p>
          </div>
        </article>
      </div>
      <form className="composer" onSubmit={(event) => event.preventDefault()}>
        <button type="button" aria-label="Attach file">
          +
        </button>
        <input aria-label="Message Task Node" placeholder="Message Task Node" />
        <button type="submit" aria-label="Send message">
          Send
        </button>
      </form>
      <div className="build-line">
        {config.environment || "development"} - {config.buildId || "dev"}
      </div>
    </div>
  );
}

function Placeholder({ title, body }) {
  return (
    <div className="placeholder">
      <h2>{title}</h2>
      <p>{body}</p>
    </div>
  );
}

function LoginDialog({ onClose }) {
  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="login-dialog" role="dialog" aria-modal="true" aria-labelledby="login-title">
        <button className="dialog-close" onClick={onClose} aria-label="Close">
          x
        </button>
        <h2 id="login-title">Log in or sign up</h2>
        <p>Continue with an account, then link PFT when wallet actions are needed.</p>
        <button>Continue with Telegram</button>
        <button>Continue with Discord</button>
        <button>Continue with X</button>
        <div className="divider">OR</div>
        <input type="email" placeholder="Email address" aria-label="Email address" />
        <button className="continue-button">Continue</button>
      </section>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
