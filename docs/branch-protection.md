# Branch protection runbook

How to configure protection on `main` for `pveloso01/photo-portfolio-store`. These rules are not in code — they live on GitHub. This document is the source of truth so they can be re-applied or audited.

## Purpose

Prevent unreviewed or broken code from landing on `main`. Every change must go through a PR, pass CI, get at least one approval (including a code-owner review where applicable), and be discussion-clean.

## Required configuration

| Setting | Value |
|---|---|
| Require pull request before merging | **on** |
| Approving reviews required | **1** |
| Dismiss stale approvals on new commit | **on** |
| Require review from Code Owners | **on** |
| Require status checks to pass | **on** |
| Required checks | `lint`, `typecheck`, `test`, `build`, `security-scan` (job names from `.github/workflows/ci.yml` — F0.4) |
| Require branches to be up to date | **on** |
| Require conversation resolution | **on** |
| Require linear history (squash merge) | **on** |
| Restrict who can push to matching branches | **only via PR** (no direct push, even for admins) |
| Allow force pushes | **off** |
| Allow deletions | **off** |
| Lock branch | **off** (PR merges still allowed) |
| Do not allow bypassing the above | **on** |

## How to apply

The settings can be configured via the GitHub UI (`Settings → Branches → Branch protection rules`) or via the API:

```bash
# Enable PR review + dismiss stale + require code owner
gh api -X PUT repos/pveloso01/photo-portfolio-store/branches/main/protection \
  -f required_pull_request_reviews.required_approving_review_count=1 \
  -f required_pull_request_reviews.dismiss_stale_reviews=true \
  -f required_pull_request_reviews.require_code_owner_reviews=true \
  -f enforce_admins=true \
  -f required_linear_history=true \
  -f allow_force_pushes=false \
  -f allow_deletions=false \
  -f required_conversation_resolution=true
```

```bash
# Require specific status checks (after F0.4 lands and CI jobs exist)
gh api -X PATCH repos/pveloso01/photo-portfolio-store/branches/main/protection/required_status_checks \
  -f strict=true \
  -F contexts[]=lint -F contexts[]=typecheck -F contexts[]=test -F contexts[]=build -F contexts[]=security-scan
```

## How to verify

```bash
gh api repos/pveloso01/photo-portfolio-store/branches/main/protection | jq
```

Expected output includes the keys `required_pull_request_reviews`, `required_status_checks`, `enforce_admins`, `required_linear_history`, etc., matching the table above.

## Emergency override (break-glass)

If a production-down incident requires bypassing protection:

1. Document the reason in an issue tagged `incident`.
2. Temporarily disable the specific protection in the GitHub UI (audit-logged).
3. Land the fix; the commit message MUST include the tag `[break-glass]` and reference the incident issue.
4. Re-enable protection immediately after the merge.
5. Post-incident review within 48h to harden the gap that required the override.

All break-glass merges are audited via GitHub's audit log (`Settings → Audit log → Branch protection`).
