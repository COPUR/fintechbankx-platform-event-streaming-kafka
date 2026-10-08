# Proposal: one topic per event type or one topic per aggregate

Status: **Proposed. Needs the owner's decision** (and, if the scheme changes, an ADR in
`fintechbankx-governance-architecture-enablement-adr-runbooks` because it changes the naming standard).
Nothing in this repository has been switched; the catalog keeps the current scheme.

## Today

The naming standard (`NAMING_CONVENTION_DDD_EDA_BUSINESS_CONTEXT.md`) gives one topic per event type:
`evt.<ctx>.<aggregate>.<event>.v<major>`. The catalog therefore has 27 event topics for 6 aggregates
(Loan 7, Payment 9, PayRequest 3, Customer 6, RiskAssessment 1, ComplianceResult 1) plus one DLQ per aggregate.
Every record is keyed by `aggregateId`.

## The ordering implication

Kafka orders records only within one partition of one topic. Keying by `aggregateId` keeps one aggregate's events in
order **only among the events that share a topic**.

- With one topic per event type, `evt.ln.loan.approved.v1` and `evt.ln.loan.disbursed.v1` for the same loan sit in
  different topics. A consumer subscribed to both fetches them independently and can process `Disbursed` before
  `Approved` (after a rebalance, a lagging partition or a retry). The same holds for `credit-reserved` /
  `credit-released` and for the payment lifecycle.
- Each such consumer must detect and repair reordering itself, using `aggregateVersion`: buffer or park the early
  event, or make every handler commutative. That logic is repeated in every consumer and is easy to get wrong.
- With one topic per aggregate, all events of one loan land in one partition in commit order (the outbox relay
  already publishes in insertion order under one lock), so consumers see the lifecycle in order for free.

Order across different aggregates is never guaranteed in either scheme.

## Options

| | A. Per event type (current) | B. Per aggregate | C. Both (aggregate stream + per-event topics) |
|---|---|---|---|
| Per-aggregate order for multi-event consumers | No; consumers reorder with `aggregateVersion` | Yes | Yes on the stream |
| Consumer reads only what it needs | Yes (topic subscription, topic-level ACL/IAM) | Filters on the `eventType` header; reads (and is granted) the whole aggregate stream | Yes |
| Data minimisation by ACL | Per event | Per aggregate | Per event |
| Versioning | A new major of one event is a new topic for that event only | A new major of one event either bumps the whole stream (`...v2`) or mixes `eventType` versions in one topic | Two places to version |
| Topic / partition count | High (27 topics now, grows with every event) | Low (6 topics) | Highest |
| Per-event retention | Possible | One retention per aggregate | Possible |
| Producer change | none | outbox topic mapping (one method per service) | dual write |
| Naming standard | unchanged | change needed, e.g. `evt.<ctx>.<aggregate>.v<major>` | change needed |

## Recommendation

**Option B, one topic per aggregate and major version**, for the aggregates whose events are steps of one lifecycle
(Loan, Payment, PayRequest, Customer credit). The expected consumers (risk exposure, compliance evidence, ledger
reconciliation) need those steps in order, and moving the ordering problem into every consumer costs more than
filtering on the `eventType` header, which every record already carries. Keep per-event topics only where an event has
a distinct audience or retention need and no ordering relation to the others.

Why now: no consumer exists in any fintechbankx repository and no topic has been created on a shared cluster, so the
switch costs a catalog edit, an AsyncAPI channel change per contract and a one-line topic mapping in each outbox
envelope factory. After the first consumer ships it becomes a dual-publish migration.

Costs to accept with B: consumers are granted the whole aggregate stream (acceptable while payloads carry ids and facts
only, as the envelope rule requires), and a breaking change to one event type bumps the stream major version or must be
carried as a new `eventType` version inside the stream.

## If the owner accepts

1. ADR (next free number across the monorepo ADR folders and the adr-runbooks repo) amending the naming standard to
   allow `evt.<ctx>.<aggregate>.v<major>` and stating the rule for choosing per-event topics.
2. AsyncAPI catalog: one channel per aggregate with several messages, discriminated by `eventType`.
3. This repository: catalog schema (namespace-level topic), validator pattern, generators, `create-topics.sh` pattern.
4. Service repositories: change the outbox topic mapping; consumers filter on the `eventType` header.

## If the owner keeps option A

Document in the client guide that multi-event consumers must enforce order with `aggregateVersion` (park and retry
events that arrive early) and add a contract test for it in each consumer.
