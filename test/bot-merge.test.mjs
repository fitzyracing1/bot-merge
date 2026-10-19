import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIT, DARK, HOLD_LABEL, MERGED_LABEL,
  validateConfig, lightFromChecks, evaluatePr, parseMarker, mergeCommitMessage,
  runMerge, runGuard, createApi, main,
} from '../src/bot-merge.mjs';

const cfg = validateConfig({
  bots: ['github-actions[bot]', 'dependabot[bot]', 'renovate[bot]', 'fitzyracing1-bot'],
  mergeMethod: 'squash',
  requiredLight: 'lit',
  ignoreChecks: ['bot-merge', 'revert-guard'],
});

const ok = (name) => ({ name, status: 'completed', conclusion: 'success' });
const done = (name, conclusion) => ({ name, status: 'completed', conclusion });

// --- light -----------------------------------------------------------------

test('lit = 0 and dark = 1 (active-low)', () => {
  assert.equal(LIT, 0);
  assert.equal(DARK, 1);
});

test('all check runs succeeded -> lit', () => {
  const l = lightFromChecks([ok('test'), ok('lint')]);
  assert.equal(l.light, LIT);
  assert.equal(l.settled, true);
  assert.equal(l.total, 2);
});

test('no checks at all -> dark (missing)', () => {
  const l = lightFromChecks([]);
  assert.equal(l.light, DARK);
  assert.equal(l.dark[0].state, 'missing');
});

for (const c of ['failure', 'cancelled', 'skipped', 'timed_out', 'neutral', 'action_required', 'stale', null]) {
  test(`one check concluded ${c} -> dark`, () => {
    assert.equal(lightFromChecks([ok('test'), done('other', c)]).light, DARK);
  });
}

test('in-progress check -> dark and not settled', () => {
  const l = lightFromChecks([ok('test'), { name: 'slow', status: 'in_progress', conclusion: null }]);
  assert.equal(l.light, DARK);
  assert.equal(l.settled, false);
});

test('bot-merge own jobs are ignored', () => {
  const l = lightFromChecks([ok('test'), { name: 'bot-merge', status: 'in_progress' }, done('revert-guard', 'skipped')], [], cfg.ignoreChecks);
  assert.equal(l.light, LIT);
  assert.equal(l.total, 1);
});

test('only ignored checks -> dark (missing)', () => {
  assert.equal(lightFromChecks([ok('bot-merge')], [], cfg.ignoreChecks).light, DARK);
});

test('legacy commit statuses count too', () => {
  assert.equal(lightFromChecks([ok('test')], [{ context: 'ext', state: 'success' }]).light, LIT);
  assert.equal(lightFromChecks([ok('test')], [{ context: 'ext', state: 'failure' }]).light, DARK);
  const p = lightFromChecks([], [{ context: 'ext', state: 'pending' }]);
  assert.equal(p.light, DARK);
  assert.equal(p.settled, false);
});

// --- PR evaluation ---------------------------------------------------------

const pr = (over = {}) => ({
  number: 7, title: 'bump x', body: 'body', state: 'open', draft: false, labels: [],
  user: { login: 'dependabot[bot]' }, base: { ref: 'main' }, head: { sha: 'abc1234' }, ...over,
});

test('allowlisted bot + lit -> merge', () => {
  assert.equal(evaluatePr(pr(), LIT, cfg).merge, true);
});

test('allowlist match is case-insensitive', () => {
  assert.equal(evaluatePr(pr({ user: { login: 'Dependabot[bot]' } }), LIT, cfg).merge, true);
});

test('allowlisted bot + dark -> no merge', () => {
  assert.equal(evaluatePr(pr(), DARK, cfg).merge, false);
});

test('humans are never merged, even when lit', () => {
  const r = evaluatePr(pr({ user: { login: 'fitzyracing1' } }), LIT, cfg);
  assert.equal(r.merge, false);
  assert.match(r.reason, /not an allowlisted bot/);
});

test('unknown bots are never merged', () => {
  assert.equal(evaluatePr(pr({ user: { login: 'evil[bot]' } }), LIT, cfg).merge, false);
});

test('drafts are not merged', () => {
  assert.equal(evaluatePr(pr({ draft: true }), LIT, cfg).merge, false);
});

test('hold label blocks merge', () => {
  const r = evaluatePr(pr({ labels: [{ name: HOLD_LABEL }] }), LIT, cfg);
  assert.equal(r.merge, false);
  assert.match(r.reason, /hold/);
});

test('PRs to other base branches are not merged', () => {
  assert.equal(evaluatePr(pr({ base: { ref: 'dev' } }), LIT, cfg).merge, false);
});

// --- config ----------------------------------------------------------------

test('config rejects requiredLight other than lit', () => {
  assert.throws(() => validateConfig({ bots: [], requiredLight: 'dark' }), /requiredLight/);
});

test('config rejects bad merge method', () => {
  assert.throws(() => validateConfig({ bots: [], mergeMethod: 'yolo' }), /mergeMethod/);
});

test('repo bot-merge.json is valid', async () => {
  const { loadConfig } = await import('../src/bot-merge.mjs');
  const c = loadConfig(new URL('../bot-merge.json', import.meta.url));
  assert.ok(c.bots.includes('github-actions[bot]'));
  assert.equal(c.requiredLight, 'lit');
});

// --- marker ----------------------------------------------------------------

test('merge commit message carries a parseable marker', () => {
  const msg = `bump x (#7)\n\n${mergeCommitMessage(pr())}`;
  assert.equal(parseMarker(msg), 7);
  assert.equal(parseMarker('plain commit'), null);
});

// --- fake API for runMerge / runGuard --------------------------------------

function fakeApi(routes) {
  const calls = [];
  const handle = (method, p, body) => {
    calls.push({ method, path: p, body });
    for (const [key, fn] of Object.entries(routes)) {
      const [m, re] = key.split(' ');
      const match = new RegExp(`^${re}$`).exec(p.split('?')[0]);
      if (m === method && match) return typeof fn === 'function' ? fn(body, match) : fn;
    }
    const e = new Error(`404 ${method} ${p}`);
    e.status = 404;
    throw e;
  };
  return {
    calls,
    async request(method, p, body) { return handle(method, p, body); },
    async paginate(p, key) { const d = handle('GET', p); return key ? d[key] : d; },
  };
}

test('runMerge merges only lit allowlisted bot PRs', async () => {
  const prs = [
    pr({ number: 1, head: { sha: 'aaa' } }),                                       // bot, lit
    pr({ number: 2, head: { sha: 'bbb' } }),                                       // bot, dark
    pr({ number: 3, head: { sha: 'aaa' }, user: { login: 'fitzyracing1' } }),      // human, lit
    pr({ number: 4, head: { sha: 'aaa' }, labels: [{ name: HOLD_LABEL }] }),       // held
    pr({ number: 5, head: { sha: 'aaa' }, draft: true }),                          // draft
    pr({ number: 6, head: { sha: 'ccc' } }),                                       // bot, no checks
  ];
  const checks = { aaa: [ok('test'), done('bot-merge', 'cancelled')], bbb: [ok('test'), done('test2', 'failure')], ccc: [] };
  const api = fakeApi({
    'GET /pulls': prs,
    'GET /commits/(\\w+)/check-runs': (_, m) => ({ check_runs: checks[m[1]] }),
    'GET /commits/(\\w+)/status': { statuses: [] },
    'PUT /pulls/(\\d+)/merge': (_, m) => ({ sha: `merge${m[1]}` }),
    'POST /issues/(\\d+)/labels': {},
  });
  const res = await runMerge(api, cfg, () => {});
  assert.deepEqual(res.filter((r) => r.merged).map((r) => r.number), [1]);
  const merge = api.calls.find((c) => c.method === 'PUT');
  assert.equal(merge.body.sha, 'aaa');
  assert.equal(merge.body.merge_method, 'squash');
  assert.equal(parseMarker(merge.body.commit_message), 1);
  assert.ok(api.calls.some((c) => c.path === '/issues/1/labels' && c.body.labels[0] === MERGED_LABEL));
  // never asked for a merge of anything else
  assert.equal(api.calls.filter((c) => c.method === 'PUT').length, 1);
});

function guardApi({ message, checks, revertExists = false }) {
  return fakeApi({
    'GET /branches/main': { commit: { sha: 'head1' } },
    'GET /commits/head1': { sha: 'head1', commit: { message }, parents: [{ sha: 'par1' }] },
    'GET /commits/head1/pulls': [],
    'GET /commits/head1/check-runs': { check_runs: checks },
    'GET /commits/head1/status': { statuses: [] },
    'GET /git/ref/heads/revert/head1': () => {
      if (revertExists) return {};
      const e = new Error('404'); e.status = 404; throw e;
    },
    'GET /git/commits/par1': { tree: { sha: 'tree0' } },
    'POST /git/commits': { sha: 'rev1' },
    'POST /git/refs': {},
    'POST /pulls': { number: 50 },
    'POST /issues/50/labels': {},
    'POST /issues': { number: 51 },
  });
}

const botMsg = 'bump x (#7)\n\nBot-Merge: #7\nBot-Merge-Light: lit';

test('guard opens revert PR + issue when a bot-merge left main dark', async () => {
  const api = guardApi({ message: botMsg, checks: [done('test', 'failure')] });
  const r = await runGuard(api, cfg, null, () => {});
  assert.equal(r.action, 'revert');
  const commit = api.calls.find((c) => c.path === '/git/commits' && c.method === 'POST');
  assert.equal(commit.body.tree, 'tree0');
  assert.deepEqual(commit.body.parents, ['head1']);
  const ref = api.calls.find((c) => c.path === '/git/refs');
  assert.equal(ref.body.ref, 'refs/heads/revert/head1');
  assert.ok(api.calls.some((c) => c.path === '/issues/50/labels' && c.body.labels[0] === HOLD_LABEL));
  assert.ok(api.calls.some((c) => c.path === '/issues' && /bot-merge of #7/.test(c.body.title)));
  assert.ok(!api.calls.some((c) => c.method === 'PATCH' || c.method === 'DELETE'), 'no history rewrite');
});

test('guard does nothing when main is lit', async () => {
  const r = await runGuard(guardApi({ message: botMsg, checks: [ok('test')] }), cfg, null, () => {});
  assert.equal(r.reason, 'lit');
});

test('guard waits while checks are still running', async () => {
  const r = await runGuard(guardApi({ message: botMsg, checks: [{ name: 'test', status: 'in_progress' }] }), cfg, null, () => {});
  assert.equal(r.reason, 'not settled');
});

test('guard ignores dark commits that did not come from bot-merge', async () => {
  const r = await runGuard(guardApi({ message: 'human commit', checks: [done('test', 'failure')] }), cfg, null, () => {});
  assert.equal(r.reason, 'not a bot-merge');
});

test('guard does not open a second revert', async () => {
  const r = await runGuard(guardApi({ message: botMsg, checks: [done('test', 'failure')], revertExists: true }), cfg, null, () => {});
  assert.equal(r.reason, 'revert already exists');
});

// --- API client + CLI exit codes -------------------------------------------

function fakeFetch(checkRuns) {
  return async (url) => {
    const body = url.includes('/check-runs') ? { check_runs: checkRuns } : { statuses: [] };
    return { ok: true, status: 200, text: async () => JSON.stringify(body), headers: { get: () => null } };
  };
}

test('createApi paginates and sends auth header without exposing it', async () => {
  let seen;
  const api = createApi({
    token: 't0k', repo: 'o/r',
    fetchImpl: async (url, init) => { seen = { url, init }; return { ok: true, status: 200, text: async () => '[]', headers: { get: () => null } }; },
  });
  await api.paginate('/pulls?state=open');
  assert.equal(seen.url, 'https://api.github.com/repos/o/r/pulls?state=open&per_page=100');
  assert.equal(seen.init.headers.Authorization, 'Bearer t0k');
  assert.ok(!JSON.stringify(api).includes('t0k'));
});

test('CLI light exits 0 for lit and 1 for dark', async () => {
  const orig = globalThis.fetch;
  const log = console.log;
  console.log = () => {};
  try {
    const env = { GITHUB_TOKEN: 'x', GITHUB_REPOSITORY: 'o/r' };
    const conf = new URL('../bot-merge.json', import.meta.url).pathname;
    globalThis.fetch = fakeFetch([ok('test')]);
    assert.equal(await main(['light', 'abc', '--config', conf], env), 0);
    globalThis.fetch = fakeFetch([done('test', 'cancelled')]);
    assert.equal(await main(['light', 'abc', '--config', conf], env), 1);
  } finally {
    globalThis.fetch = orig;
    console.log = log;
  }
});
