import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Types } from 'mongoose';
import { LedgerService } from '../ledger/ledger.service';
import { Transaction, TransactionType } from '../transactions/schemas/transaction.schema';
import { Transfer, TransferStatus } from '../wallets/schemas/transfer.schema';
import { Wallet } from '../wallets/schemas/wallet.schema';
import { RedisService } from '../redis/redis.service';
import { RabbitMQService } from './rabbitmq.service';
import { TransferEventsConsumer } from './transfer-events.consumer';

describe('TransferEventsConsumer', () => {
  let consumer: TransferEventsConsumer;
  let transferModel: any;
  let walletModel: any;
  let transactionModel: any;
  let ledgerService: any;
  let redisService: any;

  const mockSession = {
    withTransaction: jest.fn(async (fn: () => Promise<unknown>) => fn()),
    endSession: jest.fn(),
  };

  beforeEach(async () => {
    transferModel = { findOneAndUpdate: jest.fn() };
    walletModel = { findOneAndUpdate: jest.fn() };
    transactionModel = { create: jest.fn() };
    ledgerService = { recordCredit: jest.fn() };
    redisService = { invalidateBalance: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransferEventsConsumer,
        {
          provide: RabbitMQService,
          useValue: { getChannelWrapper: jest.fn(), getTransferQueue: jest.fn() },
        },
        {
          provide: getConnectionToken(),
          useValue: { 
            startSession: jest.fn().mockResolvedValue(mockSession),
            readyState: 1
          },
        },
        { provide: getModelToken(Transfer.name), useValue: transferModel },
        { provide: getModelToken(Wallet.name), useValue: walletModel },
        { provide: getModelToken(Transaction.name), useValue: transactionModel },
        { provide: LedgerService, useValue: ledgerService },
        { provide: RedisService, useValue: redisService },
      ],
    }).compile();

    consumer = module.get(TransferEventsConsumer);
  });

  afterEach(() => jest.clearAllMocks());

  it('credits the destination wallet and marks the transfer completed', async () => {
    const transfer = {
      _id: new Types.ObjectId(),
      id: 'transfer-1',
      fromWalletId: 'wallet-1',
    };
    const toWallet = { _id: new Types.ObjectId(), id: 'wallet-2', balance: 125 };
    transferModel.findOneAndUpdate.mockResolvedValue(transfer);
    walletModel.findOneAndUpdate.mockResolvedValue(toWallet);
    const creditTransaction = { _id: new Types.ObjectId() };
    transactionModel.create.mockResolvedValue([creditTransaction]);

    await (consumer as any).completeTransfer({
      transferId: transfer._id.toString(),
      fromWalletId: 'wallet-1',
      toWalletId: toWallet._id.toString(),
      amount: 25,
    });

    expect(transferModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: transfer._id.toString(), status: TransferStatus.PENDING },
      { status: TransferStatus.COMPLETED },
      { new: true, session: mockSession },
    );
    expect(walletModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: toWallet._id.toString() },
      { $inc: { balance: 25, version: 1 } },
      { new: true, session: mockSession },
    );
    expect(transactionModel.create).toHaveBeenCalledWith(
      [
        expect.objectContaining({ type: TransactionType.TRANSFER_IN, amount: 25, balanceAfter: 125 }),
      ],
      { session: mockSession },
    );
    expect(ledgerService.recordCredit).toHaveBeenCalledWith(
      toWallet._id,
      creditTransaction._id,
      25,
      125,
      mockSession,
    );
    expect(redisService.invalidateBalance).toHaveBeenCalledWith(toWallet.id);
  });

  it('skips processing when the transfer is not found or no longer PENDING', async () => {
    transferModel.findOneAndUpdate.mockResolvedValue(null);

    await (consumer as any).completeTransfer({
      transferId: 'missing-or-completed',
      fromWalletId: 'wallet-1',
      toWalletId: 'wallet-2',
      amount: 25,
    });

    expect(walletModel.findOneAndUpdate).not.toHaveBeenCalled();
    expect(transactionModel.create).not.toHaveBeenCalled();
  });
});
