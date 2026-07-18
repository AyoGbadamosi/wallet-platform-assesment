import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { LedgerEntry, LedgerEntrySchema } from './schemas/ledger-entry.schema';
import { LedgerService } from './ledger.service';

@Module({
  imports: [MongooseModule.forFeature([{ name: LedgerEntry.name, schema: LedgerEntrySchema }])],
  providers: [LedgerService],
  exports: [LedgerService],
})
export class LedgerModule {}
