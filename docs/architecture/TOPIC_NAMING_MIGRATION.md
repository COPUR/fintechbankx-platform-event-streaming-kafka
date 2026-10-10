# Topic Naming Migration: legacy dotted topics to `evt.*`

Status: **Proposed** (Event Platform Squad review required)

Standard: `NAMING_CONVENTION_DDD_EDA_BUSINESS_CONTEXT.md` (enterprise-architecture repo,
`transformation/workspace-ddd-eda-2026-03-13/`).

| Element | Format |
|---|---|
| Event topic | `evt.<ctx>.<aggregate>.v<major>`, one per aggregate (ADR-019, owner decision 2026-10-08) |
| Dead-letter topic | `<consumer namespace>.dlq.v<major>`, i.e. `evt.<ctx>.<aggregate>.dlq.v<major>` of the consuming service |
| Event type | `<Context>.<Aggregate>.<PastTenseEvent>.v<major>`, in the envelope and the `eventType` record header |
| Consumer group | `cg.<service-id>.<purpose>.v<major>` |

The topic no longer names the event: every event of an aggregate goes to the aggregate topic, keyed by `aggregateId`,
and is told apart by its `eventType`. The per-event form `evt.<ctx>.<aggregate>.<event>.v<major>` that this document
originally mapped to is retired; nothing published to it, so it was replaced in the catalog and in
`create-topics.sh` without a dual-run (ADR-019 section 8). The tables below give the aggregate topic and the event
type.

The standard topics are defined in [`topics/catalog.yaml`](../../topics/catalog.yaml) (the source of truth since
2026-10-08; resolved table in [`topics/generated/TOPIC_CATALOG.md`](../../topics/generated/TOPIC_CATALOG.md)).
`scripts/kafka/create-topics.sh` creates them from the generated list; the legacy dotted topics are created only with
`CREATE_LEGACY_TOPICS=true`. The inventory below is the original 2026-10-07 analysis, restated for aggregate topics;
the catalog has since added `Risk.RiskAssessment.Assessed.v1` on `evt.rsk.risk.v1` and
`Compliance.ComplianceScreening.Screened.v1` on `evt.cmp.compliance.v1` (contract-only), and the bulk, mandate,
consent and payee aggregate topics.

## 1. Event inventory (original source of the catalog)

Only events that exist in service code are listed. No service README declares `published_events` yet.

| Service | Namespace | Domain event class | Aggregate topic | Event type | Published today? |
|---|---|---|---|---|---|
| svc-ln-loan-lifecycle | `evt.ln.loan` | `LoanCreatedEvent` | `evt.ln.loan.v1` | `Lending.Loan.Created.v1` | No: raised on aggregate, no publisher adapter |
| svc-ln-loan-lifecycle | `evt.ln.loan` | `LoanApprovedEvent` | `evt.ln.loan.v1` | `Lending.Loan.Approved.v1` | No |
| svc-ln-loan-lifecycle | `evt.ln.loan` | `LoanRejectedEvent` | `evt.ln.loan.v1` | `Lending.Loan.Rejected.v1` | No |
| svc-ln-loan-lifecycle | `evt.ln.loan` | `LoanDisbursedEvent` | `evt.ln.loan.v1` | `Lending.Loan.Disbursed.v1` | No |
| svc-ln-loan-lifecycle | `evt.ln.loan` | `LoanCancelledEvent` | `evt.ln.loan.v1` | `Lending.Loan.Cancelled.v1` | No |
| svc-ln-loan-lifecycle | `evt.ln.loan` | `LoanPaymentMadeEvent` | `evt.ln.loan.v1` | `Lending.Loan.PaymentMade.v1` | No |
| svc-ln-loan-lifecycle | `evt.ln.loan` | `LoanFullyPaidEvent` | `evt.ln.loan.v1` | `Lending.Loan.FullyPaid.v1` | No |
| svc-pay-initiation-settlement | `evt.pay.payment` | `PaymentCreatedEvent` | `evt.pay.payment.v1` | `Payments.Payment.Created.v1` | No: raised on aggregate, no publisher adapter |
| svc-pay-initiation-settlement | `evt.pay.payment` | `PaymentProcessingEvent` | `evt.pay.payment.v1` | `Payments.Payment.ProcessingStarted.v1` | No |
| svc-pay-initiation-settlement | `evt.pay.payment` | `PaymentCompletedEvent` | `evt.pay.payment.v1` | `Payments.Payment.Completed.v1` | No |
| svc-pay-initiation-settlement | `evt.pay.payment` | `PaymentFailedEvent` | `evt.pay.payment.v1` | `Payments.Payment.Failed.v1` | No |
| svc-pay-initiation-settlement | `evt.pay.payment` | `PaymentCancelledEvent` | `evt.pay.payment.v1` | `Payments.Payment.Cancelled.v1` | No |
| svc-pay-initiation-settlement | `evt.pay.payment` | `PaymentRefundedEvent` | `evt.pay.payment.v1` | `Payments.Payment.Refunded.v1` | No |
| svc-pay-initiation-settlement | `evt.pay.payment` | `LoanPaymentCreatedEvent` | `evt.pay.payment.v1` | `Payments.Payment.LoanPaymentCreated.v1` | No |
| svc-pay-initiation-settlement | `evt.pay.payment` | `LoanPaymentCompletedEvent` | `evt.pay.payment.v1` | `Payments.Payment.LoanPaymentCompleted.v1` | No |
| svc-pay-initiation-settlement | `evt.pay.payment` | `LoanPaymentFailedEvent` | `evt.pay.payment.v1` | `Payments.Payment.LoanPaymentFailed.v1` | No |
| svc-pay-request-to-pay | `evt.pay.rtp` | `PayRequestCreatedEvent` | `evt.pay.rtp.v1` | `Payments.PayRequest.Created.v1` | Yes, to legacy `rtp.pay_requests.v1` without envelope |
| svc-pay-request-to-pay | `evt.pay.rtp` | `PayRequestAcceptedEvent` | `evt.pay.rtp.v1` | `Payments.PayRequest.Accepted.v1` | Yes, to legacy `rtp.pay_requests.v1` without envelope |
| svc-pay-request-to-pay | `evt.pay.rtp` | `PayRequestRejectedEvent` | `evt.pay.rtp.v1` | `Payments.PayRequest.Rejected.v1` | Yes, to legacy `rtp.pay_requests.v1` without envelope |
| svc-cus-profile-kyc | `evt.cus.customer` | `CustomerCreatedEvent` | `evt.cus.customer.v1` | `Customer.Customer.Created.v1` | Via `DomainEventPublisher` after save (implementation not in repo) |
| svc-cus-profile-kyc | `evt.cus.customer` | `CustomerContactUpdatedEvent` | `evt.cus.customer.v1` | `Customer.Customer.ContactUpdated.v1` | Same |
| svc-cus-profile-kyc | `evt.cus.customer` | `CustomerCreditLimitUpdatedEvent` | `evt.cus.customer.v1` | `Customer.Customer.CreditLimitUpdated.v1` | Same |
| svc-cus-profile-kyc | `evt.cus.customer` | `CustomerCreditReservedEvent` | `evt.cus.customer.v1` | `Customer.Customer.CreditReserved.v1` | Same |
| svc-cus-profile-kyc | `evt.cus.customer` | `CustomerCreditReleasedEvent` | `evt.cus.customer.v1` | `Customer.Customer.CreditReleased.v1` | Same |
| svc-cus-profile-kyc | `evt.cus.customer` | `CustomerCreditScoreUpdatedEvent` | `evt.cus.customer.v1` | `Customer.Customer.CreditScoreUpdated.v1` | Same |

Dead-letter topics: consumer-owned (ADR-019), so a namespace gets its DLQ only when its own service consumes (or the
owner reserves it). Today: `evt.ln.loan.dlq.v1` (loan repayment allocation) and the three open-finance consent
projection DLQs; see the generated catalog.

Not in the list on purpose: the consent and participant event classes copied into the bulk, recurring-mandates and
request-to-pay repositories (`com.enterprise.openfinance.domain.event.*`) are excluded from compilation by each
module's `sourceSets` include filter, and they belong to the `evt.of.consent` namespace, not to those services.

Contracts: `asyncapi/<service-id>.yaml` in `fintechbankx-governance-api-contracts-asyncapi-catalog`.

## 2. Legacy to standard mapping

"None" means no service publishes an equivalent event today; the legacy topic has no standard replacement yet.

| Legacy topic | Aggregate topic (event type) | Notes |
|---|---|---|
| `customer.created` | `evt.cus.customer.v1` (`Customer.Customer.Created.v1`) | |
| `customer.updated` | `evt.cus.customer.v1` (`Customer.Customer.ContactUpdated.v1`) | Legacy topic was generic; new topic covers contact changes only |
| `customer.credit.updated` | `evt.cus.customer.v1` (`Customer.Customer.CreditLimitUpdated.v1`, `Customer.Customer.CreditScoreUpdated.v1`) | Split by event type |
| `customer.events` (compacted stream) | `evt.cus.customer.v1` (every customer event type) | Aggregate stream; the new topic is `cleanup.policy=delete`, not compacted |
| `customer.activated`, `customer.suspended`, `customer.closed`, `customer.kyc.completed` | None | No event class in `svc-cus-profile-kyc` |
| `loan.application.submitted` | `evt.ln.loan.v1` (`Lending.Loan.Created.v1`) | |
| `loan.application.approved` | `evt.ln.loan.v1` (`Lending.Loan.Approved.v1`) | |
| `loan.application.rejected` | `evt.ln.loan.v1` (`Lending.Loan.Rejected.v1`) | |
| `loan.disbursed` | `evt.ln.loan.v1` (`Lending.Loan.Disbursed.v1`) | |
| `loan.payment.made` | `evt.ln.loan.v1` (`Lending.Loan.PaymentMade.v1`) | |
| `loan.paid.off` | `evt.ln.loan.v1` (`Lending.Loan.FullyPaid.v1`) | |
| `loan.events` (compacted stream) | `evt.ln.loan.v1` (every loan event type) | Aggregate stream; the new topic is `cleanup.policy=delete`, not compacted |
| `loan.payment.overdue`, `loan.defaulted`, `loan.restructured` | None | No event class in `svc-ln-loan-lifecycle` |
| (none) | `evt.ln.loan.v1` (`Lending.Loan.Cancelled.v1`) | New event type |
| `payment.initiated` | `evt.pay.payment.v1` (`Payments.Payment.Created.v1`) | |
| `payment.processed` | `evt.pay.payment.v1` (`Payments.Payment.ProcessingStarted.v1`) | Legacy semantics unclear; confirm with consumers |
| `payment.completed` | `evt.pay.payment.v1` (`Payments.Payment.Completed.v1`) | |
| `payment.failed` | `evt.pay.payment.v1` (`Payments.Payment.Failed.v1`) | |
| `payment.cancelled` | `evt.pay.payment.v1` (`Payments.Payment.Cancelled.v1`) | |
| `payment.refunded` | `evt.pay.payment.v1` (`Payments.Payment.Refunded.v1`) | |
| `payment.events` | `evt.pay.payment.v1` (every payment event type) | Aggregate stream |
| `payment.reversed` | None | No event class |
| (none) | `evt.pay.payment.v1` (`Payments.Payment.LoanPaymentCreated.v1`, `...LoanPaymentCompleted.v1`, `...LoanPaymentFailed.v1`) | New event types |
| `rtp.pay_requests.v1` | `evt.pay.rtp.v1` (`Payments.PayRequest.Created.v1`, `...Accepted.v1`, `...Rejected.v1`) | Produced today by `KafkaPayRequestNotificationAdapter`; stays one topic, the payload moves into the envelope `data` and the event is named by the `eventType` header |
| `deadletter.customer`, `deadletter.loan`, `deadletter.payment` | None 1:1 | DLQs are consumer-owned (ADR-019): each consuming service dead-letters into `<its namespace>.dlq.v<major>`, e.g. `evt.ln.loan.dlq.v1` |
| `deadletter.events`, `deadletter.compliance`, `deadletter.ml` | None | Created when an owning namespace consumes |
| `compliance.*`, `audit.*`, `ml.*`, `analytics.*`, `federation.*`, `cross.region.*`, `security.*`, `zerotrust.*`, `openbanking.*`, `notifications.*`, `monitoring.*`, `transactions.high.volume`, `payments.real.time`, `fraud.detection.real.time` | None | No owning service publishes these in the fintechbankx repos; each needs an owner and a namespace before it moves |

Legacy topic settings preserved under the flag: `customer.events` and `loan.events` stay compacted (state streams),
`audit.events` and `compliance.events` keep 1-year retention, the high-throughput topics keep 6 partitions. Changed:
all other legacy topics now use `cleanup.policy=delete` (was `compact,delete`), and the previous
`min.insync.replicas=1` override on `payments.real.time` and `fraud.detection.real.time` is not reapplied, so they
use `MIN_INSYNC_REPLICAS` like every other topic. `--if-not-exists` leaves existing topics untouched.

Observed in the source monorepo: its runtime code publishes to differently named topics
(`banking.customer.events`, `customer-events`, `loan-events`, `payment-events` and others in
`shared-infrastructure`), not to the dotted names this script used to create. Confirm actual producers and
consumers with broker metrics before treating any legacy topic as unused.

## 3. Dual-publish requirement before removal

A legacy topic may be removed only after all of the following are true and recorded in the PR that removes it:

1. The owning service publishes to the standard topic through its transactional outbox, with the standard envelope.
2. The owning service dual-publishes the same event to the legacy topic (same `eventId`) for at least one full
   retention period of the legacy topic.
3. Every consumer listed in the provider README `consumed_events` (and every consumer group seen on the legacy
   topic in broker metrics) has moved to the standard topic with an idempotent consumer keyed on `eventId`.
4. Consumer lag on the legacy topic is zero and no producer has written to it for one retention period.
5. Reconciliation evidence: per-event counts on legacy versus standard topic match for the dual-publish window.

Then: stop dual-publish, remove the entry from `LEGACY_TOPICS` in `scripts/kafka/create-topics.sh`, and delete
the topic in a separately approved change. Topic deletion is irreversible.
