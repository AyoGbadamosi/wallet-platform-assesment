# Design Notes

## 1. What issues did you find?

- **[Fixed] Negative Balances (Concurrency):** `deposit`/`withdraw`/`transfer` allowed negative balances because concurrency control wasn't enforced. **Found via:** The failing `concurrency.integration-spec.ts` test.
- **[Fixed] Missing Idempotency Checks:** The transfer, withdraw, and deposit features lacked idempotency checks, allowing duplicate side-effects on client retry. **Found via:** The failing unit tests for transfers, and code reading for deposits/withdrawals.
- **[Fixed] Lost Events & Missing Outbox:** Transfer events were published directly after committing the database transaction, meaning if the message broker was down, the transfer hung forever. **Found via:** Code reading and architecture review.
- **[Fixed] Message Consumer Duplication:** Transfer consumer did not ensure idempotency, allowing double-crediting if RabbitMQ delivered the message twice. **Found via:** Code reading.
- **[Fixed] Cache Inconsistencies:** Wallet balances weren't deleted from Redis after mutations, serving stale data. **Found via:** Code reading.
- **[Fixed] N+1 Queries:** `getDashboard` and `computeBalanceFromLedger` triggered massive application-side query loops instead of DB aggregations. **Found via:** Code reading.
- **[Fixed] Stuck Transfers:** No mechanism existed to refund transfers that crashed before consumer processing. **Found via:** Code reading and architecture review.
- **[Fixed] Missing Indexes:** Read endpoints lacked indexes, causing slow collection scans. **Found via:** Code reading the Mongoose schemas.
- **[Fixed] Memory Leak in Background Workers:** `WalletEventsWorker` bound new `EventEmitter` listeners in a tight `setInterval` loop without cleanup. **Found via:** Code reading.
- **[Fixed] Lack of Distributed Tracing:** Logs across HTTP requests, background tasks, and consumers were completely disconnected. **Found via:** Code reading.
- **[Fixed] Swallowed RabbitMQ Errors & Missing DLQ:** `TransferEventsConsumer` explicitly ACKed messages on fatal errors, dropping them permanently without a Dead Letter Queue. **Found via:** Code reading.
- **[Fixed] Integration Test Flakiness (Async Handles):** Tests crashed randomly because background workers continued polling while Jest tore down the database. **Found via:** Reproducing intermittent failures locally.
- **[Fixed] Accidental Integration Test DB Wipe:** `test-utils.ts` allowed injected environment variables to wipe the local development DB. **Found via:** Reproducing locally.
- **[Not Fixed] Missing Circuit Breaker:** The system lacks a circuit breaker around upstream calls. **Found via:** README requirements.
- **[Not Fixed] Prometheus Metrics:** The system lacks a `/metrics` endpoint for standard Prometheus scraping. **Found via:** README requirements.

## 2. What did you prioritize, and why?

I prioritized **data consistency and financial integrity** (negative balances, missing indexes, consumer idempotency, and Outbox pattern implementation). In a wallet platform, a slightly slow system is acceptable, but one that loses or duplicates money is fatal.
Second priority was **system health** (memory leaks, consumer crashes, DLQ, and test teardown issues) to ensure stability under load.
Lastly, I tackled **observability** (AsyncLocalStorage distributed tracing) so we can confidently monitor these asynchronous systems in production.

## 3. How did you handle concurrency?

The primary race condition existed in the Transfer/Withdraw flow. I opted for **Pessimistic Locking** during complex transfers via Mongoose's `session.withTransaction()` and atomic queries (`findOneAndUpdate` with `$inc` and `$gte` bounds).
This guarantees that if two requests attempt to drain the same wallet, the second one will wait for the first transaction's lock to release, then evaluate the updated balance. I verified this via the concurrent test suite (`concurrency.integration-spec.ts`) and by resolving background async handlers that caused race conditions during test teardown.

## 4. How did you ensure data consistency?

To ensure consistency across MongoDB, Redis, and RabbitMQ, I implemented the **Transactional Outbox Pattern**:

1. When a transfer initiates, the wallet debit and the `OutboxEvent` are saved in the same atomic MongoDB transaction.
2. Redis balances are actively invalidated using `redisService.invalidateBalance()` inside the transaction boundary.
3. Background workers resolve the state asynchronously. If the Outbox relay publishes an event and the consumer processes it, it ensures idempotency by checking if the transfer is still `PENDING` before crediting.
4. If a consumer crashes, it NACKs the message to a Dead Letter Queue (DLQ). If a transfer hangs entirely, the `PendingTransferWorker` sweeps and refunds it automatically.

## 5. Trade-offs

I chose pessimistic locking with `withTransaction` over pure Optimistic Concurrency Control (OCC via versioning) for transfers. While OCC can yield higher throughput in low-contention environments, pessimistic locking provides simpler, stronger guarantees for financial transfers and avoids forcing the client application to implement complex retry logic.
I also chose a straightforward cron-based Outbox relay rather than tailing MongoDB's oplog (e.g., via Debezium/Kafka) because it was much simpler, cheaper, and perfectly adequate for the current scale.

## 6. Remaining technical debt

- The Outbox relay worker polls the database every 2 seconds. As data scales, querying an indexed `published: false` status is fine, but it might eventually cause unnecessary database load compared to an event-driven approach.
- The `PendingTransferWorker` refunds stuck transfers automatically. We mitigated race conditions using atomic state transition checks (`findOneAndUpdate({ status: PENDING })`), but having a cron job aggressively refund transfers that are simply stuck in a congested queue could still lead to edge cases under extreme backpressure.

## 7. What would you improve with another day?

I would implement **exponential backoff retries** in the message queue for transient failures before dead-lettering messages. I would implement **MongoDB Oplog tailing (Change Streams)** for the Outbox Pattern to replace the polling-based worker. I would also write a dedicated admin endpoint to easily inspect and **replay messages from the Dead Letter Queue (DLQ)**. Finally, I would rewrite the integration test suite using **Testcontainers** to spin up ephemeral RabbitMQ and Redis instances rather than relying on shared local infrastructure, which inherently causes teardown complexities.

## 8. Assumptions

- I assumed that all wallets are held in a single, horizontally scaled MongoDB cluster that supports replica sets (which is required for multi-document transactions).
- I assumed RabbitMQ could drop messages or crash, necessitating the strict NACK/DLQ implementation.
- I assumed that the client-provided `idempotencyKey` (for transfers) and `reference` (for deposits/withdrawals) are completely unique per discrete intended operation, allowing us to enforce strict unique indexes on them to prevent duplicate transactions.

## 9. Bonus Tasks Implemented

While features like the Outbox Pattern, Consumer-side Deduplication, and Distributed Tracing were listed as bonus tasks, they were essential to solving the core production issues. In addition to those, the following pure bonus tasks were successfully completed:

- **Dead Letter Queue (DLQ)**: Configured a DLX and DLQ in RabbitMQ and implemented strict `NACK` logic for poisoned messages.
- **Rate Limiting**: Integrated `@nestjs/throttler` with a Redis backend (`@nest-lab/throttler-storage-redis`) to share rate limits across all servers.
- **Wallet Reconciliation Endpoint**: Built `GET /wallets/:id/reconcile` to mathematically verify the cached wallet balance against a dynamic aggregation of all historical ledger entries.
- **Audit Endpoint**: Implemented `GET /wallets/:id/audit` to provide a strict, paginated, descending chronological history of all ledger entries for compliance and auditing.
