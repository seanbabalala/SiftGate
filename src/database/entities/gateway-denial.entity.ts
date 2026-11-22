import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * Stable reason codes for requests the gateway refused on a governance policy
 * before any provider call. Configuration and capability errors (unknown model,
 * context overflow, unsupported modality) are not policy decisions and are not
 * recorded here.
 */
export const GATEWAY_DENIAL_REASONS = [
  'budget_exceeded',
  'rate_limited',
  'endpoint_not_allowed',
  'modality_not_allowed',
  'routing_mode_not_allowed',
  'model_not_allowed',
] as const;

export type GatewayDenialReason = (typeof GATEWAY_DENIAL_REASONS)[number];

/**
 * Metadata-only audit of governance denials. One row covers one minute of the
 * same workspace, key and reason; `request_count` says how many requests it
 * represents, so a client retrying against an exhausted budget cannot turn
 * every refusal into a database row. No prompt, response, header or credential
 * is stored.
 */
// Index names match gateway-denial-schema-patch.service.ts so TypeORM sync
// (SQLite default) and the PostgreSQL patch converge on the same indexes.
@Entity('gateway_denials')
@Index('IDX_gateway_denials_workspace_first_at', ['workspace_id', 'first_at'])
@Index('IDX_gateway_denials_reason', ['reason'])
@Index('IDX_gateway_denials_api_key', ['api_key_id'])
export class GatewayDenial {
  @PrimaryColumn({ type: 'varchar' })
  id!: string;

  @Column({ type: 'varchar', nullable: true })
  workspace_id!: string | null;

  @Column({ type: Date })
  first_at!: Date;

  @Column({ type: Date })
  last_at!: Date;

  @Column({ type: 'integer', default: 1 })
  request_count!: number;

  @Column({ type: 'varchar' })
  reason!: GatewayDenialReason;

  @Column({ type: 'integer' })
  status_code!: number;

  /** Budget denials only: global, api_key, team or namespace. */
  @Column({ type: 'varchar', nullable: true })
  budget_scope!: string | null;

  @Column({ type: 'varchar', nullable: true })
  api_key_id!: string | null;

  @Column({ type: 'varchar', nullable: true })
  api_key_name!: string | null;

  @Column({ type: 'varchar', nullable: true })
  namespace_id!: string | null;

  @Column({ type: 'varchar', nullable: true })
  team_id!: string | null;

  @Column({ type: 'varchar', nullable: true })
  source_format!: string | null;

  /** The model the client asked for, as sent; never a resolved credential. */
  @Column({ type: 'varchar', nullable: true })
  requested_model!: string | null;

  @Column({ type: 'varchar', nullable: true })
  client_source!: string | null;

  /** The first refused request in this minute, for lookup from a client error. */
  @Column({ type: 'varchar', nullable: true })
  first_request_id!: string | null;
}
