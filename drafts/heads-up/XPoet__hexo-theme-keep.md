# Private heads-up — XPoet/hexo-theme-keep

**Workflow:** `.github/workflows/auto-merge.yml`
**File:** https://github.com/XPoet/hexo-theme-keep/blob/c5922f1990d3a5ca18f0dc6f75ee3327131e432e/.github/workflows/auto-merge.yml
**Severity (my read):** MEDIUM

---

Hi — while looking at open-source CI setups I noticed something in **XPoet/hexo-theme-keep** you may want to double-check. Sending privately rather than filing anything public.

Your workflow `.github/workflows/auto-merge.yml` has a pull_request-triggered auto-merge in job "automerge" (--auto / enable-automerge + label) with no author/review/check gate — merges any PR if branch protection is weak or absent.

In practice that can mean a pull request from **anyone** — including a stranger — could, depending on your branch-protection settings, be merged into your base branch automatically without a maintainer review or a passing (lit) CI check. On a `pull_request_target` trigger especially, that step runs with a write-scoped token against untrusted code.

If you already have branch protection (required reviews / required status checks) covering the base branch, this may be a non-issue — please ignore me. If not, a small hardening step is to gate the merge on:

- an **author/actor allowlist** (only auto-merge PRs from specific trusted bots/maintainers), **and**
- a **required review** or a **required passing status check** before the merge runs.

For a concrete example of that shape (allowlist + "merge only once the CI light is lit"), here's a small experiment of mine, shared as a reference not a pitch:
https://github.com/fitzyracing1/bot-merge

No action needed toward me — just flagging in case it's useful.

— Joshua
