#!/usr/bin/env node
// open-merge-scan.mjs — READ-ONLY scanner for public repos whose GitHub Actions
// will merge ANY pull request (no author/allowlist check, no required review,
// no required lit CI check). Node 20, zero deps.
//
// HARD SAFETY: this tool only READS. It performs GitHub code search and fetches
// workflow file contents (contents API, base64). It never opens PRs/issues/
// comments/forks/advisories, never submits a PR to any scanned repo, never sends
// anything, never prints tokens.
//
// Terminology: lit = success, dark = anything else. (Never green/red.)

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, readFileSync, mkdirSync, appendFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Pattern libraries (exported for tests)
// ---------------------------------------------------------------------------

// Any primitive that can merge a PR (used to decide "is there a merge at all").
export const MERGE_PATTERNS = [
  { id: 'gh-pr-merge',             re: /gh\s+pr\s+merge/i },
  { id: 'enable-automerge-action', re: /peter-evans\/enable-pull-request-automerge/i },
  { id: 'automerge-action',        re: /pascalgn\/automerge-action/i },
  { id: 'enable-automerge',        re: /\benable-automerge\b|--auto\b/i },
  { id: 'rest-pulls-merge',        re: /(?:rest|octokit|github)[^\n]*pulls\.merge|\bpulls\.merge\s*\(/i },
  { id: 'pulls-merge-api',         re: /pulls\/[^\s"'`]*\/merge\b/i },
  { id: 'graphql-merge',           re: /mergePullRequest/i },
];

// Author/actor allowlist gate.
export const ALLOWLIST_PATTERNS = [
  /github\.actor\s*(==|!=)/i,
  /github\.event\.pull_request\.user\.login\s*(==|!=|\bin\b)/i,
  /\.user\.login\s*(==|!=)/i,
  /event\.sender\.login\s*(==|!=)/i,
  /contains\s*\(\s*fromJSON/i,
  /\ballowlist\b|\ballow[-_ ]?list\b|\btrusted[-_ ]?(users|authors|bots)\b/i,
  /github\.actor[^\n]*dependabot|dependabot\[bot\][^\n]*github\.actor/i,
];

// Same-repo-only guard (restricts to PRs from the repo itself = push-access contributors).
export const SAME_REPO_PATTERNS = [
  /head\.repo\.full_name\s*==\s*github\.repository/i,
  /head\.repo\.fork\s*==\s*false/i,
  /!\s*github\.event\.pull_request\.head\.repo\.fork/i,
  /head\.repo\.full_name\s*!=\s*github\.repository/i, // branches that only act on same-repo
];

// Required review gate.
export const REVIEW_PATTERNS = [
  /required-approving-review-count/i,
  /reviewDecision/i,
  /\bAPPROVED\b/,
  /pull_request_review\b/i,
  /review.?required/i,
];

// Required lit CI / status-check gate.
export const CHECK_PATTERNS = [
  /wait[-_ ]?for[-_ ]?check/i,
  /wait[-_ ]?on[-_ ]?check/i,
  /lewagon\/wait-on-check-action/i,
  /fountainhead\/action-wait-for-check/i,
  /\bcheck[-_ ]?runs?\b/i,
  /mergeStateStatus/i,
  /mergeable_state/i,
  /required[_ ]status/i,
  /conclusion\s*==\s*['"]success['"]/i,
];

// Label-only gate (weak).
export const LABEL_PATTERNS = [
  /github\.event\.label\b/i,
  /labels\.\*\.name/i,
  /contains\s*\([^)]*labels/i,
  /\bMERGE_LABELS\b/i,
  /\bMERGE_FILTER_LABELS\b/i,
  /'(automerge|auto-merge|ready-to-merge|ready|merge)'/i,
];

// Guard expressions that exclude PR events (merge only runs on push/dispatch/etc).
export const EVENT_EXCLUDE_RE =
  /event_name\s*==\s*['"](push|workflow_dispatch|schedule|release|workflow_run)['"]|event_name\s*!=\s*['"]pull_request(_target)?['"]/i;

// Our own bot-merge pattern — skip.
export const SELF_PATTERNS = [/\bbot-merge\b/i, /fitzyracing1\/bot-merge/i];

// ---------------------------------------------------------------------------
// Static helpers (exported for tests)
// ---------------------------------------------------------------------------

export function anyMatch(text, patterns) {
  return patterns.some((p) => (p.re ? p.re : p).test(text));
}

export function matchedIds(text) {
  return MERGE_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.id);
}

export function stripNonMergeLines(block) {
  // Drop lines that mention merge tokens but do NOT perform a merge:
  // YAML comments, grep/ripgrep search patterns (guards that forbid merges),
  // echo/printf prose, and annotation lines.
  return block.split(/\r?\n/).filter((l) => {
    const t = l.trim();
    if (t.startsWith('#')) return false;
    if (/\bgrep\b|\brg\b|ripgrep/.test(l)) return false;
    if (/^\s*-?\s*(echo|printf)\b/.test(l)) return false;
    if (/::error|::warning|::notice/.test(l)) return false;
    return true;
  }).join('\n');
}

export function hasMergePrimitive(text) {
  const t = stripNonMergeLines(text);
  return MERGE_PATTERNS.some((p) => p.re.test(t));
}

// Extract the top-level `on:` block only (so we don't read github.event.pull_request
// inside an `if:` as a trigger).
export function extractOnBlock(text) {
  const lines = text.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^on\s*:/.test(lines[i])) { start = i; break; }
  }
  if (start === -1) return '';
  const inline = lines[start].replace(/^on\s*:/, '').trim();
  if (inline && !inline.startsWith('#')) return inline;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') { out.push(l); continue; }
    if (/^\S/.test(l)) break;
    out.push(l);
  }
  return out.join('\n');
}

export function triggers(text) {
  const on = extractOnBlock(text);
  return {
    pull_request: /\bpull_request\b(?!_target)/.test(on),
    pull_request_target: /\bpull_request_target\b/.test(on),
    issue_comment: /\bissue_comment\b/.test(on),
    workflow_run: /\bworkflow_run\b/.test(on),
    schedule: /\bschedule\b/.test(on),
    push: /\bpush\b/.test(on),
    workflow_dispatch: /\bworkflow_dispatch\b/.test(on),
  };
}

const indentOf = (l) => (l.match(/^(\s*)/)[1] || '').length;

// Split the jobs: section into { name, indent, body(lines) } per job.
export function collectJobs(text) {
  const lines = text.split(/\r?\n/);
  const ji = lines.findIndex((l) => /^jobs\s*:/.test(l));
  if (ji === -1) return [];
  const jobs = [];
  let jobIndent = null;
  let cur = null;
  for (let i = ji + 1; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === '' || /^\s*#/.test(raw)) { if (cur) cur.body.push(raw); continue; }
    if (/^\S/.test(raw)) break; // next top-level key ends jobs
    const ind = indentOf(raw);
    if (jobIndent === null) jobIndent = ind;
    if (ind === jobIndent && /^\s*[\w.-]+\s*:\s*(#.*)?$/.test(raw)) {
      cur = { name: raw.trim().replace(/:.*$/, ''), indent: jobIndent, body: [] };
      jobs.push(cur);
    } else if (cur) {
      cur.body.push(raw);
    }
  }
  return jobs;
}

// Within a job body, return the job-level `if:` expressions (direct children).
export function jobLevelIfs(bodyLines, jobIndent) {
  const child = jobIndent + 2;
  return bodyLines
    .filter((l) => indentOf(l) === child && /^\s*if\s*:/.test(l))
    .map((l) => l.replace(/^\s*if\s*:/, '').trim());
}

// Within a job body, split steps and return each step's text + its own if expressions.
export function stepsOf(bodyLines) {
  const idx = bodyLines.findIndex((l) => /^\s*steps\s*:/.test(l));
  if (idx === -1) return [];
  const stepsIndent = indentOf(bodyLines[idx]);
  const steps = [];
  let cur = null;
  for (let i = idx + 1; i < bodyLines.length; i++) {
    const l = bodyLines[i];
    if (l.trim() === '') { if (cur) cur.lines.push(l); continue; }
    const ind = indentOf(l);
    if (ind <= stepsIndent) break; // left the steps block
    if (/^\s*-\s/.test(l)) { cur = { lines: [l] }; steps.push(cur); }
    else if (cur) cur.lines.push(l);
  }
  return steps.map((s) => {
    const text = s.lines.join('\n');
    const ifs = s.lines
      .filter((x) => /(^|\s)if\s*:/.test(x))
      .map((x) => x.replace(/.*?if\s*:/, '').trim());
    return { text, ifs };
  });
}

// Determine the kind(s) of merge primitive in a block.
// 'forced'  = bypasses branch protection (gh pr merge w/o --auto, pulls.merge API, GraphQL, --admin)
// 'soft'    = respects branch protection (--auto / enable-pull-request-automerge / enable-automerge)
// 'label'   = pascalgn/automerge-action (label-gated by design)
export function mergeKinds(rawBlock) {
  const block = stripNonMergeLines(rawBlock);
  const kinds = new Set();
  if (/peter-evans\/enable-pull-request-automerge/i.test(block)) kinds.add('soft');
  if (/\benable-automerge\b/i.test(block)) kinds.add('soft');
  if (/pascalgn\/automerge-action/i.test(block)) kinds.add('label');
  // gh pr merge lines (handle backslash continuations)
  for (const m of block.matchAll(/gh\s+pr\s+merge(?:[^\n\\]*\\\s*\n?)*[^\n]*/gi)) {
    if (/--auto\b/.test(m[0])) kinds.add('soft');
    else kinds.add('forced');
  }
  if (/\bpulls\.merge\s*\(|(?:rest|octokit|github)[^\n]*pulls\.merge/i.test(block)) kinds.add('forced');
  if (/pulls\/[^\s"'`]*\/merge\b/i.test(block) && /PUT|method:\s*['"]?PUT/i.test(block)) kinds.add('forced');
  if (/mergePullRequest/i.test(block)) kinds.add('forced');
  return kinds;
}

export function adminBypass(rawBlock) {
  const block = stripNonMergeLines(rawBlock);
  return /gh\s+pr\s+merge[^\n]*--admin\b|--admin\b/i.test(block);
}

// ---------------------------------------------------------------------------
// Classifier (exported for tests) — pure, no network.
// ---------------------------------------------------------------------------

export function classifyWorkflow(text, ctx = {}) {
  const { owner = '', repo = '', path = '', fileUrl = '' } = ctx;
  const base = { owner, repo, path, fileUrl, severity: 'skip', why: '', signals: {} };

  if (path && !/\.ya?ml$/i.test(path)) {
    return { ...base, severity: 'low', why: `workflow file is disabled/renamed (${path.split('.').pop()}); would not run as-is`, signals: {} };
  }
  if (!hasMergePrimitive(text)) return { ...base, why: 'no PR-merge action found' };

  if (anyMatch(text, SELF_PATTERNS) || /\bbot-merge\b/i.test(path)) {
    return { ...base, severity: 'skip', why: 'matches our own bot-merge pattern', signals: { merges: matchedIds(text) } };
  }

  const trig = triggers(text);
  const prTriggered = trig.pull_request || trig.pull_request_target;

  const jobs = collectJobs(text);
  const perJob = [];

  for (const j of jobs) {
    const body = j.body.join('\n');
    if (!hasMergePrimitive(body)) continue;

    const jIfs = jobLevelIfs(j.body, j.indent).join(' && ');
    const steps = stepsOf(j.body);
    const mergeSteps = steps.filter((s) => hasMergePrimitive(s.text));

    // guards tied to the merge step(s): job-level if + merge-step if
    const guardFor = (s) => [jIfs, (s.ifs || []).join(' && ')].filter(Boolean).join(' && ');
    const mergeGuards = mergeSteps.length
      ? mergeSteps.map(guardFor)
      : [jIfs]; // merge is inline in the job (not a discrete step), only job-if applies

    // merge excluded from PR events if EVERY merge path is guarded to non-PR events
    const excludedFromPR = mergeGuards.length > 0 && mergeGuards.every((g) => EVENT_EXCLUDE_RE.test(g));

    const kinds = mergeKinds(body);
    const allGuards = [jIfs, ...steps.flatMap((s) => s.ifs || [])].join(' && ');

    const hasAllowlist = anyMatch(body, ALLOWLIST_PATTERNS) || anyMatch(allGuards, SAME_REPO_PATTERNS) || anyMatch(body, SAME_REPO_PATTERNS);
    const hasReview = anyMatch(body, REVIEW_PATTERNS);
    const hasCheck = anyMatch(body, CHECK_PATTERNS);
    const hasLabel = anyMatch(body, LABEL_PATTERNS) || kinds.has('label');

    perJob.push({
      job: j.name, kinds: [...kinds], excludedFromPR,
      hasAllowlist, hasReview, hasCheck, hasLabel, admin: adminBypass(body),
    });
  }

  const signals = { merges: matchedIds(text), trig, perJob };

  if (perJob.length === 0) {
    return { ...base, severity: 'low', why: 'merge primitive present but no merging job parsed (needs manual look)', signals };
  }

  // Severity per PR-reachable merging job; overall = max.
  const rank = { low: 0, medium: 1, high: 2 };
  let best = { sev: 'low', why: '' };

  for (const pj of perJob) {
    let sev = 'low', why = '';
    if (!prTriggered) {
      why = `merges but not pull_request-triggered (${Object.keys(trig).filter((k) => trig[k]).join(',') || 'unknown'})`;
    } else if (pj.excludedFromPR) {
      why = `job "${pj.job}" merges only on non-PR events (guarded by github.event_name)`;
    } else if (pj.hasAllowlist || pj.hasReview || pj.hasCheck) {
      const g = [];
      if (pj.hasAllowlist) g.push('author/allowlist or same-repo-only');
      if (pj.hasReview) g.push('required review');
      if (pj.hasCheck) g.push('required lit check');
      why = `job "${pj.job}" merges but is gated by ${g.join(' + ')}`;
    } else {
      const trigName = trig.pull_request_target ? 'pull_request_target' : 'pull_request';
      const forced = pj.kinds.includes('forced');
      const soft = pj.kinds.includes('soft') || pj.kinds.includes('label');
      if (forced && !pj.hasLabel) {
        sev = 'high';
        why = `${trigName}-triggered FORCED merge in job "${pj.job}" with no author/allowlist check, no required review, and no required lit check — a stranger PR could land on the base branch${pj.admin ? ' (uses --admin to bypass branch protection)' : ''}`;
      } else if (forced && pj.hasLabel) {
        sev = 'medium';
        why = `${trigName}-triggered forced merge in job "${pj.job}" gated only by a label (weak: any PR carrying/earning the label is merged)`;
      } else if (soft) {
        sev = 'medium';
        why = `${trigName}-triggered auto-merge in job "${pj.job}" (--auto / enable-automerge${pj.hasLabel ? ' + label' : ''}) with no author/review/check gate — merges any PR if branch protection is weak or absent`;
      } else {
        sev = 'medium';
        why = `${trigName}-triggered merge in job "${pj.job}" with unclear gating (needs manual look)`;
      }
    }
    if (rank[sev] >= rank[best.sev] && (why && (rank[sev] > rank[best.sev] || !best.why))) {
      best = { sev, why };
    }
    if (rank[sev] > rank[best.sev]) best = { sev, why };
  }

  return { ...base, severity: best.sev, why: best.why, signals };
}

// ---------------------------------------------------------------------------
// Network layer (only runs in main). gh api with backoff.
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rate = { searches: 0, fetches: 0, backoffs: 0 };

async function ghApi(args, { tries = 5 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const { stdout } = await execFileP('gh', ['api', ...args], { maxBuffer: 64 * 1024 * 1024, env: process.env });
      return JSON.parse(stdout);
    } catch (e) {
      lastErr = e;
      const msg = `${e.stderr || ''}${e.stdout || ''}${e.message || ''}`;
      if (/rate limit|secondary rate|abuse|too quickly|\b403\b|\b429\b/i.test(msg) && attempt < tries - 1) {
        const wait = Math.min(60000, 2000 * 2 ** attempt);
        rate.backoffs++;
        process.stderr.write(`[backoff] rate-limited, sleeping ${wait}ms (attempt ${attempt + 1})\n`);
        await sleep(wait);
        continue;
      }
      if (attempt < tries - 1 && /ENOTFOUND|ETIMEDOUT|ECONNRESET|Unexpected token/i.test(msg)) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

const SEARCH_QUERIES = [
  '"gh pr merge" path:.github/workflows pull_request_target',
  '"gh pr merge" NOT "--auto" path:.github/workflows pull_request',
  '"pulls" "merge" path:.github/workflows pull_request_target',
  '"mergePullRequest" path:.github/workflows pull_request',
  '"pascalgn/automerge-action" path:.github/workflows',
  '"peter-evans/enable-pull-request-automerge" path:.github/workflows pull_request',
  '"enable-automerge" path:.github/workflows pull_request',
];

async function codeSearch(q, perPage) {
  const res = await ghApi(['-X', 'GET', 'search/code', '-f', `q=${q}`, '-f', `per_page=${perPage}`]);
  return res.items || [];
}

async function fetchWorkflow(owner, repo, path) {
  const res = await ghApi(['-H', 'Accept: application/vnd.github+json', `repos/${owner}/${repo}/contents/${encodeURI(path)}`]);
  if (Array.isArray(res)) return null;
  if (res && res.content && res.encoding === 'base64') return Buffer.from(res.content, 'base64').toString('utf8');
  return null;
}

function headsUpDraft(hit) {
  const { owner, repo, path, fileUrl, severity, why } = hit;
  const sev = severity.toUpperCase();
  const strength = severity === 'high'
    ? 'could be merged into your base branch automatically, with no maintainer review or passing (lit) CI check in the way'
    : 'could, depending on your branch-protection settings, be merged into your base branch automatically without a maintainer review or a passing (lit) CI check';
  return `# Private heads-up — ${owner}/${repo}

**Workflow:** \`${path}\`
${fileUrl ? `**File:** ${fileUrl}\n` : ''}**Severity (my read):** ${sev}

---

Hi — while looking at open-source CI setups I noticed something in **${owner}/${repo}** you may want to double-check. Sending privately rather than filing anything public.

Your workflow \`${path}\` has a ${why}.

In practice that can mean a pull request from **anyone** — including a stranger — ${strength}. On a \`pull_request_target\` trigger especially, that step runs with a write-scoped token against untrusted code.

If you already have branch protection (required reviews / required status checks) covering the base branch, this may be a non-issue — please ignore me. If not, a small hardening step is to gate the merge on:

- an **author/actor allowlist** (only auto-merge PRs from specific trusted bots/maintainers), **and**
- a **required review** or a **required passing status check** before the merge runs.

For a concrete example of that shape (allowlist + "merge only once the CI light is lit"), here's a small experiment of mine, shared as a reference not a pitch:
https://github.com/fitzyracing1/bot-merge

No action needed toward me — just flagging in case it's useful.

— Joshua
`;
}

function writeOutputs(results, candCount, { draftMedium, outDir, draftsDir }) {
  const jsonl = results.map((r) => JSON.stringify({
    owner: r.owner, repo: r.repo, workflow: r.path, severity: r.severity, why: r.why, fileUrl: r.fileUrl,
  })).join('\n');
  writeFileSync(join(outDir, 'results.jsonl'), jsonl + (jsonl ? '\n' : ''));

  const by = (s) => results.filter((r) => r.severity === s);
  const high = by('high'), medium = by('medium'), low = by('low'), skip = by('skip');

  const md = ['# Open-merge scan results', '',
    `_Read-only scan. ${results.length} workflows classified from ${candCount} candidates._`, '',
    `- HIGH: ${high.length}`, `- MEDIUM: ${medium.length}`, `- LOW/skip: ${low.length + skip.length}`, ''];
  const sec = (title, arr) => {
    md.push(`## ${title}`, '');
    if (!arr.length) { md.push('_none_', ''); return; }
    md.push('| owner/repo | workflow | why | file |', '|---|---|---|---|');
    for (const r of arr) md.push(`| ${r.owner}/${r.repo} | \`${r.path}\` | ${r.why.replace(/\|/g, '\\|')} | ${r.fileUrl || ''} |`);
    md.push('');
  };
  sec('HIGH', high); sec('MEDIUM', medium);
  writeFileSync(join(outDir, 'RESULTS.md'), md.join('\n'));

  const targets = draftMedium ? [...high, ...medium] : high;
  const queueItems = [];
  for (const r of targets) {
    const fname = `${r.owner}__${r.repo}.md`.replace(/[\/\\]/g, '_');
    writeFileSync(join(draftsDir, fname), headsUpDraft(r));
    queueItems.push({ ...r, fname });
  }

  const q = ['', '## Open-merge heads-ups — awaiting Joshua OK', '',
    '> Read-only scan output. NOTHING below has been sent. Each item is a private',
    '> heads-up DRAFT; Joshua approves them one by one before any send.', ''];
  if (!queueItems.length) q.push('- [ ] _(no draft-eligible hits this run)_');
  else for (const it of queueItems) q.push(`- [ ] **${it.owner}/${it.repo}** (${it.severity}) — \`${it.path}\` — draft: \`drafts/heads-up/${it.fname}\``);
  q.push('');
  appendFileSync(join(__dirname, '..', 'QUEUE.md'), q.join('\n'));

  return { high: high.length, medium: medium.length, low: low.length, skip: skip.length, drafts: queueItems.length };
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (name, def) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? a.split('=')[1] : def; };
  const maxCands = Number(arg('max', '70'));
  const perPage = Number(arg('per-page', '15'));
  const sleepMs = Number(arg('sleep', '3500'));
  const draftMedium = args.includes('--draft-medium');
  const fromCache = args.includes('--from-cache');
  const outDir = __dirname;
  const draftsDir = join(__dirname, '..', 'drafts', 'heads-up');
  const cacheDir = join(__dirname, 'cache');
  mkdirSync(outDir, { recursive: true }); mkdirSync(draftsDir, { recursive: true }); mkdirSync(cacheDir, { recursive: true });

  if (fromCache) {
    process.stderr.write('[scan] reclassify from cache\n');
    const meta = JSON.parse(readFileSync(join(cacheDir, '_index.json'), 'utf8'));
    const results = [];
    for (const c of meta) {
      const text = readFileSync(join(cacheDir, c.file), 'utf8');
      results.push(classifyWorkflow(text, { owner: c.owner, repo: c.repo, path: c.path, fileUrl: c.fileUrl }));
    }
    const sum = writeOutputs(results, meta.length, { draftMedium, outDir, draftsDir });
    console.log(JSON.stringify(sum));
    return;
  }

  process.stderr.write(`[scan] starting, cap=${maxCands}\n`);
  const seen = new Set();
  const cands = [];
  for (const query of SEARCH_QUERIES) {
    if (cands.length >= maxCands) break;
    process.stderr.write(`[search] ${query}\n`);
    let items = [];
    try { items = await codeSearch(query, perPage); rate.searches++; }
    catch (e) { process.stderr.write(`[search] FAILED: ${(e.message || '').slice(0, 160)}\n`); }
    for (const it of items) {
      const full = it.repository?.full_name; const path = it.path;
      if (!full || !path) continue;
      const [owner, repo] = full.split('/');
      const key = `${owner}/${repo}:${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cands.push({ owner, repo, path, fileUrl: it.html_url, isFork: it.repository?.fork });
      if (cands.length >= maxCands) break;
    }
    await sleep(sleepMs);
  }
  process.stderr.write(`[scan] ${cands.length} unique candidates\n`);

  const results = [];
  const index = [];
  const dedupe = new Set();
  for (const c of cands) {
    let text = null;
    try { text = await fetchWorkflow(c.owner, c.repo, c.path); rate.fetches++; }
    catch (e) { process.stderr.write(`[fetch] FAILED ${c.owner}/${c.repo}: ${(e.message || '').slice(0, 100)}\n`); }
    await sleep(Math.max(700, sleepMs / 3));
    if (!text) continue;
    const sig = `${c.path}::${text.length}::${text.slice(0, 160)}`;
    if (c.isFork && dedupe.has(sig)) { process.stderr.write(`[skip] identical fork ${c.owner}/${c.repo}\n`); continue; }
    dedupe.add(sig);
    const file = `${c.owner}__${c.repo}__${c.path.replace(/[\/]/g, '_')}`.slice(0, 180);
    writeFileSync(join(cacheDir, file), text);
    index.push({ owner: c.owner, repo: c.repo, path: c.path, fileUrl: c.fileUrl, file });
    results.push(classifyWorkflow(text, { owner: c.owner, repo: c.repo, path: c.path, fileUrl: c.fileUrl }));
  }
  writeFileSync(join(cacheDir, '_index.json'), JSON.stringify(index, null, 2));

  const sum = writeOutputs(results, cands.length, { draftMedium, outDir, draftsDir });
  process.stderr.write(`[scan] done HIGH=${sum.high} MEDIUM=${sum.medium} LOW/skip=${sum.low + sum.skip} drafts=${sum.drafts}\n`);
  process.stderr.write(`[rate] searches=${rate.searches} fetches=${rate.fetches} backoffs=${rate.backoffs}\n`);
  console.log(JSON.stringify(sum));
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main().catch((e) => { process.stderr.write(`[fatal] ${e.stack || e}\n`); process.exit(1); });
