import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

@Entity('budget_rules')
@Index(['workspace_id'])
@Index(['api_key_name'])
@Index(['api_key_id'])
@Index(['api_key_id', 'type'])
@Index(['namespace_id'])
@Index(['namespace_id', 'type'])
@Index(['team_id'])
@Index(['team_id', 'type'])
export class BudgetRule {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'varchar', nullable: true, default: null })
  workspace_id!: string | null;

  @Column({ type: 'varchar' })
  type!: string; // daily_tokens | daily_cost | monthly_cost

  @Column({ type: 'real' })
  limit_value!: number;

  @Column({ type: 'real', default: 0.8 })
  alert_threshold!: number;

  @Column({ type: 'real', default: 0 })
  current_value!: number;

  /** Read-only transient exact balance; never an implicit schema synchronization change. */
  current_value_exact?: string;

  @CreateDateColumn()
  period_start!: Date;

  @Column({ type: 'boolean', default: true })
  is_active!: boolean;

  @Column({ type: 'varchar', nullable: true, default: null })
  api_key_name!: string | null;  // NULL = global rule, non-null = per-key rule

  @Column({ type: 'varchar', nullable: true, default: null })
  api_key_id!: string | null;  // NULL = global rule, non-null = GatewayApiKey.id

  @Column({ type: 'varchar', nullable: true, default: null })
  namespace_id!: string | null;  // NULL = global/key rule, non-null = local namespace rule

  @Column({ type: 'varchar', nullable: true, default: null })
  team_id!: string | null;  // NULL = global/key/namespace rule, non-null = local team rule
}
