import { Controller, Get } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { ApiTags } from '@nestjs/swagger';
import { Connection } from 'mongoose';
import { Public } from '../common/decorators/public.decorator';
import { RedisService } from '../redis/redis.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly redisService: RedisService,
  ) {}

  @Public()
  @Get()
  async check() {
    const mongoState = this.connection.readyState === 1 ? 'up' : 'down';

    let redisState = 'down';
    try {
      await this.redisService.getClient().ping();
      redisState = 'up';
    } catch {
      redisState = 'down';
    }

    return {
      status: mongoState === 'up' && redisState === 'up' ? 'ok' : 'degraded',
      mongo: mongoState,
      redis: redisState,
      timestamp: new Date().toISOString(),
    };
  }
}
