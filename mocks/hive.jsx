import React, { useState, useEffect } from 'react';
import {
  X, PenSquare, Search, ListTodo, Wallet, BookOpen, MoreHorizontal,
  Activity, Clock, Check, Lock, AlertCircle, PanelLeft,
  ArrowLeft, ChevronRight
} from 'lucide-react';

/* ============================================================
   TOKENS
   ============================================================ */
const cream        = '#F4EFE3';
const creamDark    = '#EBE5D5';
const surface      = '#FFFFFF';
const ink          = '#1A1A1A';
const inkSoft      = '#3A3A38';
const muted        = '#75736B';
const muted2       = '#B5B3A8';
const green        = '#5B8A55';
const greenInk     = '#2D5A2A';
const greenSoft    = '#E8F0E2';
const amber        = '#A8761A';
const amberInk     = '#7A5511';
const amberSoft    = '#F5EBD3';
const tagBg        = '#EFE9DA';
const border       = 'rgba(0,0,0,0.07)';
const borderStrong = 'rgba(0,0,0,0.13)';

const fontStack    = 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
const monoStack    = 'ui-monospace, SFMono-Regular, Menlo, monospace';

/* ============================================================
   DIRECTORY — operators, codenames, badges
   ============================================================ */
const operators = {
  '0x71f...4ab2': { codename: 'Sentinel', archetype: 'Builder · verification',       badge: 0, allotted: true,  cap: 12, load: 11, status: 'active' },
  '0xc9e...d801': { codename: 'Cipher',   archetype: 'Researcher · market structure', badge: 1, allotted: true,  cap: 10, load:  7, status: 'active' },
  '0x42a...91fc': { codename: 'Beacon',   archetype: 'Designer · onboarding',         badge: 2, allotted: false, cap:  6, load:  3, status: 'active' },
  '0xb35...027e': { codename: 'Helix',    archetype: 'Builder · liquidity',           badge: 3, allotted: true,  cap: 10, load:  9, status: 'active' },
  '0xf80...22bb': { codename: 'Quartz',   archetype: 'Community · ops',               badge: 4, allotted: true,  cap:  8, load:  4, status: 'quiet'  },
  '0x10c...8a44': { codename: 'Glyph',    archetype: 'Writer · whitepaper',           badge: 5, allotted: true,  cap:  8, load:  6, status: 'active' },
  '0xa12...77df': { codename: 'Anchor',   archetype: 'Builder · protocol',            badge: 6, allotted: false, cap:  6, load:  5, status: 'active' },
  '0x9f3...18ee': { codename: 'Drift',    archetype: 'Researcher · alpha',            badge: 7, allotted: false, cap:  5, load:  2, status: 'quiet'  },
};
const op = (w) => operators[w] || { codename: '—', archetype: '', badge: 0 };

/* ============================================================
   PROJECTS
   ============================================================ */
const projects = {
  pft_v3: {
    name: 'PFT distribution v3',
    type: 'Protocol development',
    summary: 'Reward routing infrastructure rebuild. Adds parallel epoch settlement and verified reward distribution.',
    about: 'Rebuild of the reward routing infrastructure underlying every task payout. Adds parallel epoch settlement, multi-tenant task race resolution, and a verified attestation path for reward distribution edge cases. Currently in phase 3 of 5, focused on edge case audits and operator-facing flows.',
    proposed: 'Feb 14, 2026',
    phase: '3 of 5',
    pft: 420,
    contributors: [
      { wallet: '0x71f...4ab2', tasks: 4, pft: 86, lastActive: '6m ago', role: 'lead' },
      { wallet: '0xb35...027e', tasks: 3, pft: 64, lastActive: '22m ago' },
      { wallet: '0xa12...77df', tasks: 3, pft: 72, lastActive: '3h ago' },
      { wallet: '0xc9e...d801', tasks: 2, pft: 48, lastActive: '1h ago' },
      { wallet: '0x10c...8a44', tasks: 1, pft: 22, lastActive: '1h ago' },
      { wallet: '0x9f3...18ee', tasks: 1, pft: 28, lastActive: '8h ago' },
    ],
    tasks: [
      { title: 'Audit reward distribution edge case in epoch transitions', state: 'proposed',                assignee: '0x71f...4ab2', pft: 4.5, age: 'awaiting accept' },
      { title: 'Parallel settlement implementation',                       state: 'accepted',                assignee: '0xb35...027e', pft: 5.2, age: 'day 3' },
      { title: 'Multi-tenant task UI flows',                                state: 'submitted',               assignee: '0xc9e...d801', pft: 3.5, age: 'day 1' },
      { title: 'Verified reward attestation',                               state: 'verification_requested',  assignee: '0xa12...77df', pft: 6.0, age: 'response needed' },
      { title: 'Operator notification protocol',                            state: 'verification_response',   assignee: '0x10c...8a44', pft: 2.5, age: 'awaiting decision' },
      { title: 'Epoch-3 incident retrospective writeup',                    state: 'paid',                    assignee: '0x71f...4ab2', pft: 3.0, age: '2d ago' },
      { title: 'Race condition reproduction harness',                       state: 'paid',                    assignee: '0xa12...77df', pft: 4.0, age: '4d ago' },
      { title: 'Settlement latency benchmarks',                             state: 'paid',                    assignee: '0xb35...027e', pft: 2.8, age: '5d ago' },
    ],
    activity: [
      { wallet: '0x71f...4ab2', action: 'accepted',  task: 'Audit reward distribution edge case', time: '2m ago' },
      { wallet: '0xb35...027e', action: 'submitted', task: 'Parallel settlement implementation',  time: '14m ago' },
      { wallet: '0xc9e...d801', action: 'paid',      task: 'Multi-tenant task UI flows · v1',     time: '1h ago', pft: 1.5 },
      { wallet: '0xa12...77df', action: 'v_response', task: 'Race condition reproduction harness', time: '3h ago' },
    ],
  },
  liquidity_v2: {
    name: 'Cross-chain liquidity index',
    type: 'Protocol development',
    summary: 'Aggregating depth across 7 venues. Phase 2 of 4.',
    pft: 310, tasks: [], contributors: [],
  },
  onboarding: {
    name: 'Operator onboarding redesign',
    type: 'UX',
    summary: 'Reworking the first 24 hours after a node joins.',
    pft: 45, tasks: [], contributors: [],
  },
  conf_q3: {
    name: 'Conference circuit Q3',
    type: 'Conference work',
    summary: 'EthCC, Solana Breakpoint, Token2049 presence.',
    pft: 180, tasks: [], contributors: [],
  },
  whitepaper_v2: {
    name: 'Whitepaper v2 research',
    type: 'Whitepaper research',
    summary: 'Empirical addendum and game theory section.',
    pft: 260, tasks: [], contributors: [],
  },
  alpha_weekly: {
    name: 'Alpha digest weekly',
    type: 'Alpha',
    summary: 'Recurring. Market structure observations.',
    pft: 90, tasks: [], contributors: [],
  },
};
const projectPreviewContributors = {
  pft_v3:        ['0x71f...4ab2', '0xb35...027e', '0xa12...77df', '0xc9e...d801', '0x10c...8a44', '0x9f3...18ee'],
  liquidity_v2:  ['0xb35...027e', '0xc9e...d801', '0xa12...77df', '0xf80...22bb', '0x9f3...18ee'],
  onboarding:    ['0x42a...91fc', '0xf80...22bb'],
  conf_q3:       ['0xf80...22bb', '0x10c...8a44', '0xc9e...d801'],
  whitepaper_v2: ['0x10c...8a44', '0x9f3...18ee', '0xc9e...d801', '0xa12...77df'],
  alpha_weekly:  ['0xc9e...d801', '0x9f3...18ee'],
};
const projectTaskCount = { pft_v3: 14, liquidity_v2: 9, onboarding: 3, conf_q3: 6, whitepaper_v2: 7, alpha_weekly: 4 };

/* ============================================================
   UTILITIES
   ============================================================ */
function formatTime(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m.toString().padStart(2,'0')}m`;
  if (m > 0) return `${m}m ${sec.toString().padStart(2,'0')}s`;
  return `${sec}s`;
}

/* ============================================================
   NFT BADGE — small generative-feeling avatars
   ============================================================ */
function NFTBadge({ variant = 0, size = 28 }) {
  const palettes = [
    { bg: '#1A1A1A', fg: '#E24B4A' },
    { bg: '#0C447C', fg: '#85B7EB' },
    { bg: '#0F6E56', fg: '#9FE1CB' },
    { bg: '#1A1A1A', fg: '#EF9F27' },
    { bg: '#3C3489', fg: '#CECBF6' },
    { bg: '#1A1A1A', fg: '#5DCAA5' },
    { bg: '#72243E', fg: '#F4C0D1' },
    { bg: '#1A1A1A', fg: '#D85A30' },
  ];
  const p = palettes[variant % 8];
  const v = variant % 8;
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" style={{ borderRadius: 4, display: 'block', flexShrink: 0 }}>
      <rect width="28" height="28" fill={p.bg}/>
      {v === 0 && (
        <g fill={p.fg} stroke={p.fg}>
          <rect x="4.5" y="4.5" width="19" height="19" fill="none" strokeWidth="0.6"/>
          <circle cx="14" cy="14" r="3" stroke="none"/>
        </g>
      )}
      {v === 1 && (
        <g fill={p.fg}>
          <rect x="6" y="6"  width="6" height="6"/>
          <rect x="16" y="6" width="6" height="6"/>
          <rect x="6" y="16" width="6" height="6"/>
          <rect x="16" y="16" width="6" height="6"/>
        </g>
      )}
      {v === 2 && (
        <path d="M 4 14 L 14 4 L 24 14 L 14 24 Z" fill={p.fg}/>
      )}
      {v === 3 && (
        <g stroke={p.fg} strokeWidth="0.8" fill="none">
          <path d="M 4 4 L 24 24"/>
          <path d="M 24 4 L 4 24"/>
          <circle cx="14" cy="14" r="4" fill={p.fg}/>
        </g>
      )}
      {v === 4 && (
        <g>
          <circle cx="14" cy="14" r="8" fill="none" stroke={p.fg} strokeWidth="0.8"/>
          <circle cx="14" cy="14" r="3" fill={p.fg}/>
        </g>
      )}
      {v === 5 && (
        <g fill={p.fg}>
          {[5, 10, 15, 20].map(y => [5, 10, 15, 20].map(x =>
            <circle key={`${x}-${y}`} cx={x} cy={y} r="1"/>
          ))}
        </g>
      )}
      {v === 6 && (
        <g>
          <rect x="4" y="4"  width="20" height="20" fill="none" stroke={p.fg} strokeWidth="0.6"/>
          <rect x="9" y="9"  width="10" height="10" fill="none" stroke={p.fg} strokeWidth="0.6"/>
          <rect x="12" y="12" width="4"  height="4"  fill={p.fg}/>
        </g>
      )}
      {v === 7 && (
        <g>
          <path d="M 4 23 L 14 5 L 24 23 Z" fill="none" stroke={p.fg} strokeWidth="0.8"/>
          <circle cx="14" cy="17" r="2.5" fill={p.fg}/>
        </g>
      )}
    </svg>
  );
}

/* ============================================================
   ROOT
   ============================================================ */
export default function TaskNodeMock() {
  const [view, setView] = useState('tasks');
  const [taskTab, setTaskTab] = useState('outstanding');
  const [secondsLeft, setSecondsLeft] = useState(6420);
  const [incomingState, setIncomingState] = useState('pending');
  const [selectedProject, setSelectedProject] = useState(null);

  useEffect(() => {
    const t = setInterval(() => setSecondsLeft(s => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, []);

  const urgent = secondsLeft < 1800 && incomingState === 'pending';

  const goToProject = (id) => { setView('hive'); setSelectedProject(id); };

  return (
    <div style={{ background: cream, color: ink, fontFamily: fontStack, minHeight: '100vh', display: 'flex' }}>
      <Sidebar view={view} setView={(v) => { setView(v); if (v !== 'hive') setSelectedProject(null); }} />
      <main style={{ flex: 1, padding: '28px 56px 96px', maxWidth: 1180, margin: '0 auto', width: '100%' }}>
        {view === 'tasks' && (
          <TasksView
            taskTab={taskTab} setTaskTab={setTaskTab}
            secondsLeft={secondsLeft} urgent={urgent}
            incomingState={incomingState} setIncomingState={setIncomingState}
            goToProject={goToProject}
          />
        )}
        {view === 'hive' && !selectedProject && (
          <HiveView onSelectProject={setSelectedProject} />
        )}
        {view === 'hive' && selectedProject && (
          <ProjectDetail projectId={selectedProject} onBack={() => setSelectedProject(null)} />
        )}
      </main>
    </div>
  );
}

/* ============================================================
   SIDEBAR
   ============================================================ */
function Sidebar({ view, setView }) {
  return (
    <aside style={{
      width: 248, padding: '20px 14px', borderRight: `0.5px solid ${border}`,
      display: 'flex', flexDirection: 'column', minHeight: '100vh', flexShrink: 0
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 8px', marginBottom: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontWeight: 500, fontSize: 15.5 }}>
          <X size={17} strokeWidth={2.4}/>
          Task Node
        </div>
        <PanelLeft size={15} color={muted2} />
      </div>
      <NavItem icon={<PenSquare size={15}/>} label="New chat" />
      <NavItem icon={<Search size={15}/>} label="Search chats" />
      <NavItem icon={<ListTodo size={15}/>} label="Tasks" badge="4" active={view === 'tasks'} onClick={() => setView('tasks')} />
      <NavItem icon={<Activity size={15}/>} label="Hive" badgeLive="live" active={view === 'hive'} onClick={() => setView('hive')} />
      <NavItem icon={<Wallet size={15}/>} label="Wallet" tag="Locked" />
      <NavItem icon={<BookOpen size={15}/>} label="Context" />
      <NavItem icon={<MoreHorizontal size={15}/>} label="More" />

      <div style={{ marginTop: 28, padding: '0 8px' }}>
        <div style={{ fontSize: 11, fontWeight: 500, color: muted, marginBottom: 10 }}>Recents</div>
        {['top 5 things to focus on', 'I want some advice about ...', 'okay I want to iterate on my...'].map(t => (
          <div key={t} style={{ fontSize: 13, color: ink, padding: '5px 0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t}</div>
        ))}
      </div>

      <div style={{ marginTop: 'auto', borderTop: `0.5px solid ${border}`, paddingTop: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, padding: '3px 8px' }}>
          <Wallet size={13} color={muted}/>
          <span style={{ fontWeight: 500 }}>645.45</span>
          <span style={{ color: muted }}>PFT</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, padding: '3px 8px' }}>
          <span style={{ width: 13, display: 'inline-flex', justifyContent: 'center', color: muted, fontSize: 12 }}>$</span>
          <span style={{ fontWeight: 500 }}>$19.03</span>
          <span style={{ color: muted }}>chat</span>
        </div>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: amber, background: amberSoft, padding: '2px 8px', borderRadius: 999, margin: '8px 8px 12px' }}>
          <Lock size={10}/> Locked
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px' }}>
          <div style={{ width: 26, height: 26, borderRadius: '50%', background: '#3FBA80', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 600 }}>G</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 500 }}>goodalexander</div>
            <div style={{ fontSize: 10.5, color: muted }}>Signed in with GitHub</div>
          </div>
          <Check size={13} color={green}/>
        </div>
      </div>
    </aside>
  );
}

function NavItem({ icon, label, badge, badgeLive, tag, active, onClick }) {
  return (
    <div onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '7px 8px', fontSize: 13.5,
      cursor: onClick ? 'pointer' : 'default', borderRadius: 6,
      background: active ? creamDark : 'transparent',
      fontWeight: active ? 500 : 400, color: ink, marginBottom: 1
    }}>
      <span style={{ color: active ? ink : muted, display: 'flex' }}>{icon}</span>
      <span style={{ flex: 1 }}>{label}</span>
      {badge && <span style={{ background: ink, color: 'white', borderRadius: 999, fontSize: 10.5, padding: '1px 7px', fontWeight: 500 }}>{badge}</span>}
      {badgeLive && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: green, fontSize: 10.5, fontWeight: 500 }}>
          <span style={{ width: 5, height: 5, background: green, borderRadius: '50%' }}/> {badgeLive}
        </span>
      )}
      {tag && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: amber, background: amberSoft, padding: '1px 7px', fontSize: 10.5, borderRadius: 999, fontWeight: 500 }}>
          <Lock size={9}/> {tag}
        </span>
      )}
    </div>
  );
}

/* ============================================================
   TASKS VIEW
   ============================================================ */
function TasksView({ taskTab, setTaskTab, secondsLeft, urgent, incomingState, setIncomingState, goToProject }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 22, gap: 24 }}>
        <div>
          <h1 style={{ fontSize: 34, fontWeight: 500, margin: 0, letterSpacing: '-0.02em' }}>Tasks</h1>
          <div style={{ marginTop: 10, fontSize: 13, color: muted, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span><span style={{ color: ink, fontWeight: 500 }}>1</span> proposed</span>
            <span>·</span>
            <span><span style={{ color: ink, fontWeight: 500 }}>3</span> outstanding</span>
            <span>·</span>
            <span style={{ color: green, fontWeight: 500 }}>8.5 PFT in flight</span>
            <span>·</span>
            <span>20 chain indexed</span>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 11.5, color: muted }}>
          <span>Routing health</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: greenInk, background: greenSoft, padding: '4px 10px', borderRadius: 999, fontSize: 11.5, fontWeight: 500 }}>
            <span style={{ width: 5, height: 5, background: green, borderRadius: '50%' }}/> good standing
          </span>
        </div>
      </div>

      <IncomingSection
        secondsLeft={secondsLeft} urgent={urgent}
        state={incomingState} setState={setIncomingState}
        goToProject={goToProject}
      />

      <div style={{ display: 'flex', gap: 28, borderBottom: `0.5px solid ${border}`, marginBottom: 18, marginTop: 44 }}>
        {[
          ['outstanding', 'Outstanding', 3],
          ['verification', 'Verification', 0],
          ['refused', 'Refused', 2],
          ['rewarded', 'Rewarded', 15]
        ].map(([key, label, count]) => {
          const isActive = taskTab === key;
          return (
            <button key={key} onClick={() => setTaskTab(key)} style={{
              background: 'none', border: 'none', cursor: 'pointer',
              padding: '12px 0', fontSize: 14, color: isActive ? ink : muted,
              borderBottom: isActive ? `2px solid ${ink}` : '2px solid transparent',
              fontWeight: isActive ? 500 : 400,
              display: 'inline-flex', alignItems: 'center', gap: 8, marginBottom: -1, fontFamily: 'inherit'
            }}>
              {label}
              <span style={{
                background: isActive ? ink : 'transparent',
                color: isActive ? 'white' : muted,
                border: isActive ? 'none' : `0.5px solid ${border}`,
                borderRadius: 999, padding: '1px 7px', fontSize: 10.5, fontWeight: 500, minWidth: 18, textAlign: 'center'
              }}>{count}</span>
            </button>
          );
        })}
      </div>

      {taskTab === 'outstanding' && <OutstandingList />}
      {taskTab === 'verification' && <EmptyState label="Nothing in verification."/>}
      {taskTab === 'refused' && <EmptyState label="2 refused tasks (hidden in mock)."/>}
      {taskTab === 'rewarded' && <EmptyState label="15 rewarded tasks (hidden in mock)."/>}
    </div>
  );
}

function IncomingSection({ secondsLeft, urgent, state, setState, goToProject }) {
  if (state === 'accepted') {
    return <ResultBanner tone="success" title="Accepted. Task moved to Outstanding."
      body="The network has been notified. Begin when ready." onReset={() => setState('pending')} />;
  }
  if (state === 'skipped') {
    return <ResultBanner tone="warn" title="Refused. Task re-proposed to next eligible operator."
      body="Counts toward your trailing reject rate, which influences future routing weight." onReset={() => setState('pending')} />;
  }

  return (
    <div style={{ marginTop: 28 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, padding: '0 4px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, fontWeight: 500, letterSpacing: '0.1em', color: muted, textTransform: 'uppercase' }}>
          <span style={{ width: 6, height: 6, background: green, borderRadius: '50%' }}/>
          Proposed · 1 awaiting accept
        </div>
        <div style={{ fontSize: 11.5, color: muted }}>The hive routed this to you.</div>
      </div>

      <div style={{
        background: surface,
        border: `0.5px solid ${urgent ? 'rgba(168,118,26,0.4)' : borderStrong}`,
        borderLeft: `3px solid ${urgent ? amber : ink}`,
        borderRadius: 10, padding: '22px 26px'
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 24 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11, fontWeight: 500, color: inkSoft, background: tagBg, padding: '3px 10px', borderRadius: 999 }}>Protocol development</span>
              <span style={{ fontSize: 11, color: muted }}>·</span>
              <button onClick={() => goToProject('pft_v3')} style={{
                background: 'transparent', border: 'none', cursor: 'pointer',
                fontSize: 11.5, color: ink, padding: 0, fontFamily: 'inherit',
                borderBottom: `1px dashed ${muted2}`, lineHeight: 1.4
              }}>PFT distribution v3</button>
            </div>

            <h2 style={{ fontSize: 20, fontWeight: 500, margin: 0, lineHeight: 1.3, letterSpacing: '-0.01em' }}>
              Audit reward distribution edge case in epoch transitions
            </h2>

            <p style={{ fontSize: 13.5, color: inkSoft, lineHeight: 1.55, marginTop: 10, marginBottom: 0 }}>
              The epoch transition logic has an unverified path when network task throughput exceeds 3x baseline. Reproduce the edge case in test harness, document expected behavior, recommend fix.
            </p>
          </div>

          <div style={{ textAlign: 'right', flexShrink: 0 }}>
            <div style={{ fontSize: 30, fontWeight: 500, letterSpacing: '-0.02em', lineHeight: 1 }}>4.5</div>
            <div style={{ fontSize: 10.5, color: muted, marginTop: 4, letterSpacing: '0.05em' }}>PFT</div>
          </div>
        </div>

        <div style={{ marginTop: 20, paddingTop: 18, borderTop: `0.5px solid ${border}`, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 28 }}>
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 500, letterSpacing: '0.1em', color: muted, textTransform: 'uppercase', marginBottom: 6 }}>Why you</div>
            <div style={{ fontSize: 12.5, color: inkSoft, lineHeight: 1.55 }}>
              Last 30 days: 3 audit tasks rewarded · Builder archetype with verification rigor · Active during epoch-3 incident response.
            </div>
            <div style={{ fontSize: 11, color: muted, marginTop: 8 }}>
              Routing confidence <span style={{ color: ink, fontWeight: 500 }}>92%</span> · single operator
            </div>
          </div>
          <div>
            <div style={{ fontSize: 10.5, fontWeight: 500, letterSpacing: '0.1em', color: muted, textTransform: 'uppercase', marginBottom: 6 }}>If declined</div>
            <div style={{ fontSize: 12.5, color: inkSoft, lineHeight: 1.55 }}>
              Reroutes to next-best fit. Counts toward your trailing reject rate, which influences future routing.
            </div>
            <div style={{ fontSize: 11, color: muted, marginTop: 8 }}>
              Trailing 30d: <span style={{ color: ink, fontWeight: 500 }}>1 / 22</span> declined
            </div>
          </div>
        </div>

        <div style={{ marginTop: 22, paddingTop: 16, borderTop: `0.5px solid ${border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, color: urgent ? amber : ink }}>
            <Clock size={14}/>
            <span style={{ fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>{formatTime(secondsLeft)}</span>
            <span style={{ color: muted, fontWeight: 400 }}>to accept</span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setState('skipped')} style={{
              background: 'transparent', border: `0.5px solid ${borderStrong}`, color: ink,
              padding: '9px 18px', borderRadius: 8, fontSize: 13.5, cursor: 'pointer', fontWeight: 400, fontFamily: 'inherit'
            }}>Refuse</button>
            <button onClick={() => setState('accepted')} style={{
              background: ink, color: 'white', border: 'none',
              padding: '9px 22px', borderRadius: 8, fontSize: 13.5, cursor: 'pointer', fontWeight: 500, fontFamily: 'inherit'
            }}>Accept</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ResultBanner({ tone, title, body, onReset }) {
  const isSuccess = tone === 'success';
  const bg = isSuccess ? greenSoft : amberSoft;
  const fg = isSuccess ? greenInk : amberInk;
  const Icon = isSuccess ? Check : AlertCircle;
  return (
    <div style={{ marginTop: 28, padding: '20px 24px', background: bg, borderRadius: 10, color: fg }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontWeight: 500, fontSize: 14 }}>
        <Icon size={16}/> {title}
      </div>
      <div style={{ fontSize: 13, marginTop: 4, opacity: 0.85 }}>{body}</div>
      <button onClick={onReset} style={{ marginTop: 14, fontSize: 12, color: fg, background: 'transparent', border: 'none', textDecoration: 'underline', cursor: 'pointer', padding: 0, fontFamily: 'inherit' }}>Reset mock</button>
    </div>
  );
}

function OutstandingList() {
  const tasks = [
    { state: 'accepted',  title: 'Implement wallet unlock gate for task requests',          cat: 'Engineering', date: 'May 20', ago: '29h ago', pft: 3.2 },
    { state: 'submitted', title: 'Redesign core task node modal flows',                     cat: 'Personal',    date: 'May 20', ago: '29h ago', pft: 2.5 },
    { state: 'accepted',  title: 'Prototype Steve Jobs style chat intervention loop',       cat: 'Personal',    date: 'May 21', ago: '29h ago', pft: 2.8 },
  ];
  const stateColor = { accepted: green, submitted: green };
  const stateLabel = { accepted: 'accepted', submitted: 'submitted' };
  return (
    <div style={{ background: surface, border: `0.5px solid ${border}`, borderRadius: 10 }}>
      {tasks.map((t, i) => (
        <div key={i} style={{ padding: '20px 24px', borderBottom: i < tasks.length - 1 ? `0.5px solid ${border}` : 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, flex: 1, minWidth: 0 }}>
            <span style={{ width: 8, height: 8, background: '#3D5C38', borderRadius: '50%', marginTop: 7, flexShrink: 0 }}/>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 16, fontWeight: 500, color: ink, marginBottom: 5 }}>{t.title}</div>
              <div style={{ fontSize: 12, color: muted, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span>{t.cat}</span><span>·</span>
                <span style={{ color: stateColor[t.state] }}>{stateLabel[t.state]}</span><span>·</span>
                <span>{t.date}</span><span>·</span>
                <span>{t.ago}</span>
              </div>
            </div>
          </div>
          <div style={{ textAlign: 'right', flexShrink: 0 }}>
            <div style={{ fontSize: 22, fontWeight: 500, letterSpacing: '-0.01em' }}>{t.pft}</div>
            <div style={{ fontSize: 10, color: muted, letterSpacing: '0.06em' }}>PFT</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ label }) {
  return <div style={{ padding: '70px 0', textAlign: 'center', fontSize: 13.5, color: muted }}>{label}</div>;
}

/* ============================================================
   HIVE VIEW
   ============================================================ */
function HiveView({ onSelectProject }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 36, gap: 24, flexWrap: 'wrap' }}>
        <div>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: green, marginBottom: 10, letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 500 }}>
            <span style={{ width: 6, height: 6, background: green, borderRadius: '50%' }}/>
            Live
          </div>
          <h1 style={{ fontSize: 34, fontWeight: 500, margin: 0, letterSpacing: '-0.02em' }}>Hive</h1>
          <p style={{ fontSize: 13.5, color: muted, marginTop: 8, maxWidth: 480, lineHeight: 1.55 }}>
            Aggregate view of what the network is doing. The hive routes work to nodes; this is its memory in motion.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 32 }}>
          <Stat label="Operators online" value="47" />
          <Stat label="Tasks in flight" value="124" />
          <Stat label="PFT routed · 24h" value="1.8k" accent />
        </div>
      </div>

      <Section title="Active projects" subtitle="What the hive is routing operators to">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
          {Object.entries(projects).map(([id, p]) => (
            <ProjectCard key={id} id={id} project={p} onClick={() => onSelectProject(id)} />
          ))}
        </div>
      </Section>

      <Section title="Routing feed" subtitle="Recent state transitions across the network">
        <div style={{ background: surface, border: `0.5px solid ${border}`, borderRadius: 10, overflow: 'hidden' }}>
          <FeedRow wallet="0x71f...4ab2" action="accepted"     task="Audit reward distribution edge case"   project="PFT distribution v3"        time="2m ago" />
          <FeedRow wallet="0xc9e...d801" action="paid"         task="Draft EthCC sponsor outreach"          project="Conference circuit Q3"      time="6m ago"  pft={2.0} />
          <FeedRow wallet="0x42a...91fc" action="proposed"     task="Profile messaging audit"               project="Operator onboarding"        time="14m ago" routing="3 eligible" />
          <FeedRow wallet="0xb35...027e" action="submitted"    task="Liquidity venue integration tests"     project="Cross-chain liquidity"      time="22m ago" />
          <FeedRow wallet="0x71f...4ab2" action="paid"         task="Modal flow review"                     project="UX hardening"               time="38m ago" pft={1.8} />
          <FeedRow wallet="0xf80...22bb" action="refused"      task="Discord moderation rota"               project="Community"                  time="52m ago" />
          <FeedRow wallet="0x10c...8a44" action="v_requested"  task="Whitepaper section 4 research"         project="Whitepaper v2 research"     time="1h ago"  last />
        </div>
      </Section>

      <Section title="Allotted operators" subtitle="Full-time nodes the hive routes to first">
        <div style={{ background: surface, border: `0.5px solid ${border}`, borderRadius: 10 }}>
          {Object.entries(operators).filter(([, o]) => o.allotted).map(([w], i, arr) => (
            <AllottedOpRow key={w} wallet={w} last={i === arr.length - 1} />
          ))}
        </div>
      </Section>
    </div>
  );
}

function Stat({ label, value, accent }) {
  return (
    <div style={{ minWidth: 92, textAlign: 'right' }}>
      <div style={{ fontSize: 11, color: muted, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 500, letterSpacing: '-0.02em', color: accent ? green : ink, lineHeight: 1 }}>{value}</div>
    </div>
  );
}

function Section({ title, subtitle, children, layerNumber }) {
  return (
    <div style={{ marginBottom: 44 }}>
      <div style={{ marginBottom: 14, display: 'flex', alignItems: 'baseline', gap: 12 }}>
        {layerNumber && (
          <span style={{ fontFamily: monoStack, fontSize: 11, color: muted2, fontWeight: 500 }}>{layerNumber}</span>
        )}
        <div>
          <div style={{ fontSize: 11, fontWeight: 500, letterSpacing: '0.1em', color: muted, textTransform: 'uppercase', marginBottom: 4 }}>{title}</div>
          {subtitle && <div style={{ fontSize: 12.5, color: muted }}>{subtitle}</div>}
        </div>
      </div>
      {children}
    </div>
  );
}

function ProjectCard({ id, project, onClick }) {
  const previewWallets = (projectPreviewContributors[id] || []).slice(0, 4);
  const totalContributors = (projectPreviewContributors[id] || []).length;
  const taskCount = projectTaskCount[id] || 0;

  return (
    <div onClick={onClick} style={{
      background: surface, border: `0.5px solid ${border}`, borderRadius: 10,
      padding: '16px 20px', cursor: 'pointer', transition: 'border-color 0.15s',
      display: 'flex', flexDirection: 'column'
    }}
    onMouseEnter={(e) => e.currentTarget.style.borderColor = borderStrong}
    onMouseLeave={(e) => e.currentTarget.style.borderColor = border}
    >
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 15, fontWeight: 500, color: ink, lineHeight: 1.3 }}>{project.name}</div>
        <div style={{ fontSize: 10.5, color: muted, marginTop: 4, letterSpacing: '0.04em', textTransform: 'uppercase' }}>{project.type}</div>
      </div>
      <div style={{ fontSize: 12.5, color: muted, lineHeight: 1.5, marginBottom: 14, minHeight: 36 }}>{project.summary}</div>

      {/* contributor preview stack */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <div style={{ display: 'flex' }}>
          {previewWallets.map((w, i) => (
            <div key={w} style={{ marginLeft: i === 0 ? 0 : -8, border: `1.5px solid ${surface}`, borderRadius: 5, display: 'flex' }}>
              <NFTBadge variant={op(w).badge} size={22} />
            </div>
          ))}
        </div>
        <span style={{ fontSize: 11.5, color: muted }}>
          {totalContributors} {totalContributors === 1 ? 'contributor' : 'contributors'}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 18, fontSize: 11.5, color: muted, paddingTop: 12, borderTop: `0.5px solid ${border}`, marginTop: 'auto' }}>
        <span><span style={{ color: ink, fontWeight: 500 }}>{taskCount}</span> tasks</span>
        <span style={{ marginLeft: 'auto', color: green, fontWeight: 500 }}>{project.pft} PFT</span>
        <ChevronRight size={13} color={muted2}/>
      </div>
    </div>
  );
}

function FeedRow({ wallet, action, task, project, time, pft, routing, last }) {
  const colors = {
    proposed:    amber,
    accepted:    green,
    submitted:   green,
    v_requested: amber,
    v_response:  green,
    paid:        green,
    refused:     muted,
  };
  const labels = {
    proposed:    'proposed',
    accepted:    'accepted',
    submitted:   'submitted',
    v_requested: 'v. requested',
    v_response:  'v. response',
    paid:        'paid',
    refused:     'refused',
  };
  const o = op(wallet);
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '11px 16px',
      borderBottom: last ? 'none' : `0.5px solid ${border}`,
      fontSize: 13
    }}>
      <NFTBadge variant={o.badge} size={24} />
      <div style={{ width: 138, flexShrink: 0 }}>
        <div style={{ fontSize: 12.5, color: ink, fontWeight: 500, lineHeight: 1.2 }}>{o.codename}</div>
        <div style={{ fontFamily: monoStack, fontSize: 10.5, color: muted, lineHeight: 1.3, marginTop: 1 }}>{wallet}</div>
      </div>
      <span style={{ fontSize: 11.5, color: colors[action] || ink, width: 86, fontWeight: 500, flexShrink: 0 }}>{labels[action] || action}</span>
      <span style={{ flex: 1, minWidth: 0, color: ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {task}
        <span style={{ color: muted, fontSize: 11.5, marginLeft: 8 }}>· {project}</span>
        {routing && <span style={{ color: amber, fontSize: 10.5, marginLeft: 8, background: amberSoft, padding: '2px 7px', borderRadius: 999, fontWeight: 500 }}>{routing}</span>}
      </span>
      {pft && <span style={{ color: green, fontWeight: 500, fontSize: 12, flexShrink: 0 }}>+{pft} PFT</span>}
      <span style={{ fontSize: 11, color: muted, width: 56, textAlign: 'right', flexShrink: 0 }}>{time}</span>
    </div>
  );
}

function AllottedOpRow({ wallet, last }) {
  const o = op(wallet);
  const pct = Math.round((o.load / o.cap) * 100);
  const isActive = o.status === 'active';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14,
      padding: '13px 18px',
      borderBottom: last ? 'none' : `0.5px solid ${border}`
    }}>
      <NFTBadge variant={o.badge} size={26} />
      <div style={{ minWidth: 0, width: 220 }}>
        <div style={{ fontSize: 13, color: ink, fontWeight: 500, lineHeight: 1.2 }}>{o.codename}</div>
        <div style={{ fontFamily: monoStack, fontSize: 10.5, color: muted, marginTop: 1 }}>{wallet}</div>
      </div>
      <span style={{ width: 6, height: 6, background: isActive ? green : amber, borderRadius: '50%', flexShrink: 0 }}/>
      <span style={{ fontSize: 12, color: muted, flex: 1, minWidth: 0 }}>{o.archetype}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        <div style={{ width: 84, height: 4, background: tagBg, borderRadius: 999, overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', background: isActive ? green : amber }}/>
        </div>
        <span style={{ fontSize: 11.5, color: muted, fontVariantNumeric: 'tabular-nums', width: 36 }}>{o.load}/{o.cap}</span>
      </div>
    </div>
  );
}

/* ============================================================
   PROJECT DETAIL — the canonical layered layout
   ============================================================ */
function ProjectDetail({ projectId, onBack }) {
  const p = projects[projectId];
  if (!p) return null;

  return (
    <div>
      {/* back */}
      <button onClick={onBack} style={{
        background: 'transparent', border: 'none', cursor: 'pointer',
        display: 'inline-flex', alignItems: 'center', gap: 6,
        color: muted, fontSize: 12.5, padding: '4px 0', marginBottom: 18, fontFamily: 'inherit'
      }}>
        <ArrowLeft size={13}/> Hive
      </button>

      {/* header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 24, marginBottom: 28 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, fontWeight: 500, color: inkSoft, background: tagBg, padding: '3px 10px', borderRadius: 999 }}>{p.type}</span>
            {p.phase && <span style={{ fontSize: 11, color: muted }}>phase {p.phase}</span>}
          </div>
          <h1 style={{ fontSize: 34, fontWeight: 500, margin: 0, letterSpacing: '-0.02em', lineHeight: 1.15 }}>{p.name}</h1>
          {p.summary && <p style={{ fontSize: 14, color: muted, marginTop: 12, marginBottom: 0, lineHeight: 1.55, maxWidth: 620 }}>{p.summary}</p>}
        </div>

        <div style={{ display: 'flex', gap: 28, flexShrink: 0 }}>
          <Stat label="Tasks" value={projectTaskCount[projectId] || p.tasks.length} />
          <Stat label="Contributors" value={(p.contributors || []).length} />
          <Stat label="PFT routed" value={p.pft} accent />
        </div>
      </div>

      {p.contributors && p.contributors.length > 0 ? (
        <>
          <LayerDivider />
          <Section title="About" subtitle="What this project is" layerNumber="01">
            <div style={{ background: surface, border: `0.5px solid ${border}`, borderRadius: 10, padding: '20px 24px' }}>
              <p style={{ fontSize: 14, color: inkSoft, lineHeight: 1.65, margin: 0 }}>{p.about}</p>
              <div style={{ display: 'flex', gap: 36, marginTop: 18, paddingTop: 16, borderTop: `0.5px solid ${border}`, fontSize: 12, color: muted, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontSize: 10.5, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 4 }}>Proposed by hive</div>
                  <div style={{ color: ink, fontWeight: 500, fontSize: 13 }}>{p.proposed}</div>
                </div>
                <div>
                  <div style={{ fontSize: 10.5, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 4 }}>Phase</div>
                  <div style={{ color: ink, fontWeight: 500, fontSize: 13 }}>{p.phase}</div>
                </div>
              </div>
            </div>
          </Section>

          <LayerDivider />
          <Section title="Contributors" subtitle={`${p.contributors.length} operators have earned PFT on this project`} layerNumber="02">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
              {p.contributors.map((c) => (
                <ContributorCard key={c.wallet} contributor={c} />
              ))}
            </div>
          </Section>

          <LayerDivider />
          <Section title="Tasks" subtitle={`${p.tasks.length} tasks across all states`} layerNumber="03">
            <div style={{ background: surface, border: `0.5px solid ${border}`, borderRadius: 10 }}>
              {p.tasks.map((t, i) => (
                <ProjectTaskRow key={i} task={t} last={i === p.tasks.length - 1} />
              ))}
            </div>
          </Section>

          <LayerDivider />
          <Section title="Activity" subtitle="Recent events scoped to this project" layerNumber="04">
            <div style={{ background: surface, border: `0.5px solid ${border}`, borderRadius: 10 }}>
              {p.activity.map((a, i) => (
                <ActivityRow key={i} entry={a} last={i === p.activity.length - 1} />
              ))}
            </div>
          </Section>
        </>
      ) : (
        <div style={{ marginTop: 30, padding: '40px 0', textAlign: 'center', color: muted, fontSize: 13.5 }}>
          Full project view available for PFT distribution v3 in this mock. Other projects show summary only.
        </div>
      )}
    </div>
  );
}

function LayerDivider() {
  return <div style={{ height: 1, background: 'transparent', margin: '8px 0' }} />;
}

function ContributorCard({ contributor }) {
  const o = op(contributor.wallet);
  return (
    <div style={{ background: surface, border: `0.5px solid ${border}`, borderRadius: 10, padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 14 }}>
      <NFTBadge variant={o.badge} size={36} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 14, color: ink, fontWeight: 500 }}>{o.codename}</span>
          {contributor.role === 'lead' && (
            <span style={{ fontSize: 9.5, color: inkSoft, background: tagBg, padding: '1px 7px', borderRadius: 999, letterSpacing: '0.04em', textTransform: 'uppercase', fontWeight: 500 }}>lead</span>
          )}
        </div>
        <div style={{ fontFamily: monoStack, fontSize: 10.5, color: muted, marginTop: 1 }}>{contributor.wallet}</div>
        <div style={{ fontSize: 11.5, color: muted, marginTop: 4 }}>{o.archetype}</div>
      </div>
      <div style={{ textAlign: 'right', flexShrink: 0, fontSize: 11.5, color: muted, lineHeight: 1.6 }}>
        <div><span style={{ color: ink, fontWeight: 500 }}>{contributor.tasks}</span> tasks</div>
        <div><span style={{ color: green, fontWeight: 500 }}>{contributor.pft} PFT</span></div>
        <div style={{ fontSize: 10.5 }}>active {contributor.lastActive}</div>
      </div>
    </div>
  );
}

function ProjectTaskRow({ task, last }) {
  const states = {
    proposed:               { label: 'proposed',     color: amber, dot: 'ring',  dim: false },
    accepted:               { label: 'accepted',     color: green, dot: 'solid', dim: false },
    submitted:              { label: 'submitted',    color: green, dot: 'solid', dim: false },
    verification_requested: { label: 'v. requested', color: amber, dot: 'solid', dim: false },
    verification_response:  { label: 'v. response',  color: green, dot: 'solid', dim: false },
    paid:                   { label: 'paid',         color: muted, dot: 'solid', dim: true  },
    refused:                { label: 'refused',      color: muted, dot: 'ring',  dim: true  },
  };
  const s = states[task.state] || states.proposed;
  const o = task.assignee ? op(task.assignee) : null;
  return (
    <div style={{ padding: '14px 20px', borderBottom: last ? 'none' : `0.5px solid ${border}`, display: 'flex', alignItems: 'center', gap: 14 }}>
      {s.dot === 'ring'
        ? <span style={{ width: 8, height: 8, border: `1.5px solid ${s.color}`, borderRadius: '50%', flexShrink: 0 }}/>
        : <span style={{ width: 8, height: 8, background: s.dim ? muted2 : (s.color === amber ? amber : '#3D5C38'), borderRadius: '50%', flexShrink: 0 }}/>
      }
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, color: s.dim ? muted : ink, fontWeight: 500, lineHeight: 1.3 }}>{task.title}</div>
        <div style={{ fontSize: 11.5, color: muted, marginTop: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: s.color, fontWeight: 500 }}>{s.label}</span>
          <span>·</span>
          <span>{task.age}</span>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        {o ? (
          <>
            <NFTBadge variant={o.badge} size={20} />
            <span style={{ fontSize: 12, color: ink }}>{o.codename}</span>
          </>
        ) : (
          <span style={{ fontSize: 11.5, color: muted, fontStyle: 'italic' }}>unassigned</span>
        )}
      </div>
      <div style={{ width: 60, textAlign: 'right', flexShrink: 0 }}>
        <div style={{ fontSize: 16, fontWeight: 500, color: s.dim ? muted : ink }}>{task.pft}</div>
        <div style={{ fontSize: 9.5, color: muted, letterSpacing: '0.06em' }}>PFT</div>
      </div>
    </div>
  );
}

function ActivityRow({ entry, last }) {
  const o = op(entry.wallet);
  const colors = {
    proposed:    amber,
    accepted:    green,
    submitted:   green,
    v_requested: amber,
    v_response:  green,
    paid:        green,
    refused:     muted,
  };
  const labels = {
    proposed:    'proposed',
    accepted:    'accepted',
    submitted:   'submitted',
    v_requested: 'v. requested',
    v_response:  'v. response',
    paid:        'paid',
    refused:     'refused',
  };
  return (
    <div style={{ padding: '11px 18px', borderBottom: last ? 'none' : `0.5px solid ${border}`, display: 'flex', alignItems: 'center', gap: 12, fontSize: 13 }}>
      <NFTBadge variant={o.badge} size={22} />
      <div style={{ width: 110, flexShrink: 0 }}>
        <div style={{ fontSize: 12.5, color: ink, fontWeight: 500, lineHeight: 1.2 }}>{o.codename}</div>
        <div style={{ fontFamily: monoStack, fontSize: 10.5, color: muted }}>{entry.wallet}</div>
      </div>
      <span style={{ fontSize: 11.5, color: colors[entry.action] || ink, width: 86, fontWeight: 500, flexShrink: 0 }}>{labels[entry.action] || entry.action}</span>
      <span style={{ flex: 1, minWidth: 0, color: ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.task}</span>
      {entry.pft && <span style={{ color: green, fontWeight: 500, fontSize: 12, flexShrink: 0 }}>+{entry.pft} PFT</span>}
      <span style={{ fontSize: 11, color: muted, width: 64, textAlign: 'right', flexShrink: 0 }}>{entry.time}</span>
    </div>
  );
}