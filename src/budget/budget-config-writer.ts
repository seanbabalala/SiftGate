import type { Repository } from "typeorm";
import { BudgetRule } from "../database/entities/budget-rule.entity";
import { workspaceFindWhere } from "../workspaces/workspace-scope";

/** Match the ledger's ascending rule-lock order; callers already own their key/team row. */
export async function lockBudgetConfiguration(
  repo: Repository<BudgetRule>,
  workspace: string,
  owner: { api_key_id: string } | { team_id: string },
): Promise<void> {
  if (repo.manager?.connection.options.type !== "postgres") return;
  if (!repo.manager.queryRunner?.isTransactionActive)
    throw new Error("Budget configuration requires a transaction");
  const rows = await repo.find({ where: workspaceFindWhere(workspace, owner) });
  for (const row of rows.sort((a, b) => a.id - b.id))
    await repo.findOne({
      where: workspaceFindWhere(workspace, { id: row.id }),
      lock: { mode: "pessimistic_write" },
    });
}
