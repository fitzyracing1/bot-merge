# open-merge-scan

A **read-only** scanner that finds public repos whose GitHub Actions will merge
**any** pull request — no author/allowlist check, no required review, and no
required lit CI check.

> Terminology: **lit** = success, **dark** = anything else.

## Hard safety guarantees

- Read-only against every scanned repo. It performs GitHub **code search** and
  fetches **workflow file contents** only.
- It never opens PRs/issues/comments/forks/advisories, never submits a PR to a
  scanned repo to "test" it, never sends anything, and never prints tokens.
- It authenticates through the already-configured `gh` CLI.

## Usage

```bash
# live scan (caps candidates, sleeps between calls, backs off on rate limits)
node scan/open-merge-scan.mjs --max=70 --per-page=15 --sleep=4000 --draft-medium

# re-classify the cached workflows without any network calls
node scan/open-merge-scan.mjs --from-cache --draft-medium
```

Flags: `--max=N` candidate cap, `--per-page=N` results per search, `--sleep=ms`
delay between calls, `--draft-medium` also draft MEDIUM hits, `--from-cache`
reclassify `scan/cache/` offline.

## Classification

For each candidate workflow the classifier parses the `on:` block and each job's
steps, then per merging job decides:

- **HIGH** — PR-triggered (`pull_request` / `pull_request_target`) **forced**
  merge (`gh pr merge` without `--auto`, the pulls merge REST/GraphQL API, or
  `--admin`) with no author/allowlist check, no required review, and no required
  lit check. A stranger PR could land on the base branch.
- **MEDIUM** — weak/unclear gating: merge enabled via `--auto` /
  `enable-pull-request-automerge` / `pascalgn/automerge-action` (respects branch
  protection, so it *depends on it*), or gated only by a label.
- **LOW / skip** — allowlisted bots only, same-repo-only PRs, requires review or
  a lit status check, the merge runs only on non-PR events, a disabled/renamed
  workflow file, our own bot-merge pattern, or no merge primitive at all.

Lines inside `grep`/comments/`echo` are ignored so that guards which *forbid*
merges are not mistaken for merges.

## Outputs

- `scan/results.jsonl` — one object per classified workflow.
- `scan/RESULTS.md` — HIGH and MEDIUM summary tables.
- `drafts/heads-up/<owner>__<repo>.md` — a polite private heads-up draft per hit.
- `QUEUE.md` — checklist "awaiting Joshua OK". **Nothing is ever sent.**
