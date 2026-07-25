import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ConsumeMessage } from 'amqplib';
import { Connection, Model } from 'mongoose';
import { LedgerService } from '../ledger/ledger.service';
import { RedisService } from '../redis/redis.service';
import {
  Transaction,
  TransactionDocument,
  TransactionStatus,
  TransactionType,
} from '../transactions/schemas/transaction.schema';
import { Transfer, TransferDocument, TransferStatus } from '../wallets/schemas/transfer.schema';
import { Wallet, WalletDocument } from '../wallets/schemas/wallet.schema';
import { RabbitMQService } from './rabbitmq.service';
import { v4 as uuidv4 } from 'uuid';
import { asyncLocalStorage } from '../common/logger/cls';

export interface TransferInitiatedEvent {
  transferId: string;
  fromWalletId: string;
  toWalletId: string;
  amount: number;
}

@Injectable()
export class TransferEventsConsumer implements OnModuleInit {
  private readonly logger = new Logger(TransferEventsConsumer.name);

  constructor(
    private readonly rabbitMQService: RabbitMQService,
    @InjectModel(Transfer.name) private readonly transferModel: Model<TransferDocument>,
    @InjectModel(Wallet.name) private readonly walletModel: Model<WalletDocument>,
    @InjectModel(Transaction.name)
    private readonly transactionModel: Model<TransactionDocument>,
    private readonly ledgerService: LedgerService,
    private readonly redisService: RedisService,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  onModuleInit() {
    const channelWrapper = this.rabbitMQService.getChannelWrapper();
    const queue = this.rabbitMQService.getTransferQueue();

    channelWrapper.addSetup((channel) =>
      channel.consume(queue, (message) => this.handleMessage(message, channel)),
    );
  }

  private async handleMessage(message: ConsumeMessage | null, channel: any) {
    if (!message) {
      return;
    }

    const correlationId = message.properties.headers?.['x-correlation-id'] || uuidv4();

    asyncLocalStorage.run({ correlationId }, async () => {
      try {
        const event: TransferInitiatedEvent = JSON.parse(message.content.toString());
        await this.completeTransfer(event);
        channel.ack(message);
      } catch (error) {
        this.logger.error(`Failed to process transfer event: ${(error as Error).message}`);
        channel.ack(message);
      }
    });
  }

  private async completeTransfer(event: TransferInitiatedEvent) {
    // Prevent execution during Jest/app teardown when Mongoose is disconnected
    if (this.connection.readyState !== 1) {
      this.logger.warn('Mongoose is not connected, skipping transfer processing');
      return;
    }

    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        const transfer = await this.transferModel.findOneAndUpdate(
          { _id: event.transferId, status: TransferStatus.PENDING },
          { status: TransferStatus.COMPLETED },
          { new: true, session },
        );

        if (!transfer) {
          this.logger.warn(`Transfer ${event.transferId} not found or no longer PENDING, skipping`);
          return;
        }

        const toWallet = await this.walletModel.findOneAndUpdate(
          { _id: event.toWalletId },
          { $inc: { balance: event.amount, version: 1 } },
          { new: true, session },
        );

        if (!toWallet) {
          this.logger.warn(`Destination wallet ${event.toWalletId} not found, skipping`);
          return;
        }

        const [creditTransaction] = await this.transactionModel.create(
          [
            {
              walletId: toWallet._id,
              type: TransactionType.TRANSFER_IN,
              amount: event.amount,
              status: TransactionStatus.COMPLETED,
              balanceAfter: toWallet.balance,
              transferId: transfer._id,
              counterpartyWalletId: transfer.fromWalletId,
            },
          ],
          { session },
        );

        await this.ledgerService.recordCredit(
          toWallet._id,
          creditTransaction._id,
          event.amount,
          toWallet.balance,
          session,
        );

        await this.redisService.invalidateBalance(toWallet.id);
        this.logger.log(`Transfer ${transfer.id} completed for wallet ${toWallet.id}`);
      });
    } finally {
      await session.endSession();
    }
  }
}
