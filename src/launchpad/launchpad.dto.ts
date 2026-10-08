import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

export class LaunchpadSelectionDto {
  @ApiProperty() @IsString() @MaxLength(120) node_id!: string;
  @ApiProperty() @IsString() @MaxLength(240) model!: string;
  @ApiProperty({ description: 'Live configuration/policy fingerprint from the current overview.' })
  @IsString() @Matches(/^[a-f0-9]{64}$/) expected_digest!: string;
  @ApiProperty() @IsString() @MaxLength(120) timezone!: string;
  @ApiProperty() @IsBoolean() pricing_reviewed!: boolean;
}

export class LaunchpadCreateKeyDto extends LaunchpadSelectionDto {
  @ApiProperty() @IsString() @MaxLength(80) name!: string;
  @ApiProperty({ minimum: 1, maximum: 1000000000 }) @IsInt() @Min(1) @Max(1_000_000_000) daily_token_limit!: number;
  @ApiProperty({ minimum: 0.01, maximum: 1000000 }) @IsNumber() @Min(0.01) @Max(1_000_000) daily_cost_limit!: number;
  @ApiProperty({ minimum: 1, maximum: 10000 }) @IsInt() @Min(1) @Max(10000) rate_limit_per_minute!: number;
}

export class LaunchpadPrepareDto extends LaunchpadSelectionDto {
  @ApiProperty({ writeOnly: true, description: 'The user-provided API key, compared to the selected scoped key before any provider call. Never persisted.' })
  @IsString() @MaxLength(256) key_secret!: string;
  @ApiProperty() @IsString() @MaxLength(80) key_id!: string;
  @ApiProperty({ description: 'Explicit acknowledgement that the next client request may incur provider charges.' })
  @IsBoolean() confirm_cost!: boolean;
}

export class LaunchpadQueryDto {
  @IsOptional() @IsString() @MaxLength(120) node_id?: string;
  @IsOptional() @IsString() @MaxLength(240) model?: string;
  @IsOptional() @IsString() @MaxLength(80) key_id?: string;
}
