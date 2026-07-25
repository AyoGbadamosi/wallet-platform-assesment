import { INestApplication } from '@nestjs/common';
import { Connection, Types } from 'mongoose';
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
    // Wait briefly for any triggered consumers to finish processing the message
    // before we tear down the Mongoose connection and Nest application.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await app.close();
  });

  it('publishes without throwing against a real broker connection', async () => {
    await expect(
      rabbitMQService.publish('transfer.initiated', {
        transferId: new Types.ObjectId().toString(),
        fromWalletId: new Types.ObjectId().toString(),
        toWalletId: new Types.ObjectId().toString(),
        amount: 10,
      }),
    ).resolves.not.toThrow();
  });
});
