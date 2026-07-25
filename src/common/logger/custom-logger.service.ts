import { ConsoleLogger, Injectable, Scope } from '@nestjs/common';
import { asyncLocalStorage } from './cls';

@Injectable({ scope: Scope.TRANSIENT })
export class CustomLogger extends ConsoleLogger {
  protected formatMessage(
    logLevel: 'log' | 'fatal' | 'error' | 'warn' | 'debug' | 'verbose',
    message: unknown,
    pidMessage: string,
    formattedLogLevel: string,
    contextMessage: string,
    timestampDiff: string,
  ): string {
    const store = asyncLocalStorage.getStore();
    const correlationId = store?.correlationId ? `[CorrID: ${store.correlationId}] ` : '';

    return super.formatMessage(
      logLevel,
      `${correlationId}${message}`,
      pidMessage,
      formattedLogLevel,
      contextMessage,
      timestampDiff,
    );
  }
}
