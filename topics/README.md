# Topic catalog

Status: **Proposed**. The catalog says which topics should exist and who may use them; it is not evidence that
they exist on any cluster.

[`catalog.yaml`](catalog.yaml) is the single source of truth for every `evt.*` topic: owner service, partitions,
retention, cleanup policy, dead-letter topic, allowed producer (the owner only) and known consumers. Every other
topic list in this repository is generated from it.

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

- Event topic `evt.<ctx>.<aggregate>.<event>.v<major>`, event in kebab-case; DLQ `evt.<ctx>.<aggregate>.dlq.v<major>`,
  derived (one per namespace and major version), never listed by hand.
- One owner per namespace. The owner's `event_namespace` in the bootstrap manifest must equal the namespace, so a
  service can only produce to its own namespace. `producers`, if present, must be exactly `[owner]`.
- `eventType` is `<Context>.<Aggregate>.<PastTenseEvent>.v<major>`; its aggregate, event and version must match the
  namespace aggregate, the topic event (kebab to Pascal case) and the topic major.
- `cleanup.policy` is `delete` (events are immutable facts); `min.insync.replicas` is lower than the replication
  factor (defaults 2 and 3).
- A consumer needs a code or config reference (`evidence`), a consumer group `cg.<service-id>.<purpose>.v<major>` and
  the exact topics it reads. A consumer writes and reads (redrive) one DLQ: by default the source namespace DLQ, or
  with `dlq:` the DLQ of its own manifest namespace (provisioned even if that namespace has no event topics yet, as
  for the open-finance consent projections). The owner only writes its events.

## Bootstrap manifest copy

[`registry/repository-bootstrap-manifest.csv`](registry/repository-bootstrap-manifest.csv) is a verbatim copy of
`docs/enterprisearchitecture/implementation-development/transformation/workspace-ddd-eda-2026-03-13/bootstrap/repository-bootstrap-manifest.csv`
in `fintechbankx-governance-architecture-enablement-enterprise-architecture` (main, 2026-10-08). CI has no access to
that repository, so the copy is vendored. Refresh it when the manifest changes and check it with
`node scripts/catalog/generate.mjs --check --manifest <enterprise-architecture-checkout>/<path above>`.

## Consumers today

No fintechbankx service repository contained a Kafka consumer on the branches scanned on 2026-10-08. The consumers in
the catalog (loan repayment allocation on `evt.pay.payment.loan-payment-completed.v1`, three open-finance consent
projections) were confirmed by the service threads and are in progress; their `evidence` says so. Monolith consumers
of legacy topics are not mapped.
