import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import {
  crossCheckAsyncApi,
  kebabToPascal,
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
      "svc-ln-loan-lifecycle": { k8sNamespace: "lending", serviceAccount: "loan-lifecycle-service" },
      "svc-rsk-decisioning": { k8sNamespace: "risk", serviceAccount: "risk-decisioning-service" },
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
            topics: ["evt.ln.loan.disbursed.v1"],
          },
        ],
        topics: [
          { event: "created", major: 1, eventType: "Lending.Loan.Created.v1" },
          { event: "disbursed", major: 1, eventType: "Lending.Loan.Disbursed.v1", retentionMs: 2592000000 },
          { event: "payment-made", major: 1, eventType: "Lending.Loan.PaymentMade.v1" },
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
    fs.writeFileSync(tsv, fs.readFileSync(tsv, "utf8").replace("evt.ln.loan.created.v1\tevent\t3", "evt.ln.loan.created.v1\tevent\t12"));
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

test("rejects topic names outside evt.<ctx>.<aggregate>.<event>.v<major>", () => {
  const c = fixture();
  c.namespaces[0].topics[0].event = "Created_Now";
  expectError(c, "event must be kebab-case");
  const d = fixture();
  d.namespaces[0].namespace = "loan.events";
  expectError(d, "must match evt.<ctx>.<aggregate>");
});

test("rejects listing a DLQ as an event", () => {
  const c = fixture();
  c.namespaces[0].topics.push({ event: "dlq", major: 1, eventType: "Lending.Loan.Dlq.v1" });
  expectError(c, "not 'dlq'");
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

test("rejects an eventType that does not match the topic", () => {
  const c = fixture();
  c.namespaces[0].topics[2].eventType = "Lending.Loan.PaymentReceived.v1";
  expectError(c, "does not match topic event payment-made");
  const d = fixture();
  d.namespaces[0].topics[0].eventType = "Lending.Loan.Created.v2";
  expectError(d, "differs from topic major v1");
});

test("rejects consumer groups outside cg.<service-id>.<purpose>.v<major> and unknown consumed topics", () => {
  const c = fixture();
  c.namespaces[0].consumers[0].group = "risk-loan-consumer";
  expectError(c, "group must be cg.svc-rsk-decisioning.<purpose>.v<major>");
  const d = fixture();
  d.namespaces[0].consumers[0].topics = ["evt.ln.loan.restructured.v1"];
  expectError(d, "is not an event topic of evt.ln.loan");
  const e = fixture();
  delete e.namespaces[0].consumers[0].evidence;
  expectError(e, "evidence");
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

test("kebabToPascal maps topic events to event type names", () => {
  assert.equal(kebabToPascal("payment-made"), "PaymentMade");
  assert.equal(kebabToPascal("created"), "Created");
});

test("resolves defaults, overrides and one DLQ per namespace and major", () => {
  const topics = resolveTopics(fixture());
  assert.deepEqual(
    topics.map((t) => t.name),
    ["evt.ln.loan.created.v1", "evt.ln.loan.disbursed.v1", "evt.ln.loan.payment-made.v1", "evt.ln.loan.dlq.v1"],
  );
  const disbursed = topics.find((t) => t.name === "evt.ln.loan.disbursed.v1");
  assert.equal(disbursed.retentionMs, 2592000000);
  assert.equal(disbursed.dlq, "evt.ln.loan.dlq.v1");
  assert.deepEqual(disbursed.producers, ["svc-ln-loan-lifecycle"]);
  const dlq = topics.find((t) => t.kind === "dlq");
  assert.equal(dlq.retentionMs, 1209600000);
  assert.deepEqual(dlq.producers, ["svc-rsk-decisioning"]);
});

test("access: owner writes its events, consumers read with their group prefix and write the DLQ", () => {
  const access = resolveAccess(fixture());
  assert.deepEqual(access["svc-ln-loan-lifecycle"].produce_topics, [
    "evt.ln.loan.created.v1",
    "evt.ln.loan.disbursed.v1",
    "evt.ln.loan.payment-made.v1",
  ]);
  assert.deepEqual(access["svc-ln-loan-lifecycle"].consume_topics, ["evt.ln.loan.dlq.v1"]);
  assert.deepEqual(access["svc-rsk-decisioning"].produce_topics, ["evt.ln.loan.dlq.v1"]);
  assert.deepEqual(access["svc-rsk-decisioning"].consume_topics, ["evt.ln.loan.disbursed.v1", "evt.ln.loan.dlq.v1"]);
  assert.deepEqual(access["svc-rsk-decisioning"].consumer_groups, ["cg.svc-rsk-decisioning.loan-exposure.v1"]);
  assert.deepEqual(access["svc-rsk-decisioning"].consumer_group_prefixes, ["cg.svc-rsk-decisioning."]);
  const json = JSON.parse(renderClientAccessJson(fixture()));
  assert.equal(json.services["svc-rsk-decisioning"].kubernetes_namespace, "risk");
  assert.equal(json.services["svc-rsk-decisioning"].service_account, "risk-decisioning-service");
});

test("Strimzi KafkaTopic manifests carry catalog settings and the cluster label", () => {
  const docs = YAML.parseAllDocuments(renderStrimziTopics(fixture())).map((d) => d.toJS());
  assert.equal(docs.length, 4);
  const created = docs.find((d) => d.metadata.name === "evt.ln.loan.created.v1");
  assert.equal(created.kind, "KafkaTopic");
  assert.equal(created.metadata.namespace, "kafka");
  assert.equal(created.metadata.labels["strimzi.io/cluster"], "fintechbankx");
  assert.equal(created.spec.topicName, "evt.ln.loan.created.v1");
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
  const ownerWrites = owner.spec.authorization.acls.filter((a) => a.operations.includes("Write")).map((a) => a.resource.name);
  assert.deepEqual(ownerWrites, ["evt.ln.loan.created.v1", "evt.ln.loan.disbursed.v1", "evt.ln.loan.payment-made.v1"]);
  const riskWrites = risk.spec.authorization.acls.filter((a) => a.operations.includes("Write")).map((a) => a.resource.name);
  assert.deepEqual(riskWrites, ["evt.ln.loan.dlq.v1"], "a consumer may only write the DLQ");
  const group = risk.spec.authorization.acls.find((a) => a.resource.type === "group");
  assert.deepEqual(group.resource, { type: "group", name: "cg.svc-rsk-decisioning.", patternType: "prefix" });
  assert.ok(!risk.spec.authorization.acls.some((a) => a.resource.name === "evt.ln.loan.created.v1"), "no read on unconsumed topics");
});

test("topics.tsv has eight columns per topic including DLQs", () => {
  const rows = renderTopicsTsv(fixture())
    .split("\n")
    .filter((l) => l && !l.startsWith("#"));
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.equal(row.split("\t").length, 8, row);
  }
  assert.equal(rows[3], "evt.ln.loan.dlq.v1\tdlq\t3\t3\t2\tdelete\t1209600000\t1048576");
});

test("metrics ConfigMap keeps the JMX rules and drops the standalone hostPort", () => {
  const jmx = 'hostPort: "kafka:9999"\nlowercaseOutputName: true\nrules:\n  - pattern: "x"\n    name: y\n';
  const cm = YAML.parse(renderMetricsConfigMap(fixture(), jmx));
  const config = YAML.parse(cm.data["kafka-metrics-config.yml"]);
  assert.equal(config.hostPort, undefined);
  assert.equal(config.rules.length, 1);
  assert.throws(() => renderMetricsConfigMap(fixture(), "rules: []\n"), /no rules/);
});

test("AsyncAPI cross-check reports channels missing from either side", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-asyncapi-"));
  try {
    const spec = {
      asyncapi: "3.0.0",
      info: { "x-event-namespace": "evt.ln.loan" },
      channels: {
        created: { address: "evt.ln.loan.created.v1", bindings: { kafka: { partitions: 6 } } },
        disbursed: { address: "evt.ln.loan.disbursed.v1" },
        dlq: { address: "evt.ln.loan.dlq.v1" },
        restructured: { address: "evt.ln.loan.restructured.v1" },
      },
    };
    fs.writeFileSync(path.join(dir, "svc-ln-loan-lifecycle.yaml"), YAML.stringify(spec));
    const errors = crossCheckAsyncApi(fixture(), dir);
    assert.ok(errors.some((e) => e.includes("evt.ln.loan.created.v1: partitions 3 in catalog, 6 in contract")), errors.join("\n"));
    assert.ok(errors.some((e) => e.includes("evt.ln.loan.payment-made.v1: no channel")), errors.join("\n"));
    assert.ok(errors.some((e) => e.includes("evt.ln.loan.restructured.v1: channel in svc-ln-loan-lifecycle.yaml but not in the catalog")));
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
  assert.ok(res.stdout.includes("--topic evt.ln.loan.created.v1 --partitions 1 --replication-factor 1"));
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
    fs.writeFileSync(file, "evt.ln.loan.created.v1\tevent\t3\t3\t2\tcompact\t604800000\t1048576\n");
    const compact = createTopics({ TOPICS_FILE: file });
    assert.equal(compact.status, 1);
    assert.match(compact.stderr, /cleanup.policy=delete/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
