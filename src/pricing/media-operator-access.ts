import type { EntityManager } from "typeorm";
import { WorkspaceMembership } from "../database/entities/workspace-membership.entity";
import { Workspace } from "../database/entities/workspace.entity";
import { lockWorkspaceWriter } from "../workspaces/workspace-writer-lock";
import {
  PricingRepositoryError,
  type PricingActor,
} from "./pricing-repository.types";

export function requireMediaOperator(actor: PricingActor, admin = false): void {
  if (
    !actor.id ||
    !actor.workspace_id ||
    !(admin ? ["admin"] : ["admin", "operator"]).includes(actor.role)
  )
    throw new PricingRepositoryError(
      "pricing_permission_denied",
      admin
        ? "Workspace administrator required"
        : "Workspace operator required",
      403,
    );
}
/** No stale role captured before an external lookup may authorize the eventual write. */
export async function assertMediaAdministrator(
  manager: EntityManager,
  actor: PricingActor,
): Promise<void> {
  requireMediaOperator(actor, true);
  if (manager.connection.hasMetadata(WorkspaceMembership)) {
    await lockWorkspaceWriter(manager, actor.workspace_id);
    const member = await manager
      .getRepository(WorkspaceMembership)
      .findOne({
        where: {
          workspace_id: actor.workspace_id,
          user_id: actor.id,
          status: "active",
          role: "admin",
        },
      });
    const workspace = manager.connection.hasMetadata(Workspace)
      ? await manager
          .getRepository(Workspace)
          .findOne({ where: { id: actor.workspace_id, status: "active" } })
      : true;
    if (!member || !workspace)
      throw new PricingRepositoryError(
        "pricing_permission_denied",
        "Workspace administration changed before this operation",
        403,
      );
  }
}
