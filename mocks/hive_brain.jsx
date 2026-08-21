import { useState } from "react";

/* ============================================================
   Hive Brain — Task Node
   Single-file React mockup. All design tokens live in the
   embedded <style> block so the look matches the HTML version
   exactly. Content is driven by the data arrays below.
============================================================ */

const GRAD = {
  slate:  "linear-gradient(135deg,#6b7a99,#3b4763)",
  purple: "linear-gradient(135deg,#8a6cb0,#4b3a6b)",
  blue:   "linear-gradient(135deg,#6c8fb0,#3a4f6b)",
  green:  "linear-gradient(135deg,#7c9b6b,#3f5d3a)",
  teal:   "linear-gradient(135deg,#6cb09a,#3a6b5d)",
  brown:  "linear-gradient(135deg,#b0926c,#6b543a)",
  red:    "linear-gradient(135deg,#b06c6c,#6b3a3a)",
  olive:  "linear-gradient(135deg,#9a9a6c,#5d5d3a)",
  violet: "linear-gradient(135deg,#9a6cb0,#5d3a6b)",
};

/* ---------- tiny presentational components ---------- */
const Avatar = ({ grad, cls = "av-sm" }) => (
  <div className={cls} style={{ background: GRAD[grad] }} />
);

const BADGE = { action: "b-action", green: "b-green", amber: "b-amber", red: "b-red", blue: "b-blue", gray: "b-gray" };
const Badge = ({ variant = "gray", children }) => (
  <span className={`badge ${BADGE[variant]}`}>{children}</span>
);

const STATUS = { review: "s-review", accept: "s-accept", prop: "s-prop", unassigned: "s-unassigned" };
const Status = ({ type, children }) => (
  <span className={`status ${STATUS[type]}`}>{children}</span>
);

const VER = { ok: "v-ok", warn: "v-warn", bad: "v-bad" };
const Verify = ({ type, children }) => (
  <span className={`verify ${VER[type]}`}>{children}</span>
);

const Pipe = ({ steps }) => (
  <div className="pipe">
    {steps.map((s) => (
      <div className="step" key={s.n}>
        <span className="s-num">{s.n}</span>
        <div className="s-name">{s.name}</div>
        <div className="s-meta">{s.meta}</div>
        <div className="s-stamp">{s.stamp}</div>
      </div>
    ))}
  </div>
);

const Op = ({ grad, handle, badge, meta, desc, allot }) => (
  <div className="op">
    <Avatar grad={grad} cls="av" />
    <div className="o-main">
      <div className="o-head">
        <span className="o-handle">{handle}</span>
        {badge && <Badge variant={badge.v}>{badge.t}</Badge>}
        {meta && <span className="o-meta">{meta}</span>}
      </div>
      <div className="o-desc">{desc}</div>
      {allot && (
        <div className="o-task">
          <span className="lbl">{allot.label}</span>
          <span className={allot.muted ? "muted-sm" : "muted"}>{allot.text}</span>
        </div>
      )}
    </div>
  </div>
);

const RewardCard = ({ cap, withOp, rows, more, style }) => (
  <div className="card" style={style}>
    <div className="table-cap">{cap}</div>
    <table className="tbl">
      <thead>
        <tr>
          <th>Task</th>
          {withOp && <th>Operative</th>}
          <th className="num">Reward</th>
          <th className="num">When</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            <td>{r.task}</td>
            {withOp && <td className="handle">{r.op}</td>}
            <td className="pft">{r.reward}</td>
            <td className="num muted-sm">{r.when}</td>
          </tr>
        ))}
      </tbody>
    </table>
    <div className="more">{more}</div>
  </div>
);

/* ---------- data ---------- */
const TABS = [
  { id: "overview", label: "Overview" },
  { id: "operatives", label: "Operatives", cad: "24h" },
  { id: "rewarded", label: "Rewarded tasks", cad: "20m" },
  { id: "kol", label: "KOL", cad: "daily" },
  { id: "dev", label: "Development", cad: "24h" },
  { id: "qa", label: "QA", cad: "24h" },
  { id: "exec", label: "Executive", cad: "24h" },
];

const DECISIONS = [
  { time: "24m ago", action: "Do nothing", em: "— Orc Review board within KPI, no action needed" },
  { time: "1h ago", action: "Send Hive reply", em: "— to @devsam re: badge sync evidence accepted" },
  { time: "3h ago", action: "Cancel task", em: '— "Tweet packet v2": target link dead, KOL unverified' },
  { time: "5h ago", action: "Create task", em: '— "Document onboarding friction" on Task Node Core' },
  { time: "7h ago", action: "Create board", em: '— "Contributor Activation and Eligibility"' },
];

const COMMENTS = [
  { grad: "slate", name: "@goodalexander", on: "on Post Fiat L1", quote: '"Prioritize the audit before we even talk about mainnet promotion. Don\'t fund more marketing until links are clean."', tag: { pre: "Influenced", strong: "Create task" } },
  { grad: "green", name: "@ji_park", on: "on Orc Review", quote: '"Ledger is stable, ready to freeze schema v2. No new work needed here this week."', tag: { pre: "Influenced", strong: "Do nothing" } },
];

const LIVE = [
  { task: "Build Sybil Enforcement Decision Auditor", op: { grad: "purple", h: "@r_chain" }, project: "Reward Integrity", status: { t: "review", l: "In review" }, reward: "35,000", due: "2d" },
  { task: "L1 validator audit — consensus diff", op: null, project: "Post Fiat L1", status: { t: "prop", l: "Proposed" }, reward: "75,000", due: "5d" },
  { task: "Review remaining Orc evidence", op: { grad: "teal", h: "@mira.qa" }, project: "Orc Review", status: { t: "accept", l: "Accepted" }, reward: "15,000", due: "1d" },
  { task: "Document onboarding friction points", op: { grad: "brown", h: "@nadia" }, project: "Task Node Core", status: { t: "accept", l: "Accepted" }, reward: "15,000", due: "3d" },
  { task: "PFTerminal — fix wallet unlock race", op: { grad: "blue", h: "@grant.h" }, project: "Task Node Core", status: { t: "review", l: "In review" }, reward: "12,000", due: "1d" },
  { task: "Tweet NAVCoin evidence packet", op: { grad: "red", h: "@0xlina" }, project: "Communications", status: { t: "prop", l: "Proposed" }, reward: "8,000", due: "2d" },
  { task: "Submit profile badge sync evidence", op: { grad: "olive", h: "@devsam" }, project: "Contributor Activation", status: { t: "review", l: "In review" }, reward: "100", due: "6h" },
];

const REPORTS = [
  { name: "Operative report", badge: { v: "gray", t: "24h" }, take: "132 operatives across KOL, dev, QA and expert. 12 unallotted, eligible for routing.", updated: "Updated 4h ago", go: "operatives" },
  { name: "Rewarded tasks", badge: { v: "gray", t: "20m" }, take: "Last 10 rewards per role, in plain language. 412,500 PFT paid in 24h.", updated: "Updated 6m ago", go: "rewarded" },
  { name: "KOL report", badge: { v: "amber", t: "3 dead links" }, take: "Reach flat WoW. Evidence packets out-perform price content 3:1. Links verified.", updated: "Updated 06:05", go: "kol" },
  { name: "Development report", badge: { v: "red", t: "1 risk" }, take: "Healthy on Task Node & routing. L1 consensus merged unreviewed — audit advised.", updated: "Updated 02:08", go: "dev" },
  { name: "QA report", badge: { v: "amber", t: "P0 open" }, take: "First-run wallet confusion + devnet instability. 11 chat messages flagged as feedback.", updated: "Updated 03:30", go: "qa" },
  { name: "Executive report", badge: { v: "gray", t: "24h" }, take: "4 project leaders. Consensus: ship the audit, freeze JSON reports, one QA pass on wallet.", updated: "Updated 07:00", go: "exec" },
];

const KOLS = [
  { grad: "red", handle: "@0xlina", badge: { v: "green", t: "KOL" }, meta: "41.2k followers", desc: 'Posts weekly "infra recaps" on modular L1s that consistently clear 100k+ impressions. Careful with claims — a strong fit for evidence-led packets.', allot: { label: "Allotted", text: "NAVCoin evidence packet · proposed · 8,000 PFT" } },
  { grad: "blue", handle: "@cryptoyield", badge: { v: "green", t: "KOL" }, meta: "12.8k followers", desc: "Yield-and-incentives focus; audience skews toward token mechanics and emissions. Good for explaining role-gated rewards.", allot: { label: "Unallotted", muted: true, text: "— available for routing" } },
  { grad: "olive", handle: "@meta_sam", badge: { v: "green", t: "KOL" }, meta: "8.4k followers", desc: "Builder-adjacent commentator with a developer audience. High engagement on technical posts, lower reach on price content.", allot: { label: "Allotted", text: "Explain Active Projects + Orc review · draft" } },
  { grad: "purple", handle: "@nodequeen", badge: { v: "green", t: "KOL" }, meta: "5.1k followers", desc: "Validator-operator community voice; credible on node uptime. Ideal for L1 validator onboarding pushes.", allot: { label: "Unallotted", muted: true, text: "— suggested for L1 audit awareness" } },
];

const DEVS = [
  { grad: "purple", handle: "@r_chain", badge: { v: "blue", t: "Core dev" }, meta: "Rust · consensus · routing · 31 tasks", desc: "Owns the reward-integrity routing rules. Currently building the Sybil enforcement decision auditor.", allot: { label: "Allotted", text: "Sybil enforcement auditor · in review · 35,000 PFT" } },
  { grad: "blue", handle: "@grant.h", badge: { v: "blue", t: "Core dev" }, meta: "TypeScript · wallet · client · 27 tasks", desc: "Maintains Task Node wallet unlock and the Telegram bridge. Fixing a wallet-unlock race condition.", allot: { label: "Allotted", text: "Wallet unlock race · in review · 12,000 PFT" } },
  { grad: "green", handle: "@ji_park", badge: { v: "blue", t: "Core dev" }, meta: "Solidity · contracts · 22 tasks", desc: "Maintains the Orc evidence ledger — submission schemas and export APIs. Shipped feedback export last cycle.", allot: { label: "Unallotted", muted: true, text: "— proposing schema v2 freeze" } },
  { grad: "brown", handle: "@lowlevel_io", badge: { v: "blue", t: "Core dev" }, meta: "Go · L1 node · devnet · 18 tasks", desc: "The only operative with recent consensus commits. Flagged as the natural reviewer for the proposed L1 audit.", allot: { label: "Unallotted", muted: true, text: "— candidate for L1 audit task" } },
];

const QAS = [
  { grad: "teal", handle: "@mira.qa", badge: { v: "amber", t: "QA" }, desc: "Task lifecycle & devnet stability. Filed 14 reproducible issues this month, incl. the block-stall repro.", allot: { label: "Allotted", text: "Orc review + devnet stall" } },
  { grad: "brown", handle: "@nadia", badge: { v: "amber", t: "QA" }, desc: "Onboarding and first-run flows. Authoring the onboarding friction doc.", allot: { label: "Allotted", text: "Onboarding friction · Task Node" } },
  { grad: "violet", handle: "@t_okafor", badge: { v: "amber", t: "QA" }, desc: "Wallet & payments flows. Surfaced the unlock race @grant.h is now fixing.", allot: { label: "Unallotted", muted: true, text: "— available" } },
];

const EXPERTS = [
  { grad: "purple", handle: "@r_chain", badge: { v: "green", t: "Expert" }, meta: "31 tasks", desc: "Eligible for alpha. Last alpha: emissions-schedule impact memo." },
  { grad: "blue", handle: "@grant.h", badge: { v: "green", t: "Expert" }, meta: "27 tasks", desc: "Eligible for alpha. Last alpha: routing edge-case audit." },
  { grad: "green", handle: "@ji_park", badge: { v: "green", t: "Expert" }, meta: "22 tasks", desc: "Newly eligible this cycle. No alpha request issued yet." },
];

const KOL_LINKS = [
  { url: "postfiat.org/blog/navcoin-evidence", by: "@meta_sam", v: "ok", t: "✓ Active" },
  { url: "x.com/0xlina/routing-explainer", by: "@0xlina", v: "ok", t: "✓ Active" },
  { url: "postfiat.org/blog/orc-review-v2", by: "@meta_sam", v: "ok", t: "✓ Active" },
  { url: "x.com/cryptoyield/packet-12", by: "@cryptoyield", v: "bad", t: "✗ Dead — 404" },
  { url: "linktr.ee/nodequeen-nodes", by: "@nodequeen", v: "warn", t: "⚠ Redirected off-domain" },
  { url: "postfiat.org/devnet-announce", by: "team", byMuted: true, v: "bad", t: "✗ Dead — removed" },
];

const FINDINGS = [
  { repo: "postfiatorg/routing", claim: '"Routing rule v3 shipped"', v: "ok", t: "✓ Verified", note: "Merged #210 · tests passing" },
  { repo: "agticorp/orc-ledger", claim: '"CSV + JSON export added"', v: "ok", t: "✓ Verified", note: "Merged #128" },
  { repo: "postfiatorg/task-node", claim: '"Wallet unlock race fixed"', v: "warn", t: "⚠ Refuted", note: "Fix is in open PR #341 — not merged" },
  { repo: "postfiatorg/pf-terminal", claim: '"Telegram bridge stable"', v: "warn", t: "⚠ Partial", note: "Merged, but flaky reconnect test" },
  { repo: "postfiatorg/l1", claim: '"Consensus changes merged"', v: "bad", t: "✗ Risk", note: "#218, #221 merged — no external review" },
];

const IMPROVEMENTS = [
  { prio: "p0", label: "P0", title: "Wallet unlock race on first run", desc: '6 users hit the unlock race on first run. Add a retry + a clearer "Unlocked" state. Repro by @t_okafor; fix in PR #341 (not yet merged).' },
  { prio: "p1", label: "P1", title: "Unclear first task after connecting wallet", desc: 'New users don\'t know what to do next. @nadia recommends a guided "your first task" card on the Hive page.' },
  { prio: "p1", label: "P1", title: "Devnet block stall under load", desc: "Block production stalls under load. Needs a reproducible load test in CI before promotion. Repro by @mira.qa." },
  { prio: "p2", label: "P2", title: "Reports were unreadable JSON blobs", desc: "Users couldn't parse the old report format. Addressed by this Hive Brain redesign." },
];

const FEEDBACK = [
  { q: '"I don\'t know what to do after connecting my wallet"', n: "×4" },
  { q: '"The reports are unreadable"', n: "×3" },
  { q: '"Task rewards aren\'t clear before I accept"', n: "×2" },
  { q: '"Devnet keeps stalling on me"', n: "×2" },
];

const LEADERS = [
  { grad: "slate", name: "@goodalexander", role: "Lead", quote: '"Delete and rescope the Hive brain — reports must be human-readable and carry KPIs. Prioritize the L1 audit over everything else this week."', tags: [{ pre: "Decision", strong: "Approve audit task" }, { pre: "Decision", strong: "Deprecate JSON reports" }] },
  { grad: "green", name: "@ji_park", role: "Contracts lead", quote: '"Orc ledger is stable and ready to freeze schema v2."', tags: [{ pre: "Blocker", strong: "Needs export-retention sign-off" }] },
  { grad: "blue", name: "@grant.h", role: "Client lead", quote: '"Wallet fix is in review; Telegram bridge is still flaky under reconnect."', tags: [{ pre: "Ask", strong: "One more QA pass before merge" }] },
  { grad: "red", name: "@0xlina", role: "KOL lead", quote: '"Reach is flat — leaning into evidence packets over price content."', tags: [{ pre: "Blocker", strong: "3 dead links to fix" }] },
];

/* ---------- panels ---------- */
function Overview({ go }) {
  return (
    <section className="panel active">
      <div className="stack">
        {/* Decision */}
        <div className="card decision">
          <div className="d-top">
            <Badge variant="action">● Board manager · decision</Badge>
            <Badge variant="blue">Create task</Badge>
            <span className="grow" />
            <span className="d-time">Cycle #1,284 · ran 4 min ago</span>
          </div>
          <div className="d-body">
            <h2>Open a security audit on the Post Fiat L1 validator</h2>
            <div className="who">Routed to: Core Contributors with prior L1 commits · 75,000 PFT · 5-day deadline</div>
            <p>Coverage on the Layer 1 is thin — only <b>1 operative</b> is allotted to validation work, and today's Development report flagged that the devnet branch merged consensus changes (PR&nbsp;#218, #221) with <b>no external review</b>. With 132 active operatives but only 4 holding Core Contributor access, commissioning a paid audit now is the cheapest way to cut the risk of shipping unreviewed consensus code toward mainnet.</p>
            <p>I'm <b>not</b> archiving any board: Reward Integrity and Task Node Core are both inside their KPIs (2.4M and 6.6M PFT routed). The KOL board stays open but gets <b>no new packet</b> this cycle — marketing trajectory is flat and 3 public links failed verification, which the KOL owner should clear before new packets are funded.</p>
            <div className="stat-row">
              <span className="pill">Working against · <b>L1 review coverage</b></span>
              <span className="pill">Working against · <b>Core Contributor utilization</b></span>
              <span className="pill">Working against · <b>Mainnet readiness</b></span>
            </div>
            <div className="actions">
              <span className="act-label">Decision space</span>
              <span className="act">Create board</span>
              <span className="act">Archive board</span>
              <span className="act chosen">Create task ✓</span>
              <span className="act">Cancel task</span>
              <span className="act">Send Hive reply</span>
              <span className="act">Do nothing</span>
            </div>
          </div>
        </div>

        <div className="grid2">
          {/* Decision log */}
          <div className="card pad log">
            <div className="section-label">Recent decisions</div>
            <div className="section-sub">Every board-manager action, auditable.</div>
            {DECISIONS.map((d, i) => (
              <div className="li" key={i}>
                <span className="lt">{d.time}</span>
                <span className="lx"><b>{d.action}</b> <span className="em">{d.em}</span></span>
              </div>
            ))}
          </div>

          {/* Board discussion */}
          <div className="card pad">
            <div className="section-label">Board discussion → decisions</div>
            <div className="section-sub">Project-manager comments the board manager weighed this cycle.</div>
            {COMMENTS.map((c, i) => (
              <div className="exec" key={i} style={i === 0 ? { paddingTop: 0 } : undefined}>
                <Avatar grad={c.grad} cls="av" />
                <div className="e-main">
                  <div className="e-head"><span className="e-name">{c.name}</span><span className="e-role">{c.on}</span></div>
                  <div className="e-quote">{c.quote}</div>
                  <div className="e-tags"><span className="tag">{c.tag.pre} · <b>{c.tag.strong}</b></span></div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Live tasks */}
        <div className="card">
          <div style={{ padding: "18px 24px 0" }}>
            <div className="section-label">Live task status</div>
            <div className="section-sub">Real-time — what's outstanding and to whom.</div>
          </div>
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr><th>Task</th><th>Operative</th><th>Project</th><th>Status</th><th className="num">Reward</th><th className="num">Due</th></tr>
              </thead>
              <tbody>
                {LIVE.map((t, i) => (
                  <tr key={i}>
                    <td>{t.task}</td>
                    <td>{t.op ? (
                      <div className="who-cell"><Avatar grad={t.op.grad} /><span className="handle">{t.op.h}</span></div>
                    ) : (
                      <span className="status s-unassigned" style={{ fontWeight: 600 }}>Unassigned</span>
                    )}</td>
                    <td className="muted">{t.project}</td>
                    <td><Status type={t.status.t}>{t.status.l}</Status></td>
                    <td className="pft">{t.reward}</td>
                    <td className="num muted-sm">{t.due}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Report grid */}
        <div>
          <div className="section-label" style={{ marginBottom: 3 }}>Reports & generations</div>
          <div className="section-sub">Six reports feed the board manager. Click any to read it. Task generation runs independently — it never blocks on a report.</div>
          <div className="rep-grid">
            {REPORTS.map((r) => (
              <div className="rep" key={r.go} onClick={() => go(r.go)}>
                <div className="r-top"><span className="r-name">{r.name}</span><Badge variant={r.badge.v}>{r.badge.t}</Badge></div>
                <div className="r-take">{r.take}</div>
                <div className="r-foot"><span>{r.updated}</span><span className="go">Open →</span></div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function Operatives() {
  return (
    <section className="panel active">
      <div className="panel-head">
        <h2>Operative report</h2>
        <div className="ph-meta"><Badge variant="gray">Every 24 hours</Badge><span className="sep">·</span><span>Generated 4h ago</span><span className="sep">·</span><span>132 operatives · 12 unallotted</span></div>
      </div>

      <div className="card pad op-group">
        <div className="section-label">KOL · key opinion leaders</div>
        <div className="section-sub">≥ 3,000 X followers. Vetted voices for network information — members don't share unvetted info.</div>
        {KOLS.map((o) => <Op key={o.handle} {...o} />)}
      </div>

      <div className="card pad op-group">
        <div className="section-label">Core contributors · developers</div>
        <div className="section-sub">Production access to postfiatorg or agticorp repositories.</div>
        {DEVS.map((o) => <Op key={o.handle} {...o} />)}
      </div>

      <div className="grid2">
        <div className="card pad op-group" style={{ marginBottom: 0 }}>
          <div className="section-label">QA assistants</div>
          <div className="section-sub">Paid product users (USDC) providing feedback and user flows.</div>
          {QAS.map((o) => <Op key={o.handle} {...o} />)}
        </div>
        <div className="card pad op-group" style={{ marginBottom: 0 }}>
          <div className="section-label">Experts</div>
          <div className="section-sub">20+ personal tasks completed — eligible for market-moving alpha requests.</div>
          {EXPERTS.map((o) => <Op key={o.handle} {...o} />)}
        </div>
      </div>
    </section>
  );
}

function Rewarded() {
  return (
    <section className="panel active">
      <div className="panel-head">
        <h2>Rewarded task report</h2>
        <div className="ph-meta"><Badge variant="gray">Every 20 minutes</Badge><span className="sep">·</span><span>Generated 6 min ago</span><span className="sep">·</span><span>Last 10 per role · human-readable, no JSON</span></div>
      </div>
      <div className="stack">
        <RewardCard
          cap="KOL · last 10 rewarded"
          withOp
          more="+ 5 more · oldest 4d ago"
          rows={[
            { task: "Thread: role-gated routing explainer", op: "@0xlina", reward: "8,000", when: "2h ago" },
            { task: "NAVCoin evidence recap thread", op: "@meta_sam", reward: "6,000", when: "9h ago" },
            { task: "Validator uptime explainer", op: "@nodequeen", reward: "5,000", when: "1d ago" },
            { task: "Orc review — what changed", op: "@cryptoyield", reward: "4,500", when: "1d ago" },
            { task: "Alpha-access eligibility breakdown", op: "@0xlina", reward: "6,500", when: "2d ago" },
          ]}
        />
        <RewardCard
          cap="Core developer · last 10 rewarded"
          withOp
          more="+ 5 more · oldest 5d ago"
          rows={[
            { task: "Merge: routing rule v3 (PR #210)", op: "@r_chain", reward: "18,000", when: "4h ago" },
            { task: "Fix: Telegram bridge reconnect", op: "@grant.h", reward: "9,000", when: "11h ago" },
            { task: "Orc export API — CSV + JSON", op: "@ji_park", reward: "14,000", when: "1d ago" },
            { task: "Devnet: block-producer logging", op: "@lowlevel_io", reward: "11,000", when: "1d ago" },
            { task: "Wallet: unlock-state indicator", op: "@grant.h", reward: "7,500", when: "2d ago" },
          ]}
        />
        <div className="grid2">
          <RewardCard
            cap="QA · last 10 rewarded"
            style={{ marginBottom: 0 }}
            more="+ 6 more · oldest 4d ago"
            rows={[
              { task: <>Repro: devnet block stall <span className="muted-sm">· @mira.qa</span></>, reward: "9,000", when: "6h ago" },
              { task: <>Onboarding friction pass 1 <span className="muted-sm">· @nadia</span></>, reward: "7,500", when: "14h ago" },
              { task: <>Wallet unlock race repro <span className="muted-sm">· @t_okafor</span></>, reward: "6,000", when: "1d ago" },
              { task: <>Telegram bridge flake report <span className="muted-sm">· @mira.qa</span></>, reward: "3,500", when: "2d ago" },
            ]}
          />
          <RewardCard
            cap="Expert · last 10 rewarded (alpha + high-value)"
            style={{ marginBottom: 0 }}
            more="+ 6 more · oldest 5d ago"
            rows={[
              { task: <>Alpha: emissions-schedule memo <span className="muted-sm">· @r_chain</span></>, reward: "22,000", when: "8h ago" },
              { task: <>Routing edge-case audit <span className="muted-sm">· @grant.h</span></>, reward: "15,000", when: "1d ago" },
              { task: <>Liquidity-venue alpha brief <span className="muted-sm">· @r_chain</span></>, reward: "18,000", when: "2d ago" },
              { task: <>Contract gas-cost review <span className="muted-sm">· @ji_park</span></>, reward: "10,000", when: "3d ago" },
            ]}
          />
        </div>
        <RewardCard
          cap="Contributor · last 10 rewarded"
          withOp
          more="+ 5 more · oldest 3d ago"
          rows={[
            { task: "Profile badge sync evidence", op: "@devsam", reward: "100", when: "3h ago" },
            { task: "Eligibility setup walkthrough", op: "@kez", reward: "100", when: "7h ago" },
            { task: "Role-lane verification check", op: "@amara_b", reward: "100", when: "12h ago" },
            { task: "First-task completion proof", op: "@yusuf.k", reward: "100", when: "1d ago" },
            { task: "Badge sync — retry evidence", op: "@devsam", reward: "100", when: "2d ago" },
          ]}
        />
      </div>
    </section>
  );
}

function KOLReport() {
  return (
    <section className="panel active">
      <div className="panel-head">
        <h2>KOL report — marketing state</h2>
        <div className="ph-meta"><Badge variant="gray">Daily</Badge><span className="sep">·</span><span>Generated 06:05</span><span className="sep">·</span><Verify type="warn">⚠ 3 of 21 links failed verification</Verify></div>
      </div>

      <Pipe steps={[
        { n: 1, name: "Initial report", meta: "Marketing state drafted from rewarded tasks + reach data.", stamp: "✓ Drafted 06:00" },
        { n: 2, name: "Agent verification", meta: "Agent pulls every public link and confirms it's live.", stamp: "✓ Checked 21 links · 06:04" },
        { n: 3, name: "Final report", meta: "Verified findings + recommendation to the board manager.", stamp: "✓ Finalized 06:05" },
      ]} />

      <div className="grid2">
        <div className="card pad">
          <div className="section-label">State & trajectory</div>
          <div className="body-copy" style={{ marginTop: 10 }}>
            <p>Reach is <b>flat week-over-week</b> — ~310k impressions vs 305k. Evidence-led packets out-perform price content roughly <b>3:1</b> on engagement.</p>
            <p>NAVCoin coverage is the strongest thread this week; Orc-review messaging under-performed and should be reframed around concrete user benefit.</p>
          </div>
          <div className="stat-row">
            <span className="pill">Impressions 7d · <b>310k</b> <span className="delta flat">▬ 1.6%</span></span>
            <span className="pill">Packets shipped · <b>6</b></span>
            <span className="pill">Avg engagement · <b>2.4%</b></span>
          </div>
        </div>
        <div className="card pad">
          <div className="section-label">Key rewarded tasks</div>
          <div style={{ marginTop: 10 }}>
            {[["Role-gated routing explainer · @0xlina", "8,000"], ["NAVCoin evidence recap · @meta_sam", "6,000"], ["Validator uptime explainer · @nodequeen", "5,000"]].map(([t, p], i) => (
              <div key={i} style={{ borderBottom: i < 2 ? "1px solid var(--border-soft)" : "none", padding: "10px 0", display: "flex", justifyContent: "space-between" }}>
                <span>{t}</span><span className="pft" style={{ textAlign: "right" }}>{p}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 18 }}>
        <div style={{ padding: "18px 24px 4px" }}>
          <div className="section-label">Public links · agent verification</div>
          <div className="section-sub">Every link the marketing effort points to, checked live this morning.</div>
        </div>
        <div className="table-wrap">
          <table className="tbl">
            <thead><tr><th>Link</th><th>Posted by</th><th>Status</th></tr></thead>
            <tbody>
              {KOL_LINKS.map((l, i) => (
                <tr key={i}>
                  <td className="muted">{l.url}</td>
                  <td className={l.byMuted ? "muted-sm" : "handle"}>{l.by}</td>
                  <td><Verify type={l.v}>{l.t}</Verify></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card pad" style={{ marginTop: 18, borderLeft: "3px solid var(--amber)" }}>
        <div className="section-label">Final report → board manager</div>
        <div className="body-copy" style={{ marginTop: 8 }}>
          <p>3 of 21 links failed verification. <b>Recommendation:</b> withhold new packets until @meta_sam and @cryptoyield resolve the dead links, then resume with evidence-led content. Trajectory does not justify new spend this cycle.</p>
        </div>
      </div>
    </section>
  );
}

function DevReport() {
  return (
    <section className="panel active">
      <div className="panel-head">
        <h2>Development report — core engineering</h2>
        <div className="ph-meta"><Badge variant="gray">Every 24 hours</Badge><span className="sep">·</span><span>Generated 02:08</span><span className="sep">·</span><Verify type="bad">✗ 1 risk: unreviewed L1 consensus</Verify></div>
      </div>

      <Pipe steps={[
        { n: 1, name: "Initial report", meta: "Dev narrative drafted from rewarded tasks + leader notes.", stamp: "✓ Drafted 02:00" },
        { n: 2, name: "Agent coding verification", meta: "Agent clones the Post Fiat repos and checks each claim against commits & PRs.", stamp: "✓ 5 repos cloned · 02:00–02:07" },
        { n: 3, name: "Final report", meta: "Verified findings + risk flags to the board manager.", stamp: "✓ Finalized 02:08" },
      ]} />

      <div className="card pad">
        <div className="section-label">Narrative</div>
        <div className="body-copy" style={{ marginTop: 10 }}>
          <p>Core development is <b>healthy on Task Node and routing</b>; the L1 and devnet carry the most risk. <b>14 PRs</b> merged across 5 repos in the last 7 days.</p>
          <p>Routing rule v3 shipped cleanly and the Orc export API is done. The standout concern is the L1: consensus changes were merged with no external review.</p>
        </div>
      </div>

      <div className="card" style={{ marginTop: 18 }}>
        <div style={{ padding: "18px 24px 6px" }}>
          <div className="section-label">Per-repo verification</div>
          <div className="section-sub">What was claimed vs what the agent found in the code.</div>
        </div>
        <div className="findings" style={{ padding: "0 24px 18px" }}>
          {FINDINGS.map((f, i) => (
            <div className="f" key={i}>
              <div className="f-repo">{f.repo}</div>
              <div className="f-claim"><span className="q">{f.claim}</span></div>
              <div className="f-status"><Verify type={f.v}>{f.t}</Verify><span className="f-note">{f.note}</span></div>
            </div>
          ))}
        </div>
      </div>

      <div className="card pad" style={{ marginTop: 18, borderLeft: "3px solid var(--red)" }}>
        <div className="section-label">Final report → board manager</div>
        <div className="body-copy" style={{ marginTop: 8 }}>
          <p><b>Recommendation:</b> commission a paid security audit on the L1 consensus diff before any mainnet promotion, gated to a Core Contributor with prior L1 commits. <span className="muted">→ The board manager acted on this in cycle #1,284.</span></p>
        </div>
      </div>
    </section>
  );
}

function QAReport() {
  return (
    <section className="panel active">
      <div className="panel-head">
        <h2>QA report — product</h2>
        <div className="ph-meta"><Badge variant="gray">Every 24 hours</Badge><span className="sep">·</span><span>Generated 03:30</span><span className="sep">·</span><span>Reads as a product doc · includes 24h chat feedback</span></div>
      </div>

      <div className="card pad">
        <div className="section-label">Summary</div>
        <div className="body-copy" style={{ marginTop: 8 }}>
          <p>Two recurring themes this cycle: <b>first-run wallet confusion</b> and <b>devnet instability</b>. Both are reproducible and have owners. Onboarding is the single biggest drop-off point for new contributors.</p>
        </div>
      </div>

      <div className="card pad" style={{ marginTop: 18 }}>
        <div className="section-label">Suggested improvements · prioritized</div>
        <div style={{ marginTop: 6 }}>
          {IMPROVEMENTS.map((im, i) => (
            <div className="imp" key={i}>
              <span className={`prio ${im.prio}`}>{im.label}</span>
              <div className="i-main"><div className="i-title">{im.title}</div><div className="i-desc">{im.desc}</div></div>
            </div>
          ))}
        </div>
      </div>

      <div className="card pad" style={{ marginTop: 18 }}>
        <div className="section-label">Hive chat · product feedback (24h)</div>
        <div className="section-sub">11 of 214 messages flagged as feedback by the QA agent.</div>
        <div className="feedback-box">
          {FEEDBACK.map((f, i) => (
            <div className="fq" key={i}><span>{f.q}</span><span className="ct">{f.n}</span></div>
          ))}
        </div>
      </div>
    </section>
  );
}

function ExecReport() {
  return (
    <section className="panel active">
      <div className="panel-head">
        <h2>Executive report — leadership</h2>
        <div className="ph-meta"><Badge variant="gray">Every 24 hours</Badge><span className="sep">·</span><span>Generated 07:00</span><span className="sep">·</span><span>All project-leader Hive chats, last 24h</span></div>
      </div>

      <div className="card pad">
        <div className="section-label">Consensus this cycle</div>
        <div className="body-copy" style={{ marginTop: 8 }}>
          <p>Leaders agree on three moves: <b>ship the L1 audit</b>, <b>retire the JSON report format</b> in favor of human-readable reports, and run <b>one more QA pass</b> on the wallet before merging the fix. No disagreements logged.</p>
        </div>
      </div>

      <div className="card pad" style={{ marginTop: 18 }}>
        <div className="section-label">By leader</div>
        <div style={{ marginTop: 6 }}>
          {LEADERS.map((l, i) => (
            <div className="exec" key={i}>
              <Avatar grad={l.grad} cls="av" />
              <div className="e-main">
                <div className="e-head"><span className="e-name">{l.name}</span><span className="e-role">{l.role}</span></div>
                <div className="e-quote">{l.quote}</div>
                <div className="e-tags">{l.tags.map((t, j) => <span className="tag" key={j}>{t.pre} · <b>{t.strong}</b></span>)}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------- root ---------- */
export default function HiveBrain() {
  const [tab, setTab] = useState("overview");
  const go = (name) => {
    setTab(name);
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <>
      <style>{CSS}</style>
      <div className="app">
        {/* Sidebar */}
        <aside className="sidebar">
          <div className="brand">
            <svg className="x" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
            <span className="logo">Task Node</span>
            <svg className="collapse" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></svg>
          </div>

          <nav className="nav">
            <div className="nav-item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3v18M3 12h18" /></svg><span className="grow">New chat</span></div>
            <div className="nav-item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></svg><span className="grow">Search chats</span></div>
            <div className="nav-item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></svg><span className="grow">Tasks</span><span className="nav-badge">4</span></div>
            <div className="nav-item active"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12h4l2 7 4-16 2 9h6" /></svg><span className="grow">Hive</span><span className="nav-tag"><span className="dot live" />live</span></div>
            <div className="nav-item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="6" width="20" height="13" rx="2.5" /><path d="M16 12h2" /></svg><span className="grow">Wallet</span><span className="nav-tag lock"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>Unlocked</span></div>
            <div className="nav-item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 0-2 2V5z" /><path d="M18 3v16" /></svg><span className="grow">Context</span></div>
            <div className="nav-item"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></svg><span className="grow">More</span></div>
          </nav>

          <div className="recents">
            <div className="label">Recents</div>
            <div className="r active"><svg className="ic" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M6 6l2 2M16 16l2 2M18 6l-2 2M8 16l-2 2" /></svg>Hive Brain</div>
            <div className="r">let's talk about m context d…</div>
            <div className="r">is this working</div>
            <div className="r">Hello</div>
            <div className="r">alright the app surface has …</div>
            <div className="r">The context document I ha…</div>
          </div>

          <div className="wallet">
            <div className="row"><span className="bal">1,430,524.67</span><span className="pft">PFT</span></div>
            <div className="sub"><span>$22.65</span><span className="chip">chat</span><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginLeft: "auto", color: "var(--text-3)" }}><path d="M9 6l6 6-6 6" /></svg></div>
            <div className="unlock"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0" /></svg>Unlocked</div>
            <div className="user">
              <div className="av" />
              <div><div className="name">@goodalexander</div><div className="at">@goodalexander</div></div>
              <svg className="ok" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M20 6L9 17l-5-5" /></svg>
            </div>
          </div>
        </aside>

        {/* Main */}
        <main className="main">
          <div className="toolbar">
            <svg className="pencil menu-btn" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
            <svg className="pencil" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" /></svg>
            <div className="sync">
              <span>Synced 38s ago</span>
              <button className="btn"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5" /></svg>Refresh</button>
            </div>
          </div>

          <div className="page">
            {/* Header */}
            <div className="head">
              <div>
                <div className="eyebrow"><span className="dot live" />Live · Auditable</div>
                <h1 className="title">Hive Brain</h1>
                <p className="lede">The decision layer for the network. Reports flow up from every role, the board manager reads them, and routes work — every action shown in plain English with the reasoning behind it.</p>
              </div>
              <div className="head-meta">
                <div>Board manager <b>ran 4 min ago</b></div>
                <div>Next run in <b>16 min</b></div>
                <div style={{ marginTop: 8 }}>Token <b style={{ color: "var(--green)" }}>PFT ▲ 4.1% 24h</b></div>
              </div>
            </div>

            {/* KPIs */}
            <div className="kpis">
              <div className="kpi"><div className="k-label">Active operatives</div><div className="k-val">132</div><div className="k-sub"><span className="delta up">▲ 8</span> this week</div></div>
              <div className="kpi"><div className="k-label">Open tasks</div><div className="k-val">41</div><div className="k-sub">12 unassigned</div></div>
              <div className="kpi"><div className="k-label">Rewarded · 24h</div><div className="k-val">23</div><div className="k-sub"><span style={{ color: "var(--green)", fontWeight: 600 }}>412,500 PFT</span></div></div>
              <div className="kpi"><div className="k-label">PFT routed · total</div><div className="k-val green">9.4M</div><div className="k-sub">across 5 boards</div></div>
              <div className="kpi"><div className="k-label">Links verified</div><div className="k-val">18<span style={{ fontSize: 15, color: "var(--text-3)" }}> / 21</span></div><div className="k-sub"><span className="delta dn">3 dead</span></div></div>
              <div className="kpi"><div className="k-label">PRs merged · 7d</div><div className="k-val">14</div><div className="k-sub">5 repos · 1 unreviewed</div></div>
            </div>

            {/* Tabs */}
            <div className="tabs">
              {TABS.map((t) => (
                <div key={t.id} className={`tab ${tab === t.id ? "active" : ""}`} onClick={() => go(t.id)}>
                  {t.label}{t.cad && <span className="cad">{t.cad}</span>}
                </div>
              ))}
            </div>

            {/* Panels */}
            {tab === "overview" && <Overview go={go} />}
            {tab === "operatives" && <Operatives />}
            {tab === "rewarded" && <Rewarded />}
            {tab === "kol" && <KOLReport />}
            {tab === "dev" && <DevReport />}
            {tab === "qa" && <QAReport />}
            {tab === "exec" && <ExecReport />}
          </div>
        </main>
      </div>
    </>
  );
}

/* ============================================================
   Styles
============================================================ */
const CSS = `
  :root{
    --bg:#f6f4ee; --bg-sidebar:#efece4; --surface:#ffffff; --surface-2:#faf9f5;
    --surface-3:#f1efe8; --border:#e6e2d8; --border-soft:#ece9e0;
    --text:#23231f; --text-2:#6f6c63; --text-3:#9a968c;
    --green:#2f7d4e; --green-bg:#e9f3ec; --green-live:#34a853;
    --amber:#946215; --amber-bg:#f6eed8; --red:#ab412c; --red-bg:#f6e7e1;
    --blue:#3a6ea5; --blue-bg:#eaf0f7; --sel:#eef2f7; --sel-border:#d9e1ec;
    --radius:12px; --radius-sm:9px;
    --shadow:0 1px 2px rgba(40,38,32,.05),0 1px 1px rgba(40,38,32,.03);
    --font:ui-sans-serif,-apple-system,"Segoe UI",Inter,system-ui,"Helvetica Neue",Arial,sans-serif;
    --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  }
  *{box-sizing:border-box}
  body{margin:0;padding:0;background:var(--bg)}
  .app{display:flex;min-height:100vh;font-family:var(--font);background:var(--bg);color:var(--text);-webkit-font-smoothing:antialiased;font-size:14px;line-height:1.5}
  .app svg{display:block}
  .app button{font-family:inherit}

  .sidebar{width:262px;flex:0 0 262px;background:var(--bg-sidebar);border-right:1px solid var(--border);display:flex;flex-direction:column;height:100vh;position:sticky;top:0;padding:14px 12px 12px}
  .brand{display:flex;align-items:center;gap:10px;padding:6px 8px 14px}
  .brand .logo{font-weight:700;font-size:17px;letter-spacing:-.01em}
  .brand .x{width:20px;height:20px;color:var(--text-2)}
  .brand .collapse{margin-left:auto;color:var(--text-3)}
  .nav{display:flex;flex-direction:column;gap:1px}
  .nav-item{display:flex;align-items:center;gap:11px;padding:8px 9px;border-radius:9px;color:var(--text);font-size:14px;cursor:pointer;border:1px solid transparent}
  .nav-item:hover{background:rgba(0,0,0,.035)}
  .nav-item.active{background:var(--sel);border-color:var(--sel-border)}
  .nav-item svg{width:17px;height:17px;color:var(--text-2);flex:0 0 17px}
  .nav-item.active svg{color:#41618c}
  .nav-item .grow{flex:1}
  .nav-badge{background:#2b2a26;color:#fff;font-size:11px;font-weight:600;min-width:19px;height:19px;border-radius:10px;display:inline-flex;align-items:center;justify-content:center;padding:0 6px}
  .nav-tag{font-size:11px;color:var(--green-live);font-weight:600;display:flex;align-items:center;gap:5px}
  .nav-tag.lock{color:var(--text-3);font-weight:500}
  .dot{width:7px;height:7px;border-radius:50%;background:var(--green-live);display:inline-block}
  .dot.live{animation:pulse 2s ease-in-out infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}

  .recents{margin-top:18px;flex:1;overflow:hidden;display:flex;flex-direction:column}
  .recents .label{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3);padding:4px 9px 7px;font-weight:600}
  .recents .r{padding:7px 9px;border-radius:8px;color:var(--text-2);font-size:13.5px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;align-items:center;gap:8px}
  .recents .r:hover{background:rgba(0,0,0,.035)}
  .recents .r.active{background:rgba(0,0,0,.05);color:var(--text)}
  .recents .r .ic{color:var(--text-3)}

  .wallet{border-top:1px solid var(--border);margin:0 -12px;padding:12px 14px 4px}
  .wallet .row{display:flex;align-items:center;gap:9px;font-size:13.5px}
  .wallet .bal{font-weight:600}
  .wallet .pft{color:var(--text-3);font-weight:500;font-size:12px}
  .wallet .sub{color:var(--text-2);font-size:12.5px;margin-top:3px;display:flex;align-items:center;gap:7px}
  .wallet .chip{color:var(--text-3)}
  .wallet .unlock{display:inline-flex;align-items:center;gap:5px;color:var(--green);font-size:12px;font-weight:600;margin-top:7px}
  .user{display:flex;align-items:center;gap:9px;padding:11px 2px 2px;margin-top:6px}
  .user .av{width:26px;height:26px;border-radius:50%;background:linear-gradient(135deg,#6b7a99,#3b4763)}
  .user .name{font-size:13.5px;font-weight:600}
  .user .at{font-size:12px;color:var(--text-3)}
  .user .ok{margin-left:auto;color:var(--green-live)}

  .main{flex:1;min-width:0;display:flex;flex-direction:column}
  .toolbar{height:52px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:14px;padding:0 26px;background:var(--bg);position:sticky;top:0;z-index:5}
  .toolbar .pencil{color:var(--text-2)}
  .toolbar .sync{margin-left:auto;display:flex;align-items:center;gap:8px;color:var(--text-3);font-size:12.5px}
  .toolbar .btn{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;font-weight:600;color:var(--text);background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:6px 11px;cursor:pointer}
  .toolbar .btn:hover{background:var(--surface-2)}

  .page{padding:30px 40px 60px;max-width:1180px;width:100%;margin:0 auto}

  .eyebrow{font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:var(--green-live);font-weight:700;display:flex;align-items:center;gap:7px;margin-bottom:8px}
  h1.title{font-size:40px;line-height:1.05;letter-spacing:-.022em;margin:0;font-weight:700}
  .lede{color:var(--text-2);font-size:15px;max-width:620px;margin:12px 0 0}
  .head{display:flex;justify-content:space-between;align-items:flex-start;gap:30px}
  .head-meta{text-align:right;color:var(--text-3);font-size:12.5px;flex:0 0 auto;padding-top:4px}
  .head-meta b{color:var(--text-2);font-weight:600}

  .kpis{display:grid;grid-template-columns:repeat(6,1fr);gap:1px;background:var(--border);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;margin-top:26px;box-shadow:var(--shadow)}
  .kpi{background:var(--surface);padding:15px 16px 14px;min-width:0}
  .kpi .k-label{font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--text-3);font-weight:600;margin-bottom:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .kpi .k-val{font-size:23px;font-weight:700;letter-spacing:-.02em;line-height:1}
  .kpi .k-val.green{color:var(--green)}
  .kpi .k-sub{font-size:12px;color:var(--text-2);margin-top:7px}
  .delta{font-weight:600}
  .delta.up{color:var(--green)} .delta.dn{color:var(--red)} .delta.flat{color:var(--text-3)}

  .tabs{display:flex;gap:2px;margin:30px 0 22px;border-bottom:1px solid var(--border);overflow-x:auto;scrollbar-width:none}
  .tabs::-webkit-scrollbar{display:none}
  .tab{padding:10px 14px 12px;font-size:13.5px;font-weight:600;color:var(--text-3);cursor:pointer;border-bottom:2px solid transparent;white-space:nowrap;display:flex;align-items:center;gap:8px}
  .tab:hover{color:var(--text)}
  .tab.active{color:var(--text);border-bottom-color:#2b2a26}
  .tab .cad{font-size:10.5px;font-weight:600;color:var(--text-3);background:var(--surface-3);border-radius:20px;padding:1.5px 7px}
  .tab.active .cad{color:var(--text-2)}

  .panel{animation:fade .25s ease}
  @keyframes fade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}

  .card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow)}
  .card.pad{padding:22px 24px}
  .section-label{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--text-3);font-weight:700;margin:0 0 4px}
  .section-sub{color:var(--text-2);font-size:13.5px;margin:0 0 16px}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:18px}
  .stack{display:flex;flex-direction:column;gap:18px}

  .badge{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;border-radius:6px;padding:3px 8px}
  .b-action{background:#2b2a26;color:#fff} .b-green{background:var(--green-bg);color:var(--green)}
  .b-amber{background:var(--amber-bg);color:var(--amber)} .b-red{background:var(--red-bg);color:var(--red)}
  .b-blue{background:var(--blue-bg);color:var(--blue)} .b-gray{background:var(--surface-3);color:var(--text-2)}

  .stat-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
  .pill{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--text-2);background:var(--surface-2);border:1px solid var(--border-soft);border-radius:20px;padding:5px 11px}
  .pill b{color:var(--text);font-weight:600}

  .decision{padding:0;overflow:hidden}
  .decision .d-top{display:flex;align-items:center;gap:12px;padding:16px 24px;border-bottom:1px solid var(--border-soft);background:var(--surface-2)}
  .decision .d-top .grow{flex:1}
  .decision .d-time{color:var(--text-3);font-size:12.5px}
  .decision .d-body{padding:20px 24px 22px}
  .decision h2{font-size:21px;letter-spacing:-.01em;margin:0 0 4px;font-weight:700}
  .decision .who{color:var(--text-3);font-size:12.5px;margin-bottom:14px}
  .decision p{margin:0 0 12px;color:var(--text);font-size:14.5px;line-height:1.62}
  .decision p:last-of-type{margin-bottom:0}
  .actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:18px;padding-top:16px;border-top:1px dashed var(--border)}
  .act{font-size:12px;font-weight:600;color:var(--text-3);border:1px solid var(--border);border-radius:7px;padding:5px 11px;background:var(--surface)}
  .act.chosen{color:#fff;background:#2b2a26;border-color:#2b2a26}
  .act-label{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3);font-weight:700;align-self:center;margin-right:4px}

  .log .li{display:flex;gap:12px;padding:11px 0;border-bottom:1px solid var(--border-soft);align-items:baseline}
  .log .li:last-child{border-bottom:none}
  .log .lt{color:var(--text-3);font-size:12px;flex:0 0 64px;font-variant-numeric:tabular-nums}
  .log .lx{font-size:13.5px;color:var(--text)}
  .log .lx .em{color:var(--text-2)}

  .tbl{width:100%;border-collapse:collapse;font-size:13.5px}
  .tbl thead th{text-align:left;font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-3);font-weight:700;padding:11px 14px;border-bottom:1px solid var(--border);background:var(--surface-2);white-space:nowrap}
  .tbl tbody td{padding:12px 14px;border-bottom:1px solid var(--border-soft);vertical-align:middle}
  .tbl tbody tr:last-child td{border-bottom:none}
  .tbl tbody tr:hover{background:var(--surface-2)}
  .tbl .num{font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
  .tbl .pft{color:var(--green);font-weight:600;font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
  .who-cell{display:flex;align-items:center;gap:9px}
  .av-sm{width:22px;height:22px;border-radius:50%;flex:0 0 22px}
  .handle{font-weight:600;color:var(--text)}
  .muted{color:var(--text-2)} .muted-sm{color:var(--text-3);font-size:12px}

  .status{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;white-space:nowrap}
  .status::before{content:"";width:7px;height:7px;border-radius:50%}
  .s-review{color:var(--blue)} .s-review::before{background:var(--blue)}
  .s-accept{color:var(--green)} .s-accept::before{background:var(--green-live)}
  .s-prop{color:var(--amber)} .s-prop::before{background:var(--amber)}
  .s-unassigned{color:var(--red)} .s-unassigned::before{background:var(--red)}

  .rep-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
  .rep{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:18px 19px;box-shadow:var(--shadow);cursor:pointer;transition:border-color .15s,transform .15s}
  .rep:hover{border-color:#cfcabd;transform:translateY(-1px)}
  .rep .r-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:11px}
  .rep .r-name{font-weight:700;font-size:15px;letter-spacing:-.01em}
  .rep .r-take{color:var(--text-2);font-size:13px;line-height:1.5;margin-bottom:13px;min-height:38px}
  .rep .r-foot{display:flex;justify-content:space-between;align-items:center;font-size:12px;color:var(--text-3);border-top:1px solid var(--border-soft);padding-top:11px}
  .rep .r-foot .go{color:var(--blue);font-weight:600;display:flex;align-items:center;gap:4px}

  .op-group{margin-bottom:26px}
  .op{display:flex;gap:14px;padding:16px 0;border-bottom:1px solid var(--border-soft)}
  .op:last-child{border-bottom:none}
  .op .av{width:38px;height:38px;border-radius:50%;flex:0 0 38px}
  .op .o-main{flex:1;min-width:0}
  .op .o-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:4px}
  .op .o-handle{font-weight:700;font-size:14.5px}
  .op .o-meta{font-size:12px;color:var(--text-3)}
  .op .o-desc{color:var(--text-2);font-size:13.5px;line-height:1.55}
  .op .o-task{margin-top:8px;font-size:12.5px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .o-task .lbl{color:var(--text-3);font-weight:600;text-transform:uppercase;font-size:10.5px;letter-spacing:.05em}

  .pipe{display:flex;align-items:stretch;margin:0 0 22px;border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;background:var(--surface);box-shadow:var(--shadow)}
  .pipe .step{flex:1;padding:14px 16px;position:relative;min-width:0}
  .pipe .step:not(:last-child){border-right:1px solid var(--border-soft)}
  .pipe .s-num{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;font-size:11px;font-weight:700;background:var(--green-bg);color:var(--green);margin-bottom:9px}
  .pipe .s-name{font-weight:700;font-size:13.5px;margin-bottom:3px}
  .pipe .s-meta{font-size:11.5px;color:var(--text-3)}
  .pipe .s-stamp{font-size:11px;color:var(--green);font-weight:600;display:flex;align-items:center;gap:5px;margin-top:7px}

  .body-copy{font-size:14.5px;line-height:1.62;color:var(--text)}
  .body-copy p{margin:0 0 13px}
  .body-copy p:last-child{margin-bottom:0}

  .findings .f{display:flex;gap:14px;padding:13px 0;border-bottom:1px solid var(--border-soft);align-items:flex-start}
  .findings .f:last-child{border-bottom:none}
  .findings .f-repo{flex:0 0 188px;font-family:var(--mono);font-size:12.5px;color:var(--text);font-weight:600}
  .findings .f-claim{flex:1;color:var(--text-2);font-size:13px}
  .findings .f-claim .q{color:var(--text);font-style:italic}
  .findings .f-status{flex:0 0 auto;text-align:right}
  .findings .f-note{display:block;font-size:12px;color:var(--text-3);margin-top:4px}

  .verify{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:700}
  .v-ok{color:var(--green)} .v-warn{color:var(--amber)} .v-bad{color:var(--red)}

  .imp{display:flex;gap:14px;padding:14px 0;border-bottom:1px solid var(--border-soft);align-items:flex-start}
  .imp:last-child{border-bottom:none}
  .prio{flex:0 0 auto;font-size:11px;font-weight:700;border-radius:6px;padding:3px 9px;letter-spacing:.03em}
  .p0{background:var(--red-bg);color:var(--red)} .p1{background:var(--amber-bg);color:var(--amber)} .p2{background:var(--surface-3);color:var(--text-2)}
  .imp .i-main{flex:1}
  .imp .i-title{font-weight:600;font-size:14px;margin-bottom:3px}
  .imp .i-desc{color:var(--text-2);font-size:13px;line-height:1.5}

  .feedback-box{background:var(--surface-2);border:1px solid var(--border-soft);border-radius:var(--radius-sm);padding:16px 18px;margin-top:6px}
  .feedback-box .fq{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px dashed var(--border);font-size:13.5px}
  .feedback-box .fq:last-child{border-bottom:none}
  .feedback-box .fq .ct{color:var(--text-3);font-variant-numeric:tabular-nums}

  .exec{display:flex;gap:14px;padding:16px 0;border-bottom:1px solid var(--border-soft)}
  .exec:last-child{border-bottom:none}
  .exec .av{width:34px;height:34px;border-radius:50%;flex:0 0 34px}
  .exec .e-main{flex:1}
  .exec .e-head{display:flex;align-items:center;gap:9px;margin-bottom:5px}
  .exec .e-name{font-weight:700;font-size:14px}
  .exec .e-role{font-size:11.5px;color:var(--text-3)}
  .exec .e-quote{color:var(--text);font-size:13.5px;line-height:1.55;margin-bottom:8px}
  .exec .e-tags{display:flex;gap:7px;flex-wrap:wrap}
  .tag{font-size:11.5px;border-radius:6px;padding:3px 9px;background:var(--surface-2);border:1px solid var(--border-soft);color:var(--text-2)}
  .tag b{color:var(--text);font-weight:600}

  .panel-head{margin-bottom:18px}
  .panel-head h2{font-size:22px;letter-spacing:-.015em;margin:0 0 5px;font-weight:700}
  .panel-head .ph-meta{display:flex;gap:10px;flex-wrap:wrap;align-items:center;color:var(--text-3);font-size:12.5px}
  .panel-head .ph-meta .sep{color:var(--border)}

  .table-wrap{overflow-x:auto}
  .table-cap{font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--text-3);font-weight:700;padding:14px 18px 4px}
  .more{padding:12px 14px;color:var(--text-3);font-size:12.5px;text-align:center;border-top:1px solid var(--border-soft)}
  .menu-btn{display:none}

  @media (max-width:1080px){.kpis{grid-template-columns:repeat(3,1fr)}.rep-grid{grid-template-columns:repeat(2,1fr)}}
  @media (max-width:860px){
    .sidebar{display:none}
    .page{padding:22px 18px 50px}
    h1.title{font-size:31px}
    .head{flex-direction:column;gap:14px}
    .head-meta{text-align:left}
    .grid2{grid-template-columns:1fr}
    .pipe{flex-direction:column}
    .pipe .step:not(:last-child){border-right:none;border-bottom:1px solid var(--border-soft)}
    .findings .f{flex-wrap:wrap}
    .findings .f-repo{flex-basis:100%}
    .menu-btn{display:inline-flex}
  }
  @media (max-width:560px){.kpis{grid-template-columns:repeat(2,1fr)}.rep-grid{grid-template-columns:1fr}}
`;