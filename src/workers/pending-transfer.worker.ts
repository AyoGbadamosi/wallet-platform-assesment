import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Transfer, TransferDocument, TransferStatus } from '../wallets/schemas/transfer.schema';
import { WalletsService } from '../wallets/wallets.service';
import { v4 as uuidv4 } from 'uuid';
import { asyncLocalStorage } from '../common/logger/cls';

@Injectable()
export class PendingTransferWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PendingTransferWorker.name);
  private timer: NodeJS.Timeout;
  private isSweeping = false;

  constructor(
    @InjectModel(Transfer.name) private readonly transferModel: Model<TransferDocument>,
    private readonly configService: ConfigService,
    private readonly walletsService: WalletsService,
  ) {}

  onModuleInit() {
    const intervalMs = this.configService.getOrThrow<number>(
      'workers.pendingTransferSweepIntervalMs',
    );
    this.timer = setInterval(() => this.sweep(), intervalMs);
  }

  private async sweep() {
    if (this.isSweeping || this.transferModel.db.readyState !== 1) return;
    this.isSweeping = true;

    asyncLocalStorage.run({ correlationId: uuidv4() }, async () => {
      try {
        const timeoutMs = this.configService.getOrThrow<number>('workers.pendingTransferTimeoutMs');
        const cutoff = new Date(Date.now() - timeoutMs);

        const stale = await this.transferModel
          .find({ status: TransferStatus.PENDING, createdAt: { $lt: cutoff } })
          .limit(50)
          .exec();

        for (const transfer of stale) {
          try {
            await this.walletsService.refundTransfer(transfer._id.toString());
            this.logger.log(`Refunded stuck transfer ${transfer._id}`);
          } catch (error) {
            this.logger.error(`Failed to refund transfer ${transfer._id}`, error);
          }
        }
      } finally {
        this.isSweeping = false;
      }
    });
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }
}
