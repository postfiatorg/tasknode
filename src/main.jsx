import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowUp,
  BookOpen,
  ChevronRight,
  ListTodo,
  MoreHorizontal,
  PanelLeft,
  Plus,
  Search,
  Sparkles,
  SquarePen,
  Store,
  Wallet,
} from "lucide-react";
import { fetchAppState, fetchRuntimeConfig, requestJson } from "./api";
import "./styles.css";

const fallbackConfig = window.__TASKNODE_CONFIG__ || {};

function App() {
  const [view, setView] = useState("chat");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [loginOpen, setLoginOpen] = useState(false);
  const [runtimeConfig, setRuntimeConfig] = useState(fallbackConfig);
  const [appState, setAppState] = useState(null);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let active = true;

    Promise.all([fetchRuntimeConfig(), fetchAppState()])
      .then(([config, state]) => {
        if (!active) return;
        setRuntimeConfig(config);
        setAppState(state);
      })
      .catch((error) => {
        if (active) setLoadError(error?.message || "Failed to load app state");
      });

    return () => {
      active = false;
    };
  }, []);

  const recents = appState?.chat?.recents || [];
  const pftBalance = formatDrops(appState?.wallet?.pftBalanceDrops || 0);
  const session = appState?.session;

  return (
    <main className={`app-shell ${sidebarOpen ? "" : "sidebar-collapsed"}`}>
      <aside className="sidebar" aria-label="Primary">
        <div className="sidebar-header">
          {sidebarOpen ? <span className="sidebar-title">Task Node</span> : <BrandDot />}
          <button
            className="icon-button"
            onClick={() => setSidebarOpen((open) => !open)}
            title={sidebarOpen ? "Collapse sidebar" : "Open sidebar"}
            type="button"
          >
            <PanelLeft size={18} strokeWidth={1.75} />
          </button>
        </div>

        <nav className="nav-list">
          <SidebarButton
            active={view === "chat"}
            icon={SquarePen}
            label="New chat"
            onClick={() => setView("chat")}
            sidebarOpen={sidebarOpen}
          />
          <SidebarButton icon={Search} label="Search chats" sidebarOpen={sidebarOpen} />
          <SidebarButton
            active={view === "tasks"}
            badge={appState?.tasks?.outstanding?.length}
            icon={ListTodo}
            label="Tasks"
            onClick={() => setView("tasks")}
            sidebarOpen={sidebarOpen}
          />
          <SidebarButton
            active={view === "wallet"}
            icon={Wallet}
            label="Wallet"
            onClick={() => setView("wallet")}
            sidebarOpen={sidebarOpen}
          />
          <SidebarButton
            active={view === "context"}
            icon={BookOpen}
            label="Context"
            onClick={() => setView("context")}
            sidebarOpen={sidebarOpen}
          />
          <SidebarButton icon={MoreHorizontal} label="More" sidebarOpen={sidebarOpen} />
        </nav>

        {sidebarOpen && (
          <section className="recents" aria-label="Recent chats">
            <div className="section-label">Recents</div>
            {recents.length > 0 ? (
              recents.map((item) => <button key={item}>{item}</button>)
            ) : (
              <div className="sidebar-note">No chats yet</div>
            )}
          </section>
        )}

        <div className="sidebar-footer">
          {sidebarOpen && (
            <button className="balance-pill" onClick={() => setView("wallet")} type="button">
              <span className="balance-left">
                <Wallet size={14} strokeWidth={1.75} />
                <strong>{pftBalance}</strong>
                <span>PFT</span>
              </span>
              <ChevronRight size={14} strokeWidth={1.75} />
            </button>
          )}
          <button className="profile-button" onClick={() => setLoginOpen(true)}>
            <span className="profile-avatar">AG</span>
            {sidebarOpen && (
              <>
                <span className="profile-copy">
                  <strong>{session?.displayName || "Alex Good"}</strong>
                  <small>{session?.status === "signed_out" ? "Log in or sign up" : "Pro"}</small>
                </span>
                <Store size={14} strokeWidth={1.75} />
              </>
            )}
          </button>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="topbar-left">
            {!sidebarOpen && (
              <button className="icon-button" onClick={() => setSidebarOpen(true)} type="button">
                <PanelLeft size={18} strokeWidth={1.75} />
              </button>
            )}
            <button className="icon-button" onClick={() => setView("chat")} type="button">
              <SquarePen size={18} strokeWidth={1.75} />
            </button>
          </div>
          {view !== "chat" && <h1>{titleForView(view)}</h1>}
        </header>

        {loadError && <StatusBanner tone="error">{loadError}</StatusBanner>}
        {!appState && !loadError && <StatusBanner>Loading product state</StatusBanner>}

        {view === "chat" && (
          <ChatSurface config={runtimeConfig} chat={appState?.chat} usage={appState?.usage} />
        )}
        {view === "tasks" && <TasksView tasks={appState?.tasks} />}
        {view === "wallet" && (
          <WalletView wallet={appState?.wallet} usage={appState?.usage} />
        )}
        {view === "context" && <ContextView context={appState?.context} />}
      </section>

      {loginOpen && (
        <LoginDialog session={session} onClose={() => setLoginOpen(false)} />
      )}
    </main>
  );
}

function titleForView(view) {
  if (view === "tasks") return "Tasks";
  if (view === "wallet") return "Wallet";
  if (view === "context") return "Context";
  return "What are we executing?";
}

function ChatSurface({ chat, usage }) {
  const modes = chat?.modes || [];
  const messages = chat?.seedMessages || [];
  const defaultMode = chat?.defaultMode || "Private Instant";
  const [turns, setTurns] = useState(messages);
  const [selectedMode, setSelectedMode] = useState(defaultMode);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [input, setInput] = useState("");
  const [sendMessage, setSendMessage] = useState("");
  const [estimate, setEstimate] = useState(null);
  const [actualUsage, setActualUsage] = useState(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    setSelectedMode(defaultMode);
  }, [defaultMode]);

  useEffect(() => {
    setTurns(messages);
  }, [messages]);

  async function submitMessage(event) {
    event.preventDefault();
    const message = input.trim();
    if (!message) return;

    setSending(true);
    setSendMessage("");
    setEstimate(null);
    setActualUsage(null);

    try {
      const result = await requestJson(usage?.chatSendPath || "/api/chat/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, mode: selectedMode }),
      });
      setEstimate(result.body?.estimate || null);
      setActualUsage(result.body?.usage || null);

      if (result.ok && result.body?.assistant) {
        setTurns((current) => [
          ...current,
          result.body.user || { role: "user", body: message },
          result.body.assistant,
        ]);
        setInput("");
        setSendMessage(result.body.message || "Chat response generated.");
      } else {
        setSendMessage(
          result.body?.message ||
            result.body?.actionRequired ||
            `Chat returned HTTP ${result.status}.`
        );
      }
    } catch (error) {
      setSendMessage(error?.message || "Chat execution is unavailable.");
    } finally {
      setSending(false);
    }
  }

  const composer = (
    <form className="composer" onSubmit={submitMessage}>
      <button className="composer-icon" type="button" aria-label="Add">
        <Plus size={20} strokeWidth={1.75} />
      </button>
      <input
        aria-label="Ask anything"
        onChange={(event) => setInput(event.target.value)}
        placeholder="Ask anything"
        value={input}
      />
      <div className="model-picker">
        <button
          className="model-button"
          onClick={() => setModelMenuOpen((open) => !open)}
          type="button"
        >
          {formatModeLabel(selectedMode)}
          <ChevronRight size={14} strokeWidth={1.75} />
        </button>
        {modelMenuOpen && (
          <div className="model-menu">
            <ModelGroup label="Private" />
            {modes
              .filter((mode) => mode.label.startsWith("Private"))
              .map((mode) => (
                <ModelOption
                  key={mode.label}
                  mode={mode}
                  selected={mode.label === selectedMode}
                  onClick={() => {
                    setSelectedMode(mode.label);
                    setModelMenuOpen(false);
                  }}
                />
              ))}
            <div className="menu-divider" />
            <ModelGroup label="Frontier" />
            {modes
              .filter((mode) => mode.label.startsWith("Frontier"))
              .map((mode) => (
                <ModelOption
                  key={mode.label}
                  mode={mode}
                  selected={mode.label === selectedMode}
                  onClick={() => {
                    setSelectedMode(mode.label);
                    setModelMenuOpen(false);
                  }}
                />
              ))}
          </div>
        )}
      </div>
      <button className="send-button" disabled={!input.trim() || sending} type="submit" aria-label="Send">
        <ArrowUp size={18} strokeWidth={2.25} />
      </button>
    </form>
  );

  return (
    <div className={turns.length === 0 ? "chat-surface empty" : "chat-surface"}>
      {turns.length === 0 ? (
        <div className="chat-empty">
          <h1>What are you working on?</h1>
          {composer}
        </div>
      ) : (
        <>
          <div className="message-list" aria-live="polite">
            {turns.map((message, index) =>
              message.role === "user" ? (
                <article className="user-message" key={message.id || `user-${index}`}>
                  <div>{message.body}</div>
                </article>
              ) : (
                <article className="assistant-message" key={message.id || `assistant-${index}`}>
                  {message.body}
                </article>
              )
            )}
          </div>
          <div className="composer-dock">{composer}</div>
        </>
      )}

      {(sendMessage || estimate) && (
        <div className="chat-contract-message">
          {estimate && (
            <span>
              Estimated {formatUsd(estimate.estimatedUsd)} before execution.
            </span>
          )}
          {actualUsage && (
            <span>
              Billed {formatUsageUsd(actualUsage.costUsd)} from {actualUsage.totalTokens} tokens.
            </span>
          )}
          {sendMessage && <span>{sendMessage}</span>}
        </div>
      )}
    </div>
  );
}

function SidebarButton({ active, badge, icon: Icon, label, onClick, sidebarOpen }) {
  return (
    <button className={active ? "active" : ""} onClick={onClick} type="button">
      <Icon size={18} strokeWidth={1.75} />
      {sidebarOpen && <span>{label}</span>}
      {sidebarOpen && badge ? <small>{badge}</small> : null}
    </button>
  );
}

function BrandDot() {
  return (
    <span className="brand-dot">
      <Sparkles size={14} strokeWidth={2} />
    </span>
  );
}

function ModelGroup({ label }) {
  return <div className="model-group">{label}</div>;
}

function ModelOption({ mode, onClick, selected }) {
  return (
    <button className={selected ? "selected" : ""} onClick={onClick} type="button">
      <span>{formatModeLabel(mode.label)}</span>
      <small>{mode.enabled ? "Ready" : mode.configured ? "Disabled" : "Needs config"}</small>
    </button>
  );
}

function formatModeLabel(label) {
  return label.replace("Private ", "Private - ").replace("Frontier ", "Frontier - ");
}

function TasksView({ tasks }) {
  const outstanding = tasks?.outstanding || [];
  const routed = tasks?.routed || [];

  return (
    <div className="view-surface">
      <section className="summary-band">
        <div>
          <span className="label">Personal requests</span>
          <strong>{tasks?.personalRequestEnabled ? "Enabled" : "Disabled"}</strong>
        </div>
        <div>
          <span className="label">Network requests</span>
          <strong>{tasks?.networkRequestEnabled ? "Enabled" : "Receive only"}</strong>
        </div>
        <div>
          <span className="label">Reward cap</span>
          <strong>{tasks?.dailyRewardCap || 8} per day</strong>
        </div>
      </section>

      <section className="section-block">
        <div className="section-heading">
          <h2>Outstanding</h2>
          <button type="button">Request personal task</button>
        </div>
        <div className="item-list">
          {outstanding.map((task) => (
            <TaskCard key={task.id} task={task} />
          ))}
        </div>
      </section>

      <section className="section-block">
        <div className="section-heading">
          <h2>Routed work</h2>
        </div>
        <div className="item-list">
          {routed.map((task) => (
            <TaskCard key={task.id} task={task} />
          ))}
        </div>
      </section>
    </div>
  );
}

function TaskCard({ task }) {
  return (
    <article className="item-card">
      <div className="item-card-top">
        <span className="pill">{task.kind}</span>
        <span className="muted">{task.status}</span>
      </div>
      <h3>{task.title}</h3>
      <p>{task.summary}</p>
      <div className="item-meta">
        {task.pft ? <span>{formatDrops(task.pft)} PFT</span> : null}
        {task.due ? <span>{task.due}</span> : null}
      </div>
    </article>
  );
}

function WalletView({ wallet, usage }) {
  const [message, setMessage] = useState("");
  const [pendingAction, setPendingAction] = useState("");
  const actions = wallet?.actions || [];
  const linkAction = actions.find((action) => action.id === "link_start");

  async function startWalletAction(action) {
    if (!action) return;

    setPendingAction(action.id);
    setMessage("");

    try {
      const result = await requestJson(action.path, { method: action.method || "POST" });
      setMessage(
        result.body?.message ||
          result.body?.actionRequired ||
          `${action.label} returned HTTP ${result.status}.`
      );
    } catch (error) {
      setMessage(error?.message || `${action.label} is unavailable.`);
    } finally {
      setPendingAction("");
    }
  }

  return (
    <div className="view-surface">
      <section className="summary-band">
        <div>
          <span className="label">PFT balance</span>
          <strong>{formatDrops(wallet?.pftBalanceDrops || 0)}</strong>
        </div>
        <div>
          <span className="label">Chat credit</span>
          <strong>{formatUsd(wallet?.chatCreditUsd || 0)}</strong>
        </div>
        <div>
          <span className="label">Billing</span>
          <strong>{usage?.billingModel === "usage_based" ? "Usage based" : "Unknown"}</strong>
        </div>
      </section>

      <section className="section-block">
        <div className="section-heading">
          <h2>PFT wallet</h2>
          <button type="button" onClick={() => startWalletAction(linkAction)}>
            Link seed wallet
          </button>
        </div>
        <div className="split-panel">
          <div>
            <span className="label">Status</span>
            <strong>{wallet?.pftWallet?.status || "not_linked"}</strong>
            <p>
              PFTL wallet actions stay separate from normal account login. The
              seed-based path is the preferred core PFT wallet flow.
            </p>
          </div>
          <div>
            <span className="label">Requires unlock</span>
            <ul>
              {(wallet?.pftWallet?.signingRequiredFor || []).map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="section-block">
        <div className="section-heading">
          <h2>Wallet lifecycle</h2>
        </div>
        <div className="action-grid">
          {actions.map((action) => (
            <button
              key={action.id}
              className="action-button"
              type="button"
              onClick={() => startWalletAction(action)}
            >
              <span>{action.label}</span>
              <small>
                {pendingAction === action.id
                  ? "Checking"
                  : action.configured
                    ? "Config ready"
                    : "Needs config"}
              </small>
            </button>
          ))}
        </div>
        {message && <div className="inline-message">{message}</div>}
      </section>

      <section className="section-block">
        <div className="section-heading">
          <h2>Funding rails</h2>
        </div>
        <div className="item-list">
          {(wallet?.fundingRails || []).map((rail) => (
            <article className="item-card" key={rail.label}>
              <div className="item-card-top">
                <span className="pill">{rail.status}</span>
              </div>
              <h3>{rail.label}</h3>
              <p>{rail.note}</p>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function ContextView({ context }) {
  const [message, setMessage] = useState("");
  const [pendingAction, setPendingAction] = useState("");
  const actions = context?.actions || [];
  const importAction = actions.find((action) => action.id === "import_shared_url");

  async function startContextAction(action) {
    if (!action) return;

    setPendingAction(action.id);
    setMessage("");

    try {
      const result = await requestJson(action.path, { method: action.method || "POST" });
      setMessage(
        result.body?.message ||
          result.body?.actionRequired ||
          `${action.label} returned HTTP ${result.status}.`
      );
    } catch (error) {
      setMessage(error?.message || `${action.label} is unavailable.`);
    } finally {
      setPendingAction("");
    }
  }

  return (
    <div className="view-surface">
      <section className="summary-band single">
        <div>
          <span className="label">Manifest policy</span>
          <strong>{context?.manifestPolicy || "Loading"}</strong>
        </div>
      </section>

      <section className="section-block">
        <div className="section-heading">
          <h2>Sources</h2>
          <button type="button" onClick={() => startContextAction(importAction)}>
            Import context
          </button>
        </div>
        <div className="item-list">
          {(context?.sources || []).map((source) => (
            <article className="item-card" key={source.label}>
              <div className="item-card-top">
                <span className="pill">{source.status}</span>
              </div>
              <h3>{source.label}</h3>
              <p>{source.note}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section-block">
        <div className="section-heading">
          <h2>Context actions</h2>
        </div>
        <div className="action-grid">
          {actions.map((action) => (
            <button
              key={action.id}
              className="action-button"
              type="button"
              onClick={() => startContextAction(action)}
            >
              <span>{action.label}</span>
              <small>
                {pendingAction === action.id
                  ? "Checking"
                  : action.configured
                    ? "Config ready"
                    : "Needs config"}
              </small>
            </button>
          ))}
        </div>
        {message && <div className="inline-message">{message}</div>}
      </section>
    </div>
  );
}

function LoginDialog({ session, onClose }) {
  const providers = session?.accountLinks || [];
  const [message, setMessage] = useState("");
  const [pendingProvider, setPendingProvider] = useState("");

  async function startProvider(provider) {
    setPendingProvider(provider.id);
    setMessage("");

    try {
      const result = await requestJson(provider.startPath);
      setMessage(
        result.body?.message ||
          result.body?.actionRequired ||
          `${provider.label} login returned HTTP ${result.status}.`
      );
    } catch (error) {
      setMessage(error?.message || `${provider.label} login is unavailable.`);
    } finally {
      setPendingProvider("");
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="login-dialog" role="dialog" aria-modal="true" aria-labelledby="login-title">
        <button className="dialog-close" onClick={onClose} aria-label="Close">
          x
        </button>
        <h2 id="login-title">Log in or sign up</h2>
        <p>You get account history first. PFT wallet unlock only appears when a wallet action needs it.</p>
        {providers.map((provider) => (
          <button
            key={provider.id}
            className="provider-row"
            type="button"
            onClick={() => startProvider(provider)}
          >
            <span>Continue with {provider.label}</span>
            <small>
              {pendingProvider === provider.id
                ? "Checking"
                : provider.configured
                  ? "Config ready"
                  : "Needs config"}
            </small>
          </button>
        ))}
        {message && <div className="dialog-message">{message}</div>}
        <div className="divider">OR</div>
        <input type="email" placeholder="Email address" aria-label="Email address" />
        <button
          className="continue-button"
          type="button"
          onClick={() => setMessage("Email login needs a transactional email provider and magic-link callback.")}
        >
          Continue
        </button>
      </section>
    </div>
  );
}

function StatusBanner({ children, tone = "default" }) {
  return <div className={`status-banner ${tone}`}>{children}</div>;
}

function formatDrops(value) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);
}

function formatUsd(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatUsageUsd(value) {
  const numeric = Number(value || 0);
  if (numeric > 0 && numeric < 0.01) return "<$0.01";
  return formatUsd(numeric);
}

createRoot(document.getElementById("root")).render(<App />);
