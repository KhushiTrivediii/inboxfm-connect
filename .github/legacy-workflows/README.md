# Inactive upstream workflow templates

These workflows were inherited from Activepieces and depend on its deployment environments, service accounts, monitoring IDs, paid runners, or removed visual-builder test paths.

They are retained here for attribution and reference. GitHub only discovers workflow files directly under `.github/workflows/`, so these templates cannot deploy, publish, modify upstream monitoring, or comment on issues automatically.

This fork's active checks are documented in [docs/CI.md](../../docs/CI.md). To restore a template, first replace upstream domains/accounts, verify current source paths, configure infrastructure owned by this fork, and review credentials and untrusted PR handling. Copying a template back into the active directory should be reviewed in a PR against `dev`.
