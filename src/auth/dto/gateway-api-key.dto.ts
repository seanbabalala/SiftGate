import {
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { ApiKeyModelRoute } from '../../routing/api-key-model-route';
import { GatewayApiKeyStatus } from '../../database/entities/gateway-api-key.entity';

export class CreateGatewayApiKeyDto {
  @ApiProperty({ example: 'production-app', maxLength: 80 })
  @IsString()
  @MaxLength(80)
  name!: string;

  @ApiPropertyOptional({ example: 'Used by the production web app', nullable: true })
  @IsOptional()
  @IsString()
  description?: string | null;

  @ApiPropertyOptional({ default: true, description: 'Allow model: "auto" smart routing.' })
  @IsOptional()
  @IsBoolean()
  allow_auto?: boolean;

  @ApiPropertyOptional({ default: false, description: 'Allow direct model or node routing.' })
  @IsOptional()
  @IsBoolean()
  allow_direct?: boolean;

  @ApiPropertyOptional({ type: [String], example: ['openai', 'anthropic'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowed_nodes?: string[];

  @ApiPropertyOptional({ description: 'Opt-in exact-model node pools; does not expand effective permissions.', type: 'array', items: { type: 'object' } })
  @IsOptional()
  @IsArray()
  model_routes?: ApiKeyModelRoute[] | null;

  @ApiPropertyOptional({ type: [String], example: ['gpt-4o', 'claude-sonnet-4-20250514'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowed_models?: string[];

  @ApiPropertyOptional({ type: [String], example: ['chat_completions', 'responses', 'embeddings', 'mcp'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowed_endpoints?: string[];

  @ApiPropertyOptional({ type: [String], example: ['text', 'embedding', 'image'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowed_modalities?: string[];

  @ApiPropertyOptional({ example: 'team-alpha', nullable: true, description: 'Optional local OSS namespace binding.' })
  @IsOptional()
  @IsString()
  namespace_id?: string | null;

  @ApiPropertyOptional({ example: 'team_01h...', nullable: true, description: 'Optional local OSS team binding.' })
  @IsOptional()
  @IsString()
  team_id?: string | null;

  @ApiPropertyOptional({ example: 1000000, nullable: true, minimum: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  daily_token_limit?: number | null;

  @ApiPropertyOptional({ example: 50, nullable: true, minimum: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  daily_cost_limit?: number | null;

  @ApiPropertyOptional({ example: 120, nullable: true, minimum: 1 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  rate_limit_per_minute?: number | null;
}

export class UpdateGatewayApiKeyDto {
  @ApiPropertyOptional({ example: 'production-app', maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional({ example: 'Used by the production web app', nullable: true })
  @IsOptional()
  @IsString()
  description?: string | null;

  @ApiPropertyOptional({ enum: ['active', 'disabled'], example: 'active' })
  @IsOptional()
  @IsIn(['active', 'disabled'])
  status?: GatewayApiKeyStatus;

  @ApiPropertyOptional({ description: 'Allow model: "auto" smart routing.' })
  @IsOptional()
  @IsBoolean()
  allow_auto?: boolean;

  @ApiPropertyOptional({ description: 'Allow direct model or node routing.' })
  @IsOptional()
  @IsBoolean()
  allow_direct?: boolean;

  @ApiPropertyOptional({ type: [String], example: ['openai', 'anthropic'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowed_nodes?: string[];

  @ApiPropertyOptional({ description: 'Opt-in exact-model node pools; does not expand effective permissions.', type: 'array', items: { type: 'object' } })
  @IsOptional()
  @IsArray()
  model_routes?: ApiKeyModelRoute[] | null;

  @ApiPropertyOptional({ type: [String], example: ['gpt-4o'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowed_models?: string[];

  @ApiPropertyOptional({ type: [String], example: ['chat_completions', 'responses', 'embeddings', 'mcp'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowed_endpoints?: string[];

  @ApiPropertyOptional({ type: [String], example: ['text', 'embedding', 'image'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowed_modalities?: string[];

  @ApiPropertyOptional({ example: 'team-alpha', nullable: true, description: 'Optional local OSS namespace binding.' })
  @IsOptional()
  @IsString()
  namespace_id?: string | null;

  @ApiPropertyOptional({ example: 'team_01h...', nullable: true, description: 'Optional local OSS team binding.' })
  @IsOptional()
  @IsString()
  team_id?: string | null;

  @ApiPropertyOptional({ example: 1000000, nullable: true, minimum: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  daily_token_limit?: number | null;

  @ApiPropertyOptional({ example: 50, nullable: true, minimum: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  daily_cost_limit?: number | null;

  @ApiPropertyOptional({ example: 120, nullable: true, minimum: 1 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  rate_limit_per_minute?: number | null;
}
