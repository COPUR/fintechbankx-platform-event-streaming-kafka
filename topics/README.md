# Topic catalog

Status: **Proposed**. The catalog says which topics should exist and who may use them; it is not evidence that
they exist on any cluster.

[`catalog.yaml`](catalog.yaml) is the single source of truth for every `evt.*` topic: owner service, partitions,
retention, cleanup policy, the event types published on it, dead-letter topics, allowed producer (the owner only) and
known consumers. Every other topic list in this repository is generated from it.

Topics are **one per aggregate** (ADR-019, owner decision 2026-10-08): `evt.<ctx>.<aggregate>.v<major>`, record key
`aggregateId` (UTF-8), the event named by the `eventType` header. Today: `evt.ln.loan.v1`, `evt.pay.payment.v1`,
`evt.pay.rtp.v1`, `evt.pay.bulk.v1`, `evt.pay.mandate.v1`, `evt.cus.customer.v1`, `evt.rsk.risk.v1`,
`evt.cmp.compliance.v1`, `evt.of.consent.v1` and `evt.of.payee.v1`, plus the consumer-owned DLQs. The per-event topics
(`evt.<ctx>.<aggregate>.<event>.v1`) were removed without a dual-run because nothing published to them (ADR-019
section 8).

| Generated file | Used by |
|---|---|
| [`generated/TOPIC_CATALOG.md`](generated/TOPIC_CATALOG.md) | People: the resolved table, with gaps |
| [`generated/topics.tsv`](generated/topics.tsv) | `scripts/kafka/create-topics.sh` (Amazon MSK, local Kafka) |
| [`generated/msk-client-access.json`](generated/msk-client-access.json) | Terraform `msk-client-access` module: per-service produce/consume topics and consumer groups ([deploy/msk](../deploy/msk/README.md)) |
| [`../deploy/strimzi/generated/kafka-topics.yaml`](../deploy/strimzi/generated/kafka-topics.yaml) | Strimzi Topic Operator (`KafkaTopic`) |
| [`../deploy/strimzi/generated/kafka-users.yaml`](../deploy/strimzi/generated/kafka-users.yaml) | Strimzi User Operator (`KafkaUser`, TLS auth, ACLs) |
| [`../deploy/strimzi/generated/kafka-metrics-configmap.yaml`](../deploy/strimzi/generated/kafka-metrics-configmap.yaml) | Strimzi broker metrics, rendered from [`monitoring/jmx/kafka.yml`](../monitoring/jmx/kafka.yml) |

## Change a topic

1. Change the AsyncAPI contract in the provider repository and the AsyncAPI catalog first.
2. Edit `catalog.yaml`, then run `npm run catalog:generate` and commit the catalog and the generated files together.
3. `npm test` (run by `ci/test`) fails if the catalog is invalid or a generated file is out of date.

Optional local cross-check against a checkout of `fintechbankx-governance-api-contracts-asyncapi-catalog`:

```bash
node scripts/catalog/generate.mjs --check --asyncapi <asyncapi-catalog-checkout>/asyncapi
```

## Rules the validator enforces

- Event topic `evt.<ctx>.<aggregate>.v<major>`, one per aggregate namespace and topic major, declared as
  `topics: [{major: 1, eventTypes: [...]}]`. The retired per-event form (`event:` entries, or a consumer reading
  `evt.<ctx>.<aggregate>.<event>.v<major>`) is rejected with an explicit message, and so is any topic key other than
  `major`, `eventTypes`, `partitions`, `retentionMs`, `maxMessageBytes` and `cleanupPolicy` (the record key is always
  `aggregateId`). DLQ `<consumer namespace>.dlq.v<major>`, derived, never listed by hand.
- One owner per namespace. The owner's `event_namespace` in the bootstrap manifest must equal the namespace, so a
  service can only produce to its own namespace. `producers`, if present, must be exactly `[owner]`.
- `eventTypes` lists every `<Context>.<Aggregate>.<PastTenseEvent>.v<major>` published on the topic, once each; the
  aggregate must be the namespace aggregate and the context must be the same for the whole namespace. The event major
  is independent of the topic major: a breaking change to one event adds `...v2` to the same topic's `eventTypes`
  while the producer dual-publishes. A new topic major (`evt.<ctx>.<aggregate>.v2`) is only for a change of record
  key, partition count or cleanup policy.
- `cleanup.policy` is `delete` (events are immutable facts); `min.insync.replicas` is lower than the replication
  factor (defaults 2 and 3).
- A consumer needs a code or config reference (`evidence`), a consumer group `cg.<service-id>.<purpose>.v<major>`, the
  exact topics it reads and the `eventTypes` it handles (each published on one of those topics). It skips every other
  event type on the topic: commit, never dead-letter. Access is granted per aggregate topic, so a consumer can read
  every event type of the aggregate; payloads therefore carry ids and facts only. DLQs are consumer-owned (ADR-019): a consumer writes and reads (redrive) only the DLQ of
  its own namespace (`services.<id>.eventNamespace`, checked against the manifest). `dlq:`, if set, must be that
  topic; the source namespace DLQ is rejected. A consumer-only service still gets its namespace DLQ (as for the
  open-finance consent projections). A pure producer only writes its events.

## Bootstrap manifest copy

[`registry/repository-bootstrap-manifest.csv`](registry/repository-bootstrap-manifest.csv) is a verbatim copy of
`docs/enterprisearchitecture/implementation-development/transformation/workspace-ddd-eda-2026-03-13/bootstrap/repository-bootstrap-manifest.csv`
in `fintechbankx-governance-architecture-enablement-enterprise-architecture` (main, 2026-10-08). CI has no access to
that repository, so the copy is vendored. Refresh it when the manifest changes and check it with
`node scripts/catalog/generate.mjs --check --manifest <enterprise-architecture-checkout>/<path above>`.

## Consumers today

No fintechbankx service repository contained a Kafka consumer on the branches scanned on 2026-10-08. The consumers in
the catalog (loan repayment allocation on `evt.pay.payment.v1`, handling `Payments.Payment.LoanPaymentCompleted.v1`;
three open-finance consent projections on `evt.of.consent.v1`) were confirmed by the service threads and are in progress; their `evidence` says so. Monolith consumers
of legacy topics are not mapped.
