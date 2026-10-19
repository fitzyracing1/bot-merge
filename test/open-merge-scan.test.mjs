import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  classifyWorkflow, matchedIds, triggers, extractOnBlock, anyMatch,
  collectJobs, stepsOf, jobLevelIfs, mergeKinds,
  ALLOWLIST_PATTERNS, CHECK_PATTERNS, EVENT_EXCLUDE_RE,
} from '../scan/open-merge-scan.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fx = (n) => readFileSync(join(__dirname, 'fixtures', n), 'utf8');
const real = (n) => readFileSync(join(__dirname, 'fixtures', 'real', n), 'utf8');
const C = (txt, path = '.github/workflows/x.yml') => classifyWorkflow(txt, { owner: 'o', repo: 'r', path });

// ---- synthetic fixtures ----
test('HIGH: pull_request_target forced merge, no gate', () => {
  const r = C(fx('high-open-merge.yml'));
  assert.equal(r.severity, 'high');
  assert.match(r.why, /FORCED merge/);
});

test('MEDIUM: label-only + --auto', () => {
  const r = C(fx('medium-label-only.yml'));
  assert.equal(r.severity, 'medium');
});

test('LOW: dependabot actor allowlist', () => {
  const r = C(fx('safe-allowlist.yml'));
  assert.equal(r.severity, 'low');
  assert.match(r.why, /allowlist|gated/);
});

test('LOW: requires lit check + review', () => {
  const r = C(fx('safe-requires-checks.yml'));
  assert.equal(r.severity, 'low');
});

test('skip: no merge action', () => {
  const r = C(fx('none-no-merge.yml'));
  assert.equal(r.severity, 'skip');
});

test('skip: our own bot-merge', () => {
  const t = 'name: bot-merge\non:\n  pull_request:\njobs:\n  m:\n    steps:\n      - run: gh pr merge $PR';
  const r = classifyWorkflow(t, { owner: 'fitzyracing1', repo: 'bot-merge', path: '.github/workflows/bot-merge.yml' });
  assert.equal(r.severity, 'skip');
});

// ---- forced vs auto distinction ----
test('forced merge (no --auto) outranks auto-merge', () => {
  assert.ok(mergeKinds('run: gh pr merge 5 --merge').has('forced'));
  assert.ok(mergeKinds('run: gh pr merge --auto --squash').has('soft'));
  assert.ok(!mergeKinds('run: gh pr merge --auto --squash').has('forced'));
  assert.ok(mergeKinds('uses: peter-evans/enable-pull-request-automerge@v3').has('soft'));
  assert.ok(mergeKinds('uses: pascalgn/automerge-action@v0.16').has('label'));
});

// ---- real-world regression fixtures (classifier must NOT over-flag) ----
test('REAL authentik: merge steps guarded to non-PR events -> LOW', () => {
  const r = classifyWorkflow(real('authentik-compress.yml'), { owner: 'goauthentik', repo: 'authentik', path: '.github/workflows/gen-image-compress.yml' });
  assert.notEqual(r.severity, 'high');
  assert.equal(r.severity, 'low');
});

test('REAL cml: merge in workflow_dispatch-only job -> LOW', () => {
  const r = classifyWorkflow(real('cml-release.yml'), { owner: 'iterative', repo: 'cml', path: '.github/workflows/release.yml' });
  assert.notEqual(r.severity, 'high');
});

test('REAL projen auto-queue: --auto respects branch protection -> MEDIUM not HIGH', () => {
  const r = classifyWorkflow(real('projen-autoqueue.yml'), { owner: 'projen', repo: 'projen', path: '.github/workflows/auto-queue.yml' });
  assert.equal(r.severity, 'medium');
});

test('REAL PreMailer pascalgn + MERGE_LABELS -> MEDIUM', () => {
  const r = classifyWorkflow(real('premailer-automerge.yml'), { owner: 'milkshakesoftware', repo: 'PreMailer.Net', path: '.github/workflows/auto-merge.yml' });
  assert.equal(r.severity, 'medium');
});

test('REAL enarx --auto -> MEDIUM not HIGH', () => {
  const r = classifyWorkflow(real('enarx-pr.yml'), { owner: 'enarx', repo: 'enarx', path: '.github/workflows/pr.yml' });
  assert.notEqual(r.severity, 'high');
  assert.equal(r.severity, 'medium');
});

test('REAL merely-true --auto weak gate -> MEDIUM not HIGH', () => {
  const r = classifyWorkflow(real('merelytrue-automerge.yml'), { owner: 'merely-true', repo: 'merely-true', path: '.github/workflows/auto_merge.yml' });
  assert.notEqual(r.severity, 'high');
});

// ---- parser units ----
test('collectJobs splits jobs', () => {
  const jobs = collectJobs('jobs:\n  a:\n    runs-on: x\n    steps: []\n  b:\n    runs-on: y\n');
  assert.deepEqual(jobs.map((j) => j.name), ['a', 'b']);
});

test('stepsOf captures per-step if', () => {
  const body = 'runs-on: x\nsteps:\n  - name: s1\n    if: github.event_name == \'push\'\n    run: echo hi\n  - run: gh pr merge'.split('\n');
  const steps = stepsOf(body);
  assert.equal(steps.length, 2);
  assert.ok(steps[0].ifs.length === 1);
});

test('EVENT_EXCLUDE_RE matches non-PR guards', () => {
  assert.ok(EVENT_EXCLUDE_RE.test("github.event_name != 'pull_request'"));
  assert.ok(EVENT_EXCLUDE_RE.test("github.event_name == 'workflow_dispatch'"));
  assert.ok(!EVENT_EXCLUDE_RE.test("github.event.pull_request.draft == false"));
});

test('triggers read only on: block', () => {
  const t = triggers('on:\n  push:\njobs:\n  a:\n    if: github.event.pull_request.user.login == "x"');
  assert.equal(t.pull_request, false);
  assert.equal(t.push, true);
});

test('matchedIds detects primitives', () => {
  assert.ok(matchedIds('gh pr merge 5').includes('gh-pr-merge'));
  assert.ok(matchedIds('mergePullRequest').includes('graphql-merge'));
  assert.equal(matchedIds('npm run lint').length, 0);
});

// ---- regression: false-positive guards ----
test('REAL ops-digit guard-no-merge: grep that FORBIDS merges -> skip', () => {
  const r = classifyWorkflow(real('opsdigit-guard-ci.yml'), { owner: 'ops-digit-io', repo: 'digitalization-portal', path: '.github/workflows/ci.yml' });
  assert.notEqual(r.severity, 'high');
  assert.equal(r.severity, 'skip');
});

test('REAL DDC-statistic graphql mergePullRequest (csv-only gate) -> HIGH', () => {
  const r = classifyWorkflow(real('ddc-graphql-merge.yml'), { owner: 'SnowAmberX', repo: 'DDC-statistic', path: '.github/workflows/auto-merge.yaml' });
  assert.equal(r.severity, 'high');
});

test('REAL MisakaNet: real merge is gh pr merge --auto, comments ignored -> not HIGH', () => {
  const r = classifyWorkflow(real('misaka-prchecks.yml'), { owner: 'Ikalus1988', repo: 'MisakaNet', path: '.github/workflows/pr-checks.yml' });
  assert.notEqual(r.severity, 'high');
});

test('stripNonMergeLines drops grep/comment/echo merge mentions', async () => {
  const { stripNonMergeLines } = await import('../scan/open-merge-scan.mjs');
  const t = stripNonMergeLines('# gh pr merge in comment\n  run: grep -E "pulls.merge" lib\n  run: gh pr merge 5');
  assert.ok(/gh pr merge 5/.test(t));
  assert.ok(!/comment/.test(t));
  assert.ok(!/grep/.test(t));
});

test('disabled workflow file (.disable/.bak) -> low', () => {
  const r = classifyWorkflow('on:\n  pull_request_target:\njobs:\n  m:\n    steps:\n      - run: gh pr merge $PR --merge', { owner: 'o', repo: 'r', path: '.github/workflows/automerge.yml.disable' });
  assert.equal(r.severity, 'low');
  assert.match(r.why, /disabled|renamed/);
});
