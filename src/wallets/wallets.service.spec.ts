import { BadRequestException, NotFoundException } from '@nestjs/common';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { Types } from 'mongoose';
import { LedgerService } from '../ledger/ledger.service';
import { LedgerEntry } from '../ledger/schemas/ledger-entry.schema';
import { OutboxService } from '../outbox/outbox.service';
import { RabbitMQService } from '../queue/rabbitmq.service';
import { RedisService } from '../redis/redis.service';
import { Transaction, TransactionType } from '../transactions/schemas/transaction.schema';
import { TransactionsService } from '../transactions/transactions.service';
import { Transfer } from './schemas/transfer.schema';
import { Wallet } from './schemas/wallet.schema';
import { WalletsService } from './wallets.service';

describe('WalletsService', () => {
  let service: WalletsService;
  let walletModel: any;
  let transferModel: any;
  let transactionModel: any;
  let ledgerEntryModel: any;
  let transactionsService: any;
  let ledgerService: any;
  let outboxService: any;
  let rabbitMQService: any;
  let redisService: any;

  const mockSession = {
    withTransaction: jest.fn(async (fn: () => Promise<unknown>) => fn()),
    endSession: jest.fn(),
  };

  beforeEach(async () => {
    walletModel = {
      create: jest.fn(),
      findById: jest.fn(),
      findByIdAndUpdate: jest.fn(),
      findOneAndUpdate: jest.fn(),
    };
    transferModel = {
      create: jest.fn(),
      findOne: jest.fn(),
      findOneAndUpdate: jest.fn(),
    };
    transactionModel = {
      create: jest.fn(),
      find: jest.fn(),
    };
    ledgerEntryModel = {
      find: jest.fn(),
    };
    transactionsService = { create: jest.fn() };
    ledgerService = { recordCredit: jest.fn(), recordDebit: jest.fn() };
    outboxService = { enqueue: jest.fn() };
    rabbitMQService = { publish: jest.fn() };
    redisService = {
      getCachedBalance: jest.fn(),
      setCachedBalance: jest.fn(),
      invalidateBalance: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalletsService,
        {
          provide: getConnectionToken(),
          useValue: { startSession: jest.fn().mockResolvedValue(mockSession) },
        },
        { provide: getModelToken(Wallet.name), useValue: walletModel },
        { provide: getModelToken(Transfer.name), useValue: transferModel },
        { provide: getModelToken(Transaction.name), useValue: transactionModel },
        { provide: getModelToken(LedgerEntry.name), useValue: ledgerEntryModel },
        { provide: TransactionsService, useValue: transactionsService },
        { provide: LedgerService, useValue: ledgerService },
        { provide: OutboxService, useValue: outboxService },
        { provide: RabbitMQService, useValue: rabbitMQService },
        { provide: RedisService, useValue: redisService },
      ],
    }).compile();

    service = module.get(WalletsService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('createWallet', () => {
    it('creates a wallet with a zero opening balance and enqueues a wallet.created event', async () => {
      const created = {
        _id: new Types.ObjectId(),
        userId: 'user-1',
        ownerName: 'Ama Owusu',
        balance: 0,
      };
      walletModel.create.mockResolvedValue([created]);

      const result = await service.createWallet({ userId: 'user-1', ownerName: 'Ama Owusu' });

      expect(walletModel.create).toHaveBeenCalledWith(
        [expect.objectContaining({ userId: 'user-1', balance: 0 })],
        expect.objectContaining({ session: mockSession }),
      );
      expect(outboxService.enqueue).toHaveBeenCalledWith(
        'wallet.created',
        expect.objectContaining({ walletId: created._id.toString() }),
        mockSession,
      );
      expect(result).toBe(created);
    });
  });

  describe('getWallet', () => {
    it('seeds the cache from Mongo on a cache miss', async () => {
      const wallet = {
        id: 'w1',
        _id: 'w1',
        balance: 250,
        toObject: () => ({ id: 'w1', balance: 250 }),
      };
      walletModel.findById.mockResolvedValue(wallet);
      redisService.getCachedBalance.mockResolvedValue(null);

      const result = await service.getWallet('w1');

      expect(redisService.setCachedBalance).toHaveBeenCalledWith('w1', 250);
      expect(result).toBe(wallet);
    });

    it('returns the cached balance instead of re-reading Mongo on a cache hit', async () => {
      const wallet = {
        id: 'w1',
        _id: 'w1',
        balance: 250,
        toObject: () => ({ id: 'w1', balance: 250 }),
      };
      walletModel.findById.mockResolvedValue(wallet);
      redisService.getCachedBalance.mockResolvedValue(99);

      const result = await service.getWallet('w1');

      expect(redisService.setCachedBalance).not.toHaveBeenCalled();
      expect(result).toEqual(expect.objectContaining({ balance: 99 }));
    });

    it('throws NotFoundException when the wallet does not exist', async () => {
      walletModel.findById.mockResolvedValue(null);

      await expect(service.getWallet('missing-id')).rejects.toThrow(NotFoundException);
    });
  });

  describe('deposit', () => {
    it('increments the balance atomically and records a ledger credit', async () => {
      const walletId = new Types.ObjectId().toString();
      const updatedWallet = { id: walletId, _id: walletId, balance: 150 };
      walletModel.findByIdAndUpdate.mockResolvedValue(updatedWallet);
      const transaction = { _id: new Types.ObjectId() };
      transactionsService.create.mockResolvedValue(transaction);

      const result = await service.deposit(walletId, { amount: 50 });

      expect(walletModel.findByIdAndUpdate).toHaveBeenCalledWith(
        walletId,
        { $inc: { balance: 50, version: 1 } },
        { new: true },
      );
      expect(transactionsService.create).toHaveBeenCalledWith(
        expect.objectContaining({ type: TransactionType.DEPOSIT, amount: 50 }),
      );
      expect(ledgerService.recordCredit).toHaveBeenCalledWith(
        updatedWallet._id,
        transaction._id,
        50,
        150,
      );
      expect(result).toBe(updatedWallet);
    });

    it('throws NotFoundException when the wallet does not exist', async () => {
      walletModel.findByIdAndUpdate.mockResolvedValue(null);

      await expect(service.deposit('missing-id', { amount: 10 })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('withdraw', () => {
    it('debits the wallet when the balance is sufficient', async () => {
      const wallet = { id: 'w1', _id: 'w1', balance: 60 };
      walletModel.findOneAndUpdate.mockResolvedValue(wallet);
      const transaction = { _id: new Types.ObjectId() };
      transactionsService.create.mockResolvedValue(transaction);

      const result = await service.withdraw('w1', { amount: 40 });

      expect(walletModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'w1', balance: { $gte: 40 } },
        { $inc: { balance: -40, version: 1 } },
        { new: true },
      );
      expect(ledgerService.recordDebit).toHaveBeenCalledWith(wallet._id, transaction._id, 40, 60);
      expect(result).toBe(wallet);
    });

    it('rejects a withdrawal larger than the current balance', async () => {
      walletModel.findOneAndUpdate.mockResolvedValue(null);
      walletModel.findById.mockResolvedValue({ id: 'w1', _id: 'w1', balance: 10 });

      await expect(service.withdraw('w1', { amount: 40 })).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException when the wallet does not exist', async () => {
      walletModel.findOneAndUpdate.mockResolvedValue(null);
      walletModel.findById.mockResolvedValue(null);

      await expect(service.withdraw('missing-id', { amount: 10 })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('transfer', () => {
    const fromId = new Types.ObjectId();
    const toId = new Types.ObjectId();

    function mockWallets(fromBalance: number) {
      const fromWallet = { _id: fromId, balance: fromBalance, save: jest.fn() };
      const toWallet = { _id: toId, balance: 0 };

      const sessionable = (val: any) => ({ session: jest.fn().mockResolvedValue(val) });

      walletModel.findOneAndUpdate.mockImplementation((query: any, update: any) => {
        if (String(query._id) === String(fromId))
          return Promise.resolve(
            fromBalance > 0
              ? {
                  ...fromWallet,
                  balance: fromBalance - (update.$inc?.balance ? Math.abs(update.$inc.balance) : 0),
                }
              : null,
          );
        return Promise.resolve(null);
      });
      walletModel.findById.mockImplementation((id: unknown) => {
        if (String(id) === String(fromId)) return sessionable(fromWallet);
        if (String(id) === String(toId)) return sessionable(toWallet);
        return sessionable(null);
      });
      return { fromWallet, toWallet };
    }

    it('rejects transfers between the same wallet', async () => {
      await expect(
        service.transfer({
          fromWalletId: fromId.toString(),
          toWalletId: fromId.toString(),
          amount: 10,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException when either wallet is missing', async () => {
      walletModel.findOneAndUpdate.mockResolvedValue(null);
      walletModel.findById.mockReturnValue({ session: jest.fn().mockResolvedValue(null) });

      await expect(
        service.transfer({
          fromWalletId: fromId.toString(),
          toWalletId: toId.toString(),
          amount: 10,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects a transfer larger than the sender balance', async () => {
      mockWallets(0);

      await expect(
        service.transfer({
          fromWalletId: fromId.toString(),
          toWalletId: toId.toString(),
          amount: 10,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('debits the sender, records a ledger entry, and publishes a transfer.initiated event', async () => {
      const { fromWallet } = mockWallets(100);
      const createdTransfer = { _id: new Types.ObjectId(), status: 'PENDING' };
      transferModel.create.mockResolvedValue([createdTransfer]);
      const debitTransaction = { _id: new Types.ObjectId() };
      transactionModel.create.mockResolvedValue([debitTransaction]);

      const result = await service.transfer({
        fromWalletId: fromId.toString(),
        toWalletId: toId.toString(),
        amount: 30,
      });

      expect(ledgerService.recordDebit).toHaveBeenCalledWith(
        fromWallet._id,
        debitTransaction._id,
        30,
        70,
        mockSession,
      );
      expect(outboxService.enqueue).toHaveBeenCalledWith(
        'transfer.initiated',
        expect.objectContaining({ transferId: createdTransfer._id.toString(), amount: 30 }),
        mockSession,
      );
      expect(result).toBe(createdTransfer);
    });

    it('does not create a second transfer when retried with the same idempotency key', async () => {
      mockWallets(100);
      const createdTransfer = { _id: new Types.ObjectId(), status: 'PENDING' };
      transferModel.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(createdTransfer);
      transferModel.create.mockResolvedValue([createdTransfer]);
      transactionModel.create.mockResolvedValue([{ _id: new Types.ObjectId() }]);

      const dto = {
        fromWalletId: fromId.toString(),
        toWalletId: toId.toString(),
        amount: 30,
        idempotencyKey: 'retry-key-1',
      };

      await service.transfer(dto);
      await service.transfer(dto);

      expect(transferModel.create).toHaveBeenCalledTimes(1);
    });

    it('ends the Mongo session even when the transaction fails partway through', async () => {
      mockWallets(100);
      const createdTransfer = { _id: new Types.ObjectId(), status: 'PENDING' };
      transferModel.create.mockResolvedValue([createdTransfer]);
      transactionModel.create.mockRejectedValue(new Error('write conflict'));

      await expect(
        service.transfer({
          fromWalletId: fromId.toString(),
          toWalletId: toId.toString(),
          amount: 30,
        }),
      ).rejects.toThrow('write conflict');

      expect(mockSession.endSession).toHaveBeenCalled();
      expect(rabbitMQService.publish).not.toHaveBeenCalled();
    });
  });
  describe('refundTransfer', () => {
    it('safely refunds a stuck pending transfer', async () => {
      const transferId = new Types.ObjectId().toString();
      const fromWalletId = new Types.ObjectId().toString();
      const mockTransfer = {
        _id: transferId,
        fromWalletId: fromWalletId,
        amount: 50,
      };

      const mockWallet = {
        _id: fromWalletId,
        id: fromWalletId,
        balance: 150,
      };

      const mockRefundTransaction = {
        _id: new Types.ObjectId(),
      };

      transferModel.findOneAndUpdate.mockResolvedValue(mockTransfer);
      walletModel.findByIdAndUpdate.mockResolvedValue(mockWallet);
      transactionModel.create.mockResolvedValue([mockRefundTransaction]);

      await service.refundTransfer(transferId);

      // Verify the atomic guard was used
      expect(transferModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: transferId, status: 'PENDING' },
        { status: 'FAILED', failureReason: 'Timeout' },
        { new: true, session: mockSession },
      );

      // Verify sender was credited
      expect(walletModel.findByIdAndUpdate).toHaveBeenCalledWith(
        fromWalletId,
        { $inc: { balance: 50, version: 1 } },
        { new: true, session: mockSession },
      );

      // Verify a TRANSFER_IN refund transaction was created
      expect(transactionModel.create).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            type: TransactionType.TRANSFER_IN,
            amount: 50,
            reference: `REFUND-${transferId}`,
          }),
        ],
        { session: mockSession },
      );

      // Verify ledger entry
      expect(ledgerService.recordCredit).toHaveBeenCalledWith(
        mockWallet._id,
        mockRefundTransaction._id,
        50,
        150,
        mockSession,
      );
    });

    it('aborts silently if the transfer is no longer pending', async () => {
      transferModel.findOneAndUpdate.mockResolvedValue(null);

      await service.refundTransfer('missing-or-completed-id');

      expect(walletModel.findByIdAndUpdate).not.toHaveBeenCalled();
      expect(transactionModel.create).not.toHaveBeenCalled();
    });
  });
});
