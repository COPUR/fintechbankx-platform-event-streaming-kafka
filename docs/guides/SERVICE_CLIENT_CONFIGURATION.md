# Kafka client configuration for FinTechBankX services

Status: **Proposed** (Event Platform Squad). Applies to every service that produces or consumes `evt.*` topics.
The topics, owners and allowed consumers are in [`topics/catalog.yaml`](../../topics/catalog.yaml).

Topic scheme (ADR-019, owner decision 2026-10-08): **one topic per aggregate**, `evt.<ctx>.<aggregate>.v<major>`, for
example `evt.ln.loan.v1` and `evt.pay.payment.v1`. Every event of the aggregate goes to that topic; the event is
named by its `eventType` (envelope field and record header), not by the topic. The per-event topics
`evt.<ctx>.<aggregate>.<event>.v1` are retired: nothing published to them, so they were removed without a dual-run.

## 1. Connection per runtime

| Runtime | Bootstrap | `security.protocol` | Authentication | Identity |
|---|---|---|---|---|
| AWS (Amazon MSK) | `bootstrap_brokers_sasl_iam` output of `msk-cluster` (port 9098) | `SASL_SSL` | `AWS_MSK_IAM` | The pod's IRSA role (`system:serviceaccount:<ns>:<sa>`) with the policy from `msk-client-access` |
| In-cluster (Strimzi) | `fintechbankx-kafka-bootstrap.kafka.svc.cluster.local:9093` | `SSL` | TLS client certificate | `KafkaUser` named after the service id, ACLs from the catalog |
| Laptop ([`deploy/local`](../../deploy/local/docker-compose.yml)) | `localhost:29092` | `PLAINTEXT` | none | none (local only; the service runs with `SPRING_PROFILES_ACTIVE=local`) |

Keep `application.yml` runtime-neutral (as the service repositories already do with `KAFKA_BOOTSTRAP_SERVERS` and
`KAFKA_SECURITY_PROTOCOL`) and add the authentication in a Spring profile selected per environment
(`SPRING_PROFILES_ACTIVE=kafka-msk` or `kafka-strimzi`).

### Profile selection

The service does not choose its Kafka profile. On the shared chart (`charts/fintechbankx-service` in
`fintechbankx-platform-delivery-iac-cicd-templates`) the profile comes from the chart value `kafka.runtime`: `msk`
renders `SPRING_PROFILES_ACTIVE=kafka-msk`, `strimzi` renders `kafka-strimzi`. The default is `""`, which renders no
profile and is meant for services without Kafka; a Kafka service must set `kafka.runtime`, and the chart fails when a
`security.protocol` name (for example `KAFKA_SECURITY_PROTOCOL`) is set while `kafka.runtime` is `""`. The chart
refuses any user-set `spring.profiles.*` name (in `config`, `extraEnv`, `SPRING_APPLICATION_JSON` or JVM options), so
the profile cannot be overridden or extended from values. Services with their own chart follow the same rule: they
render the Kafka profile only as `kafka-msk` or `kafka-strimzi` (the consent, corporate and payee charts add `aws`;
the atm and products charts, which have no Kafka client, render `aws` alone), and the guard they vendor (see the end of
the next section) refuses every user-set `spring.profiles.*` name on the value routes its adapter maps. They render no
Spring config import from values, and in the charts with a PostgreSQL database the guard pins the database CA mount.

### Startup TLS assertion

Guardrail 4a requires every service to assert its Kafka client configuration at startup, on by default, and to refuse
to start when the assertion fails:

- Every producer, consumer, admin and Streams client uses `security.protocol` `SASL_SSL` (Amazon MSK with
  `AWS_MSK_IAM`, profile `kafka-msk`) or `SSL` (Strimzi mutual TLS, profile `kafka-strimzi`).
- `PLAINTEXT`, `SASL_PLAINTEXT` and an unset protocol stop startup.
- `ssl.endpoint.identification.algorithm` stays `https`, the Kafka client default (host name verification is never
  turned off; no service sets it, and only consent and payee check it explicitly, refusing an empty or `none` value).

The same assertion checks the database URL (`sslmode=verify-full`); see the chart README section "Service-side TLS
assertion" in `fintechbankx-platform-delivery-iac-cicd-templates` at commit `cc26a97` or later. That README agrees with
this guide from that commit on; its earlier commits describe the services before the pull request heads the status
below was checked against.

Status, as checked against the services' open pull request branches in October 2026:

- `fintechbankx-lendingpayments-loan-lifecycle-core`, the payment-orchestration repositories `-initiation-settlement`,
  `-bulk-orchestration`, `-recurring-mandates` and `-request-to-pay`, and the seven open-finance services
  (`fintechbankx-openfinance-*`) ship it in the shape this guide describes: the property `fintechbankx.tls.enforce`
  (`true` in `application.yml`), the profiles `application-kafka-msk.yml`, `application-kafka-strimzi.yml` and
  `application-local.yml`, and a test that the default enforces and only the `local` profile switches it off. The check
  needs no other profile to run. The open-finance atm and products services have no Kafka client: they have no Kafka
  profile files and check the database URL only. Corporate, retail and metadata use DocumentDB, so their assertion
  checks the MongoDB client's TLS in place of a JDBC URL.
- `fintechbankx-customer-profile-kyc-core`, `fintechbankx-riskcompliance-risk-decisioning-core` and
  `fintechbankx-riskcompliance-compliance-evidence-core` ship a `KafkaTlsGuard` (with a `DatabaseTlsGuard`) that is on
  by default, whether or not the outbox relay is on, with `kafka-msk` and `kafka-strimzi` profiles. All three accept
  `SASL_SSL` or `SSL`. While on, the guards require `DB_SSL_ROOT_CERT`, which their own charts always set; the shared
  chart sets it only while `databaseCa.enabled` (the default). Only the `local` profile, by its name, or
  `fintechbankx.tls.enforce` set to `false` turns them off; they have no `local` profile file, and only their tests set
  the switch.

Every other service, and every new one, adds the assertion in the first shape. The second group has not moved to it:
its branches have no `application-local.yml` and set `fintechbankx.tls.enforce` in tests only.

The laptop runtime (`PLAINTEXT` on `localhost:29092`, or `kafka:9092` inside the shared compose stack of
`fintechbankx-platform-delivery-iac-cicd-templates`) is refused by the assertion outside local runs, so a service
started against it sets `SPRING_PROFILES_ACTIVE=local` (the shared compose stack does this for every service). In the
first group the `local` profile (`application-local.yml`, with the test resources) is the one place in the service's
own configuration that sets the assertion's off switch `fintechbankx.tls.enforce: false`; in the second group the
`local` profile turns the guards off by its name, and only the tests set the switch. No service chart renders `local`
or the switch, and the guard refuses both on the value routes its adapter maps (below).

The shared chart (`fintechbankx-service`) refuses the switch and every `spring.profiles.*` name, so values can set
neither the switch nor `local`. The exact names and spellings it refuses are the name rules in the chart README
section "Datasource and TLS guard" (`charts/fintechbankx-service/README.md` in
`fintechbankx-platform-delivery-iac-cicd-templates`, commit `cc26a97` or later); this guide does not repeat them. The
service charts vendor that guard (same README, section "Vendoring the guard"): each copies the shared chart's
`templates/_helpers.tpl` unchanged and calls `fbx.guard` through an adapter that maps the chart's own value names to the
guard's input routes, so it refuses the same names on every route the adapter maps.

Service charts must vendor the guard of `fintechbankx-platform-delivery-iac-cicd-templates` commit `6b6c317` or later
(`_helpers.tpl` sha256 `8ba2e4a11ead019c25bf0a01e4fe4bbabb6fef0e1980e5fa828ccb9f5673f8ba`), copied without a header
and checked in the service's CI with that repository's `verify-vendored-guard.sh`. From that commit on, the guard pins
the database CA mount (its path, key and ConfigMap) to the platform's RDS CA bundle, so values cannot mount another
file through it. The service charts render no Spring config import from values, and the guard refuses every
`spring.config.*` name on the routes their adapters map. As checked against the open pull request branches in October
2026, the charts of all the services named in this section do so: loan-lifecycle-core, the four payment-orchestration
charts, customer, risk, compliance and the seven open-finance charts. A service that does not vendor the guard depends
on its own chart's checks.

### Amazon MSK: `application-kafka-msk.yml`

```yaml
spring:
  kafka:
    security:
      protocol: SASL_SSL
    properties:
      sasl.mechanism: AWS_MSK_IAM
      sasl.jaas.config: software.amazon.msk.auth.iam.IAMLoginModule required;
      sasl.client.callback.handler.class: software.amazon.msk.auth.iam.IAMClientCallbackHandler
```

Add `software.amazon.msk:aws-msk-iam-auth` (pin a 2.x release) to the infrastructure module. Credentials come from the
default AWS chain, which picks up the IRSA web identity token; nothing secret is configured.

### Strimzi: `application-kafka-strimzi.yml`

```yaml
spring:
  kafka:
    security:
      protocol: SSL
    ssl:
      key-store-type: PEM
      trust-store-type: PEM
      # PEM content, bound from environment variables (below)
      key-store-certificate-chain: ${KAFKA_TLS_CERT}
      key-store-key: ${KAFKA_TLS_KEY}
      trust-store-certificates: ${KAFKA_TLS_CA}
```

The User Operator writes the client certificate to Secret `<service-id>` in namespace `kafka` (keys `user.crt`,
`user.key`) and the cluster CA to `fintechbankx-cluster-ca-cert` (key `ca.crt`). Copy them into the service
namespace (External Secrets with the Kubernetes provider on shared clusters) as Secret `kafka-client-tls` and map
`KAFKA_TLS_CERT`, `KAFKA_TLS_KEY`, `KAFKA_TLS_CA` from it with `secretKeyRef`. PEM avoids keystore files and their
passphrases.

Istio: add the pod annotation `traffic.sidecar.istio.io/excludeOutboundPorts: "9093"` so the sidecar does not wrap
Kafka's own mutual TLS (see [deploy/strimzi/README.md](../../deploy/strimzi/README.md#istio)).

### Never create topics from a service

Topics exist only through the catalog. Set `spring.kafka.admin.auto-create: false` and do not declare `NewTopic` /
`TopicBuilder` beans; services have no create rights (no `CreateTopic` IAM action, no `Create` ACL), and auto topic
creation is off on both clusters.

## 2. Producer

All owners publish through their transactional outbox; the relay is the only Kafka producer in the service.

| Setting | Value | Why |
|---|---|---|
| `acks` | `all` | Write is acknowledged only when `min.insync.replicas` (2) replicas have it |
| `enable.idempotence` | `true` | No duplicates or reordering from producer retries |
| `max.in.flight.requests.per.connection` | `<= 5` | Required for idempotence to keep order |
| `retries` | default (`Integer.MAX_VALUE`), bounded by `delivery.timeout.ms` | |
| `delivery.timeout.ms` | `30000` (current service value) | The outbox row stays unpublished and is retried on the next relay run |
| `request.timeout.ms` | `20000` | Kafka refuses to build the producer unless `delivery.timeout.ms >= linger.ms + request.timeout.ms`; with the client default of 30000 the values above fail at startup |
| `compression.type` | `lz4` (recommended) | Cheaper network and storage; transparent to consumers |
| `linger.ms` | `5` (recommended) | Small batches without visible latency |
| Relay send timeout | `35 s` (outbox relay waiting on the send future) | Longer than `delivery.timeout.ms`, so the producer reports the real outcome before the relay gives up; cover the producer construction with a test |
| `client.id` | the service id | Broker logs and quotas per service |
| Topic | `evt.<ctx>.<aggregate>.v<major>` of the service's own namespace | One topic per aggregate; the relay writes every event type of the aggregate to it |
| Record key | `aggregateId`, UTF-8 text (`StringSerializer`) | Every event of one aggregate instance lands in one partition of the aggregate topic, in commit order (the loan origination and repayment sagas rely on it) |
| Record value | the envelope JSON | [`asyncapi/common/event-envelope.yaml`](https://github.com/COPUR/fintechbankx-governance-api-contracts-asyncapi-catalog/blob/main/asyncapi/common/event-envelope.yaml) |

Envelope fields: `eventId` (UUID, idempotency key), `eventType` (`<Context>.<Aggregate>.<Event>.v<major>`),
`occurredAt` (UTC), `aggregateId`, `aggregateVersion`, `correlationId`, `causationId`, `producer` (service id), `data`
(ids and facts only, no personal data snapshots).

Record headers, UTF-8 text (`EventHeaders` in the envelope schema):

| Header | Required | Value |
|---|---|---|
| `eventType` | yes | Same as the envelope `eventType`, e.g. `Lending.Loan.Disbursed.v1`; consumers route on it without parsing the value |
| `eventId` | yes | Same as the envelope `eventId` |
| `correlationId` | yes | Same as the envelope `correlationId` |
| `traceparent` | when tracing | W3C trace context, so traces cross the broker |
| `x-fapi-interaction-id` | when the flow started at a FAPI API | The interaction id |

Event topics are never compacted (`cleanup.policy=delete`; the catalog rejects anything else). Two reasons:
an event is a fact, not a state snapshot; and compacting an aggregate topic keeps only the latest event per
key (say *revoked*), dropping the history every consumer that replays needs.
A consumer that needs current state keeps its own projection and rebuilds it by replaying from the earliest
offset. Consent example: `evt.of.consent.v1` keeps 366 days (`retention.ms=31622400000`), one day more than the
365-day consent lifetime, so a replay from earliest sees every consent still alive; records are keyed by `consentId`.
The 365 days are the owner's choice, recorded in ADR-035 in the governance adr-runbooks repository (pending
acceptance by the owner and the DPO). On consent-auth's default branch nothing caps a consent's lifetime yet, so a
consent can outlive the retention and a replay then drops it; consent PR #13 adds the 365-day cap and the contract
with `retention.ms=31622400000`. The cap must merge with or before this retention reaches consumers (nothing here
enforces that order). The events carry `customerId`, `participantId` and `accountIds`
(internal identifiers, no names, contact details or balances) and now stay up to 366 days, the consent's lifetime plus
one day. A delete-only topic cannot remove one customer's records before they age out, so an erasure is carried out in
consent-auth and in each consumer's projection; a consumer that replays inside those 366 days rebuilds an erased
consent unless the consent contract gains an event telling it to drop one (open finance's decision).
If a consent could outlive the retention, raise the retention or publish a separate state topic owned by
consent-auth (an ADR), rather than compacting event topics.

The partition count of an aggregate topic is fixed once a consumer exists: changing it moves keys between partitions
and breaks per-aggregate order, so it is a topic major (below), not an operational tweak.

The relay sends one row at a time in insertion order under a Postgres advisory lock, so only one replica publishes and
an aggregate's events keep their order. A Kafka outage does not fail business requests: rows wait in the outbox. Alert
on the outbox backlog gauge.

Send failures (ADR-021 decision 4):

| Error | Relay behaviour |
|---|---|
| Payload errors: `RecordTooLargeException`, `SerializationException`, `InvalidTopicException` | Park the row (status and error class recorded), count it in `outbox_parked_events_total`, raise an alert, continue with the next row |
| Anything else (authentication, `TopicAuthorizationException` during an ACL rollout, `UnknownTopicOrPartitionException` (topic missing or catalog not applied), producer construction, timeouts, unclassified) | Stop the batch without marking any row, retry with backoff; never park automatically, so order is kept |

There is no time-based parking ceiling. Only an operator may park a row that failed for a non-payload reason, with
the reason recorded. Metrics (Micrometer names, Prometheus names in brackets; common tags `app` = service account and
`squad` = owning context):

| Metric | Type | Tags | Alert (observability repo) |
|---|---|---|---|
| `outbox.oldest.pending.age.seconds` (`outbox_oldest_pending_age_seconds`) | gauge | app, squad | pages the squad above 900 s for 5 min |
| `outbox.send.failures` (`outbox_send_failures_total`) | counter | app, squad, `exception` (simple class name, no ids) | warning on a sustained failure rate |
| `outbox.parked.events` (`outbox_parked_events_total`) | counter | app, squad, `exception` (simple class name, or `OperatorPark` when an operator parked the row) | `OutboxEventsParked`: warning on any increase |
| `outbox.parked.rows` (`outbox_parked_rows`) | gauge | app (and the common `squad` tag); no exception, row, event or aggregate ids | `OutboxEventsParked` fallback: warning when it rose within 15 min and the service has no counter series in the last hour |

`outbox.parked.rows` is the number of rows currently parked in the service's own outbox table (a `count` of parked
rows, not a running total). It falls when the squad replays or discards a row. Register it at startup, so it exports
`0` before the first park: Micrometer registers the counter lazily, on the first park, so until then the gauge is the
only parked series. `OutboxParkedSignalMissing` (warning after 1 h) fires for a relay that exports
`outbox_oldest_pending_age_seconds` but none of `outbox_parked_events_total`, `outbox_parked_rows` or the legacy
gauge `outbox_parked_events`. Do not register a gauge named `outbox.parked.events`: that legacy gauge (relays built
before the counter) has the counter's name, and the alert reads it only as a fallback.

The alert rules are in `prometheus/rules/kafka-outbox.rules.yml` of `fintechbankx-platform-observability-sre-operations`.
They key on `service_id`, which the PodMonitor copies from the pod label `fintechbankx.io/service-id`. Series without
that label are not evaluated, so set the label on the pod; the service does not add a `service_id` tag itself. The rules
route on the service's own `squad` tag (`management.metrics.tags`), falling back to the Kubernetes namespace.

## 3. Consumer

| Setting | Value | Why |
|---|---|---|
| `group.id` | `cg.<service-id>.<purpose>.v<major>` | Declared in the catalog; ACLs / IAM grant only the service's groups |
| `isolation.level` | `read_committed` | Never read aborted transactional writes (safe default even with idempotent-only producers) |
| `enable.auto.commit` | `false` | Commit the offset only after the side effects are committed |
| Spring `ack-mode` | `RECORD` (or `MANUAL` after the DB commit) | |
| `auto.offset.reset` | `earliest` for a new group | A new consumer must not silently skip retained facts |
| `client.rack` | the node's zone (Strimzi) or AZ id (MSK) | Fetch from a same-zone replica (`RackAwareReplicaSelector` is on) |
| `max.poll.records` / `max.poll.interval.ms` | sized so one poll is processed well within the interval | Avoid rebalance storms |

Event types: a consumer subscribes to the aggregate topic and reads the `eventType` header first. It handles the
types it declares (`eventTypes` of its consumer entry in the catalog) and **skips every other type**: it commits the
offset without processing, never fails and never dead-letters it. A new event type on a topic is therefore additive.
With Spring Kafka, filter before deserialising the value:

```java
factory.setRecordFilterStrategy(record -> {          // true = discard
    Header h = record.headers().lastHeader("eventType");
    return h == null || !HANDLED_EVENT_TYPES.contains(new String(h.value(), StandardCharsets.UTF_8));
});
factory.setAckDiscarded(true);                        // discarded records are committed, not retried
```

A record without an `eventType` header breaks the contract of the producer; skip it the same way and raise it with
the producing squad rather than blocking the partition.

Idempotency: store processed `eventId`s (an inbox table in the consumer's own schema) in the same transaction as the
side effect, and skip duplicates. Events of one aggregate instance arrive in order (same key, same partition); use
`aggregateVersion` to detect gaps and redelivered older versions.

Versioning (ADR-019 section 5): ignore unknown fields (additive changes are minor versions). A breaking change to one
event is a new **event** major on the same topic: the producer publishes `...Disbursed.v1` and `...Disbursed.v2`
(two records, same key, in that order) until every consumer of v1 has moved; a consumer handles one of the two and
skips the other. The **topic** major (`evt.ln.loan.v2`) changes only when the record key, the partition count or the
cleanup policy changes; then the producer dual-publishes to both topics, and consumers read both during the window
and de-duplicate on `eventId`.

### Retries and the dead-letter topic

Dead-letter topics are **consumer-owned** (ADR-019 / ADR-024 in the ADR repository). Each namespace has one DLQ,
`evt.<ctx>.<aggregate>.dlq.v<major>`, and only that namespace's own service writes it: a consumer that gives up on a
record writes it to the DLQ of **its own** namespace, never to the source topic's namespace. Example: the loan service
dead-letters a failed `evt.pay.payment.v1` record (a `Payments.Payment.LoanPaymentCompleted.v1` it handles) to
`evt.ln.loan.dlq.v1`, not to `evt.pay.payment.dlq.v1`. A consumer-only service (no events of its own, such as the open-finance consent projections)
still gets its namespace DLQ. A namespace whose service consumes nothing has no DLQ, since nobody would write it;
an owner that plans a consumer can reserve it early with `dlq: {reserved: true}` in the catalog. The catalog grants write and read on that DLQ to its own service only. Do not block a
partition forever:

1. Retry in-process with exponential backoff, bounded (for example 3 attempts: 1 s, 2 s, 4 s).
2. Send to the DLQ immediately, without retries, for errors that cannot heal in an event type the consumer handles:
   deserialization, contract violation. An event type it does not handle is never an error: skip and commit (above),
   never dead-letter.
3. Copy key and value unchanged and add the headers from `DeadLetterHeaders` in the envelope schema. These four
   identify the source so the owning team can replay it:

   | Header | Value |
   |---|---|
   | `dlq-original-topic` | source topic, e.g. `evt.pay.payment.v1` |
   | `dlq-original-partition` | source partition |
   | `dlq-original-offset` | source offset |
   | `dlq-consumer-group` | the group that gave up, `cg.<service-id>.<purpose>.v<major>` |

   Also set `eventType`, `eventId`, `correlationId`, `dlq-attempts`, `dlq-error-class` and `dlq-failed-at`. Put the
   exception class, never the exception message (it can contain personal data).
4. Redrive after a fix by replaying the DLQ records through the same idempotent handler (the DLQ is yours, so the
   redrive is too).

Spring Kafka sketch:

```java
@Bean
DefaultErrorHandler kafkaErrorHandler(KafkaTemplate<String, String> template) {
    var recoverer = new DeadLetterPublishingRecoverer(template,
        (record, ex) -> new TopicPartition("evt.ln.loan.dlq.v1", -1)); // always the consumer's OWN namespace DLQ
    recoverer.excludeHeader(HeaderNames.HeadersToAdd.EXCEPTION_MESSAGE,
        HeaderNames.HeadersToAdd.EX_STACKTRACE); // no free text in DLQ headers
    recoverer.setHeadersFunction((record, ex) -> DlqHeaders.of(record, ex, "cg.svc-...-purpose.v1"));
    var handler = new DefaultErrorHandler(recoverer, new ExponentialBackOffWithMaxRetries(3));
    handler.addNotRetryableExceptions(DeserializationException.class, ContractViolationException.class);
    return handler;
}
```

## 4. Resilience summary (cell plan, Phase 2)

| Dependency | Mode | Timeout | Retry | Breaker / fallback |
|---|---|---|---|---|
| Producer to Kafka | async via outbox | `delivery.timeout.ms` 30 s per send (`request.timeout.ms` 20 s, relay wait 35 s) | relay every 1 s, at-least-once | Outbox absorbs outages; alert on backlog |
| Consumer from Kafka | async | `max.poll.interval.ms` | bounded backoff, then DLQ | DLQ; lag alert per `cg.*` group (Kafka Exporter / MSK metrics) |

Drill evidence still to collect: broker loss under load, zone loss, consumer poison message, relay outage. Record
outbox backlog, consumer lag, DLQ rate and end-to-end latency.
