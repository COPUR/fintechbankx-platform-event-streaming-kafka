# fintechbankx-platform-event-streaming-kafka

Bu repository, FinTechBankX DDD/EDA dönüşümünde **svc-evt-streaming** servis yetkinliğinin kaynak kodunu, kontratlarını ve operasyonel guardrail'lerini içerir.

## Sorumluluk ve Sahiplik
| Alan | Değer |
|---|---|
| Organizasyon Modeli | Spotify Model (Tribe/Squad) |
| Tribe | Platform and Reliability Tribe |
| Squad | Event Platform Squad |
| Repo Kümesi (Capability) | platform |
| Service ID | svc-evt-streaming |
| Bounded Context | event_streaming |
| Wave | 0 |
| Mimari Yaklaşım | DDD + Hexagonal + Event-Driven |

## What this repository provides (Status: Proposed)

The event-streaming platform for every FinTechBankX service. Platform only: no domain logic.

| Area | Where | What |
|---|---|---|
| Topic catalog | [topics/catalog.yaml](topics/catalog.yaml), [resolved table](topics/generated/TOPIC_CATALOG.md) | Single source of truth for `evt.*` topics (one per aggregate): owner (only producer), event types, partitions, retention, cleanup policy, DLQ, known consumers and the event types they handle, gaps |
| Generator / validator | [scripts/catalog](scripts/catalog/catalog.mjs) | Validates naming and producer namespace against the bootstrap manifest; renders Strimzi topics/users, the MSK topic list and per-service access; `npm test` fails on drift |
| In-cluster Kafka | [deploy/strimzi](deploy/strimzi/README.md) | Strimzi KRaft cluster (3 controllers, 3 brokers across zones), TLS + client certificates, ACLs, RF 3 / min ISR 2, metrics; optional Cruise Control |
| AWS | [deploy/msk](deploy/msk/README.md) | Using the terraform-modules `msk-cluster` and `msk-client-access` modules with the catalog output; IAM auth |
| Topic provisioning | [scripts/kafka/create-topics.sh](scripts/kafka/create-topics.sh) | Creates catalog topics on MSK or local Kafka (legacy topics behind `CREATE_LEGACY_TOPICS=true`) |
| Local | [deploy/local/docker-compose.yml](deploy/local/docker-compose.yml) | Single KRaft broker with the catalog topics, for laptops only |
| Client guide | [docs/guides/SERVICE_CLIENT_CONFIGURATION.md](docs/guides/SERVICE_CLIENT_CONFIGURATION.md) | MSK IAM / Strimzi TLS settings, producer and consumer defaults, envelope headers, DLQ handling |
| Metrics | [monitoring/jmx/kafka.yml](monitoring/jmx/kafka.yml) | Broker JMX exporter rules (Strimzi ConfigMap rendered from it) |

How a service consumes it:

1. Its aggregate topic `evt.<ctx>.<aggregate>.v<major>` and the event types published on it are declared in the
   catalog under its own namespace (`evt.<ctx>.<aggregate>`, from the bootstrap manifest), matching its AsyncAPI
   contract. Consumers are added with a code reference, a `cg.<service-id>.<purpose>.v<major>` group and the event
   types they handle.
2. AWS: its Terraform applies `msk-client-access` with its entry from
   [topics/generated/msk-client-access.json](topics/generated/msk-client-access.json); in-cluster: it mounts the
   certificate of its generated `KafkaUser`.
3. It configures its client as in the client guide; it never creates topics.

Topic scheme: one topic per aggregate, `evt.<ctx>.<aggregate>.v<major>`, keyed by `aggregateId`, with the event named
by the `eventType` header (ADR-019, owner decision 2026-10-08; options in
[the granularity proposal](docs/architecture/TOPIC_GRANULARITY_PROPOSAL.md)).

The Java module under `src/` is the extraction seed from `amanahfi-platform/event-streaming` (Spring Kafka
publisher library). It is not wired to the catalog and still declares its own `amanahfi.*` topics with
`TopicBuilder` beans (one with `min.insync.replicas=1`); treat it as legacy until the Event Platform Squad decides to
keep or remove it.

## Sorumluluk Sınırları
- Bu repo kendi bounded context domain modelinin tek yetkili sahibidir.
- Domain kuralları altyapıdan bağımsız tutulur; entegrasyonlar port/adapter katmanında yönetilir.
- API/Event kontratları geriye dönük uyumluluk kontrolleri ile korunur.
- Güvenlik guardrail'leri (mTLS, token doğrulama, idempotency, log hijyeni) CI/CD ile zorlanır.

## Kapsam
### In Scope
- event_streaming bağlamına ait uygulama kodu, testler ve otomasyon.
- Bu servise ait OpenAPI/AsyncAPI veya şema artefaktları.
- Bu servisin çalışma zamanı operasyonları (gözlemlenebilirlik, release, rollback).

### Out of Scope
- Diğer bounded context'lerin iş kuralları ve veri sahipliği.
- Paylaşımlı DB anti-pattern'i; cross-context doğrudan tablo erişimi.
- Platform dışı gizli bilgi/anahtar yönetimi (merkezi policy dışında local hardcode).

## Mühendislik Standartları
- **TDD öncelikli** geliştirme, birim test + entegrasyon testi.
- **Clean Architecture**: Domain katmanı framework bağımsız.
- **12-Factor** ve environment-driven configuration.
- **FAPI odaklı güvenlik** (OIDC/OAuth2, mTLS, DPoP gereksinimleri ilgili servislerde).
- **PII güvenliği**: loglarda maskeleme, secret'ların source/env içine yazılmaması.

## Branching ve Release Akışı
- Uzun ömürlü branch'ler: `main`, `dev`, `staging`, `local`.
- Feature branch kuralı: `codex/<kisa-aciklama>`.
- Release yaklaşımı: PR + required status checks + tag tabanlı sürümleme.

## Dokümantasyon ve Referanslar
- [Enterprise Architecture Hub](https://github.com/COPUR/fintechbankx-governance-architecture-enablement-enterprise-architecture)
- [Secure Microservices Architecture](https://github.com/COPUR/fintechbankx-governance-architecture-enablement-enterprise-architecture/blob/main/docs/architecture/overview/SECURE_MICROSERVICES_ARCHITECTURE.md)
- [Service Data Ownership Matrix](https://github.com/COPUR/fintechbankx-governance-architecture-enablement-enterprise-architecture/blob/main/docs/enterprisearchitecture/implementation-development/SERVICE_DATA_OWNERSHIP_MATRIX.md)
- [Service API Contracts Index](https://github.com/COPUR/fintechbankx-governance-architecture-enablement-enterprise-architecture/blob/main/docs/enterprisearchitecture/implementation-development/SERVICE_API_CONTRACTS_INDEX.md)
- [Transformation Plan](https://github.com/COPUR/fintechbankx-governance-architecture-enablement-enterprise-architecture/blob/main/docs/enterprisearchitecture/implementation-development/MICROSERVICES_TRANSFORMATION_PLAN.md)
- [Capability Map (PUML)](https://github.com/COPUR/fintechbankx-governance-architecture-enablement-enterprise-architecture/blob/main/docs/puml/service-mesh/enterprise-capability-map.puml)
- [Bu Repo Dokümantasyonu](./docs)

## Güvenlik ve Uyumluluk Notları
- Gerçek secret değerleri repo veya `.env` içinde tutulmaz.
- Secret üretim/rotasyon olayları merkezi log/SIEM'e taşınır.
- CI pipeline, anonimlik ve local-path sızıntısı kontrollerini bloklayıcı olarak çalıştırır.

## Katkı
- Katkı süreci için `CONTRIBUTING.md` ve squad runbook'ları izlenmelidir.
- PR'larda mimari kararlar ADR veya backlog referansı ile ilişkilendirilmelidir.

<!-- cell-architecture-start -->
## Cell-Based Architecture

This repository participates in the FinTechBankX cell-based resilience program.

- Plan: docs/architecture/CELL_BASED_ARCHITECTURE_IMPLEMENTATION_PLAN.md
- Backlog: docs/project-management/CELL_ARCHITECTURE_BACKLOG_BOARD.md
<!-- cell-architecture-end -->
