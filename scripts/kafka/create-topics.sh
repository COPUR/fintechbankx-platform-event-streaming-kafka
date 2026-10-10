#!/usr/bin/env bash
#
# FinTechBankX event platform (svc-evt-streaming) - Kafka topic provisioning
# for clusters without the Strimzi Topic Operator (Amazon MSK, local Kafka).
#
# The topic list is NOT maintained here. It is read from
# topics/generated/topics.tsv, which scripts/catalog/generate.mjs renders from
# topics/catalog.yaml (the single source of truth, see topics/README.md):
#   event topic : evt.<ctx>.<aggregate>.v<major>   (one per aggregate, ADR-019; the
#                 event is named by the eventType record header, not by the topic)
#   dead letter : <consumer namespace>.dlq.v<major>, i.e. evt.<ctx>.<aggregate>.dlq.v<major>
# The per-event form evt.<ctx>.<aggregate>.<event>.v<major> is retired and rejected
# (nothing published to it, so there is no dual-run; ADR-019 section 8).
# To add a topic, change topics/catalog.yaml and run `npm run catalog:generate`.
#
# Legacy dotted topics (customer.created, loan.disbursed, ...) are created only
# with CREATE_LEGACY_TOPICS=true. Do not remove them before the dual-publish
# plan in docs/architecture/TOPIC_NAMING_MIGRATION.md is complete.
#
# Environment (all optional). Per-topic values come from the catalog; the
# overrides below, when set, apply to every catalog topic (local clusters).
#   TOPICS_FILE             catalog topic list                    (default <repo>/topics/generated/topics.tsv)
#   KAFKA_BROKER            bootstrap servers                     (default kafka:9092)
#   KAFKA_COMMAND_CONFIG    client properties file for TLS/SASL   (default: none)
#   PARTITIONS              override partitions of event topics   (default: catalog)
#   DLQ_PARTITIONS          override partitions of DLQ topics     (default: catalog)
#   REPLICATION_FACTOR      override replication factor           (default: catalog, 3; use 1 locally)
#   MIN_INSYNC_REPLICAS     override min.insync.replicas          (default: catalog, 2; use 1 locally)
#   RETENTION_MS            override event topic retention        (default: catalog)
#   DLQ_RETENTION_MS        override DLQ retention                (default: catalog)
#   MAX_MESSAGE_BYTES       override max.message.bytes            (default: catalog)
#   CREATE_LEGACY_TOPICS    also create legacy dotted topics      (default false)
#   KAFKA_TOPICS_BIN        kafka-topics CLI name or path         (default kafka-topics)
#   KAFKA_API_VERSIONS_BIN  broker readiness CLI                  (default kafka-broker-api-versions)
#   WAIT_TIMEOUT_SECONDS    max wait for the broker               (default 300)
#   DRY_RUN                 print commands, do not call Kafka     (default false)
#
# Amazon MSK (IAM auth) example; the properties file is in docs/guides/SERVICE_CLIENT_CONFIGURATION.md:
#   KAFKA_BROKER=<msk-bootstrap-brokers-sasl-iam> KAFKA_COMMAND_CONFIG=msk-iam.properties \
#     scripts/kafka/create-topics.sh
#
# Local single-broker example:
#   REPLICATION_FACTOR=1 MIN_INSYNC_REPLICAS=1 KAFKA_BROKER=localhost:9092 \
#     scripts/kafka/create-topics.sh
#
# Note: --if-not-exists leaves existing topics untouched. Changing partitions,
# replication or configs of an existing topic is a separate, reviewed change.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOPICS_FILE="${TOPICS_FILE:-${SCRIPT_DIR}/../../topics/generated/topics.tsv}"
KAFKA_BROKER="${KAFKA_BROKER:-kafka:9092}"
KAFKA_COMMAND_CONFIG="${KAFKA_COMMAND_CONFIG:-}"
PARTITIONS="${PARTITIONS:-}"
DLQ_PARTITIONS="${DLQ_PARTITIONS:-}"
REPLICATION_FACTOR="${REPLICATION_FACTOR:-}"
MIN_INSYNC_REPLICAS="${MIN_INSYNC_REPLICAS:-}"
RETENTION_MS="${RETENTION_MS:-}"
DLQ_RETENTION_MS="${DLQ_RETENTION_MS:-}"
MAX_MESSAGE_BYTES="${MAX_MESSAGE_BYTES:-}"
CREATE_LEGACY_TOPICS="${CREATE_LEGACY_TOPICS:-false}"
KAFKA_TOPICS_BIN="${KAFKA_TOPICS_BIN:-kafka-topics}"
KAFKA_API_VERSIONS_BIN="${KAFKA_API_VERSIONS_BIN:-kafka-broker-api-versions}"
WAIT_TIMEOUT_SECONDS="${WAIT_TIMEOUT_SECONDS:-300}"
DRY_RUN="${DRY_RUN:-false}"

# Retention for legacy audit/compliance aggregate streams (1 year), as before.
readonly LEGACY_LONG_RETENTION_MS=31536000000
# Defaults for legacy topics only (they are not in the catalog).
readonly LEGACY_PARTITIONS=3
readonly LEGACY_RETENTION_MS=604800000

readonly EVENT_TOPIC_PATTERN='^evt\.[a-z]+\.[a-z0-9]+(-[a-z0-9]+)*\.v[0-9]+$'
readonly DLQ_TOPIC_PATTERN='^evt\.[a-z]+\.[a-z0-9]+(-[a-z0-9]+)*\.dlq\.v[0-9]+$'
# Retired per-event form; matched only to reject it with a clear message.
readonly PER_EVENT_TOPIC_PATTERN='^evt\.[a-z]+\.[a-z0-9]+(-[a-z0-9]+)*\.[a-z0-9]+(-[a-z0-9]+)*\.v[0-9]+$'

log() { printf '%s %s\n' "[create-topics]" "$*"; }
die() { printf '%s ERROR: %s\n' "[create-topics]" "$*" >&2; exit 1; }

is_uint() { [[ "$1" =~ ^[0-9]+$ ]]; }
is_bool() { [[ "$1" == "true" || "$1" == "false" ]]; }

validate_settings() {
  local name
  for name in PARTITIONS DLQ_PARTITIONS REPLICATION_FACTOR MIN_INSYNC_REPLICAS \
              RETENTION_MS DLQ_RETENTION_MS MAX_MESSAGE_BYTES; do
    [[ -z "${!name}" ]] || is_uint "${!name}" || die "${name} must be a non-negative integer (got '${!name}')"
  done
  is_uint "${WAIT_TIMEOUT_SECONDS}" || die "WAIT_TIMEOUT_SECONDS must be a non-negative integer (got '${WAIT_TIMEOUT_SECONDS}')"
  for name in PARTITIONS DLQ_PARTITIONS REPLICATION_FACTOR MIN_INSYNC_REPLICAS; do
    [[ -z "${!name}" ]] || (( ${!name} >= 1 )) || die "${name} must be >= 1"
  done
  for name in CREATE_LEGACY_TOPICS DRY_RUN; do
    is_bool "${!name}" || die "${name} must be 'true' or 'false' (got '${!name}')"
  done
  if [[ -n "${KAFKA_COMMAND_CONFIG}" && "${DRY_RUN}" == "false" && ! -r "${KAFKA_COMMAND_CONFIG}" ]]; then
    die "KAFKA_COMMAND_CONFIG is set but not readable: ${KAFKA_COMMAND_CONFIG}"
  fi
  if [[ -n "${REPLICATION_FACTOR}" ]] && (( REPLICATION_FACTOR < 3 )); then
    log "WARNING: REPLICATION_FACTOR=${REPLICATION_FACTOR} is for local use only; shared clusters use 3 with MIN_INSYNC_REPLICAS=2."
  fi
  [[ -r "${TOPICS_FILE}" ]] || die "TOPICS_FILE not readable: ${TOPICS_FILE} (run npm run catalog:generate)"
}

# Catalog rows after validation and overrides:
# name kind partitions rf min_isr cleanup retention max_bytes (space separated).
CATALOG_ROWS=()

load_catalog() {
  local line name kind partitions rf min_isr cleanup retention max_bytes extra lineno=0
  while IFS= read -r line || [[ -n "${line}" ]]; do
    lineno=$(( lineno + 1 ))
    [[ -z "${line}" || "${line}" == \#* ]] && continue
    IFS=$'\t' read -r name kind partitions rf min_isr cleanup retention max_bytes extra <<<"${line}"
    [[ -z "${extra:-}" && -n "${max_bytes:-}" ]] || die "${TOPICS_FILE}:${lineno}: expected 8 tab-separated columns"
    case "${kind}" in
      event)
        if ! [[ "${name}" =~ ${EVENT_TOPIC_PATTERN} ]]; then
          if [[ "${name}" =~ ${PER_EVENT_TOPIC_PATTERN} && ! "${name}" =~ ${DLQ_TOPIC_PATTERN} ]]; then
            die "${TOPICS_FILE}:${lineno}: per-event topic '${name}' is retired; use the aggregate topic evt.<ctx>.<aggregate>.v<major> (ADR-019)"
          fi
          die "${TOPICS_FILE}:${lineno}: '${name}' does not match evt.<ctx>.<aggregate>.v<major>"
        fi
        partitions="${PARTITIONS:-${partitions}}"
        retention="${RETENTION_MS:-${retention}}"
        ;;
      dlq)
        [[ "${name}" =~ ${DLQ_TOPIC_PATTERN} ]] || die "${TOPICS_FILE}:${lineno}: DLQ topic '${name}' must be <namespace>.dlq.v<major> (evt.<ctx>.<aggregate>.dlq.v<major>)"
        partitions="${DLQ_PARTITIONS:-${partitions}}"
        retention="${DLQ_RETENTION_MS:-${retention}}"
        ;;
      *) die "${TOPICS_FILE}:${lineno}: kind must be event or dlq (got '${kind}')" ;;
    esac
    [[ "${cleanup}" == "delete" ]] || die "${TOPICS_FILE}:${lineno}: ${name} must use cleanup.policy=delete"
    rf="${REPLICATION_FACTOR:-${rf}}"
    min_isr="${MIN_INSYNC_REPLICAS:-${min_isr}}"
    max_bytes="${MAX_MESSAGE_BYTES:-${max_bytes}}"
    local value
    for value in "${partitions}" "${rf}" "${min_isr}" "${retention}" "${max_bytes}"; do
      if ! is_uint "${value}" || (( value < 1 )); then
        die "${TOPICS_FILE}:${lineno}: ${name} has a non-positive numeric setting '${value}'"
      fi
    done
    (( min_isr <= rf )) || die "${name}: min.insync.replicas (${min_isr}) cannot exceed the replication factor (${rf})"
    CATALOG_ROWS+=("${name} ${kind} ${partitions} ${rf} ${min_isr} ${cleanup} ${retention} ${max_bytes}")
  done < "${TOPICS_FILE}"
  (( ${#CATALOG_ROWS[@]} > 0 )) || die "${TOPICS_FILE} lists no topics"
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

# create_topic <name> <partitions> <rf> <min.insync.replicas> <cleanup.policy> <retention.ms> <max.message.bytes>
create_topic() {
  local name="$1" partitions="$2" rf="$3" min_isr="$4" cleanup="$5" retention="$6" max_bytes="$7"
  local args=(
    "${KAFKA_TOPICS_BIN}" --create "${CLIENT_ARGS[@]}"
    --topic "${name}"
    --partitions "${partitions}"
    --replication-factor "${rf}"
    --if-not-exists
    --config "cleanup.policy=${cleanup}"
    --config "retention.ms=${retention}"
    --config "min.insync.replicas=${min_isr}"
    --config "max.message.bytes=${max_bytes}"
  )
  log "topic ${name} (partitions=${partitions}, rf=${rf}, min_isr=${min_isr}, cleanup.policy=${cleanup})"
  run "${args[@]}" || die "failed to create topic ${name}"
  CREATED_COUNT=$(( CREATED_COUNT + 1 ))
}

# Event and DLQ topics from the catalog. Event topics are immutable facts:
# delete policy, never compaction (checked above).
create_catalog_topics() {
  local row
  log "Creating ${#CATALOG_ROWS[@]} catalog topics from ${TOPICS_FILE}"
  for row in "${CATALOG_ROWS[@]}"; do
    # shellcheck disable=SC2086 # row is a space-separated record built above
    set -- ${row}
    create_topic "$1" "$3" "$4" "$5" "$6" "$7" "$8"
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
    create_topic "${name}" "${partitions:-${PARTITIONS:-${LEGACY_PARTITIONS}}}" "${REPLICATION_FACTOR:-3}" \
      "${MIN_INSYNC_REPLICAS:-2}" "${cleanup:-delete}" "${retention:-${RETENTION_MS:-${LEGACY_RETENTION_MS}}}" \
      "${MAX_MESSAGE_BYTES:-1048576}"
  done
}

main() {
  validate_settings
  load_catalog
  log "broker=${KAFKA_BROKER} topics_file=${TOPICS_FILE} overrides: partitions=${PARTITIONS:-catalog} dlq_partitions=${DLQ_PARTITIONS:-catalog} rf=${REPLICATION_FACTOR:-catalog} min_isr=${MIN_INSYNC_REPLICAS:-catalog} legacy=${CREATE_LEGACY_TOPICS} dry_run=${DRY_RUN}"
  wait_for_kafka
  create_catalog_topics
  create_legacy_topics
  log "Done: ${CREATED_COUNT} topic create requests issued (existing topics are left unchanged)"
}

main "$@"
