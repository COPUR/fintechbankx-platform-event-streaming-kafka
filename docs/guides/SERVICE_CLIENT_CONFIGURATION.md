# Kafka client configuration for FinTechBankX services

Status: **Proposed** (Event Platform Squad). Applies to every service that produces or consumes `evt.*` topics.
The topics, owners and allowed consumers are in [`topics/catalog.yaml`](../../topics/catalog.yaml).

## 1. Connection per runtime

| Runtime | Bootstrap | `security.protocol` | Authentication | Identity |
|---|---|---|---|---|
| AWS (Amazon MSK) | `bootstrap_brokers_sasl_iam` output of `msk-cluster` (port 9098) | `SASL_SSL` | `AWS_MSK_IAM` | The pod's IRSA role (`system:serviceaccount:<ns>:<sa>`) with the policy from `msk-client-access` |
| In-cluster (Strimzi) | `fintechbankx-kafka-bootstrap.kafka.svc.cluster.local:9093` | `SSL` | TLS client certificate | `KafkaUser` named after the service id, ACLs from the catalog |
| Laptop ([`deploy/local`](../../deploy/local/docker-compose.yml)) | `localhost:29092` | `PLAINTEXT` | none | none (local only) |

Keep `application.yml` runtime-neutral (as the service repositories already do with `KAFKA_BOOTSTRAP_SERVERS` and
`KAFKA_SECURITY_PROTOCOL`) and add the authentication in a Spring profile selected per environment
(`SPRING_PROFILES_ACTIVE=kafka-msk` or `kafka-strimzi`).

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
| Record key | `aggregateId` | All events of one aggregate land in one partition of a topic |
| Record value | the envelope JSON | [`asyncapi/common/event-envelope.yaml`](https://github.com/COPUR/fintechbankx-governance-api-contracts-asyncapi-catalog/blob/main/asyncapi/common/event-envelope.yaml) |

Envelope fields: `eventId` (UUID, idempotency key), `eventType` (`<Context>.<Aggregate>.<Event>.v<major>`),
`occurredAt` (UTC), `aggregateId`, `aggregateVersion`, `correlationId`, `causationId`, `producer` (service id), `data`
(ids and facts only, no personal data snapshots).

Headers on every record: `eventType`, `eventId`, `correlationId` (required); `x-fapi-interaction-id` when the flow
started at a FAPI API; `traceparent` (W3C) so traces cross the broker.

The relay sends one row at a time in insertion order under a Postgres advisory lock, so only one replica publishes and
an aggregate's events keep their order. A Kafka outage does not fail business requests: rows wait in the outbox. Alert
on the outbox backlog gauge.

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

Idempotency: store processed `eventId`s (an inbox table in the consumer's own schema) in the same transaction as the
side effect, and skip duplicates. Use `aggregateVersion` to detect gaps or reordering; with one topic per event type,
two events of the same aggregate on different topics can arrive in either order (see
[the granularity proposal](../architecture/TOPIC_GRANULARITY_PROPOSAL.md)).

Ignore unknown fields (additive changes are minor versions). A new major version is a new topic; consume both during
the producer's dual-publish window and de-duplicate on `eventId`.

### Retries and the dead-letter topic

Dead-letter topics are **consumer-owned** (ADR-019 / ADR-024 in the ADR repository). Each namespace has one DLQ,
`evt.<ctx>.<aggregate>.dlq.v<major>`, and only that namespace's own service writes it: a consumer that gives up on a
record writes it to the DLQ of **its own** namespace, never to the source topic's namespace. Example: the loan service
dead-letters a failed `evt.pay.payment.loan-payment-completed.v1` record to `evt.ln.loan.dlq.v1`, not to
`evt.pay.payment.dlq.v1`. A consumer-only service (no events of its own, such as the open-finance consent projections)
still gets its namespace DLQ. The catalog grants write and read on that DLQ to its own service only. Do not block a
partition forever:

1. Retry in-process with exponential backoff, bounded (for example 3 attempts: 1 s, 2 s, 4 s).
2. Send to the DLQ immediately, without retries, for errors that cannot heal: deserialization, contract violation,
   unknown `eventType` version.
3. Copy key and value unchanged and add the headers from `DeadLetterHeaders` in the envelope schema. These four
   identify the source so the owning team can replay it:

   | Header | Value |
   |---|---|
   | `dlq-original-topic` | source topic, e.g. `evt.pay.payment.loan-payment-completed.v1` |
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
