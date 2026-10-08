import { DataSource, InsertQueryBuilder, type ObjectLiteral } from "typeorm";
import { createE2EHarness, type E2EHarness } from "./setup";
import { ConfigService } from "../../src/config/config.service";
import { AuthService } from "../../src/auth/auth.service";
import { WorkspaceService } from "../../src/workspaces/workspace.service";
import { WorkspaceMembershipService } from "../../src/auth/workspace-membership.service";
import { WorkspaceInvitationService } from "../../src/auth/workspace-invitation.service";
import {
  Workspace,
  WorkspaceMembership,
  WorkspaceInvitation,
  ManagementAuditEvent,
  ConfigAuditEvent,
} from "../../src/database/entities";

describe("coordinated workspace administration over isolated HTTP", () => {
  let harness: E2EHarness, source: DataSource;
  beforeEach(async () => {
    harness = await createE2EHarness();
    source = harness.app.get(DataSource);
    const config = harness.app.get(ConfigService);
    jest
      .spyOn(config, "configAudit", "get")
      .mockReturnValue({ ...config.configAudit, enabled: true });
  }, 30000);
  afterEach(async () => {
    jest.restoreAllMocks();
    await harness?.close();
  });
  const failInsert = (target: Function) => {
    const execute = InsertQueryBuilder.prototype.execute;
    return jest
      .spyOn(InsertQueryBuilder.prototype, "execute")
      .mockImplementation(function (this: InsertQueryBuilder<ObjectLiteral>) {
        if (
          this.expressionMap.mainAlias?.hasMetadata &&
          this.expressionMap.mainAlias.target === target
        )
          return Promise.reject(
            new Error("synthetic workspace write unavailable"),
          );
        return execute.call(this);
      });
  };
  const create = async () => {
    const response = await harness.agent
      .post("/api/dashboard/workspaces")
      .send({ name: "Synthetic workspace" });
    expect(response.status).toBe(201);
    return response.body.item as { id: string; name: string };
  };

  it("creates, renames, disables and reactivates with one committed audit per change", async () => {
    const row = await create();
    expect(
      await harness.app
        .get(WorkspaceMembershipService)
        .findActiveRole("dashboard", row.id),
    ).toBe("admin");
    expect(
      (
        await harness.agent
          .put(`/api/dashboard/workspaces/${row.id}`)
          .send({ name: "Changed name" })
      ).status,
    ).toBe(200);
    expect(
      (await harness.agent.post(`/api/dashboard/workspaces/${row.id}/disable`))
        .status,
    ).toBe(201);
    expect(
      (
        await harness.agent.post(
          `/api/dashboard/workspaces/${row.id}/reactivate`,
        )
      ).status,
    ).toBe(201);
    const audits = await source
      .getRepository(ManagementAuditEvent)
      .find({ where: { resource_id: row.id }, order: { id: "ASC" } });
    expect(audits.map((event) => event.action)).toEqual([
      "workspace.create",
      "workspace.rename",
      "workspace.disable",
      "workspace.reactivate",
    ]);
    expect(
      audits.every(
        (event) =>
          event.actor_id === "dashboard" && event.workspace_id === row.id,
      ),
    ).toBe(true);
    expect(JSON.parse(audits[1].before_summary_json!).name).toBe(
      "Synthetic workspace",
    );
    expect(harness.fetchMock.calls).toHaveLength(0);
  });

  it.each([WorkspaceMembership, ManagementAuditEvent])(
    "does not leave an ownerless workspace after failed required %p creation",
    async (target) => {
      failInsert(target);
      expect(
        (
          await harness.agent
            .post("/api/dashboard/workspaces")
            .send({ name: "Must rollback" })
        ).status,
      ).toBe(500);
      expect(
        await source
          .getRepository(Workspace)
          .count({ where: { name: "Must rollback" } }),
      ).toBe(0);
      expect(
        await source
          .getRepository(ManagementAuditEvent)
          .count({ where: { action: "workspace.create" } }),
      ).toBe(0);
    },
  );

  it("rolls back rename and status changes when audit persistence fails", async () => {
    const row = await create();
    const fail = failInsert(ManagementAuditEvent);
    try {
      expect(
        (
          await harness.agent
            .put(`/api/dashboard/workspaces/${row.id}`)
            .send({ name: "Must rollback" })
        ).status,
      ).toBe(500);
      expect(
        (
          await harness.agent.post(
            `/api/dashboard/workspaces/${row.id}/disable`,
          )
        ).status,
      ).toBe(500);
    } finally {
      fail.mockRestore();
    }
    expect(
      await source.getRepository(Workspace).findOneByOrFail({ id: row.id }),
    ).toMatchObject({ name: row.name, status: "active" });
  });

  it("keeps role and config audit unchanged when required member audit fails", async () => {
    const row = await harness.app
      .get(WorkspaceMembershipService)
      .ensureMembership({
        userId: "synthetic-member",
        organizationId: "default-org",
        workspaceId: "default-workspace",
        role: "viewer",
      });
    failInsert(ManagementAuditEvent);
    expect(
      (
        await harness.agent
          .put(`/api/dashboard/members/${row.id}`)
          .send({ role: "operator" })
      ).status,
    ).toBe(500);
    expect(
      await harness.app
        .get(WorkspaceMembershipService)
        .findActiveRole("synthetic-member", "default-workspace"),
    ).toBe("viewer");
    expect(
      await source
        .getRepository(ConfigAuditEvent)
        .count({ where: { action: "workspace_member.update" } }),
    ).toBe(0);
  });

  it("rejects member updates and invitation revocations outside the active workspace", async () => {
    const row = await harness.app
      .get(WorkspaceMembershipService)
      .ensureMembership({
        userId: "foreign-member",
        organizationId: "default-org",
        workspaceId: "foreign",
        role: "viewer",
      });
    const invite = await harness.app
      .get(WorkspaceInvitationService)
      .create({ role: "viewer", workspaceId: "foreign" });
    expect(
      (
        await harness.agent
          .put(`/api/dashboard/members/${row.id}`)
          .send({ role: "operator" })
      ).status,
    ).toBe(404);
    expect(
      (
        await harness.agent.delete(
          `/api/dashboard/members/invitations/${invite.id}`,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await source
          .getRepository(WorkspaceInvitation)
          .findOneByOrFail({ id: invite.id })
      ).status,
    ).toBe("pending");
  });

  it("rolls back invitation creation and revocation if mandatory audit cannot persist", async () => {
    const fail = failInsert(ManagementAuditEvent);
    const failed = await harness.agent
      .post("/api/dashboard/members/invitations")
      .send({ role: "viewer" });
    expect(failed.status).toBe(500);
    expect(JSON.stringify(failed.body)).not.toContain("sg_inv_");
    expect(await source.getRepository(WorkspaceInvitation).count()).toBe(0);
    fail.mockRestore();
    const created = await harness.agent
      .post("/api/dashboard/members/invitations")
      .send({ role: "viewer" });
    expect(created.status).toBe(201);
    expect(created.body.item.token).toMatch(/^sg_inv_/);
    failInsert(ManagementAuditEvent);
    expect(
      (
        await harness.agent.delete(
          `/api/dashboard/members/invitations/${created.body.item.id}`,
        )
      ).status,
    ).toBe(500);
    expect(
      (
        await source
          .getRepository(WorkspaceInvitation)
          .findOneByOrFail({ id: created.body.item.id })
      ).status,
    ).toBe("pending");
    expect(
      await source
        .getRepository(ConfigAuditEvent)
        .count({ where: { action: "workspace_invitation.revoke" } }),
    ).toBe(0);
  });

  it("does not consume a local-login invitation or issue a session after failed membership creation", async () => {
    const config = harness.app.get(ConfigService);
    jest
      .spyOn(config, "dashboard", "get")
      .mockReturnValue({
        ...config.dashboard,
        session_secret: "synthetic-workspace-session-secret",
      });
    const auth = harness.app.get(AuthService);
    jest.spyOn(auth, "isLocalPasswordAuthEnabled", "get").mockReturnValue(true);
    jest.spyOn(auth, "verifyPassword").mockResolvedValue(true);
    const issue = jest.spyOn(auth, "generateToken");
    const workspace = await harness.app
      .get(WorkspaceService)
      .createWorkspace({ name: "Invite only" });
    const invite = await harness.app
      .get(WorkspaceInvitationService)
      .create({ workspaceId: workspace.id, role: "operator" });
    const fail = failInsert(WorkspaceMembership);
    const response = await harness.agent
      .post("/api/auth/login")
      .send({ password: "synthetic", invite: invite.token });
    expect(response.status).toBe(500);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(issue).not.toHaveBeenCalled();
    expect(
      (
        await source
          .getRepository(WorkspaceInvitation)
          .findOneByOrFail({ id: invite.id })
      ).status,
    ).toBe("pending");
    fail.mockRestore();
    const retry = await harness.agent
      .post("/api/auth/login")
      .send({ password: "synthetic", invite: invite.token });
    expect(retry.status).toBe(201);
    expect(retry.body.token).toBeTruthy();
    expect(
      await harness.app
        .get(WorkspaceMembershipService)
        .findActiveRole("dashboard", workspace.id),
    ).toBe("operator");
    expect(
      (
        await source
          .getRepository(WorkspaceInvitation)
          .findOneByOrFail({ id: invite.id })
      ).status,
    ).toBe("accepted");
    expect(issue).toHaveBeenCalledTimes(1);
  });
});
