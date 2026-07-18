import { INestApplication } from '@nestjs/common';
import { Connection } from 'mongoose';
import { RabbitMQService } from '../../src/queue/rabbitmq.service';
import { createTestApp, resetDatabase } from './test-utils';

describe('RabbitMQ publishing (integration)', () => {
  let app: INestApplication;
  let connection: Connection;
  let rabbitMQService: RabbitMQService;

  beforeAll(async () => {
    ({ app, connection } = await createTestApp());
    rabbitMQService = app.get(RabbitMQService);
  });

  beforeEach(async () => {
    await resetDatabase(connection);
  });

  afterAll(async () => {
    await app.close();
  });

  it('publishes without throwing against a real broker connection', async () => {
    await expect(
      rabbitMQService.publish('transfer.initiated', {
        transferId: 'test-transfer',
        fromWalletId: 'a',
        toWalletId: 'b',
        amount: 10,
      }),
    ).resolves.not.toThrow();
  });
});
