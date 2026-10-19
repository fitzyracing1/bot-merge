# Private heads-up — Ikalus1988/MisakaNet

**Workflow:** `.github/workflows/pr-checks.yml`
**File:** https://github.com/Ikalus1988/MisakaNet/blob/45f279fd780d431bc2c31e58c8e955289da169c4/.github/workflows/pr-checks.yml
**Severity (my read):** MEDIUM

---

Hi — while looking at open-source CI setups I noticed something in **Ikalus1988/MisakaNet** you may want to double-check. Sending privately rather than filing anything public.

Your workflow `.github/workflows/pr-checks.yml` has a pull_request-triggered auto-merge in job "audit" (--auto / enable-automerge) with no author/review/check gate — merges any PR if branch protection is weak or absent.

In practice that can mean a pull request from **anyone** — including a stranger — could, depending on your branch-protection settings, be merged into your base branch automatically without a maintainer review or a passing (lit) CI check. On a `pull_request_target` trigger especially, that step runs with a write-scoped token against untrusted code.

If you already have branch protection (required reviews / required status checks) covering the base branch, this may be a non-issue — please ignore me. If not, a small hardening step is to gate the merge on:

- an **author/actor allowlist** (only auto-merge PRs from specific trusted bots/maintainers), **and**
- a **required review** or a **required passing status check** before the merge runs.

For a concrete example of that shape (allowlist + "merge only once the CI light is lit"), here's a small experiment of mine, shared as a reference not a pitch:
https://github.com/fitzyracing1/bot-merge

No action needed toward me — just flagging in case it's useful.

— Joshua
