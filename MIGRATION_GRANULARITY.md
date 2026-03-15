# Migration Granularity Notes

- Repository: `fintechbankx-platform-event-streaming`
- Source monorepo: `enterprise-loan-management-system`
- Sync date: `2026-03-15`
- Sync branch: `chore/granular-source-sync-20260313`

## Applied Rules

- dir: `amanahfi-platform/event-streaming` -> `.`
- dir: `scripts/kafka` -> `scripts/kafka`
- file: `docs/DOCKER_ARCHITECTURE.md` -> `docs/DOCKER_ARCHITECTURE.md`

## Notes

- This is an extraction seed for bounded-context split migration.
- Follow-up refactoring may be needed to remove residual cross-context coupling.
- Build artifacts and local machine files are excluded by policy.

