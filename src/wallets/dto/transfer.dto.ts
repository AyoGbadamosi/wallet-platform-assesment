import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsMongoId, IsNotEmpty, IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';

export class TransferDto {
  @ApiProperty({ example: '66d9f2b1c8a1e4f6a2b5c8e1' })
  @IsMongoId()
  fromWalletId: string;

  @ApiProperty({ example: '66d9f2b1c8a1e4f6a2b5c8e2' })
  @IsMongoId()
  toWalletId: string;

  @ApiProperty({ example: 25 })
  @IsNumber()
  @IsPositive()
  amount: number;

  @ApiPropertyOptional({
    description: 'Client supplied idempotency key. Retried requests should reuse the same key.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  idempotencyKey?: string;
}
