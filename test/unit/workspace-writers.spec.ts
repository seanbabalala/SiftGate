import { OidcService } from "../../src/auth/oidc.service";
import { mockConfigService } from "../helpers";
import { hashInviteToken } from "../../src/auth/workspace-invitation.service";
import {
  DataSource,
  InsertQueryBuilder,
  Repository,
  type ObjectLiteral,
} from "typeorm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { WorkspaceService } from "../../src/workspaces/workspace.service";
import { WorkspaceMembershipService } from "../../src/auth/workspace-membership.service";
import {
  WorkspaceInvitationService,
  type InvitationAcceptanceEffect,
} from "../../src/auth/workspace-invitation.service";
import { WorkspaceContextService } from "../../src/workspaces/workspace-context.service";
import { ManagementAuditService } from "../../src/audit/management-audit.service";
import { AuditRequestContextService } from "../../src/audit/audit-request-context.service";
import {
  Organization,
  Workspace,
  WorkspaceMembership,
  WorkspaceInvitation,
  ManagementAuditEvent,
  BudgetRule,
} from "../../src/database/entities";
import { coordinatedRepositoryOperation } from "../../src/database/coordinated-repository";
import { applyWorkspaceSchemaPatches, bootstrapDefaultWorkspaceMembership } from "../../src/database/workspace-schema-patch.service";

const entities = [
  Organization,
  Workspace,
  WorkspaceMembership,
  WorkspaceInvitation,
  ManagementAuditEvent,
  BudgetRule,
];
type Fixture = { source: DataSource; cleanup: () => Promise<void> };
const gate = () => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release };
};
const services = (source: DataSource) => ({
  workspaces: new WorkspaceService(
    source.getRepository(Organization),
    source.getRepository(Workspace),
  ),
  members: new WorkspaceMembershipService(
    source.getRepository(WorkspaceMembership),
  ),
  invitations: new WorkspaceInvitationService(
    source.getRepository(WorkspaceInvitation),
  ),
  audit: new ManagementAuditService(
    new WorkspaceContextService(),
    new AuditRequestContextService(),
    source.getRepository(ManagementAuditEvent),
  ),
});

function writerContract(
  label: string,
  connect: () => Promise<Fixture>,
  run: typeof describe = describe,
) {
  run(label, () => {
    let source: DataSource,
      cleanup: Fixture["cleanup"],
      app: ReturnType<typeof services>;
    const peers: DataSource[] = [];
    beforeEach(async () => {
      ({ source, cleanup } = await connect());
      app = services(source);
    });
    afterEach(async () => {
      jest.restoreAllMocks();
      for (const peer of peers.splice(0))
        if (peer.isInitialized) await peer.destroy();
      if (source?.isInitialized) await source.destroy();
      await cleanup?.();
    });
    const peer = async () => {
      if (source.options.type !== "postgres") return services(source);
      const other = await new DataSource({
        ...source.options,
        synchronize: false,
      }).initialize();
      peers.push(other);
      return services(other);
    };
    const membership = (
      userId: string,
      role: "admin" | "operator" | "viewer" = "admin",
      workspaceId = "default-workspace",
    ) =>
      app.members.ensureMembership({
        userId,
        role,
        organizationId: "default-org",
        workspaceId,
      });
    const effect =
      (userId: string): InvitationAcceptanceEffect =>
      async (accepted, manager) => {
        await app.members.withTransaction(
          (members) =>
            members.ensureMembership({
              userId,
              role: accepted.role,
              organizationId: accepted.organizationId,
              workspaceId: accepted.workspaceId,
            }),
          manager,
        );
      };
    const failInsert = (target: Function) => {
      const execute = InsertQueryBuilder.prototype.execute;
      return jest
        .spyOn(InsertQueryBuilder.prototype, "execute")
        .mockImplementation(function (this: InsertQueryBuilder<ObjectLiteral>) {
          if (
            this.expressionMap.mainAlias?.hasMetadata &&
            this.expressionMap.mainAlias.target === target
          )
            return Promise.reject(new Error("synthetic required write failed"));
          return execute.call(this);
        });
    };
    const createWithOwner = () =>
      app.workspaces.withTransaction(async (workspaces, manager) => {
        const item = await workspaces.createWorkspace({
          name: "Atomic workspace",
        });
        await app.members.withTransaction(
          (members) =>
            members.ensureMembership({
              userId: "owner",
              organizationId: item.organization_id,
              workspaceId: item.id,
              role: "admin",
            }),
          manager,
        );
        await app.audit.record(
          {
            action: "workspace.create",
            resourceType: "workspace",
            resourceId: item.id,
            workspaceId: item.id,
          },
          manager,
        );
        return item;
      });

    it("commits workspace, initial owner and audit together, without a pricing migration", async () => {
      const created = await createWithOwner();
      expect(await app.members.findActiveRole("owner", created.id)).toBe(
        "admin",
      );
      expect(await source.getRepository(ManagementAuditEvent).count()).toBe(1);
      const runner = source.createQueryRunner();
      try {
        expect(await runner.hasTable("pricing_schema_versions")).toBe(false);
      } finally {
        await runner.release();
      }
    });
    it.each([WorkspaceMembership, ManagementAuditEvent])(
      "rolls back bootstrap and workspace if required %p insert fails",
      async (target) => {
        failInsert(target);
        await expect(createWithOwner()).rejects.toThrow(
          "synthetic required write failed",
        );
        for (const entity of [
          Organization,
          Workspace,
          WorkspaceMembership,
          ManagementAuditEvent,
        ])
          expect(await source.getRepository(entity).count()).toBe(0);
      },
    );
    it("serializes initially empty organization bootstrap across connections", async () => {
      const other = await peer();
      const rows = await Promise.all([
        app.workspaces.createWorkspace({ name: "One" }),
        other.workspaces.createWorkspace({ name: "Two" }),
      ]);
      expect(new Set(rows.map((row) => row.id)).size).toBe(2);
      expect(await source.getRepository(Organization).count()).toBe(1);
    });
    it("maps concurrent duplicate workspace slugs to the domain conflict", async () => {
      const other = await peer();
      const results = await Promise.allSettled([
        app.workspaces.createWorkspace({ name: "Same" }),
        other.workspaces.createWorkspace({ name: "Same" }),
      ]);
      expect(
        results.filter((item) => item.status === "fulfilled"),
      ).toHaveLength(1);
      expect(results.find((item) => item.status === "rejected")).toMatchObject({
        reason: expect.any(ConflictException),
      });
    });
    it("preserves concurrent name and slug edits instead of stale-row replacement", async () => {
      const row = await app.workspaces.createWorkspace({ name: "Original" });
      const other = await peer();
      await Promise.all([
        app.workspaces.renameWorkspace(row.id, { name: "Changed name" }),
        other.workspaces.renameWorkspace(row.id, { slug: "changed-slug" }),
      ]);
      expect(await app.workspaces.requireWorkspace(row.id)).toMatchObject({
        name: "Changed name",
        slug: "changed-slug",
      });
    });
    it("reports a concurrent rename collision without masking unrelated errors", async () => {
      const one = await app.workspaces.createWorkspace({ name: "One" });
      const two = await app.workspaces.createWorkspace({ name: "Two" });
      const other = await peer();
      if (source.options.type === "postgres") {
        const repo = source.getRepository(Workspace);
        const index = repo.metadata.indices.find(
          (candidate) =>
            candidate.isUnique &&
            candidate.columns.some((column) => column.propertyName === "slug"),
        )!;
        await source.query(
          `ALTER INDEX "${source.options.schema}"."${index.name}" RENAME TO idx_workspaces_org_slug`,
        );
        const bothRead = gate();
        let reads = 0;
        const find = Repository.prototype.findOne;
        jest
          .spyOn(Repository.prototype, "findOne")
          .mockImplementation(async function (
            this: Repository<ObjectLiteral>,
            options,
          ) {
            const row = await find.call(this, options);
            if (
              this.metadata.target === Workspace &&
              (options.where as { slug?: string }).slug === "shared"
            ) {
              if (++reads === 2) bothRead.release();
              await bothRead.ready;
            }
            return row;
          });
      }
      const results = await Promise.allSettled([
        app.workspaces.renameWorkspace(one.id, { slug: "shared" }),
        other.workspaces.renameWorkspace(two.id, { slug: "shared" }),
      ]);
      expect(
        results.filter((item) => item.status === "fulfilled"),
      ).toHaveLength(1);
      expect(results.find((item) => item.status === "rejected")).toMatchObject({
        reason: expect.any(ConflictException),
      });
    });
    it("does not reactivate a workspace when a competing rename saves", async () => {
      const row = await app.workspaces.createWorkspace({ name: "Original" });
      const other = await peer();
      await Promise.all([
        app.workspaces.renameWorkspace(row.id, { name: "Changed" }),
        other.workspaces.setWorkspaceStatus(row.id, "disabled"),
      ]);
      expect(
        await source.getRepository(Workspace).findOneByOrFail({ id: row.id }),
      ).toMatchObject({ name: "Changed", status: "disabled" });
    });
    it("keeps one active admin under competing demotions across connections", async () => {
      const one = await membership("one"),
        two = await membership("two");
      const other = await peer();
      const results = await Promise.allSettled([
        app.members.update(one.id, { role: "viewer" }),
        other.members.update(two.id, { status: "disabled" }),
      ]);
      expect(
        results.filter((item) => item.status === "fulfilled"),
      ).toHaveLength(1);
      expect(results.find((item) => item.status === "rejected")).toMatchObject({
        reason: expect.any(BadRequestException),
      });
      expect(
        (await app.members.list()).filter(
          (member) => member.role === "admin" && member.status === "active",
        ),
      ).toHaveLength(1);
    });
    it("does not bypass last-admin protection through invitation membership upsert", async () => {
      await membership("only-admin");
      const invite = await app.invitations.create({ role: "viewer" });
      await expect(
        app.invitations.acceptForUser(
          invite.token,
          "only-admin",
          null,
          effect("only-admin"),
        ),
      ).rejects.toThrow("last active workspace Admin");
      expect(
        await app.members.findActiveRole("only-admin", "default-workspace"),
      ).toBe("admin");
      expect((await app.invitations.list())[0].status).toBe("pending");
    });
    it("concurrently ensures one membership and one default bootstrap admin", async () => {
      const other = await peer();
      await Promise.all([
        membership("one", "viewer"),
        other.members.ensureMembership({
          userId: "one",
          workspaceId: "default-workspace",
          organizationId: "default-org",
          role: "viewer",
        }),
      ]);
      const defaults = await Promise.all([
        app.members.ensureDefaultAdmin(),
        other.members.ensureDefaultAdmin(),
      ]);
      if (source.options.type === "postgres")
        expect(defaults[0].id).toMatch(/^[0-9a-f-]{36}$/);
      else expect(defaults[0].id).toBe("membership-default-dashboard-admin");
      expect(defaults[1].id).toBe(defaults[0].id);
      expect(await source.getRepository(WorkspaceMembership).count()).toBe(2);
    });
    it("bootstraps native startup tables and keeps the same admin across repeated concurrent startup inserts", async () => {
      await applyWorkspaceSchemaPatches(source);
      const repo = source.getRepository(WorkspaceMembership);
      const first = await repo.findOneByOrFail({ workspace_id: "default-workspace", user_id: "dashboard" });
      if (source.options.type === "postgres") expect(first.id).toMatch(/^[0-9a-f-]{36}$/);
      else expect(first.id).toBe("membership-default-dashboard-admin");
      await Promise.all([
        bootstrapDefaultWorkspaceMembership(source),
        bootstrapDefaultWorkspaceMembership(source),
      ]);
      await applyWorkspaceSchemaPatches(source);
      const rows = await repo.findBy({ workspace_id: "default-workspace", user_id: "dashboard" });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: first.id, role: "admin", status: "active" });
    });
    it("preserves a legacy startup administrator id and supports varchar tables without an id default", async () => {
      const repo = source.getRepository(WorkspaceMembership);
      if (source.options.type === "postgres") await source.query(
        `ALTER TABLE ${repo.metadata.tablePath} ALTER COLUMN id TYPE varchar USING id::text, ALTER COLUMN id DROP DEFAULT`,
      );
      await bootstrapDefaultWorkspaceMembership(source);
      const created = await repo.findOneByOrFail({ workspace_id: "default-workspace", user_id: "dashboard" });
      await repo.update(created.id, { id: "membership-default-dashboard-admin", role: "viewer", status: "disabled" });
      await bootstrapDefaultWorkspaceMembership(source);
      const rows = await repo.findBy({ workspace_id: "default-workspace", user_id: "dashboard" });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: "membership-default-dashboard-admin", role: "admin", status: "active" });
    });
    it("creates a new default admin in a legacy varchar table without an ID default", async () => {
      const repo = source.getRepository(WorkspaceMembership);
      if (source.options.type === "postgres")
        await source.query(
          `ALTER TABLE ${repo.metadata.tablePath} ALTER COLUMN id TYPE varchar USING id::text, ALTER COLUMN id DROP DEFAULT`,
        );
      const row = await app.members.ensureDefaultAdmin();
      expect(row).toMatchObject({
        user_id: "dashboard",
        role: "admin",
        status: "active",
      });
      if (source.options.type === "postgres")
        expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(await repo.count()).toBe(1);
    });
    it("preserves an existing legacy default administrator ID", async () => {
      const repo = source.getRepository(WorkspaceMembership);
      if (source.options.type === "postgres")
        await source.query(
          `ALTER TABLE ${repo.metadata.tablePath} ALTER COLUMN id TYPE varchar USING id::text`,
        );
      await repo.save(
        repo.create({
          id: "membership-default-dashboard-admin",
          user_id: "dashboard",
          workspace_id: "default-workspace",
          organization_id: "default-org",
          role: "admin",
          status: "active",
        }),
      );
      expect((await app.members.ensureDefaultAdmin()).id).toBe(
        "membership-default-dashboard-admin",
      );
      expect(await repo.count()).toBe(1);
    });
    it("scopes member updates and invitation revocation by workspace, not ID alone", async () => {
      const row = await membership("foreign", "viewer", "other-workspace");
      const invite = await app.invitations.create({
        workspaceId: "other-workspace",
        role: "viewer",
      });
      await expect(
        app.members.update(row.id, { status: "disabled" }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(app.invitations.revoke(invite.id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(
        await app.members.findActiveRole("foreign", "other-workspace"),
      ).toBe("viewer");
      expect((await app.invitations.list("other-workspace"))[0].status).toBe(
        "pending",
      );
    });
    it("accepts an invitation exactly once even from independent connections", async () => {
      const invite = await app.invitations.create({ role: "operator" });
      const other = await peer();
      const results = await Promise.allSettled([
        app.invitations.acceptForUser(invite.token, "one", null, effect("one")),
        other.invitations.acceptForUser(
          invite.token,
          "two",
          null,
          effect("two"),
        ),
      ]);
      expect(
        results.filter((item) => item.status === "fulfilled"),
      ).toHaveLength(1);
      expect(await source.getRepository(WorkspaceMembership).count()).toBe(1);
      const accepted = (await app.invitations.list())[0];
      expect(
        await app.members.findActiveRole(
          accepted.accepted_by_user_id!,
          "default-workspace",
        ),
      ).toBe("operator");
    });
    it("preserves the invitation and membership on failed acceptance effect, allowing retry", async () => {
      const invite = await app.invitations.create({ role: "operator" });
      await expect(
        app.invitations.acceptForUser(
          invite.token,
          "one",
          null,
          async (accepted, manager) => {
            await effect("one")(accepted, manager);
            throw new Error("synthetic membership effect failure");
          },
        ),
      ).rejects.toThrow("synthetic membership effect failure");
      expect(await source.getRepository(WorkspaceMembership).count()).toBe(0);
      expect((await app.invitations.list())[0]).toMatchObject({
        status: "pending",
        accepted_at: null,
        accepted_by_user_id: null,
      });
      await app.invitations.acceptForUser(
        invite.token,
        "one",
        null,
        effect("one"),
      );
      expect(await app.members.findActiveRole("one", "default-workspace")).toBe(
        "operator",
      );
    });
    it("uses the invitation transaction for OIDC membership creation before issuing a session", async () => {
      const invitation = await app.invitations.create({
        workspaceId: "oidc-workspace",
        role: "operator",
        email: "identity@example.com",
      });
      const auth = { generateToken: jest.fn(() => "synthetic-session") };
      const oidc = new OidcService(
        mockConfigService({
          dashboardOidc: {
            enabled: true,
            issuer: "https://identity.example",
            client_id: "synthetic",
            redirect_uri: "http://127.0.0.1/callback",
            allowed_domains: [],
            default_role: "viewer",
            default_workspace_id: "default-workspace",
          },
        }),
        auth as never,
        {} as never,
        app.members,
        app.invitations,
        {} as never,
      );
      const privateOidc = oidc as unknown as {
        consumeState: () => Promise<unknown>;
        exchangeCode: () => Promise<unknown>;
        resolveIdentity: () => Promise<unknown>;
      };
      jest.spyOn(privateOidc, "consumeState").mockResolvedValue({
        nonce: "synthetic-nonce",
        createdAt: Date.now(),
        inviteTokenHash: hashInviteToken(invitation.token),
      });
      jest.spyOn(privateOidc, "exchangeCode").mockResolvedValue({});
      jest
        .spyOn(privateOidc, "resolveIdentity")
        .mockResolvedValue({ sub: "synthetic", email: "identity@example.com" });
      const fail = failInsert(WorkspaceMembership);
      await expect(
        oidc.completeCallback({
          state: "synthetic-state",
          code: "synthetic-code",
        }),
      ).rejects.toThrow("synthetic required write failed");
      expect(auth.generateToken).not.toHaveBeenCalled();
      expect((await app.invitations.list("oidc-workspace"))[0].status).toBe(
        "pending",
      );
      fail.mockRestore();
      expect(
        await oidc.completeCallback({
          state: "new-synthetic-state",
          code: "new-synthetic-code",
        }),
      ).toMatchObject({
        workspace_id: "oidc-workspace",
        role: "operator",
        token: "synthetic-session",
      });
      expect(
        await app.members.findActiveRole(
          "oidc:identity@example.com",
          "oidc-workspace",
        ),
      ).toBe("operator");
      expect(
        await app.members.findActiveRole(
          "oidc:identity@example.com",
          "default-workspace",
        ),
      ).toBeNull();
      expect(auth.generateToken).toHaveBeenCalledTimes(1);
    });
    it("commits expiry before rejecting acceptance, without creating a member", async () => {
      const invite = await app.invitations.create({ role: "viewer" });
      await source
        .getRepository(WorkspaceInvitation)
        .update({ id: invite.id }, { expires_at: new Date(0).toISOString() });
      const callback = jest.fn();
      await expect(
        app.invitations.acceptForUser(invite.token, "one", null, callback),
      ).rejects.toThrow("has expired");
      expect(
        (
          await source
            .getRepository(WorkspaceInvitation)
            .findOneByOrFail({ id: invite.id })
        ).status,
      ).toBe("expired");
      expect(callback).not.toHaveBeenCalled();
    });
    it("expires only the listed workspace and never overwrites accepted invitations", async () => {
      const own = await app.invitations.create({ role: "viewer" });
      const foreign = await app.invitations.create({
        role: "viewer",
        workspaceId: "foreign",
      });
      const accepted = await app.invitations.create({ role: "viewer" });
      await app.invitations.acceptForUser(accepted.token, "one");
      for (const row of [own, foreign, accepted])
        await source
          .getRepository(WorkspaceInvitation)
          .update({ id: row.id }, { expires_at: new Date(0).toISOString() });
      await app.invitations.list();
      const repo = source.getRepository(WorkspaceInvitation);
      expect((await repo.findOneByOrFail({ id: own.id })).status).toBe(
        "expired",
      );
      expect((await repo.findOneByOrFail({ id: foreign.id })).status).toBe(
        "pending",
      );
      expect((await repo.findOneByOrFail({ id: accepted.id })).status).toBe(
        "accepted",
      );
    });
    it("does not accept a revocation that commits while acceptance is competing", async () => {
      const invite = await app.invitations.create({ role: "viewer" });
      const entered = gate(),
        release = gate();
      const other = await peer();
      const revocation = app.invitations.withTransaction(
        async (invitations) => {
          await invitations.revoke(invite.id);
          entered.release();
          await release.ready;
        },
      );
      await entered.ready;
      const acceptance = other.invitations.acceptForUser(
        invite.token,
        "one",
        null,
        effect("one"),
      );
      // Register rejection immediately; do not rely on wall-clock contention sleeps.
      const result = Promise.allSettled([acceptance]);
      release.release();
      await revocation;
      expect(await result).toMatchObject([
        { status: "rejected", reason: expect.any(BadRequestException) },
      ]);
      expect(await source.getRepository(WorkspaceMembership).count()).toBe(0);
    });
    it("does not expose rolled-back member permissions or workspace status to cooperating reads", async () => {
      const row = await membership("reader", "viewer");
      const workspace = await app.workspaces.createWorkspace({
        name: "Read isolation",
      });
      const entered = gate(),
        release = gate();
      const write = app.members.withTransaction(async (members, manager) => {
        await members.update(row.id, { role: "operator" });
        await app.workspaces.withTransaction(
          (workspaces) =>
            workspaces.setWorkspaceStatus(workspace.id, "disabled"),
          manager,
        );
        entered.release();
        await release.ready;
        throw new Error("rollback");
      });
      const result = Promise.allSettled([write]);
      await entered.ready;
      const reads = Promise.all([
        app.members.findActiveRole("reader", "default-workspace"),
        app.workspaces.requireWorkspace(workspace.id),
      ]);
      release.release();
      await result;
      expect(await reads).toEqual([
        "viewer",
        expect.objectContaining({ status: "active" }),
      ]);
    });
    it("keeps queued administrator writes outside a rolled-back monetary transaction", async () => {
      const entered = gate(),
        release = gate();
      const tx = coordinatedRepositoryOperation(
        source.getRepository(BudgetRule),
        true,
        async (manager) => {
          expect(manager?.queryRunner?.isTransactionActive).toBe(true);
          entered.release();
          await release.ready;
          throw new Error("monetary rollback");
        },
      );
      const result = Promise.allSettled([tx]);
      await entered.ready;
      const writes = Promise.all([
        app.workspaces.createWorkspace({ name: "Survives" }),
        membership("survives", "viewer"),
        app.invitations.create({ role: "viewer" }),
      ]);
      release.release();
      await result;
      await writes;
      expect(await source.getRepository(Workspace).count()).toBe(1);
      expect(await source.getRepository(WorkspaceMembership).count()).toBe(1);
      expect(await source.getRepository(WorkspaceInvitation).count()).toBe(1);
    });
    it("rolls back membership, workspace and revocation if a required audit fails", async () => {
      const row = await membership("one", "viewer");
      const workspace = await app.workspaces.createWorkspace({
        name: "Original",
      });
      const invite = await app.invitations.create({ role: "viewer" });
      failInsert(ManagementAuditEvent);
      await expect(
        app.members.withTransaction(async (members, manager) => {
          await members.update(row.id, { role: "operator" });
          await app.workspaces.withTransaction(
            (workspaces) =>
              workspaces.renameWorkspace(workspace.id, { name: "Uncommitted" }),
            manager,
          );
          await app.invitations.withTransaction(
            (invitations) => invitations.revoke(invite.id),
            manager,
          );
          await app.audit.record(
            { action: "test.required", resourceType: "workspace" },
            manager,
          );
        }),
      ).rejects.toThrow("synthetic required write failed");
      expect(await app.members.findActiveRole("one", "default-workspace")).toBe(
        "viewer",
      );
      expect((await app.workspaces.requireWorkspace(workspace.id)).name).toBe(
        "Original",
      );
      expect((await app.invitations.list())[0].status).toBe("pending");
    });
    it("rejects inactive or foreign transaction managers for each service", async () => {
      for (const service of [app.workspaces, app.members, app.invitations]) {
        expect(() =>
          service.withTransaction(async () => null, source.manager),
        ).toThrow("active transaction");
      }
      const other = await connect();
      try {
        await other.source.transaction(async (manager) => {
          for (const service of [app.workspaces, app.members, app.invitations])
            expect(() =>
              service.withTransaction(async () => null, manager),
            ).toThrow("same database");
        });
      } finally {
        await other.source.destroy();
        await other.cleanup();
      }
    });
  });
}
writerContract("SQLite coordinated workspace writers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "workspace-writers-"));
  const source = await new DataSource({
    type: "better-sqlite3",
    database: join(directory, "database.sqlite"),
    entities,
    synchronize: true,
  }).initialize();
  await source.query("PRAGMA journal_mode=WAL");
  return {
    source,
    cleanup: async () => rmSync(directory, { recursive: true, force: true }),
  };
});
const pgUrl = process.env.SIFTGATE_PRICING_TEST_POSTGRES_URL;
if (pgUrl) {
  const url = new URL(pgUrl);
  if (
    url.hostname !== "127.0.0.1" ||
    !/^\/pricing_goal_[a-z0-9_]+$/.test(url.pathname)
  )
    throw new Error("Use the isolated PostgreSQL test database");
}
writerContract(
  "PostgreSQL coordinated workspace writers",
  async () => {
    if (!pgUrl) throw new Error("No isolated PostgreSQL URL");
    const schema = `workspace_writers_${process.pid}_${Math.random().toString(16).slice(2)}`;
    const admin = await new DataSource({
      type: "postgres",
      url: pgUrl,
      synchronize: false,
    }).initialize();
    let source: DataSource | undefined,
      created = false;
    try {
      // Keep shared UUID support outside disposable schemas. Nested fixture schemas
      // must not depend on an extension owned by the first fixture's search_path.
      await admin.query(
        'CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public',
      );
      await admin.query(`CREATE SCHEMA "${schema}"`);
      created = true;
      source = new DataSource({
        type: "postgres",
        url: pgUrl,
        schema,
        installExtensions: false,
        extra: { options: `-c search_path=${schema},public`, max: 6 },
        entities,
        synchronize: true,
      });
      await source.initialize();
      return {
        source,
        cleanup: async () => {
          try {
            await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
          } finally {
            await admin.destroy();
          }
        },
      };
    } catch (error) {
      if (source?.isInitialized) await source.destroy();
      try {
        if (created) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await admin.destroy();
      }
      throw error;
    }
  },
  pgUrl ? describe : describe.skip,
);
