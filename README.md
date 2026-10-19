# bot-merge

> **Status: test repo.** This is an experiment. It is not installed anywhere else yet.

A GitHub Action that **auto-merges pull requests opened by allowlisted bot accounts once their CI light is lit**, and **opens a revert PR if `main` goes dark** after one of those merges.

## The lit / dark rule

bot-merge only knows two CI states:

| Light | Value | Meaning |
|-------|-------|---------|
| **lit**  | `0` | At least one check exists on the PR head commit **and every one concluded `success`**. |
| **dark** | `1` | Anything else: `failure`, `cancelled`, `skipped`, `timed_out`, `neutral`, `action_required`, still queued / running, or **no checks at all**. |

It is active-low, like a process exit code: `lit = 0`, `dark = 1`. `node src/bot-merge.mjs light <sha>` exits `0` when the commit is lit and `1` when it is dark.

How the light is computed (`lightFromChecks` in `src/bot-merge.mjs`):

1. Fetch the latest check run per name for the head SHA (`GET /commits/{sha}/check-runs?filter=latest`) plus any legacy commit statuses.
2. Drop bot-merge's own jobs (`ignoreChecks`, default `bot-merge`, `revert-guard`) so it never waits on itself.
3. Zero checks left? **dark**. Any check not `completed` + `success` (or a status that is not `success`)? **dark**. Otherwise **lit**.

## What it does

**Merge sweep** (`bot-merge` job). For every open PR into `baseBranch`:

- author must be on the `bots` allowlist (case-insensitive exact login match), otherwise skipped. **Humans are never auto-merged.**
- not a draft, and no `bot-merge:hold` label;
- light of the head SHA must be **lit**;
- then it merges with `mergeMethod`, pinned to the evaluated SHA (if the branch moved in the meantime GitHub rejects the merge and the next sweep re-evaluates). The merge commit gets a `Bot-Merge: #<pr>` trailer and the PR gets a `bot-merge:merged` label.

**Revert guard** (`revert-guard` job). When CI finishes on `main`:

- if `main`'s head commit came from a bot-merge (trailer or `bot-merge:merged` label), every check has finished, and the light is **dark**,
- it creates a revert commit on a new branch `revert/<sha>` (tree restored to the parent commit), opens a PR for it labelled `bot-merge:hold`, and opens an issue naming the merge that made `main` dark and the dark checks.
- It never force-pushes or rewrites history, and never opens a second revert for the same commit. The revert PR is held, so a human decides whether to merge it.

## Triggers

`.github/workflows/bot-merge.yml` runs on `check_suite: completed`, `workflow_run: completed` (of `CI`), `pull_request` (opened / synchronize / reopened), a 15-minute `schedule`, and `workflow_dispatch` (mode `merge`, `guard`, or `both`).

Why the schedule: PRs, pushes and merges made with `GITHUB_TOKEN` do **not** trigger other workflows (except `workflow_dispatch`). So bot-merge dispatches `CI` itself after merging (`dispatchCiWorkflow`), and the schedule catches anything the events miss.

## Config: `bot-merge.json`

```json
{
  "bots": ["github-actions[bot]", "dependabot[bot]", "renovate[bot]", "fitzyracing1-bot"],
  "mergeMethod": "squash",
  "requiredLight": "lit",
  "baseBranch": "main",
  "ignoreChecks": ["bot-merge", "revert-guard", "make-test-pr"],
  "dispatchCiWorkflow": "ci.yml"
}
```

| Key | Meaning |
|-----|---------|
| `bots` | Allowlist of PR author logins that may be auto-merged. Anyone else is ignored. `fitzyracing1-bot` is a placeholder. |
| `mergeMethod` | `squash` (default), `merge`, or `rebase`. |
| `requiredLight` | Must be `lit`. bot-merge refuses any other value. |
| `baseBranch` | Branch PRs merge into and the guard watches. Default `main`. |
| `ignoreChecks` | Check names left out of the light (bot-merge's own jobs). |
| `dispatchCiWorkflow` | Workflow file to `workflow_dispatch` on the base branch after a merge and on a revert branch. `null` to disable (e.g. if merges are done with a PAT / App token that triggers CI normally). |

## Safety

- **Humans never auto-merged.** Only exact allowlisted logins qualify.
- **Hold label.** Add `bot-merge:hold` to any PR to keep bot-merge's hands off it.
- **No checks means dark.** A PR with no CI is never merged.
- **SHA-pinned merges.** A push after evaluation makes the merge fail instead of merging untested code.
- **Revert guard.** A merge that leaves `main` dark gets a revert PR + issue, never a force-push.

## Add it to another repo

1. Copy `src/bot-merge.mjs`, `bot-merge.json` and `.github/workflows/bot-merge.yml`.
2. Edit `bot-merge.json`: set `bots`, `baseBranch`, and `dispatchCiWorkflow` (your CI workflow file name, or `null`). In `bot-merge.yml`, set `workflow_run.workflows` to your CI workflow's `name`.
3. Settings → Actions → General → Workflow permissions: "Read and write" and "Allow GitHub Actions to create and approve pull requests" (needed for revert PRs), or:
   `gh api -X PUT repos/OWNER/REPO/actions/permissions/workflow -f default_workflow_permissions=write -F can_approve_pull_request_reviews=true`
4. If `main` has branch protection requiring reviews, `GITHUB_TOKEN` cannot satisfy it; use a GitHub App token instead.

## Development

```sh
npm test            # node --test, zero dependencies, Node 20+
GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo node src/bot-merge.mjs light <sha>   # exit 0 lit, 1 dark
```

`.github/workflows/make-test-pr.yml` is a demo: it opens a `lit` or `dark` PR as `github-actions[bot]` under `demo/` so the whole flow can be exercised in this repo.

## License

MIT, Copyright (c) 2026 Joshua Almeida.
