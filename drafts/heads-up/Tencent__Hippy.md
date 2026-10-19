# Private heads-up — Tencent/Hippy

**Workflow:** `.github/workflows/gh_action_merge.yml`
**File:** https://github.com/Tencent/Hippy/blob/b0a8f6761a83eaccc9cbde1662a1a8e463995140/.github/workflows/gh_action_merge.yml
**Severity (my read):** MEDIUM

---

Hi — while looking at open-source CI setups I noticed something in **Tencent/Hippy** you may want to double-check. Sending privately rather than filing anything public.

Your workflow `.github/workflows/gh_action_merge.yml` has a pull_request_target-triggered forced merge in job "rebase_merge_action" gated only by a label (weak: any PR carrying/earning the label is merged).

In practice that can mean a pull request from **anyone** — including a stranger — could, depending on your branch-protection settings, be merged into your base branch automatically without a maintainer review or a passing (lit) CI check. On a `pull_request_target` trigger especially, that step runs with a write-scoped token against untrusted code.

If you already have branch protection (required reviews / required status checks) covering the base branch, this may be a non-issue — please ignore me. If not, a small hardening step is to gate the merge on:

- an **author/actor allowlist** (only auto-merge PRs from specific trusted bots/maintainers), **and**
- a **required review** or a **required passing status check** before the merge runs.

For a concrete example of that shape (allowlist + "merge only once the CI light is lit"), here's a small experiment of mine, shared as a reference not a pitch:
https://github.com/fitzyracing1/bot-merge

No action needed toward me — just flagging in case it's useful.

— Joshua
