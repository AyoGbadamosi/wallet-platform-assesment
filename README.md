# Wallet Platform

A NestJS + MongoDB + Redis + RabbitMQ wallet ledger service, developed as a
take-home engineering assessment. This is not a toy CRUD app - it's a
snapshot of a real service, warts and all, the way you'd inherit it on your
first week on a team.

## Project Overview

The Wallet Platform lets users hold a wallet, deposit and withdraw funds, and
transfer money to other wallets. Every financial operation is recorded as a
double-entry ledger movement. MongoDB is the source of truth; Redis caches
wallet balances for fast reads; RabbitMQ carries domain events for
asynchronous settlement between the two sides of a transfer.

The platform has been running in production for a while. It mostly works.
Engineering has also been getting pages about it.

## Business Context

Think of this as the ledger service behind a mobile money / merchant payments
platform: wallets belong to users or merchants, money moves in
(`deposit`), out (`withdraw`), and between wallets (`transfer`), and every
movement needs to be auditable after the fact. The original engineer who
built the transfer feature left the company partway through - the endpoint
exists, it does *something*, but it was never finished, and nobody has gone
back to close it out.

## Architecture Overview

See [ARCHITECTURE.md](./ARCHITECTURE.md) for a full description of the
current system: request pipeline, module boundaries, data model, and how the
API, MongoDB, Redis, and RabbitMQ fit together.

## ASCII Architecture Diagram

```
 Client ──HTTPS──▶ NestJS API ──▶ MongoDB (source of truth)
                       │  │
                       │  └──▶ Redis (wallet balance cache)
                       │
                       └──▶ RabbitMQ ──▶ Transfer event consumer
                                              │
                                              └──▶ MongoDB
```

## Technology Stack

- **Runtime**: Node.js 20, TypeScript
- **Framework**: NestJS 10
- **Database**: MongoDB (Mongoose), used as a single-node replica set so
  multi-document transactions work
- **Cache**: Redis (ioredis)
- **Messaging**: RabbitMQ (amqp-connection-manager / amqplib)
- **Auth**: JWT (passport-jwt)
- **Testing**: Jest, Supertest
- **Tooling**: pnpm, ESLint, Prettier, Docker Compose

## Prerequisites

- Node.js 20+
- pnpm (`corepack enable` will make it available)
- Docker + Docker Compose (for MongoDB, Redis, RabbitMQ)

## Setup Instructions

```bash
corepack enable
pnpm install
cp .env.example .env
```

Wallet and transfer writes use MongoDB multi-document transactions, which
**require Mongo to be running as a replica set** (even a single-node one) -
a plain standalone `mongod` will reject them. The bundled `docker-compose.yml`
handles this for you (see below); if you're running Mongo yourself, start it
with `--replSet rs0` and run `rs.initiate()` once.

```bash
docker-compose up -d mongo redis rabbitmq
pnpm run seed        # optional: populates 20 wallets, ~500 transactions, and
                      # a handful of transfers in various states
pnpm run start:dev
```

The API listens on `http://localhost:3000` with unprefixed routes, e.g.
`http://localhost:3000/wallets`. Swagger docs are available at
`http://localhost:3000/docs`.

If you ran the seed script, you can log in with:

```
POST /auth/login
{ "email": "demo@wallet-platform.test", "password": "Password123!" }
```

## Docker Instructions

```bash
docker-compose up -d            # mongo, redis, rabbitmq, and the API itself
docker-compose up -d mongo redis rabbitmq   # just the infra, for local `pnpm run start:dev`
docker-compose logs -f api
docker-compose down             # stop everything (add -v to also drop volumes)
```

## Environment Variables

See [.env.example](./.env.example) for the full list with defaults. The
notable one: `MONGODB_URI` must include `replicaSet=rs0` (or point at
whatever replica set you're actually running) for the reasons above.

## Folder Structure

```
wallet-platform/
├── src/
│   ├── auth/            # login, JWT guard/strategy
│   ├── wallets/          # wallet CRUD, deposit, withdraw, transfer, dashboard
│   ├── transactions/      # transaction history
│   ├── ledger/            # double-entry ledger
│   ├── outbox/            # transactional outbox
│   ├── queue/              # RabbitMQ publisher + consumer
│   ├── workers/            # background interval workers
│   ├── redis/              # balance cache
│   ├── health/             # liveness endpoint
│   ├── config/             # typed config loader
│   └── common/             # filters, interceptors, middleware, decorators
├── scripts/seed/          # seed data generator
├── test/
│   ├── integration/        # tests against real Mongo/Redis/RabbitMQ
│   └── hidden/             # see note below
├── docker-compose.yml
├── Dockerfile
├── DESIGN.md              # fill this in as part of your submission
└── ARCHITECTURE.md        # describes the current system
```

`test/hidden/` is used internally by eTranzact during evaluation. It is not
wired into `package.json` and you are not expected to run it, but its
existence is not a secret - assume the platform's behavior under
concurrency, retries, and failure will be checked more thoroughly than what
you can see locally.

## Running the Application

```bash
pnpm run start:dev     # watch mode
pnpm run build && pnpm run start:prod
```

## Running Visible Tests

```bash
pnpm test               # unit tests (src/**/*.spec.ts)
pnpm run test:integration   # requires mongo/redis/rabbitmq running (docker-compose up -d)
pnpm run test:e2e        # basic end-to-end smoke test
pnpm run lint
```

Out of the box, most unit tests pass. A few fail - that's expected, not a
setup problem on your end. They're pointing at the parts of the system that
are incomplete or broken.

## Assessment Objectives

This assessment evaluates:

- Problem solving and debugging in an unfamiliar codebase
- Software architecture and API design judgement
- Backend engineering fundamentals (NestJS, TypeScript)
- MongoDB modeling, indexing, and transaction usage
- Data consistency under concurrency and partial failure
- Event-driven architecture (outbox, message delivery, idempotency)
- Testing strategy and quality
- Performance awareness
- Written communication (see `DESIGN.md`)

You are **not** expected to fix everything. Prioritize, and explain your
prioritization.

## Submission Guidelines

1. Work in a fork or a private clone - please don't open a public PR against
   this repository.
2. Commit as you go; we care about your process, not just the final diff.
3. Fill in `DESIGN.md` with your findings, priorities, and trade-offs.
4. Send us your repository link (or a patch/bundle) along with `DESIGN.md`.
5. Include instructions for anything you changed about setup/running the
   project, if applicable.

## Expected Time

Budget **5-6 hours**. This is intentionally more work than that budget
comfortably allows - we'd rather see good prioritization on a subset of
issues than a rushed pass at all of them.

## Evaluation Criteria

Roughly, in order of weight:

1. Correctness of the fixes you attempt (do they actually hold up under
   concurrency and retries, not just in the happy path?)
2. Quality of your engineering judgement and prioritization (see `DESIGN.md`)
3. Code quality and testing of what you changed
4. Communication - can we understand *why* you did what you did?

Hidden tests (`test/hidden`, not visible to you) make up roughly 30% of the
overall score and probe the same categories of issue more aggressively than
the visible test suite does.

## Known Production Issues

Engineering has flagged the following as active concerns. We won't tell you
where they live or how to fix them - finding them is part of the exercise.

- Wallet balances have occasionally gone negative under load.
- The transfer feature was left partially implemented and needs to be
  completed.
- Some clients retry requests on timeout; this has caused duplicate side
  effects at least once.
- There's a gap between when we publish domain events and when the
  underlying database work is guaranteed to have persisted.
- Message consumers don't always behave correctly when a message is
  delivered more than once.
- Customers have reported seeing balances that don't match what the mobile
  app shows immediately after a transaction.
- At least one read endpoint is doing more database work than it needs to.
- Some transfers appear to get stuck and never resolve.
- There's a `version` field on the wallet model. It's not clear it does
  anything right now.
- Some queries against transaction/ledger history are slower than expected
  as data volume grows.
- One background worker's memory footprint grows steadily over time.
- Production incidents involving this service have been harder to
  investigate than they should be, because logs are difficult to correlate
  across a single request or event.

## Bonus Tasks

Not required, but if you have time and want to demonstrate more:

- Outbox pattern (note: some of this already exists - look closely at
  whether it's used consistently)
- Inbox pattern / consumer-side deduplication
- Distributed tracing
- Dead letter queue for the transfer consumer
- Prometheus metrics
- A wallet reconciliation endpoint
- Optimistic locking using the existing `version` field
- An audit endpoint
- Circuit breaker around upstream calls
- Rate limiting

## FAQ

**Do I need to fix every issue?**
No. Pick what you think matters most, fix it well, and explain your
reasoning for what you left out in `DESIGN.md`.

**Can I change the data model?**
Yes, as long as you explain the migration/compatibility implications in
`DESIGN.md`.

**Can I add new dependencies?**
Yes, within reason - justify anything non-obvious.

**Should I write tests for my changes?**
Yes. We want to see how you verify your own fixes, especially anything
concurrency-related.

**What if I run out of time?**
Stop, and use the remaining time to write up what you'd do next in
`DESIGN.md`. A clear-eyed list of what's left is worth more than a rushed,
undocumented attempt at everything.
