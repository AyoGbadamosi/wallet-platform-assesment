import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Wallet, WalletDocument } from '../wallets/schemas/wallet.schema';
import { v4 as uuidv4 } from 'uuid';
import { asyncLocalStorage } from '../common/logger/cls';

/**
 * Watches wallets whose balance recently changed and logs a snapshot for
 * downstream monitoring dashboards. Ticks on a fixed interval.
 */
@Injectable()
export class WalletEventsWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WalletEventsWorker.name);
  private timer: NodeJS.Timeout;

  constructor(@InjectModel(Wallet.name) private readonly walletModel: Model<WalletDocument>) {}

  onModuleInit() {
    this.timer = setInterval(() => this.tick(), 10_000);
  }

  private async tick() {
    asyncLocalStorage.run({ correlationId: uuidv4() }, async () => {
      const recentWallets = await this.walletModel.find().sort({ updatedAt: -1 }).limit(20).exec();

      for (const wallet of recentWallets) {
        this.logger.debug(`Wallet ${wallet.id} snapshot balance=${wallet.balance}`);
      }
    });
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }
}
