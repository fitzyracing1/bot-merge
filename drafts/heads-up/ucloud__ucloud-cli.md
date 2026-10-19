# Private heads-up — ucloud/ucloud-cli

**Workflow:** `.github/workflows/auto-merge.yml`
**File:** https://github.com/ucloud/ucloud-cli/blob/713ed4871a3ae4187f42487e5fcc6ed51e79331c/.github/workflows/auto-merge.yml
**Severity (my read):** MEDIUM

---

Hi — while looking at open-source CI setups I noticed something in **ucloud/ucloud-cli** you may want to double-check. Sending privately rather than filing anything public.

Your workflow `.github/workflows/auto-merge.yml` has a pull_request_target-triggered forced merge in job "enable" gated only by a label (weak: any PR carrying/earning the label is merged).

In practice that can mean a pull request from **anyone** — including a stranger — could, depending on your branch-protection settings, be merged into your base branch automatically without a maintainer review or a passing (lit) CI check. On a `pull_request_target` trigger especially, that step runs with a write-scoped token against untrusted code.

If you already have branch protection (required reviews / required status checks) covering the base branch, this may be a non-issue — please ignore me. If not, a small hardening step is to gate the merge on:

- an **author/actor allowlist** (only auto-merge PRs from specific trusted bots/maintainers), **and**
- a **required review** or a **required passing status check** before the merge runs.

For a concrete example of that shape (allowlist + "merge only once the CI light is lit"), here's a small experiment of mine, shared as a reference not a pitch:
https://github.com/fitzyracing1/bot-merge

No action needed toward me — just flagging in case it's useful.

— Joshua
