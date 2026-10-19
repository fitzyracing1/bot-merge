# Open-merge scan results

_Read-only scan. 70 workflows classified from 70 candidates._

- HIGH: 1
- MEDIUM: 16
- LOW/skip: 53

## HIGH

| owner/repo | workflow | why | file |
|---|---|---|---|
| SnowAmberX/DDC-statistic | `.github/workflows/auto-merge.yaml` | pull_request-triggered FORCED merge in job "auto-merge" with no author/allowlist check, no required review, and no required lit check — a stranger PR could land on the base branch | https://github.com/SnowAmberX/DDC-statistic/blob/55fbd3886ac40505098db8f591e037ddee67e5ce/.github/workflows/auto-merge.yaml |

## MEDIUM

| owner/repo | workflow | why | file |
|---|---|---|---|
| Tencent/Hippy | `.github/workflows/gh_action_merge.yml` | pull_request_target-triggered forced merge in job "rebase_merge_action" gated only by a label (weak: any PR carrying/earning the label is merged) | https://github.com/Tencent/Hippy/blob/b0a8f6761a83eaccc9cbde1662a1a8e463995140/.github/workflows/gh_action_merge.yml |
| enarx/enarx | `.github/workflows/pr.yml` | pull_request_target-triggered auto-merge in job "auto-merge" (--auto / enable-automerge) with no author/review/check gate — merges any PR if branch protection is weak or absent | https://github.com/enarx/enarx/blob/6eb92364c3d8e93802deb24e03255a5c1f3e80ce/.github/workflows/pr.yml |
| determined-ai/determined | `.github/workflows/backport.yaml` | pull_request_target-triggered forced merge in job "backport_and_merge" gated only by a label (weak: any PR carrying/earning the label is merged) | https://github.com/determined-ai/determined/blob/c1e9c6d7b821ef246d612bb9922f7fb1b58dcf2e/.github/workflows/backport.yaml |
| google/json_serializable.dart | `.github/workflows/autosubmit.yml` | pull_request_target-triggered auto-merge in job "autosubmit" (--auto / enable-automerge + label) with no author/review/check gate — merges any PR if branch protection is weak or absent | https://github.com/google/json_serializable.dart/blob/fee3c8ba7c8076cc3a798aa8323adee0498277f2/.github/workflows/autosubmit.yml |
| projen/projen | `.github/workflows/auto-queue.yml` | pull_request_target-triggered auto-merge in job "enableAutoQueue" (--auto / enable-automerge) with no author/review/check gate — merges any PR if branch protection is weak or absent | https://github.com/projen/projen/blob/1c93ff3a07954e7fec85aba836737d03b654564f/.github/workflows/auto-queue.yml |
| ucloud/ucloud-cli | `.github/workflows/auto-merge.yml` | pull_request_target-triggered forced merge in job "enable" gated only by a label (weak: any PR carrying/earning the label is merged) | https://github.com/ucloud/ucloud-cli/blob/713ed4871a3ae4187f42487e5fcc6ed51e79331c/.github/workflows/auto-merge.yml |
| merely-true/merely-true | `.github/workflows/auto_merge.yml` | pull_request_target-triggered auto-merge in job "auto-merge" (--auto / enable-automerge) with no author/review/check gate — merges any PR if branch protection is weak or absent | https://github.com/merely-true/merely-true/blob/f4ff319d4622f410e001ebab016c4e7d23f9cd97/.github/workflows/auto_merge.yml |
| yementechcollective/aweasome-yemeni-open-source | `.github/workflows/auto-merge.yml` | pull_request_target-triggered forced merge in job "auto-merge" gated only by a label (weak: any PR carrying/earning the label is merged) | https://github.com/yementechcollective/aweasome-yemeni-open-source/blob/19f6ed2b7c8652d8051002a68980f57161943ac3/.github/workflows/auto-merge.yml |
| Ikalus1988/MisakaNet | `.github/workflows/pr-checks.yml` | pull_request-triggered auto-merge in job "audit" (--auto / enable-automerge) with no author/review/check gate — merges any PR if branch protection is weak or absent | https://github.com/Ikalus1988/MisakaNet/blob/45f279fd780d431bc2c31e58c8e955289da169c4/.github/workflows/pr-checks.yml |
| z5labs/bedrock | `.github/workflows/auto-merge.yaml` | pull_request_target-triggered auto-merge in job "enable-auto-merge" (--auto / enable-automerge + label) with no author/review/check gate — merges any PR if branch protection is weak or absent | https://github.com/z5labs/bedrock/blob/ea6b0abcd4785442fc8da68d07a5a26f0f68106a/.github/workflows/auto-merge.yaml |
| PostOakLabs/ainumbers | `.github/workflows/automerge-label.yml` | pull_request-triggered forced merge in job "enable-automerge" gated only by a label (weak: any PR carrying/earning the label is merged) | https://github.com/PostOakLabs/ainumbers/blob/4c73bac6334b9ceae9b1db1b1169b65e4b7608d0/.github/workflows/automerge-label.yml |
| antvis/G2Plot | `.github/workflows/auto-merge.yml` | pull_request-triggered auto-merge in job "automerge" (--auto / enable-automerge + label) with no author/review/check gate — merges any PR if branch protection is weak or absent | https://github.com/antvis/G2Plot/blob/eda7f0035a45a0ca90641106ca08d679c5ef0a63/.github/workflows/auto-merge.yml |
| vuestorefront/storefront-ui | `.github/workflows/cd-v2-automerge.yml` | pull_request-triggered auto-merge in job "automerge" (--auto / enable-automerge + label) with no author/review/check gate — merges any PR if branch protection is weak or absent | https://github.com/vuestorefront/storefront-ui/blob/bfa337e2b516b3a7433dd3d60bff4c4044c5e0da/.github/workflows/cd-v2-automerge.yml |
| jmcdo29/testing-nestjs | `.github/workflows/ci.yml` | pull_request-triggered auto-merge in job "automerge" (--auto / enable-automerge + label) with no author/review/check gate — merges any PR if branch protection is weak or absent | https://github.com/jmcdo29/testing-nestjs/blob/47ab935278c662b5165e07f6783d395db047db2d/.github/workflows/ci.yml |
| XPoet/hexo-theme-keep | `.github/workflows/auto-merge.yml` | pull_request-triggered auto-merge in job "automerge" (--auto / enable-automerge + label) with no author/review/check gate — merges any PR if branch protection is weak or absent | https://github.com/XPoet/hexo-theme-keep/blob/c5922f1990d3a5ca18f0dc6f75ee3327131e432e/.github/workflows/auto-merge.yml |
| jing332/tts-server-android | `.github/workflows/automerge.yml` | pull_request-triggered auto-merge in job "automerge" (--auto / enable-automerge + label) with no author/review/check gate — merges any PR if branch protection is weak or absent | https://github.com/jing332/tts-server-android/blob/49b4a7c33496110b62a5e727b76458bdec0aa6e7/.github/workflows/automerge.yml |
