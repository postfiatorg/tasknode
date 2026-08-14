import React, { useState, useRef, useCallback } from "react";
import {
  X, SquarePen, Search, ListTodo, Activity, FileText, Wallet, BookOpen,
  MoreHorizontal, ChevronRight, PanelLeft, ArrowLeft, Lock, Share2,
  Bold, Italic, Underline, Strikethrough, Link2, List, ListOrdered,
  Quote, Table, Sigma, Flag, MessageSquare, AlignLeft, AlignCenter,
  AlignRight, Undo2, Redo2, History, Sparkles, Check, Bell,
  ChevronDown, Minimize2, Type, Eye, Users, Download, Copy, FileUp,
  CircleCheck, ArrowUp, Plus
} from "lucide-react";

/* Task Node design tokens, pulled from the existing app:
   ink #1C1917 · ink-2 #57534E · ink-3 #A8A29E · border #E7E5E4
   panel #FAFAF9 / #FCFCFB · green dot #17B26A · green pill #ECFDF3 / #067647 */

const CSS = `
  .tn * { box-sizing: border-box; }
  .tn {
    display: flex; height: 100vh; background: #fff;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif;
    color: #1C1917; -webkit-font-smoothing: antialiased;
  }
  .tn button { font-family: inherit; border: none; background: none; cursor: pointer; padding: 0; color: inherit; }
  .tn input { font-family: inherit; }

  /* ── Sidebar ── */
  .tn-side { width: 264px; flex-shrink: 0; border-right: 1px solid #EDEBE9; display: flex; flex-direction: column; background:#fff; }
  @media (max-width: 1100px) { .tn-side { display: none; } }
  .tn-brand { display: flex; align-items: center; justify-content: space-between; padding: 16px 16px 8px; }
  .tn-brand-l { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
  .tn-iconbtn { display:flex; align-items:center; justify-content:center; border-radius: 8px; padding: 6px; color: #78716C; }
  .tn-iconbtn:hover { background: #F5F5F4; }
  .tn-nav { display: flex; flex-direction: column; gap: 2px; padding: 4px 8px 0; }
  .tn-nav-item { display: flex; align-items: center; justify-content: space-between; border-radius: 12px; padding: 8px 12px; font-size: 13.5px; color: #44403C; text-align: left; }
  .tn-nav-item:hover { background: #FAFAF9; }
  .tn-nav-item.active { background: #F5F5F4; font-weight: 500; color: #1C1917; }
  .tn-nav-l { display: flex; align-items: center; gap: 10px; }
  .tn-nav-l svg { color: #78716C; }
  .tn-nav-item.active .tn-nav-l svg { color: #1C1917; }
  .tn-badge { display:flex; align-items:center; justify-content:center; height:18px; min-width:18px; padding:0 4px; border-radius:999px; background:#1C1917; color:#fff; font-size:10px; font-weight:600; }
  .tn-live { display:flex; align-items:center; gap:4px; font-size:11px; color:#57534E; }
  .tn-dot { width:6px; height:6px; border-radius:999px; background:#17B26A; display:inline-block; }
  .tn-pill-green { display:inline-flex; align-items:center; gap:4px; border-radius:999px; background:#ECFDF3; color:#067647; font-size:11px; font-weight:500; padding:2px 8px; }

  .tn-recents { flex:1; min-height:0; overflow-y:auto; padding: 20px 8px 8px; }
  .tn-recents-title { padding: 0 12px 6px; font-size:12px; font-weight:600; }
  .tn-hive { display:flex; align-items:center; gap:8px; width:100%; border-radius:12px; border:1px solid #D1FADF; background:#F0FDF4; color:#067647; font-size:13px; font-weight:500; padding:8px 12px; text-align:left; }
  .tn-recent { display:block; width:100%; border-radius:12px; padding:7px 12px; font-size:13px; color:#57534E; text-align:left; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .tn-recent:hover { background:#FAFAF9; }

  .tn-side-foot { border-top:1px solid #EDEBE9; padding:12px 16px; }
  .tn-wallet-row { display:flex; align-items:center; justify-content:space-between; }
  .tn-wallet-amt { display:flex; align-items:center; gap:6px; font-size:13px; font-weight:600; }
  .tn-wallet-amt svg { color:#78716C; }
  .tn-unit { font-size:10px; font-weight:500; color:#A8A29E; }
  .tn-sub { font-size:12px; color:#57534E; margin: 4px 0; }
  .tn-sub span { color:#A8A29E; }
  .tn-user { display:flex; align-items:center; gap:10px; margin-top:12px; }
  .tn-avatar { width:32px; height:32px; border-radius:999px; background:linear-gradient(135deg,#57534E,#1C1917); flex-shrink:0; }
  .tn-user-name { font-size:13px; font-weight:500; line-height:1.3; }
  .tn-user-handle { font-size:11.5px; color:#A8A29E; }

  /* ── Main column ── */
  .tn-main { flex:1; min-width:0; display:flex; flex-direction:column; }
  .tn-top { display:flex; align-items:center; justify-content:space-between; gap:16px; border-bottom:1px solid #EDEBE9; padding:12px 20px; }
  .tn-top-l { display:flex; align-items:center; gap:12px; min-width:0; }
  .tn-btn-outline { display:inline-flex; align-items:center; gap:6px; border-radius:999px; border:1px solid #E7E5E4; background:#fff; padding:6px 14px; font-size:13px; font-weight:500; color:#44403C; }
  .tn-btn-outline:hover { border-color:#D6D3D1; }
  .tn-btn-black { display:inline-flex; align-items:center; gap:6px; border-radius:999px; background:#1C1917; color:#fff; padding:6px 16px; font-size:13px; font-weight:500; }
  .tn-btn-black:hover { background:#000; }
  .tn-title-input { width:100%; max-width:280px; border:none; outline:none; background:transparent; border-radius:8px; padding:0 4px; font-size:15px; font-weight:600; letter-spacing:-0.01em; color:#1C1917; }
  .tn-title-input:hover { background:#FAFAF9; }
  .tn-title-input:focus { background:#F5F5F4; }
  .tn-meta { display:flex; align-items:center; gap:8px; padding:0 4px; font-size:11.5px; color:#78716C; }
  .tn-meta .sep { color:#D6D3D1; }
  .tn-meta-item { display:flex; align-items:center; gap:4px; }
  .tn-top-r { display:flex; align-items:center; gap:8px; }
  .tn-vsep { width:1px; height:20px; background:#E7E5E4; margin:0 4px; }
  .tn-chat-pill { display:inline-flex; align-items:center; gap:6px; border-radius:999px; border:1px solid #D1FADF; background:#F0FDF4; color:#067647; padding:6px 14px; font-size:13px; font-weight:500; }

  /* dropdown */
  .tn-menu { position:relative; }
  .tn-menu-btn { display:inline-flex; align-items:center; gap:6px; border-radius:999px; border:1px solid #E7E5E4; background:#fff; padding:6px 14px; font-size:13px; font-weight:500; color:#44403C; }
  .tn-menu-btn:hover { border-color:#D6D3D1; }
  .tn-menu-btn.open { background:#1C1917; border-color:#1C1917; color:#fff; }
  .tn-menu-pop { position:absolute; left:0; top:calc(100% + 6px); z-index:20; width:210px; border-radius:16px; border:1px solid #EDEBE9; background:#fff; padding:6px 0; box-shadow:0 8px 30px rgba(0,0,0,0.08); }
  .tn-menu-item { display:flex; align-items:center; gap:10px; width:100%; padding:8px 14px; font-size:13px; color:#44403C; text-align:left; }
  .tn-menu-item:hover { background:#FAFAF9; }
  .tn-menu-item svg { color:#78716C; flex-shrink:0; }
  .tn-menu-item .grow { flex:1; }
  .tn-menu-item .hint { font-size:10.5px; color:#A8A29E; }

  /* ── Toolbar ── */
  .tn-toolbar { display:flex; align-items:center; gap:2px; overflow-x:auto; border-bottom:1px solid #EDEBE9; background:#FCFCFB; padding:6px 16px; }
  .tn-tool { display:flex; align-items:center; justify-content:center; width:32px; height:32px; border-radius:8px; color:#57534E; flex-shrink:0; }
  .tn-tool:hover { background:#F5F5F4; color:#1C1917; }
  .tn-tool.on { background:#1C1917; color:#fff; }
  .tn-div { width:1px; height:20px; background:#E7E5E4; margin:0 4px; flex-shrink:0; }
  .tn-style-btn { display:flex; align-items:center; gap:6px; border-radius:8px; padding:6px 10px; font-size:13px; color:#44403C; flex-shrink:0; }
  .tn-style-btn:hover { background:#F5F5F4; }
  .tn-style-btn svg:first-child { color:#78716C; }
  .tn-style-btn svg:last-child { color:#A8A29E; }

  /* ── Editor ── */
  .tn-scroll { flex:1; min-height:0; overflow-y:auto; }
  .tn-page { max-width:760px; margin:0 auto; padding:48px 32px 96px; }
  .tn-editor { min-height:60vh; outline:none; font-size:16px; line-height:1.75; caret-color:#067647; }
  .tn-editor blockquote { border-left:2px solid #D6D3D1; margin:0; padding-left:16px; color:#57534E; }

  /* ── Status bar ── */
  .tn-status { display:flex; align-items:center; justify-content:space-between; border-top:1px solid #EDEBE9; background:#fff; padding:8px 20px; font-size:11.5px; color:#78716C; }
  .tn-status-g { display:flex; align-items:center; gap:12px; }
  .tn-status button { display:flex; align-items:center; gap:4px; color:#78716C; font-size:11.5px; }
  .tn-status button:hover { color:#1C1917; }
  .tn-count { border-radius:999px; background:#F5F5F4; padding:1px 6px; font-weight:500; color:#57534E; }
  .tn-publish { border:1px solid #E7E5E4; border-radius:999px; padding:4px 10px; font-weight:500; color:#44403C !important; }
  .tn-publish:hover { border-color:#D6D3D1; }

  /* ── Chat panel ── */
  .tn-chat { width:340px; flex-shrink:0; border-left:1px solid #EDEBE9; background:#fff; display:flex; flex-direction:column; }
  @media (max-width: 900px) { .tn-chat { display:none; } }
  .tn-chat-head { display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid #EDEBE9; padding:12px 16px; }
  .tn-chat-title { display:flex; align-items:center; gap:8px; font-size:13.5px; font-weight:600; }
  .tn-chat-title svg { color:#067647; }
  .tn-chat-body { flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:12px; font-size:13px; line-height:1.6; color:#44403C; }
  .tn-msg-user { margin-left:32px; border-radius:16px 16px 4px 16px; background:#1C1917; color:#fff; padding:10px 14px; }
  .tn-msg-ai { border-radius:16px 16px 16px 4px; border:1px solid #EDEBE9; background:#FAFAF9; padding:12px 14px; }
  .tn-msg-ai p { margin:0 0 8px; }
  .tn-msg-ai p:last-child { margin:0; color:#57534E; }
  .tn-chat-foot { border-top:1px solid #EDEBE9; padding:12px; }
  .tn-chat-input { display:flex; align-items:center; gap:8px; border-radius:16px; border:1px solid #E7E5E4; background:#fff; padding:8px 12px; }
  .tn-chat-input:focus-within { border-color:#A8A29E; }
  .tn-chat-input input { flex:1; min-width:0; border:none; outline:none; background:transparent; font-size:13px; color:#1C1917; }
  .tn-chat-input input::placeholder { color:#A8A29E; }
  .tn-plus { display:flex; align-items:center; justify-content:center; width:28px; height:28px; border-radius:999px; color:#57534E; flex-shrink:0; }
  .tn-plus:hover { background:#F5F5F4; }
  .tn-send { display:flex; align-items:center; justify-content:center; width:32px; height:32px; border-radius:999px; background:#1C1917; color:#fff; flex-shrink:0; transition:opacity 0.15s; }
  .tn-send:hover { background:#000; }
  .tn-send.idle { opacity:0.35; }
  .tn-chat-note { margin:8px 0 0; text-align:center; font-size:10.5px; color:#A8A29E; }
`;

const NAV = [
  { icon: SquarePen, label: "New chat" },
  { icon: Search, label: "Search chats" },
  { icon: ListTodo, label: "Tasks", badge: "5" },
  { icon: Activity, label: "Hive", live: true },
  { icon: FileText, label: "Docs", active: true },
  { icon: Wallet, label: "Wallet", unlocked: true },
  { icon: BookOpen, label: "Context" },
  { icon: MoreHorizontal, label: "More" },
];

const RECENTS = [
  "do you know my context",
  "is this working",
  "have an emergency. anothe…",
  "I am completing accepted t…",
  "are you ramped on the NAV…",
  "hello",
  "Should I add a fifth settings…",
];

function Sidebar() {
  return (
    <aside className="tn-side">
      <div className="tn-brand">
        <span className="tn-brand-l"><X size={18} strokeWidth={2.5} /> Task Node</span>
        <button className="tn-iconbtn"><PanelLeft size={16} /></button>
      </div>

      <nav className="tn-nav">
        {NAV.map(({ icon: Icon, label, badge, live, active, unlocked }) => (
          <button key={label} className={`tn-nav-item${active ? " active" : ""}`}>
            <span className="tn-nav-l"><Icon size={16} strokeWidth={1.9} /> {label}</span>
            {badge && <span className="tn-badge">{badge}</span>}
            {live && <span className="tn-live"><span className="tn-dot" /> live</span>}
            {unlocked && <span className="tn-pill-green"><Lock size={11} /> Unlocked</span>}
          </button>
        ))}
      </nav>

      <div className="tn-recents">
        <p className="tn-recents-title">Recents</p>
        <button className="tn-hive"><Users size={14} /> Hive Chat</button>
        {RECENTS.map((r) => <button key={r} className="tn-recent">{r}</button>)}
      </div>

      <div className="tn-side-foot">
        <div className="tn-wallet-row">
          <div>
            <p className="tn-wallet-amt" style={{ margin: 0 }}>
              <Wallet size={13} /> 1,495,797.72 <span className="tn-unit">PFT</span>
            </p>
            <p className="tn-sub">$20.94 <span>chat</span></p>
            <span className="tn-pill-green"><Lock size={11} /> Unlocked</span>
          </div>
          <ChevronRight size={15} color="#A8A29E" />
        </div>
        <div className="tn-user">
          <div className="tn-avatar" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="tn-user-name">@goodalexander</div>
            <div className="tn-user-handle">@goodalexander</div>
          </div>
          <Check size={15} color="#17B26A" />
        </div>
      </div>
    </aside>
  );
}

function Menu({ label, icon: Icon, items }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="tn-menu">
      <button
        className={`tn-menu-btn${open ? " open" : ""}`}
        onClick={() => setOpen(v => !v)}
        onBlur={() => setTimeout(() => setOpen(false), 130)}
      >
        <Icon size={13.5} /> {label} <ChevronDown size={12} style={{ opacity: 0.6 }} />
      </button>
      {open && (
        <div className="tn-menu-pop">
          {items.map(({ icon: I, label: l, hint }) => (
            <button key={l} className="tn-menu-item">
              <I size={14} /><span className="grow">{l}</span>
              {hint && <span className="hint">{hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ToolBtn({ icon: Icon, label, active, onClick }) {
  return (
    <button
      title={label}
      className={`tn-tool${active ? " on" : ""}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      <Icon size={15} strokeWidth={2} />
    </button>
  );
}

function ChatPanel({ onClose }) {
  const [msg, setMsg] = useState("");
  return (
    <aside className="tn-chat">
      <div className="tn-chat-head">
        <span className="tn-chat-title"><Sparkles size={14} /> Chat</span>
        <div style={{ display: "flex", gap: 4 }}>
          <button className="tn-iconbtn" title="History"><History size={15} /></button>
          <button className="tn-iconbtn" title="Collapse" onClick={onClose}><Minimize2 size={15} /></button>
        </div>
      </div>

      <div className="tn-chat-body">
        <div className="tn-msg-user">what do you think of this doc?</div>
        <div className="tn-msg-ai">
          <p>The document is a single assertion: <em>“The purpose in life is radical longevity.”</em> It’s provocative but underdeveloped as written.</p>
          <p>As a thesis it’s defensible — several thinkers argue extended healthy lifespan is a precondition for other purposes. As a statement it conflates a <em>means</em> with a <em>purpose</em>. As a document it needs expansion: arguments, counterarguments, and a definition of “radical.”</p>
          <p>Want me to suggest structure or arguments to add?</p>
        </div>
      </div>

      <div className="tn-chat-foot">
        <div className="tn-chat-input">
          <button className="tn-plus" title="Attach"><Plus size={16} /></button>
          <input
            value={msg}
            onChange={(e) => setMsg(e.target.value)}
            placeholder="Ask about this doc…"
          />
          <button className={`tn-send${msg ? "" : " idle"}`} title="Send"><ArrowUp size={16} strokeWidth={2.4} /></button>
        </div>
        <p className="tn-chat-note">Chat can read this document. Billing is usage-based.</p>
      </div>
    </aside>
  );
}

export default function TaskNodeDocs() {
  const [title, setTitle] = useState("alexdoco1");
  const [chatOpen, setChatOpen] = useState(true);
  const [words, setWords] = useState(7);
  const [fmt, setFmt] = useState({ bold: false, italic: false, underline: false, strike: false });
  const editorRef = useRef(null);

  const syncFmt = useCallback(() => {
    setFmt({
      bold: document.queryCommandState("bold"),
      italic: document.queryCommandState("italic"),
      underline: document.queryCommandState("underline"),
      strike: document.queryCommandState("strikeThrough"),
    });
    const text = editorRef.current?.innerText || "";
    setWords(text.trim() ? text.trim().split(/\s+/).length : 0);
  }, []);

  const exec = useCallback((cmd) => {
    document.execCommand(cmd, false, null);
    editorRef.current?.focus();
    syncFmt();
  }, [syncFmt]);

  return (
    <div className="tn">
      <style>{CSS}</style>
      <Sidebar />

      <main className="tn-main">
        {/* Top bar */}
        <header className="tn-top">
          <div className="tn-top-l">
            <button className="tn-btn-outline"><ArrowLeft size={13.5} /> Docs</button>
            <div style={{ minWidth: 0 }}>
              <input className="tn-title-input" value={title} onChange={(e) => setTitle(e.target.value)} />
              <div className="tn-meta">
                <span className="tn-meta-item"><span className="tn-dot" /> End-to-end encrypted</span>
                <span className="sep">·</span>
                <span className="tn-meta-item"><CircleCheck size={11} color="#17B26A" /> Saved</span>
              </div>
            </div>
          </div>

          <div className="tn-top-r">
            <Menu label="File" icon={FileText} items={[
              { icon: FileUp, label: "Import", hint: ".md, .docx" },
              { icon: Download, label: "Export" },
              { icon: Copy, label: "Duplicate" },
              { icon: History, label: "Version history", hint: "47" },
            ]} />
            <Menu label="Access" icon={Lock} items={[
              { icon: Eye, label: "View link" },
              { icon: SquarePen, label: "Edit link" },
              { icon: Users, label: "Manage people" },
            ]} />
            <button className="tn-btn-black"><Share2 size={13.5} /> Share</button>
            <div className="tn-vsep" />
            <button className="tn-iconbtn"><Bell size={16} /></button>
            {!chatOpen && (
              <button className="tn-chat-pill" onClick={() => setChatOpen(true)}>
                <Sparkles size={13.5} /> Chat
              </button>
            )}
          </div>
        </header>

        {/* Toolbar */}
        <div className="tn-toolbar">
          <ToolBtn icon={Undo2} label="Undo" onClick={() => exec("undo")} />
          <ToolBtn icon={Redo2} label="Redo" onClick={() => exec("redo")} />
          <div className="tn-div" />
          <button className="tn-style-btn">
            <Type size={14} /> Normal <ChevronDown size={11} />
          </button>
          <div className="tn-div" />
          <ToolBtn icon={Bold} label="Bold" active={fmt.bold} onClick={() => exec("bold")} />
          <ToolBtn icon={Italic} label="Italic" active={fmt.italic} onClick={() => exec("italic")} />
          <ToolBtn icon={Underline} label="Underline" active={fmt.underline} onClick={() => exec("underline")} />
          <ToolBtn icon={Strikethrough} label="Strikethrough" active={fmt.strike} onClick={() => exec("strikeThrough")} />
          <div className="tn-div" />
          <ToolBtn icon={List} label="Bulleted list" onClick={() => exec("insertUnorderedList")} />
          <ToolBtn icon={ListOrdered} label="Numbered list" onClick={() => exec("insertOrderedList")} />
          <ToolBtn icon={Quote} label="Quote" />
          <div className="tn-div" />
          <ToolBtn icon={AlignLeft} label="Align left" onClick={() => exec("justifyLeft")} />
          <ToolBtn icon={AlignCenter} label="Align center" onClick={() => exec("justifyCenter")} />
          <ToolBtn icon={AlignRight} label="Align right" onClick={() => exec("justifyRight")} />
          <div className="tn-div" />
          <ToolBtn icon={Link2} label="Insert link" />
          <ToolBtn icon={Table} label="Insert table" />
          <ToolBtn icon={Sigma} label="Insert equation" />
          <ToolBtn icon={Flag} label="Insert marker" />
          <ToolBtn icon={MessageSquare} label="Comment" />
        </div>

        {/* Editor */}
        <div className="tn-scroll">
          <div className="tn-page">
            <div
              ref={editorRef}
              className="tn-editor"
              contentEditable
              suppressContentEditableWarning
              onKeyUp={syncFmt}
              onMouseUp={syncFmt}
              onInput={syncFmt}
            >
              The purpose in life is radical longevity
            </div>
          </div>
        </div>

        {/* Status bar */}
        <footer className="tn-status">
          <div className="tn-status-g">
            <span>{words} {words === 1 ? "word" : "words"}</span>
            <span style={{ color: "#E7E5E4" }}>|</span>
            <button><History size={11.5} /> Versions <span className="tn-count">47</span></button>
          </div>
          <div className="tn-status-g">
            <span className="tn-meta-item"><span className="tn-dot" /> Network live</span>
            <button className="tn-publish">Publish to PFT</button>
          </div>
        </footer>
      </main>

      {chatOpen && <ChatPanel onClose={() => setChatOpen(false)} />}
    </div>
  );
}