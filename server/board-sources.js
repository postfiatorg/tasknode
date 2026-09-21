// Remote grounding sources for board packets.
//
// The manager used to ground tasks in checkouts on the operator host. Those
// do not exist where the API runs and drift on the host (a divergent local
// branch paused a whole board). Every source here is fetched from its
// canonical remote, cached with a fetched_at timestamp, and reported with an
// explicit status so an outage is a visible input problem, never a silent
// "nothing to route".
import { query as defaultQuery } from "./db/pool.js";

export const SOURCE_TTL_MS = 30 * 60_000;
const FETCH_TIMEOUT_MS = 12_000;

// Repo names in board metadata are short names; map them to canonical remotes.
// Override or extend with TASKNODE_BOARD_SOURCE_REPO_MAP='{"name":"owner/repo"}'.
export const DEFAULT_REPO_MAP = {
  postfiatl1v2: "postfiatorg/postfiatl1v2",
  tasknodeofficial: "postfiatorg/tasknode",
  tasknode: "postfiatorg/tasknode",
  "postfiatorg.github.io": "postfiatorg/postfiatorg.github.io",
  "goodalexander.github.io": "goodalexander/goodalexander.github.io",
  agti: "postfiatorg/agti",
  "dynamic-unl-scoring": "postfiatorg/dynamic-unl-scoring",
  PfTerminal: "CorbanuCore/CorbanuTerminal",
  CorbanuTerminal: "CorbanuCore/CorbanuTerminal",
};

export function resolveRepoFullName(name, env = process.env) {
  const text = String(name || "").trim();
  if (!text) return "";
  let map = DEFAULT_REPO_MAP;
  if (env.TASKNODE_BOARD_SOURCE_REPO_MAP) {
    try { map = { ...DEFAULT_REPO_MAP, ...JSON.parse(env.TASKNODE_BOARD_SOURCE_REPO_MAP) }; } catch { map = DEFAULT_REPO_MAP; }
  }
  if (/^[\w.-]+\/[\w.-]+$/.test(text)) return text;
  return map[text] || "";
}

function firstLine(text = "") { return String(text || "").split("\n")[0].slice(0, 200); }

async function fetchJson(url, { headers = {}, fetchImpl = fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const response = await fetchImpl(url, { headers: { accept: "application/vnd.github+json", "user-agent": "tasknode-board-sources", ...headers }, signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
  if (!response.ok) {
    const error = new Error(`source_http_${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

export async function fetchGitHubRepoSnapshot(fullName, { token = process.env.GITHUB_SOURCE_TOKEN || "", fetchImpl = fetch } = {}) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const base = `https://api.github.com/repos/${fullName}`;
  const repo = await fetchJson(base, { headers, fetchImpl });
  const [commits, issues, pulls] = await Promise.all([
    fetchJson(`${base}/commits?per_page=15`, { headers, fetchImpl }).catch(() => []),
    fetchJson(`${base}/issues?state=open&per_page=30&sort=updated`, { headers, fetchImpl }).catch(() => []),
    fetchJson(`${base}/pulls?state=open&per_page=15&sort=updated`, { headers, fetchImpl }).catch(() => []),
  ]);
  let readmeExcerpt = "";
  try {
    const readme = await fetchJson(`${base}/readme`, { headers: { ...headers, accept: "application/vnd.github.raw+json" }, fetchImpl });
    readmeExcerpt = typeof readme === "string" ? readme.slice(0, 4000) : "";
  } catch {
    try {
      const response = await fetchImpl(`${base}/readme`, { headers: { ...headers, accept: "application/vnd.github.raw", "user-agent": "tasknode-board-sources" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      readmeExcerpt = response.ok ? (await response.text()).slice(0, 4000) : "";
    } catch { readmeExcerpt = ""; }
  }
  return {
    full_name: repo.full_name || fullName,
    html_url: repo.html_url || `https://github.com/${fullName}`,
    default_branch: repo.default_branch || "",
    pushed_at: repo.pushed_at || null,
    open_issues_count: Number(repo.open_issues_count || 0),
    head_sha: Array.isArray(commits) && commits[0]?.sha ? commits[0].sha : "",
    recent_commits: (Array.isArray(commits) ? commits : []).slice(0, 15).map((item) => ({
      sha: String(item.sha || "").slice(0, 12), date: item.commit?.author?.date || item.commit?.committer?.date || null,
      author: item.commit?.author?.name || item.author?.login || "", message: firstLine(item.commit?.message),
    })),
    open_issues: (Array.isArray(issues) ? issues : []).filter((item) => !item.pull_request).slice(0, 25).map((item) => ({
      number: item.number, title: String(item.title || "").slice(0, 200), labels: (item.labels || []).map((label) => label.name || label).slice(0, 8),
      updated_at: item.updated_at || null, url: item.html_url || "", comments: Number(item.comments || 0),
    })),
    open_pulls: (Array.isArray(pulls) ? pulls : []).slice(0, 15).map((item) => ({
      number: item.number, title: String(item.title || "").slice(0, 200), draft: Boolean(item.draft), updated_at: item.updated_at || null, url: item.html_url || "", author: item.user?.login || "",
    })),
    readme_excerpt: readmeExcerpt,
  };
}

export async function fetchXAccountSnapshot(handle, { bearer = process.env.X_BEARER_TOKEN || "", fetchImpl = fetch } = {}) {
  if (!bearer) throw Object.assign(new Error("x_api_not_configured"), { status: 409 });
  const headers = { authorization: `Bearer ${bearer}`, "user-agent": "tasknode-board-sources" };
  const user = await fetchJson(`https://api.x.com/2/users/by/username/${encodeURIComponent(handle)}?user.fields=public_metrics`, { headers, fetchImpl });
  const id = user?.data?.id;
  if (!id) throw new Error("x_user_not_found");
  const posts = await fetchJson(`https://api.x.com/2/users/${id}/tweets?max_results=10&exclude=replies,retweets&tweet.fields=created_at,public_metrics`, { headers, fetchImpl });
  return {
    handle, user_id: id, followers: Number(user.data.public_metrics?.followers_count || 0),
    recent_posts: (posts?.data || []).map((post) => ({
      id: post.id, url: `https://x.com/${handle}/status/${post.id}`, created_at: post.created_at || null,
      text: String(post.text || "").slice(0, 600), likes: Number(post.public_metrics?.like_count || 0), reposts: Number(post.public_metrics?.retweet_count || 0),
    })),
  };
}

export async function fetchWebsiteSnapshot(url, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, { headers: { "user-agent": "tasknode-board-sources" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "follow" });
  const text = response.ok ? (await response.text()).slice(0, 200_000) : "";
  const title = /<title[^>]*>([^<]{0,200})<\/title>/i.exec(text)?.[1]?.trim() || "";
  if (!response.ok) throw Object.assign(new Error(`source_http_${response.status}`), { status: response.status });
  return { url, http_status: response.status, title, bytes: text.length, last_modified: response.headers.get("last-modified") || null };
}

export function sourceDescriptorsForBoard(board = {}) {
  const sources = board?.metadata_json?.sources || board?.sources || {};
  const descriptors = [];
  for (const repo of Array.isArray(sources.repos) ? sources.repos : []) {
    const fullName = resolveRepoFullName(repo);
    descriptors.push({ id: `repo:${repo}`, kind: "github_repo", reference: fullName, unresolved: !fullName });
  }
  for (const handle of Array.isArray(sources.x_accounts) ? sources.x_accounts : []) descriptors.push({ id: `x:${handle}`, kind: "x_account", reference: String(handle).replace(/^@/, "") });
  for (const url of Array.isArray(sources.websites) ? sources.websites : []) descriptors.push({ id: `web:${url}`, kind: "website", reference: String(url) });
  return descriptors;
}

async function fetchSnapshot(descriptor, fetchers) {
  if (descriptor.kind === "github_repo") return fetchers.github(descriptor.reference);
  if (descriptor.kind === "x_account") return fetchers.x(descriptor.reference);
  if (descriptor.kind === "website") return fetchers.website(descriptor.reference);
  throw new Error("source_kind_unsupported");
}

// Returns one entry per declared source with status fresh|stale|unavailable.
// stale = an older snapshot is served because the refresh failed; the error is
// attached. unavailable = nothing usable was ever fetched.
export async function readBoardSources(board, { queryImpl = defaultQuery, now = Date.now(), ttlMs = SOURCE_TTL_MS, fetchers = {}, force = false, env = process.env } = {}) {
  // Fixtures and offline runs: declared sources are reported, never fetched.
  if (env.TASKNODE_BOARD_SOURCES_OFFLINE === "true" && !Object.keys(fetchers).length) {
    return sourceDescriptorsForBoard(board).map((descriptor) => ({ id: descriptor.id, kind: descriptor.kind, reference: descriptor.reference, status: "unavailable", fetched_at: null, error: "sources_offline" }));
  }
  const active = { github: fetchGitHubRepoSnapshot, x: fetchXAccountSnapshot, website: fetchWebsiteSnapshot, ...fetchers };
  const results = [];
  for (const descriptor of sourceDescriptorsForBoard(board)) {
    if (descriptor.unresolved) { results.push({ id: descriptor.id, kind: descriptor.kind, reference: "", status: "unavailable", fetched_at: null, error: "repo_not_mapped: add it to TASKNODE_BOARD_SOURCE_REPO_MAP" }); continue; }
    const key = `${descriptor.kind}:${descriptor.reference}`;
    const cached = (await queryImpl("SELECT status,payload_json,error,fetched_at FROM board_source_snapshots WHERE source_key=$1", [key])).rows[0] || null;
    const fetchedAt = cached?.fetched_at ? Date.parse(cached.fetched_at) : NaN;
    const fresh = Number.isFinite(fetchedAt) && now - fetchedAt < ttlMs && cached.status !== "unavailable";
    if (fresh && !force) { results.push({ id: descriptor.id, kind: descriptor.kind, reference: descriptor.reference, status: "fresh", fetched_at: cached.fetched_at, error: "", ...cached.payload_json }); continue; }
    try {
      const payload = await fetchSnapshot(descriptor, active);
      const fetchedIso = new Date(now).toISOString();
      await queryImpl(`INSERT INTO board_source_snapshots (source_key,kind,reference,status,payload_json,error,fetched_at,updated_at)
        VALUES ($1,$2,$3,'fresh',$4::jsonb,'',$5,now())
        ON CONFLICT (source_key) DO UPDATE SET status='fresh',payload_json=EXCLUDED.payload_json,error='',fetched_at=EXCLUDED.fetched_at,updated_at=now()`,
      [key, descriptor.kind, descriptor.reference, JSON.stringify(payload), fetchedIso]);
      results.push({ id: descriptor.id, kind: descriptor.kind, reference: descriptor.reference, status: "fresh", fetched_at: fetchedIso, error: "", ...payload });
    } catch (error) {
      const message = String(error?.message || error).slice(0, 300);
      const status = cached?.payload_json && Object.keys(cached.payload_json).length ? "stale" : "unavailable";
      await queryImpl(`INSERT INTO board_source_snapshots (source_key,kind,reference,status,payload_json,error,fetched_at,updated_at)
        VALUES ($1,$2,$3,$4,'{}'::jsonb,$5,NULL,now())
        ON CONFLICT (source_key) DO UPDATE SET status=EXCLUDED.status,error=EXCLUDED.error,updated_at=now()`,
      [key, descriptor.kind, descriptor.reference, status, message]).catch(() => null);
      results.push({ id: descriptor.id, kind: descriptor.kind, reference: descriptor.reference, status, fetched_at: cached?.fetched_at || null, error: message, ...(status === "stale" ? cached.payload_json : {}) });
    }
  }
  return results;
}

export function summarizeSources(sources = []) {
  return sources.map((source) => `${source.id}: ${source.status}${source.fetched_at ? ` (${source.fetched_at})` : ""}${source.error ? ` ${source.error}` : ""}`);
}

// Durable operator action items on a board: a blocker that only the operator
// can clear is recorded once with an owner, surfaced in every packet and in
// runtime status, and resolved explicitly. It is not repeated as prose.
export function normalizeOperatorActions(list) {
  return (Array.isArray(list) ? list : []).filter((item) => item && typeof item === "object" && typeof item.id === "string").map((item) => ({
    id: String(item.id).slice(0, 80), description: String(item.description || "").slice(0, 600), owner: String(item.owner || "operator").slice(0, 120),
    since: item.since || null, resolved_at: item.resolved_at || null, resolution: String(item.resolution || "").slice(0, 600),
  }));
}
