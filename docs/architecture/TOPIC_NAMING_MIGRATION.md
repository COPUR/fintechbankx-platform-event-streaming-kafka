# Topic Naming Migration: legacy dotted topics to `evt.*`

Status: **Proposed** (Event Platform Squad review required)

Standard: `NAMING_CONVENTION_DDD_EDA_BUSINESS_CONTEXT.md` (enterprise-architecture repo,
`transformation/workspace-ddd-eda-2026-03-13/`).

| Element | Format |
|---|---|
| Event topic | `evt.<ctx>.<aggregate>.v<major>` (one per aggregate, all its events, keyed by `aggregateId`) |
| Dead-letter topic | `evt.<ctx>.<aggregate>.dlq.v<major>` (one per aggregate namespace) |
| Event type | `<Context>.<Aggregate>.<PastTenseEvent>.v<major>` |
| Consumer group | `cg.<service-id>.<purpose>.v<major>` |

Consumers tell events apart by `eventType` (envelope field and record header), not by topic. One topic per aggregate
keeps every event of one aggregate in one partition, so consumers see a loan's or payment's lifecycle in order. The
owner chose this layout over one topic per event on 2026-10-08 (ADR-019).

`scripts/kafka/create-topics.sh` creates the standard topics below by default. The legacy dotted topics are created
only with `CREATE_LEGACY_TOPICS=true`.

## 1. Event inventory (source of the standard topic list)

Only events that exist in service code are listed. No service README declares `published_events` yet.

| Service | Namespace | Domain event class | Standard topic | Event type | Published today? |
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

Dead-letter topics created: `evt.ln.loan.dlq.v1`, `evt.pay.payment.dlq.v1`, `evt.pay.rtp.dlq.v1`, `evt.cus.customer.dlq.v1`.

Not in the list on purpose: the consent and participant event classes copied into the bulk, recurring-mandates and
request-to-pay repositories (`com.enterprise.openfinance.domain.event.*`) are excluded from compilation by each
module's `sourceSets` include filter, and they belong to the `evt.of.consent` namespace, not to those services.

Contracts: `asyncapi/<service-id>.yaml` in `fintechbankx-governance-api-contracts-asyncapi-catalog`.

## 2. Legacy to standard mapping

"None" means no service publishes an equivalent event today; the legacy topic has no standard replacement yet.

| Legacy topic | Standard topic (event type) | Notes |
|---|---|---|
| `customer.created` | `evt.cus.customer.v1` (`Created`) | |
| `customer.updated` | `evt.cus.customer.v1` (`ContactUpdated`) | Legacy topic was generic; the new event covers contact changes only |
| `customer.credit.updated` | `evt.cus.customer.v1` (`CreditLimitUpdated`, `CreditScoreUpdated`) | Split by fact |
| `customer.events` (compacted stream) | `evt.cus.customer.v1` (all) | Was a compacted state stream; the new topic is a delete-policy event stream |
| `customer.activated`, `customer.suspended`, `customer.closed`, `customer.kyc.completed` | None | No event class in `svc-cus-profile-kyc` |
| `loan.application.submitted` | `evt.ln.loan.v1` (`Created`) | |
| `loan.application.approved` | `evt.ln.loan.v1` (`Approved`) | |
| `loan.application.rejected` | `evt.ln.loan.v1` (`Rejected`) | |
| `loan.disbursed` | `evt.ln.loan.v1` (`Disbursed`) | |
| `loan.payment.made` | `evt.ln.loan.v1` (`PaymentMade`) | |
| `loan.paid.off` | `evt.ln.loan.v1` (`FullyPaid`) | |
| `loan.events` (compacted stream) | `evt.ln.loan.v1` (all) | Was a compacted state stream; the new topic is a delete-policy event stream |
| `loan.payment.overdue`, `loan.defaulted`, `loan.restructured` | None | No event class in `svc-ln-loan-lifecycle` |
| (none) | `evt.ln.loan.v1` (`Cancelled`) | New |
| `payment.initiated` | `evt.pay.payment.v1` (`Created`) | |
| `payment.processed` | `evt.pay.payment.v1` (`ProcessingStarted`) | Legacy semantics unclear; confirm with consumers |
| `payment.completed` | `evt.pay.payment.v1` (`Completed`) | |
| `payment.failed` | `evt.pay.payment.v1` (`Failed`) | |
| `payment.cancelled` | `evt.pay.payment.v1` (`Cancelled`) | |
| `payment.refunded` | `evt.pay.payment.v1` (`Refunded`) | |
| `payment.events` | `evt.pay.payment.v1` (all) | |
| `payment.reversed` | None | No event class |
| (none) | `evt.pay.payment.v1` (`LoanPaymentCreated`, `LoanPaymentCompleted`, `LoanPaymentFailed`) | New |
| `rtp.pay_requests.v1` | `evt.pay.rtp.v1` (`Created`, `Accepted`, `Rejected`) | Produced today by `KafkaPayRequestNotificationAdapter`; same one-topic shape, payload moves into the envelope `data` |
| `deadletter.customer` | `evt.cus.customer.dlq.v1` | |
| `deadletter.loan` | `evt.ln.loan.dlq.v1` | |
| `deadletter.payment` | `evt.pay.payment.dlq.v1` | |
| (none) | `evt.pay.rtp.dlq.v1` | New |
| `deadletter.events`, `deadletter.compliance`, `deadletter.ml` | None | Created when the owning namespace publishes |
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
