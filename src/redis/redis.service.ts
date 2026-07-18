import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;
  private readonly ttlSeconds: number;

  constructor(private readonly configService: ConfigService) {
    this.client = new Redis({
      host: this.configService.get<string>('redis.host'),
      port: this.configService.get<number>('redis.port'),
      lazyConnect: false,
    });
    this.ttlSeconds = this.configService.getOrThrow<number>('redis.ttlSeconds');

    this.client.on('error', (err) => this.logger.error(`Redis error: ${err.message}`));
  }

  private walletBalanceKey(walletId: string): string {
    return `wallet:balance:${walletId}`;
  }

  async getCachedBalance(walletId: string): Promise<number | null> {
    const value = await this.client.get(this.walletBalanceKey(walletId));
    return value === null ? null : parseFloat(value);
  }

  async setCachedBalance(walletId: string, balance: number): Promise<void> {
    await this.client.set(
      this.walletBalanceKey(walletId),
      balance.toString(),
      'EX',
      this.ttlSeconds,
    );
  }

  async invalidateBalance(walletId: string): Promise<void> {
    await this.client.del(this.walletBalanceKey(walletId));
  }

  getClient(): Redis {
    return this.client;
  }

  async onModuleDestroy() {
    await this.client.quit();
  }
}
