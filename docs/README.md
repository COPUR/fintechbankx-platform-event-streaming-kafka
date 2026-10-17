# Documentation

Service-level architecture, contracts, and test references for `fintechbankx-platform-event-streaming-kafka`.

- [Topic catalog (resolved, generated)](../topics/generated/TOPIC_CATALOG.md) and [how to change it](../topics/README.md)
- [Service client configuration (MSK IAM, Strimzi TLS, producer/consumer, DLQ)](guides/SERVICE_CLIENT_CONFIGURATION.md)
- [Topic granularity: one topic per aggregate (decided 2026-10-08, ADR-019)](architecture/TOPIC_GRANULARITY_PROPOSAL.md)
- [Topic Naming Migration (legacy to `evt.*`)](architecture/TOPIC_NAMING_MIGRATION.md)
- [Strimzi deployment](../deploy/strimzi/README.md) and [Amazon MSK usage](../deploy/msk/README.md)
- [Cell-based architecture plan](architecture/CELL_BASED_ARCHITECTURE_IMPLEMENTATION_PLAN.md)
- [Publication Guardrails](publication/PUBLICATION_GUARDRAILS.md)
- [Docker architecture (historical monolith reference)](DOCKER_ARCHITECTURE.md)
