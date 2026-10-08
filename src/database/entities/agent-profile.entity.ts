import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export const AGENT_PROFILE_CONNECTORS = [
  'cursor',
  'cline',
  'roo_code',
  'continue',
  'codex',
  'claude_code',
  'opencode',
  // Existing non-coding chat clients remain supported for compatibility.
  'cherry_studio',
  'hermes',
  'openclaw',
  'generic_openai',
  'generic_anthropic',
] as const;

export type AgentProfileConnector = (typeof AGENT_PROFILE_CONNECTORS)[number];

export const AGENT_PROFILE_STATUSES = ['active', 'disabled'] as const;
export type AgentProfileStatus = (typeof AGENT_PROFILE_STATUSES)[number];

export const AGENT_PROFILE_BASE_URL_MODES = [
  'openai_v1',
  'anthropic_v1',
  'root',
] as const;

export type AgentProfileBaseUrlMode =
  (typeof AGENT_PROFILE_BASE_URL_MODES)[number];

@Entity('agent_profiles')
@Index(['workspace_id', 'name'], { unique: true })
@Index(['connector'])
@Index(['status'])
@Index(['workspace_id'])
@Index(['api_key_id'])
@Index(['namespace_id'])
export class AgentProfile {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar' })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'varchar' })
  connector!: AgentProfileConnector;

  @Column({ type: 'varchar', default: 'active' })
  status!: AgentProfileStatus;

  @Column({ type: 'varchar', nullable: true })
  workspace_id!: string | null;

  @Column({ type: 'varchar', nullable: true })
  api_key_id!: string | null;

  @Column({ type: 'varchar', nullable: true })
  namespace_id!: string | null;

  @Column({ type: 'varchar', default: 'auto' })
  default_model!: string;

  @Column({ type: 'varchar', default: 'auto' })
  smart_model_id!: string;

  @Column({ type: 'varchar', default: 'openai_v1' })
  base_url_mode!: AgentProfileBaseUrlMode;

  @Column({ type: 'simple-json', nullable: true })
  routing_hint!: Record<string, unknown> | null;

  @Column({ type: 'simple-json', nullable: true })
  mcp_server_ids!: string[] | null;

  @Column({ type: 'simple-json', nullable: true })
  metadata!: Record<string, unknown> | null;

  @Column({ type: Date, nullable: true })
  last_generated_at!: Date | null;

  @CreateDateColumn()
  created_at!: Date;

  @UpdateDateColumn()
  updated_at!: Date;
}
