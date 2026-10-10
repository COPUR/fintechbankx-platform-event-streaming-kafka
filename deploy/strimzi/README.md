# Strimzi Kafka (in-cluster, non-AWS and local Kubernetes)

Status: **Proposed**. Validated with `kustomize build` and `kubeconform -strict` against the Strimzi CRD schemas;
not applied to any cluster. AWS environments use Amazon MSK instead ([../msk/README.md](../msk/README.md)).

## What it creates

| File | Resources |
|---|---|
| [`namespace.yaml`](namespace.yaml) | Namespace `kafka` with the platform-contract labels |
| [`kafka-nodepools.yaml`](kafka-nodepools.yaml) | `KafkaNodePool` `controller` (3, KRaft controllers) and `broker` (3), spread one per zone and host |
| [`kafka.yaml`](kafka.yaml) | `Kafka` `fintechbankx`: KRaft, rack awareness on `topology.kubernetes.io/zone`, TLS listener 9093 with client-certificate auth, simple authorization, RF 3 / `min.insync.replicas` 2, `auto.create.topics.enable=false`, `unclean.leader.election.enable=false`, TLS 1.3, PDB `maxUnavailable: 1`, JMX Prometheus metrics, Kafka Exporter for `evt.*` topics and `cg.*` groups |
| [`generated/kafka-metrics-configmap.yaml`](generated/kafka-metrics-configmap.yaml) | JMX exporter rules, rendered from [`monitoring/jmx/kafka.yml`](../../monitoring/jmx/kafka.yml) |
| [`generated/kafka-topics.yaml`](generated/kafka-topics.yaml) | One `KafkaTopic` per catalog topic and DLQ |
| [`generated/kafka-users.yaml`](generated/kafka-users.yaml) | One `KafkaUser` per service: TLS auth, ACLs owner `Write` on its events, consumers `Read` on what they consume plus their `cg.<service-id>.` group prefix and `Write`/`Read` on the DLQ of their own namespace (consumer-owned, ADR-019); nobody else writes a DLQ |
| [`optional/cruise-control`](optional/cruise-control/kustomization.yaml) | Kustomize component: Cruise Control and a proposal-only `KafkaRebalance` |

The `generated/` files come from [`topics/catalog.yaml`](../../topics/catalog.yaml); edit the catalog, not them.

Pins: Strimzi operator **0.47.0**, Kafka **4.0.0** (`metadataVersion: 4.0-IV3`). Check the operator's supported
Kafka versions before moving either pin.

## Render and validate

```bash
kubectl kustomize deploy/strimzi > /tmp/strimzi.yaml
kubeconform -strict -summary -schema-location default \
  -schema-location 'https://raw.githubusercontent.com/datreeio/CRDs-catalog/main/{{.Group}}/{{.ResourceKind}}_{{.ResourceAPIVersion}}.json' \
  /tmp/strimzi.yaml
```

Install order on a cluster (by the owning squad, not by CI): Strimzi cluster operator 0.47.0 watching `kafka`, then
`kubectl apply -k deploy/strimzi`.

## Client access

- Bootstrap: `fintechbankx-kafka-bootstrap.kafka.svc.cluster.local:9093` (TLS).
- The User Operator writes each service's certificate to Secret `<service-id>` in namespace `kafka` (`user.crt`,
  `user.key`, plus the cluster CA in Secret `fintechbankx-cluster-ca-cert`, key `ca.crt`). Workloads run in their own
  namespaces, so the Secret has to be copied there; on shared clusters do it with an External Secrets
  `ClusterSecretStore` of the Kubernetes provider (owned by the platform team), locally with `kubectl`. See
  [the client guide](../../docs/guides/SERVICE_CLIENT_CONFIGURATION.md).
- The listener's NetworkPolicy admits only namespaces labelled `fintechbankx.io/context` in `lending`, `payments`,
  `customer`, `risk`, `compliance`, `open-finance`.

## Istio

The namespace carries `istio-injection=enabled` like every namespace in the platform contract, but the Strimzi pods
opt out (`sidecar.istio.io/inject: "false"`): brokers advertise per-pod addresses and terminate mutual TLS
themselves, which a sidecar would intercept. Client pods should exclude the Kafka port from sidecar capture
(`traffic.sidecar.istio.io/excludeOutboundPorts: "9093"`) so a mesh-wide `ISTIO_MUTUAL` DestinationRule cannot wrap
the Kafka TLS connection. This is a deviation from "everything in the mesh"; the mesh squad has to confirm it.

## Resilience notes

- Losing one zone leaves two in-sync replicas, so `acks=all` producers keep writing; losing two zones blocks writes
  (`NotEnoughReplicas`) rather than losing data. The service outbox absorbs the outage and relays when the brokers
  return (`outbox_pending_events` / `<ctx>.outbox.pending` gauges grow meanwhile).
- Drill evidence still needed (cell plan, Phase 3): broker pod kill under load, zone drain, controller quorum loss;
  record consumer lag, outbox backlog and producer error rate.
