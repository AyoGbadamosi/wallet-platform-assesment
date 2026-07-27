import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { LedgerEntry, LedgerEntryDocument } from '../ledger/schemas/ledger-entry.schema';
import { LedgerService } from '../ledger/ledger.service';
import { OutboxService } from '../outbox/outbox.service';
import { RabbitMQService } from '../queue/rabbitmq.service';
import { RedisService } from '../redis/redis.service';
import { TransactionsService } from '../transactions/transactions.service';
import {
  Transaction,
  TransactionDocument,
  TransactionStatus,
  TransactionType,
} from '../transactions/schemas/transaction.schema';
import { CreateWalletDto } from './dto/create-wallet.dto';
import { DepositDto } from './dto/deposit.dto';
import { TransferDto } from './dto/transfer.dto';
import { WithdrawDto } from './dto/withdraw.dto';
import { Transfer, TransferDocument, TransferStatus } from './schemas/transfer.schema';
import { Wallet, WalletDocument } from './schemas/wallet.schema';

@Injectable()
export class WalletsService {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Wallet.name) private readonly walletModel: Model<WalletDocument>,
    @InjectModel(Transfer.name) private readonly transferModel: Model<TransferDocument>,
    @InjectModel(Transaction.name) private readonly transactionModel: Model<TransactionDocument>,
    @InjectModel(LedgerEntry.name) private readonly ledgerEntryModel: Model<LedgerEntryDocument>,
    private readonly transactionsService: TransactionsService,
    private readonly ledgerService: LedgerService,
    private readonly outboxService: OutboxService,
    private readonly rabbitMQService: RabbitMQService,
    private readonly redisService: RedisService,
  ) {}

  async createWallet(dto: CreateWalletDto) {
    const session = await this.connection.startSession();
    let wallet!: WalletDocument;

    try {
      await session.withTransaction(async () => {
        [wallet] = await this.walletModel.create(
          [
            {
              userId: dto.userId,
              ownerName: dto.ownerName,
              currency: dto.currency ?? 'GHS',
              balance: 0,
            },
          ],
          { session },
        );

        await this.outboxService.enqueue(
          'wallet.created',
          {
            walletId: wallet._id.toString(),
            userId: wallet.userId,
            currency: wallet.currency,
          },
          session,
        );
      });
    } finally {
      await session.endSession();
    }

    return wallet;
  }

  async getWallet(id: string) {
    const wallet = await this.walletModel.findById(id);
    if (!wallet) {
      throw new NotFoundException(`Wallet ${id} not found`);
    }

    const cachedBalance = await this.redisService.getCachedBalance(id);
    if (cachedBalance !== null) {
      return { ...wallet.toObject(), balance: cachedBalance };
    }

    await this.redisService.setCachedBalance(id, wallet.balance);
    return wallet;
  }

  async deposit(id: string, dto: DepositDto) {
    if (dto.reference) {
      const existing = await this.transactionsService.findByReference(dto.reference);
      if (existing) {
        return this.walletModel.findById(id);
      }
    }

    const session = await this.connection.startSession();
    try {
      let finalWallet!: WalletDocument;
      await session.withTransaction(async () => {
        const wallet = await this.walletModel.findByIdAndUpdate(
          id,
          { $inc: { balance: dto.amount, version: 1 } },
          { new: true, session },
        );

        if (!wallet) {
          throw new NotFoundException(`Wallet ${id} not found`);
        }

        const transaction = await this.transactionsService.create(
          {
            walletId: wallet.id,
            type: TransactionType.DEPOSIT,
            amount: dto.amount,
            balanceAfter: wallet.balance,
            reference: dto.reference,
          },
          session,
        );

        await this.ledgerService.recordCredit(wallet._id, transaction._id, dto.amount, wallet.balance, session);
        finalWallet = wallet;
      });

      await this.redisService.invalidateBalance(id);
      return finalWallet;
    } finally {
      await session.endSession();
    }
  }

  async withdraw(id: string, dto: WithdrawDto) {
    if (dto.reference) {
      const existing = await this.transactionsService.findByReference(dto.reference);
      if (existing) {
        return this.walletModel.findById(id);
      }
    }

    const session = await this.connection.startSession();
    try {
      let finalWallet!: WalletDocument;
      await session.withTransaction(async () => {
        const wallet = await this.walletModel.findOneAndUpdate(
          { _id: id, balance: { $gte: dto.amount } },
          { $inc: { balance: -dto.amount, version: 1 } },
          { new: true, session },
        );

        if (!wallet) {
          const exists = await this.walletModel.findById(id).session(session);
          if (!exists) {
            throw new NotFoundException(`Wallet ${id} not found`);
          }
          throw new BadRequestException('Insufficient balance');
        }

        const transaction = await this.transactionsService.create(
          {
            walletId: wallet.id,
            type: TransactionType.WITHDRAWAL,
            amount: dto.amount,
            balanceAfter: wallet.balance,
            reference: dto.reference,
          },
          session,
        );

        await this.ledgerService.recordDebit(wallet._id, transaction._id, dto.amount, wallet.balance, session);
        finalWallet = wallet;
      });

      await this.redisService.invalidateBalance(id);
      return finalWallet;
    } finally {
      await session.endSession();
    }
  }

  async transfer(dto: TransferDto) {
    if (dto.fromWalletId === dto.toWalletId) {
      throw new BadRequestException('Cannot transfer to the same wallet');
    }

    if (dto.idempotencyKey) {
      const existingTransfer = await this.transferModel.findOne({
        idempotencyKey: dto.idempotencyKey,
      });
      if (existingTransfer) {
        return existingTransfer;
      }
    }

    const session = await this.connection.startSession();
    let transfer!: TransferDocument;

    try {
      await session.withTransaction(async () => {
        const fromWallet = await this.walletModel.findOneAndUpdate(
          { _id: dto.fromWalletId, balance: { $gte: dto.amount } },
          { $inc: { balance: -dto.amount, version: 1 } },
          { new: true, session },
        );

        if (!fromWallet) {
          const exists = await this.walletModel.findById(dto.fromWalletId).session(session);
          if (!exists) throw new NotFoundException('Wallet not found');
          throw new BadRequestException('Insufficient balance');
        }

        const toWallet = await this.walletModel.findById(dto.toWalletId).session(session);
        if (!toWallet) {
          throw new NotFoundException('Wallet not found');
        }

        [transfer] = await this.transferModel.create(
          [
            {
              fromWalletId: fromWallet._id,
              toWalletId: toWallet._id,
              amount: dto.amount,
              status: TransferStatus.PENDING,
              idempotencyKey: dto.idempotencyKey,
            },
          ],
          { session },
        );

        const [debitTransaction] = await this.transactionModel.create(
          [
            {
              walletId: fromWallet._id,
              type: TransactionType.TRANSFER_OUT,
              amount: dto.amount,
              status: TransactionStatus.COMPLETED,
              balanceAfter: fromWallet.balance,
              transferId: transfer._id,
              counterpartyWalletId: toWallet._id,
            },
          ],
          { session },
        );

        await this.ledgerService.recordDebit(
          fromWallet._id,
          debitTransaction._id,
          dto.amount,
          fromWallet.balance,
          session,
        );

        await this.outboxService.enqueue(
          'transfer.initiated',
          {
            transferId: transfer._id.toString(),
            fromWalletId: fromWallet._id.toString(),
            toWalletId: toWallet._id.toString(),
            amount: dto.amount,
          },
          session,
        );
      });
    } finally {
      await session.endSession();
    }

    await this.redisService.invalidateBalance(dto.fromWalletId);

    return transfer;
  }

  async refundTransfer(transferId: string) {
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        // Atomic race-condition guard: Only update if it's currently PENDING.
        const transfer = await this.transferModel.findOneAndUpdate(
          { _id: transferId, status: TransferStatus.PENDING },
          { status: TransferStatus.FAILED, failureReason: 'Timeout' },
          { new: true, session },
        );

        // If null, it was already processed by the consumer (or doesn't exist).
        if (!transfer) return;

        const wallet = await this.walletModel.findByIdAndUpdate(
          transfer.fromWalletId,
          { $inc: { balance: transfer.amount, version: 1 } },
          { new: true, session },
        );

        if (!wallet) throw new NotFoundException('Wallet not found');

        const [refundTransaction] = await this.transactionModel.create(
          [
            {
              walletId: wallet._id,
              type: TransactionType.TRANSFER_IN,
              amount: transfer.amount,
              status: TransactionStatus.COMPLETED,
              balanceAfter: wallet.balance,
              transferId: transfer._id,
              reference: `REFUND-${transfer._id}`,
            },
          ],
          { session },
        );

        await this.ledgerService.recordCredit(
          wallet._id,
          refundTransaction._id,
          transfer.amount,
          wallet.balance,
          session,
        );

        await this.redisService.invalidateBalance(wallet.id);
      });
    } finally {
      await session.endSession();
    }
  }

  async getDashboard(id: string) {
    const wallet = await this.walletModel.findById(id);
    if (!wallet) {
      throw new NotFoundException(`Wallet ${id} not found`);
    }

    const [stats] = await this.transactionModel.aggregate([
      { $match: { walletId: new Types.ObjectId(id) } },
      {
        $group: {
          _id: null,
          totalDeposited: {
            $sum: {
              $cond: [
                { $in: ['$type', [TransactionType.DEPOSIT, TransactionType.TRANSFER_IN]] },
                '$amount',
                0,
              ],
            },
          },
          totalWithdrawn: {
            $sum: {
              $cond: [
                { $in: ['$type', [TransactionType.WITHDRAWAL, TransactionType.TRANSFER_OUT]] },
                '$amount',
                0,
              ],
            },
          },
          transactionCount: { $sum: 1 },
        },
      },
    ]);

    const recentTransactions = await this.transactionModel
      .find({ walletId: id })
      .sort({ createdAt: -1 })
      .limit(10)
      .exec();

    const transactionIds = recentTransactions.map((t) => t._id);
    const ledgerEntries = await this.ledgerEntryModel
      .find({ transactionId: { $in: transactionIds } })
      .exec();

    const recentActivity = recentTransactions.map((txn) => ({
      transaction: txn,
      entries: ledgerEntries.filter((e) => e.transactionId.toString() === txn._id.toString()),
    }));

    return {
      wallet,
      totalDeposited: stats?.totalDeposited ?? 0,
      totalWithdrawn: stats?.totalWithdrawn ?? 0,
      transactionCount: stats?.transactionCount ?? 0,
      recentActivity,
    };
  }

  async reconcile(id: string) {
    const wallet = await this.walletModel.findById(id);
    if (!wallet) {
      throw new NotFoundException(`Wallet ${id} not found`);
    }

    const calculatedBalance = await this.ledgerService.computeBalanceFromLedger(id);
    const matched = wallet.balance === calculatedBalance;
    const difference = wallet.balance - calculatedBalance;

    return {
      walletId: id,
      matched,
      actualBalance: wallet.balance,
      calculatedBalance,
      difference,
    };
  }

  async getAuditLogs(id: string, page: number, limit: number) {
    const wallet = await this.walletModel.findById(id);
    if (!wallet) {
      throw new NotFoundException(`Wallet ${id} not found`);
    }

    const skip = (page - 1) * limit;

    const [entries, total] = await Promise.all([
      this.ledgerEntryModel
        .find({ walletId: id })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      this.ledgerEntryModel.countDocuments({ walletId: id }),
    ]);

    return {
      data: entries,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }
}
