# Amazon MSK (AWS environments)

Status: **Proposed**. Nothing here has been applied. On AWS the event platform is Amazon MSK (platform contract:
Kafka 3.6+, TLS in transit, IAM client auth over `SASL_SSL` / `AWS_MSK_IAM` with each service's IRSA role). The
in-cluster alternative for non-AWS clusters is [Strimzi](../strimzi/README.md).

The cluster and the per-service IAM policies come from two modules in
`fintechbankx-platform-delivery-iac-terraform-modules`: `msk-cluster` and `msk-client-access`. Their interfaces are
being written in a parallel change and are not released; the snippets below match the in-progress inputs seen on
2026-10-08 and must be re-checked against the released module before use.

## 1. Cluster (`msk-cluster`, owned by the Event Platform Squad)

```hcl
module "msk" {
  source = "git::https://github.com/COPUR/fintechbankx-platform-delivery-iac-terraform-modules.git//modules/msk-cluster?ref=main"

  cluster_name              = "fintechbankx-${var.environment}-events"
  kafka_version             = "3.6.0"               # contract floor; pick the newest MSK-supported version
  number_of_broker_nodes    = 3                     # one per AZ; RF 3 / min.insync.replicas 2
  broker_instance_type      = "kafka.m7g.large"
  vpc_id                    = var.vpc_id
  subnet_ids                = var.private_subnet_ids # three subnets in three AZs
  client_security_group_ids = [var.eks_node_security_group_id]
  enhanced_monitoring       = "PER_TOPIC_PER_PARTITION"
  enable_open_monitoring    = true                  # Prometheus exporters for the observability stack
  # kms_key_arn = null creates a dedicated CMK for encryption at rest.
  # The module already enforces auto.create.topics.enable=false, RF 3,
  # min.insync.replicas 2 and no unclean leader election. Align the rest
  # with server.properties in this directory:
  server_properties_overrides = {
    "num.partitions"                           = "3"
    "offsets.topic.replication.factor"         = "3"
    "transaction.state.log.replication.factor" = "3"
    "transaction.state.log.min.isr"            = "2"
    "replica.selector.class"                   = "org.apache.kafka.common.replica.RackAwareReplicaSelector"
  }
}
```

[`server.properties`](server.properties) lists the broker settings this repository relies on (same values as the
Strimzi cluster). Topic auto-creation is off, so topics exist only if `create-topics.sh` created them from the catalog.

## 2. Topics (`scripts/kafka/create-topics.sh`)

MSK has no Kubernetes topic operator and the AWS provider manages no topics, so topics are created by the script
from [`topics/generated/topics.tsv`](../../topics/generated/topics.tsv) (rendered from the catalog). Run it as a
one-off Job or pipeline step whose IRSA role has only `kafka-cluster:Connect`, `kafka-cluster:DescribeTopic` and
`kafka-cluster:CreateTopic` on `topic/<cluster-name>/<cluster-uuid>/evt.*`:

```bash
KAFKA_BROKER="<bootstrap_brokers_sasl_iam output>" \
KAFKA_COMMAND_CONFIG=client-iam.properties \
  scripts/kafka/create-topics.sh
```

[`client-iam.properties.example`](client-iam.properties.example) is the client configuration; the Kafka CLI needs the
`aws-msk-iam-auth` jar on its classpath. `--if-not-exists` leaves existing topics untouched; partition increases
and config changes are separate reviewed changes.

## 3. Per-service access (`msk-client-access`, applied from each service repository)

[`topics/generated/msk-client-access.json`](../../topics/generated/msk-client-access.json) lists, per service id, the
IRSA subject (`kubernetes_namespace`, `service_account`) and:

| Field | Meaning | IAM actions the module should grant |
|---|---|---|
| `produce_topics` | Exact topics the service writes (its events and, if it consumes, its own namespace DLQ) | `DescribeTopic`, `WriteData` on each topic ARN; `WriteDataIdempotently` on the cluster (idempotent producer) |
| `produce_topic_prefixes` | The namespaces it owns, `evt.<ctx>.<aggregate>.` | same, as `topic/.../<prefix>*` |
| `consume_topics` | Exact topics it reads, including its own DLQ (redrive) | `DescribeTopic`, `ReadData` |
| `consumer_groups` | Declared groups `cg.<service-id>.<purpose>.v<major>` | `DescribeGroup`, `AlterGroup` on `group/.../<group>` |
| `consumer_group_prefixes` | `cg.<service-id>.` (used for Strimzi ACLs) | optional prefix form of the above |

Every service also needs `kafka-cluster:Connect` on the cluster ARN. No service gets `CreateTopic`, `DeleteTopic`
or `AlterTopic`.

Example in a service repository's `deploy/terraform` (copy the service's entry from a tagged version of this
repository into `kafka-access.json` so the plan does not depend on a network fetch):

```hcl
locals {
  kafka_access = jsondecode(file("${path.module}/kafka-access.json"))
}

module "kafka_access" {
  source = "git::https://github.com/COPUR/fintechbankx-platform-delivery-iac-terraform-modules.git//modules/msk-client-access?ref=main"

  service_id             = local.service_id
  policy_name            = "${local.name}-msk"
  cluster_arn            = var.msk_cluster_arn
  produce_topic_prefixes = local.kafka_access.produce_topic_prefixes
  consume_topics         = local.kafka_access.consume_topics
  consumer_groups        = local.kafka_access.consumer_groups
  attach_to_role_names   = [aws_iam_role.workload.name]
  tags                   = local.tags
}
```

DLQs are consumer-owned (ADR-019): a service only ever writes the DLQ of its own namespace, which its
`produce_topic_prefixes` entry already covers. A consumer-only service (for example `svc-of-personal-financial-data`)
gets its namespace prefix for that reason even though it publishes no events.

## 4. Service runtime settings

See [the client guide](../../docs/guides/SERVICE_CLIENT_CONFIGURATION.md): `KAFKA_BOOTSTRAP_SERVERS` = the
`bootstrap_brokers_sasl_iam` output (port 9098), `KAFKA_SECURITY_PROTOCOL=SASL_SSL`, SASL mechanism `AWS_MSK_IAM`.
