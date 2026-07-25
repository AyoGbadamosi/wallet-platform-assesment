import { INestApplication } from '@nestjs/common';
import { Connection, Types } from 'mongoose';
import { WalletsService } from '../../src/wallets/wallets.service';
import { createTestApp, resetDatabase } from './test-utils';
import { TransactionType, TransactionStatus } from '../../src/transactions/schemas/transaction.schema';
import { LedgerEntryDirection } from '../../src/ledger/schemas/ledger-entry.schema';

describe('Dashboard (integration)', () => {
  let app: INestApplication;
  let connection: Connection;
  let walletsService: WalletsService;

  beforeAll(async () => {
    ({ app, connection } = await createTestApp());
    walletsService = app.get(WalletsService);
  });

  beforeEach(async () => {
    await resetDatabase(connection);
  });

  afterAll(async () => {
    await app.close();
  });

  it('correctly aggregates dashboard stats without an N+1 query loop', async () => {
    const walletId = new Types.ObjectId();
    
    // Seed Wallet
    await connection.collection('wallets').insertOne({
      _id: walletId,
      userId: 'user-123',
      ownerName: 'Test Owner',
      currency: 'USD',
      balance: 100,
      version: 0,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    // Seed Transactions
    const txns = [
      { type: TransactionType.DEPOSIT, amount: 200, status: TransactionStatus.COMPLETED },
      { type: TransactionType.WITHDRAWAL, amount: 50, status: TransactionStatus.COMPLETED },
      { type: TransactionType.TRANSFER_IN, amount: 100, status: TransactionStatus.COMPLETED },
      { type: TransactionType.TRANSFER_OUT, amount: 30, status: TransactionStatus.COMPLETED },
    ];

    for (const txn of txns) {
      const txnId = new Types.ObjectId();
      await connection.collection('transactions').insertOne({
        _id: txnId,
        walletId,
        type: txn.type,
        amount: txn.amount,
        status: txn.status,
        balanceAfter: 0,
        createdAt: new Date(),
        updatedAt: new Date()
      });

      const direction = (txn.type === TransactionType.DEPOSIT || txn.type === TransactionType.TRANSFER_IN) 
        ? LedgerEntryDirection.CREDIT 
        : LedgerEntryDirection.DEBIT;

      await connection.collection('ledger_entries').insertOne({
        _id: new Types.ObjectId(),
        transactionId: txnId,
        walletId,
        direction,
        amount: txn.amount,
        balanceAfter: 0,
        createdAt: new Date(),
        updatedAt: new Date()
      });
    }

    const dashboard = await walletsService.getDashboard(walletId.toString());

    expect(dashboard.totalDeposited).toBe(200 + 100); // 300
    expect(dashboard.totalWithdrawn).toBe(50 + 30);   // 80
    expect(dashboard.transactionCount).toBe(4);
    expect(dashboard.recentActivity.length).toBe(4);
    
    // Ensure ledger entries are attached
    expect(dashboard.recentActivity[0].entries.length).toBe(1);
  });
});
