#!/usr/bin/env bash
#
# FinTechBankX event platform (svc-evt-streaming) - Kafka topic provisioning.
#
# Creates the standard topics from NAMING_CONVENTION_DDD_EDA_BUSINESS_CONTEXT.md:
#   event topic : evt.<ctx>.<aggregate>.v<major>        (one per aggregate; all of
#                 its events, keyed by aggregateId, eventType in the header)
#   dead letter : evt.<ctx>.<aggregate>.dlq.v<major>   (one per aggregate namespace)
#
# The topic list mirrors the event inventory in
# docs/architecture/TOPIC_NAMING_MIGRATION.md. Add a topic here only when the
# owning service publishes it (domain event class or README published_events)
# and its AsyncAPI contract exists in the asyncapi catalog.
#
# Legacy dotted topics (customer.created, loan.disbursed, ...) are created only
# with CREATE_LEGACY_TOPICS=true. Do not remove them before the dual-publish
# plan in docs/architecture/TOPIC_NAMING_MIGRATION.md is complete.
#
# Environment (all optional):
#   KAFKA_BROKER            bootstrap servers                     (default kafka:9092)
#   KAFKA_COMMAND_CONFIG    client properties file for TLS/SASL   (default: none)
#   PARTITIONS              partitions per event topic            (default 3)
#   DLQ_PARTITIONS          partitions per DLQ topic              (default PARTITIONS)
#   REPLICATION_FACTOR      replication factor                    (default 3; use 1 locally)
#   MIN_INSYNC_REPLICAS     min.insync.replicas                   (default 2; use 1 locally)
#   RETENTION_MS            event topic retention                 (default 604800000, 7 days)
#   DLQ_RETENTION_MS        DLQ retention                         (default 1209600000, 14 days)
#   MAX_MESSAGE_BYTES       max.message.bytes                     (default 1048576)
#   CREATE_LEGACY_TOPICS    also create legacy dotted topics      (default false)
#   KAFKA_TOPICS_BIN        kafka-topics CLI name or path         (default kafka-topics)
#   KAFKA_API_VERSIONS_BIN  broker readiness CLI                  (default kafka-broker-api-versions)
#   WAIT_TIMEOUT_SECONDS    max wait for the broker               (default 300)
#   DRY_RUN                 print commands, do not call Kafka     (default false)
#
# Local single-broker example:
#   REPLICATION_FACTOR=1 MIN_INSYNC_REPLICAS=1 KAFKA_BROKER=localhost:9092 \
#     scripts/kafka/create-topics.sh
#
# Note: --if-not-exists leaves existing topics untouched. Changing partitions,
# replication or configs of an existing topic is a separate, reviewed change.

set -euo pipefail

KAFKA_BROKER="${KAFKA_BROKER:-kafka:9092}"
KAFKA_COMMAND_CONFIG="${KAFKA_COMMAND_CONFIG:-}"
PARTITIONS="${PARTITIONS:-3}"
DLQ_PARTITIONS="${DLQ_PARTITIONS:-${PARTITIONS}}"
REPLICATION_FACTOR="${REPLICATION_FACTOR:-3}"
MIN_INSYNC_REPLICAS="${MIN_INSYNC_REPLICAS:-2}"
RETENTION_MS="${RETENTION_MS:-604800000}"
DLQ_RETENTION_MS="${DLQ_RETENTION_MS:-1209600000}"
MAX_MESSAGE_BYTES="${MAX_MESSAGE_BYTES:-1048576}"
CREATE_LEGACY_TOPICS="${CREATE_LEGACY_TOPICS:-false}"
KAFKA_TOPICS_BIN="${KAFKA_TOPICS_BIN:-kafka-topics}"
KAFKA_API_VERSIONS_BIN="${KAFKA_API_VERSIONS_BIN:-kafka-broker-api-versions}"
WAIT_TIMEOUT_SECONDS="${WAIT_TIMEOUT_SECONDS:-300}"
DRY_RUN="${DRY_RUN:-false}"

# Retention for legacy audit/compliance aggregate streams (1 year), as before.
readonly LEGACY_LONG_RETENTION_MS=31536000000

# ---------------------------------------------------------------------------
# Standard event topics, grouped by publishing service and event namespace.
# Source of each entry: see docs/architecture/TOPIC_NAMING_MIGRATION.md.
# ---------------------------------------------------------------------------
readonly STANDARD_EVENT_TOPICS=(
  # svc-ln-loan-lifecycle, aggregate Loan. Event types Lending.Loan.<Event>.v1:
  # Created, Approved, Rejected, Disbursed, Cancelled, PaymentMade, FullyPaid
  evt.ln.loan.v1

  # svc-pay-initiation-settlement, aggregate Payment. Event types Payments.Payment.<Event>.v1:
  # Created, ProcessingStarted, Completed, Failed, Cancelled, Refunded,
  # LoanPaymentCreated, LoanPaymentCompleted, LoanPaymentFailed
  evt.pay.payment.v1

  # svc-pay-request-to-pay, aggregate PayRequest. Event types Payments.PayRequest.<Event>.v1:
  # Created, Accepted, Rejected
  evt.pay.rtp.v1

  # svc-cus-profile-kyc, aggregate Customer. Event types Customer.Customer.<Event>.v1:
  # Created, ContactUpdated, CreditLimitUpdated, CreditReserved, CreditReleased,
  # CreditScoreUpdated
  evt.cus.customer.v1
)

readonly TOPIC_PATTERN='^evt\.[a-z]+\.[a-z0-9]+(-[a-z0-9]+)*\.v[0-9]+$'

log() { printf '%s %s\n' "[create-topics]" "$*"; }
die() { printf '%s ERROR: %s\n' "[create-topics]" "$*" >&2; exit 1; }

is_uint() { [[ "$1" =~ ^[0-9]+$ ]]; }
is_bool() { [[ "$1" == "true" || "$1" == "false" ]]; }

validate_settings() {
  local name
  for name in PARTITIONS DLQ_PARTITIONS REPLICATION_FACTOR MIN_INSYNC_REPLICAS \
              RETENTION_MS DLQ_RETENTION_MS MAX_MESSAGE_BYTES WAIT_TIMEOUT_SECONDS; do
    is_uint "${!name}" || die "${name} must be a non-negative integer (got '${!name}')"
  done
  for name in PARTITIONS DLQ_PARTITIONS REPLICATION_FACTOR MIN_INSYNC_REPLICAS; do
    (( ${!name} >= 1 )) || die "${name} must be >= 1"
  done
  for name in CREATE_LEGACY_TOPICS DRY_RUN; do
    is_bool "${!name}" || die "${name} must be 'true' or 'false' (got '${!name}')"
  done
  (( MIN_INSYNC_REPLICAS <= REPLICATION_FACTOR )) \
    || die "MIN_INSYNC_REPLICAS (${MIN_INSYNC_REPLICAS}) cannot exceed REPLICATION_FACTOR (${REPLICATION_FACTOR})"
  if (( REPLICATION_FACTOR < 3 )); then
    log "WARNING: REPLICATION_FACTOR=${REPLICATION_FACTOR} is for local use only; prod-like clusters use 3 with MIN_INSYNC_REPLICAS=2."
  fi
  if [[ -n "${KAFKA_COMMAND_CONFIG}" && "${DRY_RUN}" == "false" && ! -r "${KAFKA_COMMAND_CONFIG}" ]]; then
    die "KAFKA_COMMAND_CONFIG is set but not readable: ${KAFKA_COMMAND_CONFIG}"
  fi
}

validate_topic_names() {
  local topic
  for topic in "${STANDARD_EVENT_TOPICS[@]}"; do
    [[ "${topic}" =~ ${TOPIC_PATTERN} ]] || die "topic '${topic}' does not match evt.<ctx>.<aggregate>.v<major>"
    [[ "${topic}" != *.dlq.v* ]] || die "topic '${topic}': DLQs are derived, do not list them"
  done
}

# Common client arguments for the Kafka CLIs.
CLIENT_ARGS=(--bootstrap-server "${KAFKA_BROKER}")
if [[ -n "${KAFKA_COMMAND_CONFIG}" ]]; then
  CLIENT_ARGS+=(--command-config "${KAFKA_COMMAND_CONFIG}")
fi

run() {
  if [[ "${DRY_RUN}" == "true" ]]; then
    printf '+ %s\n' "$*"
  else
    "$@"
  fi
}

wait_for_kafka() {
  if [[ "${DRY_RUN}" == "true" ]]; then
    log "DRY_RUN=true: skipping broker readiness check"
    return 0
  fi
  local waited=0
  log "Waiting for Kafka at ${KAFKA_BROKER} (timeout ${WAIT_TIMEOUT_SECONDS}s)"
  until "${KAFKA_API_VERSIONS_BIN}" "${CLIENT_ARGS[@]}" >/dev/null 2>&1; do
    if (( waited >= WAIT_TIMEOUT_SECONDS )); then
      die "Kafka not reachable at ${KAFKA_BROKER} after ${WAIT_TIMEOUT_SECONDS}s"
    fi
    sleep 5
    waited=$(( waited + 5 ))
  done
  log "Kafka is ready"
}

CREATED_COUNT=0

# create_topic <name> <partitions> <cleanup.policy> <retention.ms> [extra key=value ...]
create_topic() {
  local name="$1" partitions="$2" cleanup="$3" retention="$4"
  shift 4
  local args=(
    "${KAFKA_TOPICS_BIN}" --create "${CLIENT_ARGS[@]}"
    --topic "${name}"
    --partitions "${partitions}"
    --replication-factor "${REPLICATION_FACTOR}"
    --if-not-exists
    --config "cleanup.policy=${cleanup}"
    --config "retention.ms=${retention}"
    --config "min.insync.replicas=${MIN_INSYNC_REPLICAS}"
    --config "max.message.bytes=${MAX_MESSAGE_BYTES}"
  )
  local extra
  for extra in "$@"; do
    args+=(--config "${extra}")
  done
  log "topic ${name} (partitions=${partitions}, rf=${REPLICATION_FACTOR}, cleanup.policy=${cleanup})"
  run "${args[@]}" || die "failed to create topic ${name}"
  CREATED_COUNT=$(( CREATED_COUNT + 1 ))
}

# Domain event topics are immutable facts: delete policy, never compaction.
create_standard_topics() {
  local topic
  log "Creating ${#STANDARD_EVENT_TOPICS[@]} standard event topics"
  for topic in "${STANDARD_EVENT_TOPICS[@]}"; do
    create_topic "${topic}" "${PARTITIONS}" delete "${RETENTION_MS}"
  done
}

# One DLQ per aggregate namespace evt.<ctx>.<aggregate>, derived from the list
# above so a new namespace cannot ship without its DLQ.
create_dlq_topics() {
  local topic ns
  local -A seen=()
  local namespaces=()
  for topic in "${STANDARD_EVENT_TOPICS[@]}"; do
    ns="$(cut -d. -f1-3 <<<"${topic}")"
    if [[ -z "${seen[${ns}]:-}" ]]; then
      seen[${ns}]=1
      namespaces+=("${ns}")
    fi
  done
  log "Creating ${#namespaces[@]} dead-letter topics"
  for ns in "${namespaces[@]}"; do
    create_topic "${ns}.dlq.v1" "${DLQ_PARTITIONS}" delete "${DLQ_RETENTION_MS}"
  done
}

# ---------------------------------------------------------------------------
# Legacy dotted topics (pre-standard). Opt-in only. Kept for the monolith and
# for consumers that have not moved yet; mapping and removal criteria are in
# docs/architecture/TOPIC_NAMING_MIGRATION.md.
# Format: name[:partitions[:cleanup.policy[:retention.ms]]]
# ---------------------------------------------------------------------------
readonly LEGACY_TOPICS=(
  # Customer
  "customer.events:3:compact" "customer.created" "customer.updated" "customer.activated"
  "customer.suspended" "customer.closed" "customer.kyc.completed" "customer.credit.updated"
  # Loan
  "loan.events:3:compact" "loan.application.submitted" "loan.application.approved"
  "loan.application.rejected" "loan.disbursed" "loan.payment.made" "loan.payment.overdue"
  "loan.paid.off" "loan.defaulted" "loan.restructured"
  # Payment
  "payment.events" "payment.initiated" "payment.processed" "payment.completed"
  "payment.failed" "payment.cancelled" "payment.refunded" "payment.reversed"
  # Request to pay (produced today by svc-pay-request-to-pay)
  "rtp.pay_requests.v1"
  # Compliance and audit
  "compliance.events:3:delete:${LEGACY_LONG_RETENTION_MS}" "compliance.kyc.check"
  "compliance.aml.check" "compliance.sanctions.check" "compliance.pep.check"
  "compliance.regulatory.report"
  "audit.events:6:delete:${LEGACY_LONG_RETENTION_MS}" "audit.user.actions"
  "audit.data.changes" "audit.security.events" "audit.access.logs" "audit.system.events"
  # ML and analytics
  "ml.events" "ml.fraud.detection" "ml.credit.scoring" "ml.risk.assessment"
  "ml.anomaly.detection" "ml.model.training" "ml.model.deployment" "ml.predictions"
  "analytics.events" "analytics.transaction.volume" "analytics.performance.metrics"
  "analytics.business.metrics" "analytics.customer.behavior"
  # Federation and cross-region
  "federation.events" "federation.metrics" "federation.alerts"
  "federation.disaster.recovery" "federation.regional.sync"
  "cross.region.us.east.1" "cross.region.eu.west.1" "cross.region.ap.southeast.1"
  # Security
  "security.events" "security.oauth.events" "security.dpop.events" "security.fapi.events"
  "security.authentication" "security.authorization" "security.token.events"
  "security.session.events"
  "zerotrust.events" "zerotrust.continuous.verification" "zerotrust.policy.enforcement"
  "zerotrust.threat.detection"
  # Open banking
  "openbanking.events" "openbanking.account.access" "openbanking.payment.initiation"
  "openbanking.consent.management" "openbanking.api.calls"
  # Notifications
  "notifications.events" "notifications.email" "notifications.sms" "notifications.push"
  "notifications.system.alerts"
  # Dead letter
  "deadletter.events" "deadletter.customer" "deadletter.loan" "deadletter.payment"
  "deadletter.compliance" "deadletter.ml"
  # Monitoring
  "monitoring.events" "monitoring.health.checks" "monitoring.performance"
  "monitoring.errors" "monitoring.alerts"
  # High throughput
  "transactions.high.volume:6" "payments.real.time:6" "fraud.detection.real.time:6"
)

create_legacy_topics() {
  if [[ "${CREATE_LEGACY_TOPICS}" != "true" ]]; then
    log "Skipping ${#LEGACY_TOPICS[@]} legacy dotted topics (set CREATE_LEGACY_TOPICS=true to create them)"
    return 0
  fi
  log "CREATE_LEGACY_TOPICS=true: creating ${#LEGACY_TOPICS[@]} legacy topics (deprecated, see docs/architecture/TOPIC_NAMING_MIGRATION.md)"
  local entry name partitions cleanup retention
  for entry in "${LEGACY_TOPICS[@]}"; do
    IFS=':' read -r name partitions cleanup retention <<<"${entry}"
    create_topic "${name}" "${partitions:-${PARTITIONS}}" "${cleanup:-delete}" "${retention:-${RETENTION_MS}}"
  done
}

main() {
  validate_settings
  validate_topic_names
  log "broker=${KAFKA_BROKER} partitions=${PARTITIONS} dlq_partitions=${DLQ_PARTITIONS} rf=${REPLICATION_FACTOR} min_isr=${MIN_INSYNC_REPLICAS} legacy=${CREATE_LEGACY_TOPICS} dry_run=${DRY_RUN}"
  wait_for_kafka
  create_standard_topics
  create_dlq_topics
  create_legacy_topics
  log "Done: ${CREATED_COUNT} topic create requests issued (existing topics are left unchanged)"
}

main "$@"
