#!/usr/bin/env node
// bot-merge: auto-merge allowlisted bot pull requests once their CI light is lit,
// and open a revert PR if main goes dark after a bot-merge.
//
// Light rule (active-low):
//   lit  = 0  -> at least one check exists and every one concluded "success"
//   dark = 1  -> anything else: failure, cancelled, skipped, timed out,
//                neutral, still running, or no checks at all
//
// Zero dependencies. Requires Node 20+ (global fetch).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const LIT = 0;
export const DARK = 1;

export const HOLD_LABEL = 'bot-merge:hold';
export const MERGED_LABEL = 'bot-merge:merged';
export const MARKER_RE = /^Bot-Merge:\s*#(\d+)\s*$/m;

export const DEFAULT_CONFIG = Object.freeze({
  bots: [],
  mergeMethod: 'squash',
  requiredLight: 'lit',
  baseBranch: 'main',
  ignoreChecks: ['bot-merge', 'revert-guard'],
  dispatchCiWorkflow: null,
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export function validateConfig(raw) {
  const cfg = { ...DEFAULT_CONFIG, ...(raw || {}) };
  const errors = [];
  if (!Array.isArray(cfg.bots) || cfg.bots.some((b) => typeof b !== 'string' || !b)) {
    errors.push('"bots" must be an array of non-empty login strings');
  }
  if (!['squash', 'merge', 'rebase'].includes(cfg.mergeMethod)) {
    errors.push('"mergeMethod" must be one of squash, merge, rebase');
  }
  if (cfg.requiredLight !== 'lit') {
    errors.push('"requiredLight" must be "lit" (the only light bot-merge will merge on)');
  }
  if (typeof cfg.baseBranch !== 'string' || !cfg.baseBranch) {
    errors.push('"baseBranch" must be a non-empty string');
  }
  if (!Array.isArray(cfg.ignoreChecks)) {
    errors.push('"ignoreChecks" must be an array of check names');
  }
  if (cfg.dispatchCiWorkflow != null && typeof cfg.dispatchCiWorkflow !== 'string') {
    errors.push('"dispatchCiWorkflow" must be a workflow file name or null');
  }
  if (errors.length) throw new Error(`Invalid bot-merge config: ${errors.join('; ')}`);
  cfg.bots = cfg.bots.map((b) => b.toLowerCase());
  return cfg;
}

export function loadConfig(file) {
  return validateConfig(JSON.parse(readFileSync(file, 'utf8')));
}

// ---------------------------------------------------------------------------
// Pure decision logic
// ---------------------------------------------------------------------------

/**
 * Compute the light for a set of check runs (and optional legacy commit statuses).
 * Returns { light, settled, total, dark: [{name, state}] }.
 *   settled = every considered check has finished (none queued / in progress / pending).
 */
export function lightFromChecks(checkRuns = [], statuses = [], ignore = []) {
  const ignored = new Set(ignore.map((n) => n.toLowerCase()));
  const runs = checkRuns.filter((r) => !ignored.has(String(r.name).toLowerCase()));
  const stats = statuses.filter((s) => !ignored.has(String(s.context).toLowerCase()));
  const dark = [];
  let settled = true;
  for (const r of runs) {
    if (r.status !== 'completed') {
      settled = false;
      dark.push({ name: r.name, state: r.status || 'unknown' });
    } else if (r.conclusion !== 'success') {
      dark.push({ name: r.name, state: r.conclusion || 'unknown' });
    }
  }
  for (const s of stats) {
    if (s.state === 'pending') settled = false;
    if (s.state !== 'success') dark.push({ name: s.context, state: s.state });
  }
  const total = runs.length + stats.length;
  if (total === 0) {
    return { light: DARK, settled: false, total, dark: [{ name: '(no checks)', state: 'missing' }] };
  }
  return { light: dark.length === 0 ? LIT : DARK, settled, total, dark };
}

export function isAllowlistedBot(login, cfg) {
  return typeof login === 'string' && cfg.bots.includes(login.toLowerCase());
}

/** Decide whether a PR may be merged given its light. Returns { merge, reason }. */
export function evaluatePr(pr, light, cfg) {
  const login = pr?.user?.login;
  if (!isAllowlistedBot(login, cfg)) return { merge: false, reason: `author ${login} is not an allowlisted bot` };
  if (pr.draft) return { merge: false, reason: 'draft' };
  if (pr.state && pr.state !== 'open') return { merge: false, reason: `state ${pr.state}` };
  const labels = (pr.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
  if (labels.includes(HOLD_LABEL)) return { merge: false, reason: `has ${HOLD_LABEL} label` };
  if (pr.base?.ref && pr.base.ref !== cfg.baseBranch) return { merge: false, reason: `base is ${pr.base.ref}, not ${cfg.baseBranch}` };
  if (light !== LIT) return { merge: false, reason: 'light is dark' };
  return { merge: true, reason: 'allowlisted bot, light is lit' };
}

export function parseMarker(message) {
  const m = MARKER_RE.exec(message || '');
  return m ? Number(m[1]) : null;
}

export function mergeCommitMessage(pr) {
  const body = (pr.body || '').trim();
  return `${body ? body + '\n\n' : ''}Bot-Merge: #${pr.number}\nBot-Merge-Light: lit`;
}

// ---------------------------------------------------------------------------
// GitHub API client (fetch based)
// ---------------------------------------------------------------------------

export class ApiError extends Error {
  constructor(status, method, url, body) {
    super(`${method} ${url} -> ${status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    this.status = status;
  }
}

export function createApi({ token, repo, baseUrl = 'https://api.github.com', fetchImpl = globalThis.fetch }) {
  if (!token) throw new Error('GITHUB_TOKEN is required');
  if (!repo) throw new Error('GITHUB_REPOSITORY is required');
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'bot-merge',
  };
  const toUrl = (p) => (p.startsWith('http') ? p : `${baseUrl}/repos/${repo}${p}`);
  async function raw(method, p, body) {
    const url = toUrl(p);
    const res = await fetchImpl(url, {
      method,
      headers: body ? { ...headers, 'Content-Type': 'application/json' } : headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = text;
    try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    if (!res.ok) throw new ApiError(res.status, method, url, data);
    return { data, link: res.headers.get('link') };
  }
  return {
    repo,
    async request(method, p, body) {
      return (await raw(method, p, body)).data;
    },
    /** GET every page. `key` picks the array out of wrapped responses (e.g. check_runs). */
    async paginate(p, key) {
      const out = [];
      let next = p + (p.includes('?') ? '&' : '?') + 'per_page=100';
      while (next) {
        const { data, link } = await raw('GET', next);
        out.push(...(key ? data[key] : data));
        const m = /<([^>]+)>;\s*rel="next"/.exec(link || '');
        next = m ? m[1] : null;
      }
      return out;
    },
  };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export async function computeLight(api, sha, cfg) {
  const runs = await api.paginate(`/commits/${sha}/check-runs?filter=latest`, 'check_runs');
  const combined = await api.request('GET', `/commits/${sha}/status`);
  return lightFromChecks(runs, combined?.statuses || [], cfg.ignoreChecks);
}

async function dispatchCi(api, cfg, ref, log) {
  if (!cfg.dispatchCiWorkflow) return;
  try {
    await api.request('POST', `/actions/workflows/${cfg.dispatchCiWorkflow}/dispatches`, { ref });
    log(`  dispatched ${cfg.dispatchCiWorkflow} on ${ref}`);
  } catch (e) {
    log(`  could not dispatch ${cfg.dispatchCiWorkflow} on ${ref}: ${e.message}`);
  }
}

/** Scan open PRs and merge every allowlisted, non-held bot PR whose light is lit. */
export async function runMerge(api, cfg, log = console.log) {
  const prs = await api.paginate(`/pulls?state=open&base=${encodeURIComponent(cfg.baseBranch)}`);
  const results = [];
  for (const pr of prs) {
    const pre = evaluatePr(pr, LIT, cfg); // everything except the light
    if (!pre.merge) {
      log(`#${pr.number} skip: ${pre.reason}`);
      results.push({ number: pr.number, merged: false, reason: pre.reason });
      continue;
    }
    const sha = pr.head.sha;
    const l = await computeLight(api, sha, cfg);
    const verdict = evaluatePr(pr, l.light, cfg);
    const lightName = l.light === LIT ? 'lit' : 'dark';
    if (!verdict.merge) {
      const why = l.dark.map((d) => `${d.name}=${d.state}`).join(', ');
      log(`#${pr.number} skip: ${verdict.reason} (${lightName}=${l.light}; ${why})`);
      results.push({ number: pr.number, merged: false, reason: verdict.reason, light: l.light });
      continue;
    }
    try {
      const body = { merge_method: cfg.mergeMethod, sha };
      if (cfg.mergeMethod !== 'rebase') {
        body.commit_title = `${pr.title} (#${pr.number})`;
        body.commit_message = mergeCommitMessage(pr);
      }
      const res = await api.request('PUT', `/pulls/${pr.number}/merge`, body);
      log(`#${pr.number} MERGED at ${sha.slice(0, 7)} -> ${res?.sha} (light lit=${l.light}, ${l.total} checks)`);
      try {
        await api.request('POST', `/issues/${pr.number}/labels`, { labels: [MERGED_LABEL] });
      } catch (e) {
        log(`  could not label #${pr.number}: ${e.message}`);
      }
      results.push({ number: pr.number, merged: true, reason: verdict.reason, light: l.light, mergeSha: res?.sha });
    } catch (e) {
      log(`#${pr.number} merge failed: ${e.message}`);
      results.push({ number: pr.number, merged: false, reason: `merge failed: ${e.status ?? ''}`, light: l.light });
    }
  }
  if (results.some((r) => r.merged)) await dispatchCi(api, cfg, cfg.baseBranch, log);
  return results;
}

async function refExists(api, ref) {
  try {
    await api.request('GET', `/git/ref/heads/${ref}`);
    return true;
  } catch (e) {
    if (e.status === 404) return false;
    throw e;
  }
}

/** Identify whether a commit on the base branch was produced by bot-merge. Returns PR number or null. */
export async function botMergeOrigin(api, commit) {
  const fromMarker = parseMarker(commit.commit?.message);
  if (fromMarker) return fromMarker;
  try {
    const pulls = await api.request('GET', `/commits/${commit.sha}/pulls`);
    const hit = (pulls || []).find(
      (p) => p.merge_commit_sha === commit.sha && (p.labels || []).some((l) => l.name === MERGED_LABEL),
    );
    return hit ? hit.number : null;
  } catch {
    return null;
  }
}

/**
 * Revert guard: if the head of the base branch came from a bot-merge and its light is dark
 * (and every check has finished), open a revert PR on revert/<sha> and an issue.
 * Never force-pushes or rewrites history.
 */
export async function runGuard(api, cfg, sha, log = console.log) {
  if (!sha) sha = (await api.request('GET', `/branches/${encodeURIComponent(cfg.baseBranch)}`)).commit.sha;
  const commit = await api.request('GET', `/commits/${sha}`);
  const prNumber = await botMergeOrigin(api, commit);
  if (!prNumber) {
    log(`guard: ${sha.slice(0, 7)} did not come from bot-merge; nothing to do`);
    return { action: 'none', reason: 'not a bot-merge' };
  }
  const l = await computeLight(api, sha, cfg);
  if (!l.settled) {
    log(`guard: ${sha.slice(0, 7)} (bot-merge of #${prNumber}) checks not finished yet; waiting`);
    return { action: 'none', reason: 'not settled' };
  }
  if (l.light === LIT) {
    log(`guard: ${sha.slice(0, 7)} (bot-merge of #${prNumber}) is lit (0); all good`);
    return { action: 'none', reason: 'lit' };
  }
  const branch = `revert/${sha}`;
  if (await refExists(api, branch)) {
    log(`guard: ${branch} already exists; not opening another revert`);
    return { action: 'none', reason: 'revert already exists' };
  }
  const parentSha = commit.parents?.[0]?.sha;
  if (!parentSha) throw new Error(`commit ${sha} has no parent to revert to`);
  const parent = await api.request('GET', `/git/commits/${parentSha}`);
  const title = (commit.commit.message || '').split('\n')[0];
  const darkList = l.dark.map((d) => `- \`${d.name}\`: ${d.state}`).join('\n');
  const revert = await api.request('POST', '/git/commits', {
    message: `Revert "${title}"\n\nThis reverts commit ${sha}.\nmain went dark (1) after the bot-merge of #${prNumber}.`,
    tree: parent.tree.sha,
    parents: [sha],
  });
  await api.request('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha: revert.sha });
  const pr = await api.request('POST', '/pulls', {
    title: `Revert "${title}"`,
    head: branch,
    base: cfg.baseBranch,
    body:
      `bot-merge revert guard: \`${cfg.baseBranch}\` went **dark** (1) at ${sha} after the bot-merge of #${prNumber}.\n\n` +
      `Dark checks:\n${darkList}\n\n` +
      `This PR restores the tree of ${parentSha}. It carries \`${HOLD_LABEL}\` so a human decides whether to merge it.`,
  });
  try {
    await api.request('POST', `/issues/${pr.number}/labels`, { labels: [HOLD_LABEL] });
  } catch (e) {
    log(`  could not label revert PR: ${e.message}`);
  }
  const issue = await api.request('POST', '/issues', {
    title: `${cfg.baseBranch} went dark after bot-merge of #${prNumber}`,
    body:
      `The bot-merge of #${prNumber} (commit ${sha}) left \`${cfg.baseBranch}\` **dark** (1).\n\n` +
      `Dark checks:\n${darkList}\n\nRevert PR: #${pr.number}`,
  });
  await dispatchCi(api, cfg, branch, log);
  log(`guard: ${sha.slice(0, 7)} is dark; opened revert PR #${pr.number} and issue #${issue.number}`);
  return { action: 'revert', pr: pr.number, issue: issue.number, branch };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `usage: bot-merge.mjs <light <sha> | merge | guard [sha]> [--config bot-merge.json]
  light <sha>  print the light for a commit; exit 0 if lit, 1 if dark
  merge        merge every allowlisted bot PR whose light is lit
  guard [sha]  open a revert PR + issue if a bot-merge left the base branch dark`;

export async function main(argv = process.argv.slice(2), env = process.env) {
  const ci = argv.indexOf('--config');
  const configPath = ci >= 0 ? argv.splice(ci, 2)[1] : 'bot-merge.json';
  const [cmd, arg] = argv;
  if (!['light', 'merge', 'guard'].includes(cmd)) {
    console.error(USAGE);
    return 2;
  }
  const cfg = loadConfig(configPath);
  const api = createApi({ token: env.GITHUB_TOKEN, repo: env.GITHUB_REPOSITORY });
  if (cmd === 'light') {
    if (!arg) { console.error(USAGE); return 2; }
    const l = await computeLight(api, arg, cfg);
    console.log(`${arg}: ${l.light === LIT ? 'lit' : 'dark'} (${l.light}); ${l.total} checks; settled=${l.settled}`);
    for (const d of l.dark) console.log(`  dark: ${d.name}=${d.state}`);
    return l.light;
  }
  if (cmd === 'merge') {
    const r = await runMerge(api, cfg);
    console.log(`merge: ${r.filter((x) => x.merged).length} merged, ${r.filter((x) => !x.merged).length} skipped`);
    return 0;
  }
  await runGuard(api, cfg, arg || null);
  return 0;
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  main().then(
    (code) => process.exit(code),
    (err) => { console.error(`bot-merge error: ${err.message}`); process.exit(2); },
  );
}
