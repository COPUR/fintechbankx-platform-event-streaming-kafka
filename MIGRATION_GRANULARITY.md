# Migration Granularity Notes

- Repository: `fintechbankx-platform-event-streaming`
- Source monorepo: `enterprise-loan-management-system`
- Sync date: `2026-03-15`
- Sync branch: `chore/granular-source-sync-20260313`

## Applied Rules

- dir: `amanahfi-platform/event-streaming` -> `.`
- dir: `scripts/kafka` -> `scripts/kafka`
- file: `docs/DOCKER_ARCHITECTURE.md` -> `docs/DOCKER_ARCHITECTURE.md`

## Later additions (2026-10-08, Proposed)

- file: `monitoring/jmx/kafka.yml` -> `monitoring/jmx/kafka.yml` (monolith `ffe8379`; rules added for the event platform)
- monolith `docker-compose.yml` services `zookeeper`, `kafka`, `kafka-topic-init` -> replaced by `deploy/local/docker-compose.yml` (KRaft) and `deploy/strimzi`
- not migrated: monolith `kafka-connect` / Debezium (`infrastructure/kafka-connect`, `monitoring/jmx/debezium.yml`). It serves the monolith's open-finance provider outbox (`openfinance.provider.*` topics), not the strangler of the extracted services, which publish through their own outbox relays. Listed as a gap in `topics/catalog.yaml`.

## Notes

- This is an extraction seed for bounded-context split migration.
- Follow-up refactoring may be needed to remove residual cross-context coupling.
- Build artifacts and local machine files are excluded by policy.

