import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import {
  AGGREGATE_TOPIC_PATTERN,
  crossCheckAsyncApi,
  loadCatalog,
  loadManifest,
  parseManifest,
  renderClientAccessJson,
  renderMetricsConfigMap,
  renderStrimziTopics,
  renderStrimziUsers,
  renderTopicsTsv,
  resolveAccess,
  resolveTopics,
  validateCatalog,
} from "../catalog.mjs";
import { run } from "../generate.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const MANIFEST = parseManifest(
  [
    "repo,context,owning_tribe,service_id,app_id,db_prod_pattern,event_namespace,owning_squad,wave",
    "r-loan,lending,T,svc-ln-loan-lifecycle,app.ln.loan-lifecycle,db,evt.ln.loan,S,3",
    "r-risk,risk,T,svc-rsk-decisioning,app.rsk.decisioning,db,evt.rsk.risk,S,4",
  ].join("\n"),
);

function fixture() {
  return {
    apiVersion: "catalog.fintechbankx.io/v1alpha1",
    kind: "TopicCatalog",
    metadata: { status: "Proposed" },
    cluster: { strimziClusterName: "fintechbankx", strimziNamespace: "kafka" },
    defaults: {
      partitions: 3,
      replicationFactor: 3,
      minInsyncReplicas: 2,
      cleanupPolicy: "delete",
      retentionMs: 604800000,
      maxMessageBytes: 1048576,
      dlq: { partitions: 3, retentionMs: 1209600000 },
    },
    services: {
      "svc-ln-loan-lifecycle": { eventNamespace: "evt.ln.loan", k8sNamespace: "lending", serviceAccount: "loan-lifecycle-service" },
      "svc-rsk-decisioning": { eventNamespace: "evt.rsk.risk", k8sNamespace: "risk", serviceAccount: "risk-decisioning-service" },
    },
    namespaces: [
      {
        namespace: "evt.ln.loan",
        owner: "svc-ln-loan-lifecycle",
        aggregate: "Loan",
        contract: "asyncapi/svc-ln-loan-lifecycle.yaml",
        implementation: "outbox-relay",
        consumersStatus: "known",
        consumers: [
          {
            service: "svc-rsk-decisioning",
            group: "cg.svc-rsk-decisioning.loan-exposure.v1",
            evidence: "risk-infrastructure LoanEventsListener",
            topics: ["evt.ln.loan.v1"],
            eventTypes: ["Lending.Loan.Disbursed.v1"],
          },
        ],
        topics: [
          {
            major: 1,
            retentionMs: 2592000000,
            eventTypes: ["Lending.Loan.Created.v1", "Lending.Loan.Disbursed.v1", "Lending.Loan.PaymentMade.v1"],
          },
        ],
      },
    ],
    gaps: [{ service: "svc-x", namespace: "evt.x.y", reason: "none" }],
  };
}

function expectError(catalog, fragment) {
  const errors = validateCatalog(catalog, MANIFEST);
  assert.ok(
    errors.some((e) => e.includes(fragment)),
    `expected an error containing "${fragment}", got:\n${errors.join("\n")}`,
  );
}

test("the committed catalog is valid against the vendored bootstrap manifest", () => {
  const catalog = loadCatalog(path.join(repoRoot, "topics/catalog.yaml"));
  const manifest = loadManifest(path.join(repoRoot, "topics/registry/repository-bootstrap-manifest.csv"));
  assert.deepEqual(validateCatalog(catalog, manifest), []);
});

test("the committed generated files are up to date (--check)", () => {
  const messages = [];
  const log = { log: (m) => messages.push(m), error: (m) => messages.push(m) };
  assert.equal(run(["--check"], log), 0, messages.join("\n"));
});

test("--check fails when a generated file drifts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-drift-"));
  try {
    for (const rel of ["topics", "monitoring", "deploy/strimzi/generated"]) {
      fs.cpSync(path.join(repoRoot, rel), path.join(dir, rel), { recursive: true });
    }
    const tsv = path.join(dir, "topics/generated/topics.tsv");
    fs.writeFileSync(tsv, fs.readFileSync(tsv, "utf8").replace("evt.ln.loan.v1\tevent\t3", "evt.ln.loan.v1\tevent\t12"));
    const messages = [];
    const log = { log: (m) => messages.push(m), error: (m) => messages.push(m) };
    assert.equal(run(["--check", "--root", dir], log), 1);
    assert.ok(messages.some((m) => m.includes("topics/generated/topics.tsv is out of date")), messages.join("\n"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a valid fixture produces no errors", () => {
  assert.deepEqual(validateCatalog(fixture(), MANIFEST), []);
});

// The ADR-019 topics after the owner's 2026-10-08 decision (one topic per aggregate),
// cross-checked with asyncapi-catalog 44837cc and schema-registry 1334e15.
const AGGREGATE_TOPICS = [
  "evt.ln.loan.v1",
  "evt.pay.payment.v1",
  "evt.pay.rtp.v1",
  "evt.pay.bulk.v1",
  "evt.pay.mandate.v1",
  "evt.cus.customer.v1",
  "evt.rsk.risk.v1",
  "evt.cmp.compliance.v1",
  "evt.of.consent.v1",
  "evt.of.payee.v1",
];

test("the committed catalog has exactly one topic per aggregate and no per-event topic (ADR-019)", () => {
  const catalog = loadCatalog(path.join(repoRoot, "topics/catalog.yaml"));
  const topics = resolveTopics(catalog);
  const events = topics.filter((t) => t.kind === "event").map((t) => t.name);
  assert.deepEqual([...events].sort(), [...AGGREGATE_TOPICS].sort());
  for (const name of events) {
    assert.match(name, AGGREGATE_TOPIC_PATTERN);
  }
  for (const t of topics.filter((x) => x.kind === "dlq")) {
    assert.match(t.name, /^evt\.[a-z]+\.[a-z0-9-]+\.dlq\.v[0-9]+$/, "DLQs stay <consumer namespace>.dlq.v<major>");
  }
  const tsv = fs.readFileSync(path.join(repoRoot, "topics/generated/topics.tsv"), "utf8");
  assert.doesNotMatch(tsv, /^evt\.[a-z]+\.[a-z0-9-]+\.(?!dlq\.)[a-z0-9-]+\.v[0-9]+\t/m, "no per-event topic is provisioned");
  const access = fs.readFileSync(path.join(repoRoot, "topics/generated/msk-client-access.json"), "utf8");
  assert.doesNotMatch(access, /"evt\.[a-z]+\.[a-z0-9-]+\.(?!dlq\.)[a-z0-9-]+\.v[0-9]+"/, "no per-event topic in IAM access");
});

test("the committed catalog keeps every event type on its aggregate topic", () => {
  const catalog = loadCatalog(path.join(repoRoot, "topics/catalog.yaml"));
  const byTopic = Object.fromEntries(resolveTopics(catalog).filter((t) => t.kind === "event").map((t) => [t.name, t.eventTypes]));
  assert.equal(byTopic["evt.ln.loan.v1"].length, 7);
  assert.ok(byTopic["evt.ln.loan.v1"].includes("Lending.Loan.Disbursed.v1"));
  assert.equal(byTopic["evt.pay.payment.v1"].length, 9);
  assert.deepEqual(byTopic["evt.of.consent.v1"], [
    "OpenFinance.Consent.Created.v1",
    "OpenFinance.Consent.Authorized.v1",
    "OpenFinance.Consent.Revoked.v1",
    "OpenFinance.Consent.Expired.v1",
  ]);
  const consent = resolveTopics(catalog).find((t) => t.name === "evt.of.consent.v1");
  assert.equal(consent.partitions, 6);
  assert.equal(consent.retentionMs, 7776000000);
});

test("rejects the retired per-event topic form evt.<ctx>.<aggregate>.<event>.v<major>", () => {
  const c = fixture();
  c.namespaces[0].topics = [{ event: "created", major: 1, eventType: "Lending.Loan.Created.v1" }];
  expectError(c, "per-event topic evt.ln.loan.created.v1 is retired");
  const d = fixture();
  d.namespaces[0].consumers[0].topics = ["evt.ln.loan.disbursed.v1"];
  expectError(d, "per-event topic evt.ln.loan.disbursed.v1 is retired");
  const e = fixture();
  e.namespaces[0].namespace = "loan.events";
  expectError(e, "must match evt.<ctx>.<aggregate>");
});

test("rejects a malformed aggregate topic entry", () => {
  const c = fixture();
  c.namespaces[0].topics[0].major = 0;
  expectError(c, "major must be a positive integer");
  const d = fixture();
  d.namespaces[0].topics.push({ major: 1, eventTypes: ["Lending.Loan.Restructured.v1"] });
  expectError(d, "topic evt.ln.loan.v1: declared twice");
  const e = fixture();
  e.namespaces[0].topics[0].key = "loanId";
  expectError(e, "topic evt.ln.loan.v1: key is not supported");
});

test("rejects a producer whose manifest event namespace differs from the topic namespace", () => {
  const c = fixture();
  c.namespaces[0].owner = "svc-rsk-decisioning";
  c.namespaces[0].contract = "asyncapi/svc-rsk-decisioning.yaml";
  expectError(c, "has event namespace evt.rsk.risk in the bootstrap manifest");
});

test("rejects an owner missing from the manifest", () => {
  const c = fixture();
  c.namespaces[0].owner = "svc-ln-unknown";
  expectError(c, "is not in the bootstrap manifest");
});

test("rejects producers other than the owner", () => {
  const c = fixture();
  c.namespaces[0].producers = ["svc-ln-loan-lifecycle", "svc-rsk-decisioning"];
  expectError(c, "owner-only produce");
});

test("rejects compaction and min.insync.replicas >= replication factor", () => {
  const c = fixture();
  c.namespaces[0].topics[0].cleanupPolicy = "compact";
  expectError(c, "cleanupPolicy must be delete");
  const d = fixture();
  d.defaults.minInsyncReplicas = 3;
  expectError(d, "must be lower than replicationFactor");
});

test("rejects event types that do not belong on the aggregate topic", () => {
  const c = fixture();
  c.namespaces[0].topics[0].eventTypes = [];
  expectError(c, "eventTypes must list every event type published on the topic");
  const d = fixture();
  d.namespaces[0].topics[0].eventTypes.push("Payments.Payment.Created.v1");
  expectError(d, "eventType aggregate Payment differs from namespace aggregate Loan");
  const e = fixture();
  e.namespaces[0].topics[0].eventTypes.push("Lending.Loan.Created.v1");
  expectError(e, "Lending.Loan.Created.v1 listed twice");
  const f = fixture();
  f.namespaces[0].topics[0].eventTypes.push("lending.loan.created");
  expectError(f, "eventType lending.loan.created must be <Context>.<Aggregate>.<PastTenseEvent>.v<major>");
  const g = fixture();
  g.namespaces[0].topics[0].eventTypes.push("Loans.Loan.Restructured.v1");
  expectError(g, "eventType context Loans differs from Lending");
});

test("an event major is independent of the topic major: v1 and v2 of one event dual-publish on the same topic", () => {
  const c = fixture();
  c.namespaces[0].topics[0].eventTypes.push("Lending.Loan.Disbursed.v2");
  assert.deepEqual(validateCatalog(c, MANIFEST), []);
  const topic = resolveTopics(c).find((t) => t.name === "evt.ln.loan.v1");
  assert.ok(topic.eventTypes.includes("Lending.Loan.Disbursed.v1") && topic.eventTypes.includes("Lending.Loan.Disbursed.v2"));
  const d = fixture();
  d.namespaces[0].topics.push({ major: 2, partitions: 12, eventTypes: ["Lending.Loan.Created.v1"] });
  assert.deepEqual(validateCatalog(d, MANIFEST), [], "a topic major (partition change) is a second topic of the namespace");
  assert.deepEqual(
    resolveTopics(d).filter((t) => t.kind === "event").map((t) => t.name),
    ["evt.ln.loan.v1", "evt.ln.loan.v2"],
  );
});

test("rejects consumer groups outside cg.<service-id>.<purpose>.v<major>, unknown topics and unpublished event types", () => {
  const c = fixture();
  c.namespaces[0].consumers[0].group = "risk-loan-consumer";
  expectError(c, "group must be cg.svc-rsk-decisioning.<purpose>.v<major>");
  const d = fixture();
  d.namespaces[0].consumers[0].topics = ["evt.ln.loan.v2"];
  expectError(d, "topic evt.ln.loan.v2 is not an event topic of evt.ln.loan");
  const e = fixture();
  delete e.namespaces[0].consumers[0].evidence;
  expectError(e, "evidence");
  const f = fixture();
  delete f.namespaces[0].consumers[0].eventTypes;
  expectError(f, "eventTypes must list the event types it handles");
  const g = fixture();
  g.namespaces[0].consumers[0].eventTypes = ["Lending.Loan.Restructured.v1"];
  expectError(g, "handles Lending.Loan.Restructured.v1, which is not published on evt.ln.loan.v1");
});

test("rejects unknown consumers declared as known and unused service entries", () => {
  const c = fixture();
  c.namespaces[0].consumers = [];
  expectError(c, "consumersStatus known requires at least one consumer");
  const d = fixture();
  d.namespaces[0].consumers = [];
  d.namespaces[0].consumersStatus = "unknown";
  expectError(d, "services.svc-rsk-decisioning: neither owns nor consumes");
});

test("resolves defaults and overrides; a producer-only namespace gets no DLQ (consumer-owned rule)", () => {
  const topics = resolveTopics(fixture());
  assert.deepEqual(topics.map((t) => t.name), ["evt.ln.loan.v1", "evt.rsk.risk.dlq.v1"]);
  const loan = topics.find((t) => t.name === "evt.ln.loan.v1");
  assert.equal(loan.retentionMs, 2592000000);
  assert.equal(loan.partitions, 3);
  assert.deepEqual(loan.eventTypes, ["Lending.Loan.Created.v1", "Lending.Loan.Disbursed.v1", "Lending.Loan.PaymentMade.v1"]);
  assert.equal(loan.dlq, null, "an event topic has no single DLQ; each consumer has its own");
  assert.deepEqual(loan.producers, ["svc-ln-loan-lifecycle"]);
  assert.deepEqual(loan.consumers[0].eventTypes, ["Lending.Loan.Disbursed.v1"]);
  const dlq = topics.find((t) => t.kind === "dlq");
  assert.equal(dlq.retentionMs, 1209600000);
});

test("an owner can reserve its namespace DLQ before it consumes anything", () => {
  const c = fixture();
  c.namespaces[0].dlq = { reserved: true };
  assert.deepEqual(validateCatalog(c, MANIFEST), []);
  const dlq = resolveTopics(c).find((t) => t.name === "evt.ln.loan.dlq.v1");
  assert.equal(dlq.kind, "dlq");
  assert.deepEqual(dlq.producers, [], "reserved: no writer until the owner consumes something");
  const bad = fixture();
  bad.namespaces[0].dlq = { reserved: "yes" };
  expectError(bad, "dlq.reserved must be true or false");
});

test("DLQ partitions and retention are configurable per namespace and validated", () => {
  const c = fixture();
  c.namespaces[0].dlq = { reserved: true, retentionMs: 2419200000, partitions: 1 };
  assert.deepEqual(validateCatalog(c, MANIFEST), []);
  const dlq = resolveTopics(c).find((t) => t.name === "evt.ln.loan.dlq.v1");
  assert.equal(dlq.retentionMs, 2419200000);
  assert.equal(dlq.partitions, 1);
  const bad = fixture();
  bad.namespaces[0].dlq = { retentionMs: -1 };
  expectError(bad, "dlq.retentionMs must be a positive integer");
  const unknown = fixture();
  unknown.namespaces[0].dlq = { cleanupPolicy: "compact" };
  expectError(unknown, "dlq.cleanupPolicy is not supported");
});

test("consumer-owned DLQ: a consumer dead-letters into its own namespace, provisioned even without event topics", () => {
  const c = fixture();
  assert.deepEqual(validateCatalog(c, MANIFEST), []);
  const topics = resolveTopics(c);
  const own = topics.find((t) => t.name === "evt.rsk.risk.dlq.v1");
  assert.equal(own.kind, "dlq");
  assert.equal(own.owner, "svc-rsk-decisioning");
  assert.deepEqual(own.producers, ["svc-rsk-decisioning"]);
  assert.deepEqual(topics.find((t) => t.name === "evt.ln.loan.v1").consumers[0].dlq, "evt.rsk.risk.dlq.v1");
  assert.equal(topics.find((t) => t.name === "evt.ln.loan.dlq.v1"), undefined, "never the source namespace DLQ");
  c.namespaces[0].consumers[0].dlq = "evt.rsk.risk.dlq.v1";
  assert.deepEqual(validateCatalog(c, MANIFEST), [], "an explicit own-namespace DLQ is accepted");
});

test("rejects a consumer DLQ outside its own namespace, including the source namespace DLQ", () => {
  for (const dlq of ["evt.ln.loan.dlq.v1", "evt.cmp.compliance.dlq.v1", "evt.rsk.risk.dlq.v2"]) {
    const c = fixture();
    c.namespaces[0].consumers[0].dlq = dlq;
    expectError(c, `dlq ${dlq} is outside its own namespace`);
  }
});

test("rejects a service eventNamespace that differs from the bootstrap manifest", () => {
  const c = fixture();
  c.services["svc-rsk-decisioning"].eventNamespace = "evt.ln.loan";
  expectError(c, "services.svc-rsk-decisioning.eventNamespace must be evt.rsk.risk");
});

test("access: owner writes its events, consumers read with their group prefix and write only their own DLQ", () => {
  const access = resolveAccess(fixture());
  assert.deepEqual(access["svc-ln-loan-lifecycle"].produce_topics, ["evt.ln.loan.v1"]);
  assert.deepEqual(access["svc-ln-loan-lifecycle"].produce_topic_prefixes, ["evt.ln.loan."]);
  assert.deepEqual(access["svc-ln-loan-lifecycle"].consume_topics, [], "the owner reads nothing");
  assert.deepEqual(access["svc-ln-loan-lifecycle"].consumer_group_prefixes, []);
  assert.deepEqual(access["svc-rsk-decisioning"].produce_topics, ["evt.rsk.risk.dlq.v1"]);
  assert.deepEqual(access["svc-rsk-decisioning"].produce_topic_prefixes, ["evt.rsk.risk."], "a consumer-only service still gets its namespace");
  assert.deepEqual(access["svc-rsk-decisioning"].consume_topics, ["evt.ln.loan.v1", "evt.rsk.risk.dlq.v1"]);
  assert.deepEqual(access["svc-rsk-decisioning"].consumer_groups, ["cg.svc-rsk-decisioning.loan-exposure.v1"]);
  assert.deepEqual(access["svc-rsk-decisioning"].consumer_group_prefixes, ["cg.svc-rsk-decisioning."]);
  const json = JSON.parse(renderClientAccessJson(fixture()));
  assert.equal(json.services["svc-rsk-decisioning"].kubernetes_namespace, "risk");
  assert.equal(json.services["svc-rsk-decisioning"].service_account, "risk-decisioning-service");
});

test("Strimzi KafkaTopic manifests carry catalog settings and the cluster label", () => {
  const docs = YAML.parseAllDocuments(renderStrimziTopics(fixture())).map((d) => d.toJS());
  assert.equal(docs.length, 2, "the aggregate topic and the consumer's own DLQ; the producer-only loan namespace has none");
  const created = docs.find((d) => d.metadata.name === "evt.ln.loan.v1");
  assert.equal(created.kind, "KafkaTopic");
  assert.equal(created.metadata.namespace, "kafka");
  assert.equal(created.metadata.labels["strimzi.io/cluster"], "fintechbankx");
  assert.equal(created.spec.topicName, "evt.ln.loan.v1");
  assert.equal(
    created.metadata.annotations["fintechbankx.io/event-types"],
    "Lending.Loan.Created.v1,Lending.Loan.Disbursed.v1,Lending.Loan.PaymentMade.v1",
  );
  assert.equal(created.spec.replicas, 3);
  assert.equal(created.spec.config["min.insync.replicas"], 2);
  assert.equal(created.spec.config["cleanup.policy"], "delete");
});

test("Strimzi KafkaUser uses TLS auth and least-privilege ACLs", () => {
  const docs = YAML.parseAllDocuments(renderStrimziUsers(fixture())).map((d) => d.toJS());
  const owner = docs.find((d) => d.metadata.name === "svc-ln-loan-lifecycle");
  const risk = docs.find((d) => d.metadata.name === "svc-rsk-decisioning");
  assert.equal(owner.spec.authentication.type, "tls");
  assert.equal(owner.spec.authorization.type, "simple");
  assert.ok(!owner.spec.authorization.acls.some((a) => a.operations.includes("Read")), "a pure producer gets no Read");
  const ownerWrites = owner.spec.authorization.acls.filter((a) => a.operations.includes("Write")).map((a) => a.resource.name);
  assert.deepEqual(ownerWrites, ["evt.ln.loan.v1"]);
  const riskWrites = risk.spec.authorization.acls.filter((a) => a.operations.includes("Write")).map((a) => a.resource.name);
  assert.deepEqual(riskWrites, ["evt.rsk.risk.dlq.v1"], "a consumer may only write its own namespace DLQ");
  const writersOfLoanDlq = docs.filter((d) =>
    d.spec.authorization.acls.some((a) => a.resource.name === "evt.ln.loan.dlq.v1" && a.operations.includes("Write")),
  );
  assert.deepEqual(writersOfLoanDlq, [], "nobody else writes the loan DLQ");
  const group = risk.spec.authorization.acls.find((a) => a.resource.type === "group");
  assert.deepEqual(group.resource, { type: "group", name: "cg.svc-rsk-decisioning.", patternType: "prefix" });
  const riskReads = risk.spec.authorization.acls.filter((a) => a.operations.includes("Read") && a.resource.type === "topic").map((a) => a.resource.name);
  assert.deepEqual(riskReads, ["evt.ln.loan.v1", "evt.rsk.risk.dlq.v1"], "reads only the consumed aggregate topic and its own DLQ");
});

test("topics.tsv has eight columns per topic including consumer DLQs", () => {
  const rows = renderTopicsTsv(fixture())
    .split("\n")
    .filter((l) => l && !l.startsWith("#"));
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.split("\t").length, 8, row);
  }
  assert.equal(rows[0], "evt.ln.loan.v1\tevent\t3\t3\t2\tdelete\t2592000000\t1048576");
  assert.equal(rows[1], "evt.rsk.risk.dlq.v1\tdlq\t3\t3\t2\tdelete\t1209600000\t1048576");
});

test("metrics ConfigMap keeps the JMX rules and drops the standalone hostPort", () => {
  const jmx = 'hostPort: "kafka:9999"\nlowercaseOutputName: true\nrules:\n  - pattern: "x"\n    name: y\n';
  const cm = YAML.parse(renderMetricsConfigMap(fixture(), jmx));
  const config = YAML.parse(cm.data["kafka-metrics-config.yml"]);
  assert.equal(config.hostPort, undefined);
  assert.equal(config.rules.length, 1);
  assert.throws(() => renderMetricsConfigMap(fixture(), "rules: []\n"), /no rules/);
});

function loanMessage(eventType) {
  return {
    payload: { allOf: [{ $ref: "#/components/schemas/EventEnvelope" }, { type: "object", properties: { eventType: { const: eventType } } }] },
  };
}

test("AsyncAPI cross-check compares the aggregate channel, its settings and its event types", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-asyncapi-"));
  try {
    const spec = {
      asyncapi: "3.0.0",
      info: { "x-event-namespace": "evt.ln.loan" },
      channels: {
        loan: {
          address: "evt.ln.loan.v1",
          messages: {
            LoanCreated: { $ref: "#/components/messages/LoanCreated" },
            LoanDisbursed: { $ref: "#/components/messages/LoanDisbursed" },
            LoanRestructured: { $ref: "#/components/messages/LoanRestructured" },
          },
          bindings: { kafka: { partitions: 6, topicConfiguration: { "retention.ms": 2592000000, "cleanup.policy": ["delete"] } } },
          "x-consumers": [{ serviceId: "svc-rsk-decisioning", consumerGroup: "cg.svc-rsk-decisioning.other.v1", deadLetterTopic: "evt.rsk.risk.dlq.v1" }],
        },
        legacy: { address: "evt.ln.loan.created.v1" },
      },
      components: {
        messages: {
          LoanCreated: loanMessage("Lending.Loan.Created.v1"),
          LoanDisbursed: loanMessage("Lending.Loan.Disbursed.v1"),
          LoanRestructured: loanMessage("Lending.Loan.Restructured.v1"),
        },
      },
    };
    fs.writeFileSync(path.join(dir, "svc-ln-loan-lifecycle.yaml"), YAML.stringify(spec));
    const errors = crossCheckAsyncApi(fixture(), dir);
    const all = errors.join("\n");
    assert.ok(errors.some((e) => e.includes("evt.ln.loan.v1: partitions 3 in catalog, 6 in contract")), all);
    assert.ok(errors.some((e) => e.includes("evt.ln.loan.v1: event type Lending.Loan.PaymentMade.v1 in catalog, not in contract")), all);
    assert.ok(errors.some((e) => e.includes("evt.ln.loan.v1: event type Lending.Loan.Restructured.v1 in contract, not in catalog")), all);
    assert.ok(errors.some((e) => e.includes("evt.ln.loan.v1: x-consumers")), all);
    assert.ok(errors.some((e) => e.includes("evt.ln.loan.created.v1: channel in svc-ln-loan-lifecycle.yaml but not in the catalog")), all);
    assert.ok(!errors.some((e) => e.includes("retention.ms")), all);

    spec.channels = { loan: { ...spec.channels.loan, bindings: { kafka: { partitions: 3 } } } };
    delete spec.channels.loan["x-consumers"];
    spec.channels.loan.messages = { LoanCreated: spec.channels.loan.messages.LoanCreated };
    fs.writeFileSync(path.join(dir, "svc-ln-loan-lifecycle.yaml"), YAML.stringify(spec));
    const c = fixture();
    c.namespaces[0].topics[0].eventTypes = ["Lending.Loan.Created.v1"];
    c.namespaces[0].consumers[0].eventTypes = ["Lending.Loan.Created.v1"];
    assert.deepEqual(crossCheckAsyncApi(c, dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTopics(env) {
  return spawnSync("bash", [path.join(repoRoot, "scripts/kafka/create-topics.sh")], {
    env: { PATH: process.env.PATH, DRY_RUN: "true", ...env },
    encoding: "utf8",
  });
}

test("create-topics.sh reads the catalog list, including DLQs, with catalog settings", () => {
  const res = createTopics({});
  assert.equal(res.status, 0, res.stderr);
  const catalog = loadCatalog(path.join(repoRoot, "topics/catalog.yaml"));
  const expected = resolveTopics(catalog);
  const commands = res.stdout.split("\n").filter((l) => l.startsWith("+ kafka-topics --create"));
  assert.equal(commands.length, expected.length);
  for (const t of expected) {
    const cmd = commands.find((c) => c.includes(`--topic ${t.name} `));
    assert.ok(cmd, `no create command for ${t.name}`);
    assert.ok(cmd.includes(`--partitions ${t.partitions} --replication-factor ${t.replicationFactor} `), cmd);
    assert.ok(cmd.includes(`retention.ms=${t.retentionMs}`), cmd);
    assert.ok(cmd.includes(`min.insync.replicas=${t.minInsyncReplicas}`), cmd);
  }
});

test("create-topics.sh keeps its local override flags", () => {
  const res = createTopics({ REPLICATION_FACTOR: "1", MIN_INSYNC_REPLICAS: "1", PARTITIONS: "1" });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stdout.includes("--topic evt.ln.loan.v1 --partitions 1 --replication-factor 1"));
  assert.ok(res.stdout.includes("--topic evt.ln.loan.dlq.v1 --partitions 3 --replication-factor 1"), "PARTITIONS does not touch DLQs");
  const bad = createTopics({ REPLICATION_FACTOR: "1" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /cannot exceed the replication factor/);
});

test("create-topics.sh rejects a malformed topic list", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-tsv-"));
  try {
    const file = path.join(dir, "topics.tsv");
    fs.writeFileSync(file, "loan.disbursed\tevent\t3\t3\t2\tdelete\t604800000\t1048576\n");
    const res = createTopics({ TOPICS_FILE: file });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /does not match evt/);
    fs.writeFileSync(file, "evt.ln.loan.v1\tevent\t3\t3\t2\tcompact\t604800000\t1048576\n");
    const compact = createTopics({ TOPICS_FILE: file });
    assert.equal(compact.status, 1);
    assert.match(compact.stderr, /cleanup.policy=delete/);
    fs.writeFileSync(file, "evt.ln.loan.created.v1\tevent\t3\t3\t2\tdelete\t604800000\t1048576\n");
    const perEvent = createTopics({ TOPICS_FILE: file });
    assert.equal(perEvent.status, 1, "per-event topics are no longer provisioned (ADR-019)");
    assert.match(perEvent.stderr, /per-event topic 'evt\.ln\.loan\.created\.v1' is retired/);
    fs.writeFileSync(file, "evt.ln.loan.v1\tdlq\t3\t3\t2\tdelete\t604800000\t1048576\n");
    const dlqKind = createTopics({ TOPICS_FILE: file });
    assert.equal(dlqKind.status, 1);
    assert.match(dlqKind.stderr, /must be <namespace>\.dlq\.v<major>/);
    fs.writeFileSync(file, "evt.ln.loan.dlq.v1\tevent\t3\t3\t2\tdelete\t604800000\t1048576\n");
    const dlqAsEvent = createTopics({ TOPICS_FILE: file });
    assert.equal(dlqAsEvent.status, 1);
    assert.match(dlqAsEvent.stderr, /does not match evt\.<ctx>\.<aggregate>\.v<major>/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
