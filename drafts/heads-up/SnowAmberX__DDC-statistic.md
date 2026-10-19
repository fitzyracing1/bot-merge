# Private heads-up — SnowAmberX/DDC-statistic

**Workflow:** `.github/workflows/auto-merge.yaml`
**File:** https://github.com/SnowAmberX/DDC-statistic/blob/55fbd3886ac40505098db8f591e037ddee67e5ce/.github/workflows/auto-merge.yaml
**Severity (my read):** HIGH

---

Hi — while looking at open-source CI setups I noticed something in **SnowAmberX/DDC-statistic** you may want to double-check. Sending privately rather than filing anything public.

Your workflow `.github/workflows/auto-merge.yaml` has a pull_request-triggered FORCED merge in job "auto-merge" with no author/allowlist check, no required review, and no required lit check — a stranger PR could land on the base branch.

In practice that can mean a pull request from **anyone** — including a stranger — could be merged into your base branch automatically, with no maintainer review or passing (lit) CI check in the way. On a `pull_request_target` trigger especially, that step runs with a write-scoped token against untrusted code.

If you already have branch protection (required reviews / required status checks) covering the base branch, this may be a non-issue — please ignore me. If not, a small hardening step is to gate the merge on:

- an **author/actor allowlist** (only auto-merge PRs from specific trusted bots/maintainers), **and**
- a **required review** or a **required passing status check** before the merge runs.

For a concrete example of that shape (allowlist + "merge only once the CI light is lit"), here's a small experiment of mine, shared as a reference not a pitch:
https://github.com/fitzyracing1/bot-merge

No action needed toward me — just flagging in case it's useful.

— Joshua
