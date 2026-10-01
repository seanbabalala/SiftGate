import {
  DataSource,
  InsertQueryBuilder,
  Repository,
  type ObjectLiteral,
} from "typeorm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GatewayApiKeyService } from "../../src/auth/gateway-api-key.service";
import { TeamService } from "../../src/auth/team.service";
import { BudgetService } from "../../src/budget/budget.service";
import { ManagementAuditService } from "../../src/audit/management-audit.service";
import { AuditRequestContextService } from "../../src/audit/audit-request-context.service";
import { ConfigAuditService } from "../../src/dashboard/config-audit.service";
import { WorkspaceContextService } from "../../src/workspaces/workspace-context.service";
import { DEFAULT_WORKSPACE_ID } from "../../src/workspaces/workspace.constants";
import {
  GatewayApiKey,
  LocalTeam,
  BudgetRule,
  CallLog,
  ManagementAuditEvent,
  ConfigAuditEvent,
  ConfigVersion,
} from "../../src/database/entities";
import { coordinatedRepositoryOperation } from "../../src/database/coordinated-repository";
import { applyPricingSchema } from "../../src/pricing/pricing-schema";
import { mockConfigService } from "../helpers";
import { BadRequestException } from "@nestjs/common";

const entities = [
  GatewayApiKey,
  LocalTeam,
  BudgetRule,
  CallLog,
  ManagementAuditEvent,
  ConfigAuditEvent,
  ConfigVersion,
];
const workspace = DEFAULT_WORKSPACE_ID;
type Fixture = { source: DataSource; cleanup: () => Promise<void> };
const gate = () => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release };
};

function writerContract(
  label: string,
  connect: () => Promise<Fixture>,
  run: typeof describe = describe,
) {
  run(label, () => {
    let source: DataSource,
      cleanup: Fixture["cleanup"],
      contexts: WorkspaceContextService,
      auditContext: AuditRequestContextService;
    let keys: GatewayApiKeyService,
      teams: TeamService,
      budgets: BudgetService,
      audit: ManagementAuditService,
      configAudit: ConfigAuditService;
    const config = mockConfigService({
      configAudit: {
        enabled: true,
        capture_startup_snapshot: false,
        max_versions: 10,
        max_events: 100,
      },
      budget: {
        daily_token_limit: 100000,
        daily_cost_limit: 100,
        alert_threshold: 0.5,
      },
    });
    const services = (db: DataSource) => {
      const management = new ManagementAuditService(
        contexts,
        auditContext,
        db.getRepository(ManagementAuditEvent),
      );
      return {
        keys: new GatewayApiKeyService(
          config,
          contexts,
          db.getRepository(GatewayApiKey),
          db.getRepository(LocalTeam),
          db.getRepository(BudgetRule),
          db.getRepository(CallLog),
        ),
        teams: new TeamService(
          config,
          contexts,
          db.getRepository(LocalTeam),
          db.getRepository(BudgetRule),
          db.getRepository(CallLog),
        ),
        audit: management,
        configAudit: new ConfigAuditService(
          config,
          contexts,
          db.getRepository(ConfigVersion),
          db.getRepository(ConfigAuditEvent),
          management,
        ),
        budgets: new BudgetService(
          config,
          contexts,
          db.getRepository(BudgetRule),
          undefined,
          undefined,
          management,
        ),
      };
    };
    beforeEach(async () => {
      ({ source, cleanup } = await connect());
      await applyPricingSchema(source);
      contexts = new WorkspaceContextService();
      auditContext = new AuditRequestContextService();
      ({ keys, teams, budgets, audit, configAudit } = services(source));
      budgets.enableExactLedger();
    });
    afterEach(async () => {
      jest.restoreAllMocks();
      budgets?.onModuleDestroy();
      if (source?.isInitialized) await source.destroy();
      await cleanup?.();
    });
    const createKey = () =>
      keys.create({
        name: "Synthetic owner",
        allow_direct: true,
        daily_token_limit: 1000,
        daily_cost_limit: 10,
      });
    const identity = (key: { id: string; name: string }) => ({
      workspaceId: workspace,
      apiKeyId: key.id,
      apiKeyName: key.name,
      namespaceId: null,
      teamId: null,
    });
    const credit = (key: { id: string; name: string }, amount: string) =>
      budgets.withCommittedBudgetEffects(() =>
        coordinatedRepositoryOperation(
          source.getRepository(BudgetRule),
          true,
          async (manager) => {
            if (!manager) throw new Error("Fixture transaction is required");
            const holds = await budgets.reserveLedger(
              manager,
              identity(key),
              "0",
              amount,
            );
            await budgets.settleLedger(
              manager,
              identity(key),
              holds,
              "0",
              amount,
            );
          },
        ),
      );
    const exact = async (id: string) =>
      (await budgets.getStatus(null, id)).find(
        (rule) => rule.type === "daily_cost",
      )!.currentExact;
    const failInsert = (target: Function, occurrence = 1) => {
      const execute = InsertQueryBuilder.prototype.execute;
      let calls = 0;
      return jest
        .spyOn(InsertQueryBuilder.prototype, "execute")
        .mockImplementation(function (this: InsertQueryBuilder<ObjectLiteral>) {
          if (
            this.expressionMap.mainAlias?.hasMetadata &&
            this.expressionMap.mainAlias.target === target &&
            ++calls === occurrence
          )
            return Promise.reject(new Error("synthetic atomic write failure"));
          return execute.call(this);
        });
    };

    it("preserves an exact committed balance and epoch while updating key limits and name", async () => {
      const created = await createKey();
      await credit(created.item, "0.123456789012345678");
      const before = await source
        .getRepository(BudgetRule)
        .find({ where: { api_key_id: created.item.id }, order: { id: "ASC" } });
      await keys.update(created.item.id, {
        name: "Renamed owner",
        daily_cost_limit: 20,
      });
      const after = await source
        .getRepository(BudgetRule)
        .find({ where: { api_key_id: created.item.id }, order: { id: "ASC" } });
      expect(after).toHaveLength(2);
      expect(after.map((row) => row.period_start.toISOString())).toEqual(
        before.map((row) => row.period_start.toISOString()),
      );
      expect(after.map((row) => row.current_value)).toEqual(
        before.map((row) => row.current_value),
      );
      expect(after.every((row) => row.api_key_name === "Renamed owner")).toBe(
        true,
      );
      expect(await exact(created.item.id)).toBe("0.123456789012345678");
    });

    it("does not copy a stale budget balance from a configuration read back to storage", async () => {
      const created = await createKey();
      const stale = await source
        .getRepository(BudgetRule)
        .findOneByOrFail({ api_key_id: created.item.id, type: "daily_cost" });
      await credit(created.item, "7.000000000000000001");
      const find = Repository.prototype.findOne;
      const read = jest
        .spyOn(Repository.prototype, "findOne")
        .mockImplementation(function (
          this: Repository<ObjectLiteral>,
          options,
        ) {
          if (
            this.metadata.target === BudgetRule &&
            JSON.stringify(options.where).includes('"type":"daily_cost"')
          )
            return Promise.resolve({ ...stale });
          return find.call(this, options);
        });
      try {
        await keys.update(created.item.id, { daily_cost_limit: 20 });
      } finally {
        read.mockRestore();
      }
      expect(await exact(created.item.id)).toBe("7.000000000000000001");
    });

    it.each(["commit", "rollback"] as const)(
      "does not join a concurrent ledger transaction that will %s",
      async (outcome) => {
        const created = await createKey(),
          entered = gate(),
          release = gate();
        const mutation = budgets
          .withCommittedBudgetEffects(() =>
            coordinatedRepositoryOperation(
              source.getRepository(BudgetRule),
              true,
              async (manager) => {
                await budgets.reserveLedger(
                  manager!,
                  identity(created.item),
                  "0",
                  "7",
                );
                entered.release();
                await release.ready;
                if (outcome === "rollback")
                  throw new Error("synthetic unrelated rollback");
              },
            ),
          )
          .then(
            () => "commit",
            () => "rollback",
          );
        await entered.ready;
        const update = keys.update(created.item.id, {
          name: "Surviving admin change",
          daily_cost_limit: 20,
        });
        try {
          await new Promise((resolve) => setTimeout(resolve, 15));
        } finally {
          release.release();
        }
        expect(await mutation).toBe(outcome);
        await update;
        expect((await keys.getSummary(created.item.id)).name).toBe(
          "Surviving admin change",
        );
        expect(await exact(created.item.id)).toBe(
          outcome === "commit"
            ? "7.000000000000000000"
            : "0.000000000000000000",
        );
      },
    );

    it("serializes concurrent administrator changes without losing distinct fields or creating duplicate rules", async () => {
      const created = await createKey();
      const other =
        source.options.type === "postgres"
          ? await new DataSource({
              ...source.options,
              synchronize: false,
            }).initialize()
          : source;
      try {
        await Promise.all([
          keys.update(created.item.id, { name: "Concurrent rename" }),
          services(other).keys.update(created.item.id, {
            daily_cost_limit: 25,
          }),
        ]);
        expect(await keys.getSummary(created.item.id)).toMatchObject({
          name: "Concurrent rename",
          daily_cost_limit: 25,
        });
        expect(
          await source
            .getRepository(BudgetRule)
            .count({ where: { api_key_id: created.item.id } }),
        ).toBe(2);
      } finally {
        if (other !== source) await other.destroy();
      }
    });

    it.each(["key", "team"] as const)(
      "returns a domain conflict for concurrent duplicate %s names without partial rows",
      async (kind) => {
        const target = kind === "key" ? GatewayApiKey : LocalTeam;
        const barrier = gate();
        let arrivals = 0;
        const find = Repository.prototype.findOne;
        const lookup = jest
          .spyOn(Repository.prototype, "findOne")
          .mockImplementation(async function (
            this: Repository<ObjectLiteral>,
            options,
          ) {
            const result = await find.call(this, options);
            if (
              source.options.type === "postgres" &&
              this.metadata.target === target &&
              JSON.stringify(options.where).includes('"name":"Collision"')
            ) {
              if (++arrivals === 2) barrier.release();
              await barrier.ready;
            }
            return result;
          });
        try {
          const create = () =>
            kind === "key"
              ? keys.create({ name: "Collision", daily_cost_limit: 10 })
              : teams.create({ name: "Collision", daily_cost_limit: 10 });
          const results = await Promise.allSettled([create(), create()]);
          expect(
            results.filter((result) => result.status === "fulfilled"),
          ).toHaveLength(1);
          const rejected = results.find(
            (result) => result.status === "rejected",
          ) as PromiseRejectedResult;
          expect(rejected.reason).toBeInstanceOf(BadRequestException);
          expect(rejected.reason.message).toContain("name already exists");
          expect(await source.getRepository(target).count()).toBe(1);
          expect(await source.getRepository(BudgetRule).count()).toBe(1);
        } finally {
          barrier.release();
          lookup.mockRestore();
        }
      },
    );

    it("rolls back key creation if the second budget rule cannot be inserted", async () => {
      const failure = failInsert(BudgetRule, 2);
      try {
        await expect(createKey()).rejects.toThrow(
          "synthetic atomic write failure",
        );
      } finally {
        failure.mockRestore();
      }
      expect(await source.getRepository(GatewayApiKey).count()).toBe(0);
      expect(await source.getRepository(BudgetRule).count()).toBe(0);
    });

    it("rolls back policy, budget and config audit together if mandatory management audit fails", async () => {
      const created = await createKey();
      await credit(created.item, "7.000000000000000001");
      const failure = failInsert(ManagementAuditEvent);
      try {
        await expect(
          keys.withTransaction(async (service, manager) => {
            await service.update(created.item.id, {
              name: "Must roll back",
              daily_cost_limit: 20,
            });
            await configAudit.recordManagementEvent(
              {
                action: "api_key.update",
                target: `api_key:${created.item.id}`,
                afterSummary: { name: "Must roll back" },
              },
              manager,
            );
          }),
        ).rejects.toThrow("synthetic atomic write failure");
      } finally {
        failure.mockRestore();
      }
      expect(await keys.getSummary(created.item.id)).toMatchObject({
        name: created.item.name,
        daily_cost_limit: 10,
      });
      expect(await exact(created.item.id)).toBe("7.000000000000000001");
      expect(await source.getRepository(ManagementAuditEvent).count()).toBe(0);
      expect(await source.getRepository(ConfigAuditEvent).count()).toBe(0);
    });

    it("captures real actor and before/after state within the same policy transaction without secret material", async () => {
      const created = await createKey();
      await auditContext.run(
        {
          requestId: "synthetic-admin-request",
          actorId: "actual-administrator",
          actorType: "dashboard",
          method: "PUT",
          path: "/api/dashboard/api-keys/synthetic",
          source: "dashboard",
        },
        () =>
          keys.withTransaction(async (service, manager) => {
            const before = await service.getSummary(created.item.id);
            const after = await service.update(created.item.id, {
              daily_cost_limit: 20,
            });
            await configAudit.recordManagementEvent(
              {
                action: "api_key.update",
                target: `api_key:${created.item.id}`,
                beforeSummary: { limit: before.daily_cost_limit },
                afterSummary: {
                  limit: after.daily_cost_limit,
                  key: created.key,
                },
              },
              manager,
            );
          }),
      );
      const events = await source.getRepository(ManagementAuditEvent).find();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actor_id: "actual-administrator",
        request_id: "synthetic-admin-request",
        workspace_id: workspace,
      });
      expect(JSON.parse(events[0].before_summary_json!)).toEqual({ limit: 10 });
      expect(JSON.parse(events[0].after_summary_json!)).toEqual({
        limit: 20,
        key: "[redacted]",
      });
      const configEvents = await source.getRepository(ConfigAuditEvent).find();
      expect(configEvents[0].actor).toBe("dashboard:actual-administrator");
      expect(JSON.stringify([events, configEvents])).not.toContain(created.key);
    });

    it("cannot resurrect a rotated or disabled key by saving stale last-used metadata", async () => {
      const created = await createKey();
      const stale = await source
        .getRepository(GatewayApiKey)
        .findOneByOrFail({ id: created.item.id });
      const rotated = await keys.rotate(created.item.id);
      const updateStale = () =>
        keys.withTransaction((service) =>
          (
            service as unknown as {
              recordLastUsed: (
                entity: GatewayApiKey,
                team: LocalTeam | null,
                ip: string,
                now: Date,
              ) => Promise<void>;
            }
          ).recordLastUsed(stale, null, "127.0.0.2", new Date()),
        );
      await updateStale();
      expect(await keys.findContextByPlainKey(created.key)).toBeNull();
      expect(await keys.findContextByPlainKey(rotated.key)).not.toBeNull();
      await keys.update(created.item.id, {
        status: "disabled",
        daily_cost_limit: 30,
      });
      await updateStale();
      expect(await keys.getSummary(created.item.id)).toMatchObject({
        status: "disabled",
        daily_cost_limit: 30,
      });
      expect(await keys.findContextByPlainKey(rotated.key)).toBeNull();
    });

    it("does not regress key/team activity when an older request finishes its metadata write later", async () => {
      const team = await teams.create({ name: "Activity owner" });
      const owner = await keys.create({
        name: "Activity key",
        team_id: team.id,
      });
      const key = await source
        .getRepository(GatewayApiKey)
        .findOneByOrFail({ id: owner.item.id });
      const row = await source
        .getRepository(LocalTeam)
        .findOneByOrFail({ id: team.id });
      const later = new Date(Date.now() + 60000),
        earlier = new Date(later.getTime() - 1000);
      const write = (date: Date, ip: string) =>
        keys.withTransaction((service) =>
          (
            service as unknown as {
              recordLastUsed: (
                entity: GatewayApiKey,
                team: LocalTeam,
                ip: string,
                now: Date,
              ) => Promise<void>;
            }
          ).recordLastUsed(key, row, ip, date),
        );
      await write(later, "127.0.0.2");
      await write(earlier, "127.0.0.1");
      const saved = await source
        .getRepository(GatewayApiKey)
        .findOneByOrFail({ id: key.id });
      expect(saved.last_used_at).toEqual(later);
      expect(saved.last_used_ip).toBe("127.0.0.2");
      expect(
        (await source.getRepository(LocalTeam).findOneByOrFail({ id: row.id }))
          .last_used_at,
      ).toEqual(later);
      await teams.touchUsage(row.id, earlier);
      expect(
        (await source.getRepository(LocalTeam).findOneByOrFail({ id: row.id }))
          .last_used_at,
      ).toEqual(later);
    });

    it("does not authenticate using permissions from an administrator transaction that rolls back", async () => {
      const owner = await keys.create({
        name: "Committed permissions",
        allow_direct: false,
      });
      const entered = gate(),
        release = gate();
      const update = keys
        .withTransaction(async (service) => {
          await service.update(owner.item.id, { allow_direct: true });
          entered.release();
          await release.ready;
          throw new Error("permission update rolled back");
        })
        .catch(() => undefined);
      await entered.ready;
      const authorization = keys.findContextByPlainKey(owner.key);
      try {
        await new Promise((resolve) => setTimeout(resolve, 15));
      } finally {
        release.release();
      }
      await update;
      expect((await authorization)?.allow_direct).toBe(false);
    });

    it("retains team balances, epochs and restrictions across updates and stale usage writes", async () => {
      const team = await teams.create({
        name: "Synthetic team",
        daily_cost_limit: 10,
        allowed_models: ["original"],
      });
      const stale = await source
        .getRepository(LocalTeam)
        .findOneByOrFail({ id: team.id });
      await budgets.withCommittedBudgetEffects(() =>
        coordinatedRepositoryOperation(
          source.getRepository(BudgetRule),
          true,
          async (manager) => {
            await budgets.reserveLedger(
              manager!,
              {
                workspaceId: workspace,
                apiKeyId: null,
                apiKeyName: null,
                namespaceId: null,
                teamId: team.id,
              },
              "0",
              "7.000000000000000001",
            );
          },
        ),
      );
      const before = await source
        .getRepository(BudgetRule)
        .findOneByOrFail({ team_id: team.id });
      await teams.update(team.id, {
        daily_cost_limit: 20,
        allowed_models: ["new-model"],
        status: "disabled",
      });
      const created = await createKey();
      const key = await source
        .getRepository(GatewayApiKey)
        .findOneByOrFail({ id: created.item.id });
      await keys.withTransaction((service) =>
        (
          service as unknown as {
            recordLastUsed: (
              entity: GatewayApiKey,
              team: LocalTeam,
              ip: string,
              now: Date,
            ) => Promise<void>;
          }
        ).recordLastUsed(key, stale, "127.0.0.1", new Date()),
      );
      expect(await teams.getSummary(team.id)).toMatchObject({
        status: "disabled",
        allowed_models: ["new-model"],
        daily_cost_limit: 20,
      });
      const after = await source
        .getRepository(BudgetRule)
        .findOneByOrFail({ id: before.id });
      expect(after.current_value).toBe(before.current_value);
      expect(after.period_start).toEqual(before.period_start);
      expect(after.is_active).toBe(false);
    });

    it("does not duplicate default-workspace legacy-null budget rules during rename and limit updates", async () => {
      const created = await createKey();
      await source
        .getRepository(BudgetRule)
        .update({ api_key_id: created.item.id }, { workspace_id: null });
      await credit(created.item, "2.000000000000000001");
      await keys.update(created.item.id, {
        name: "Legacy renamed",
        daily_cost_limit: 20,
      });
      const rows = await source
        .getRepository(BudgetRule)
        .find({ where: { api_key_id: created.item.id } });
      expect(rows).toHaveLength(2);
      expect(
        rows.every(
          (row) =>
            row.workspace_id === null && row.api_key_name === "Legacy renamed",
        ),
      ).toBe(true);
      expect(await exact(created.item.id)).toBe("2.000000000000000001");
    });

    it("cannot mutate another workspace owner or its budgets", async () => {
      const created = await createKey();
      await expect(
        contexts.run({ workspaceId: "foreign-workspace" }, () =>
          keys.update(created.item.id, { daily_cost_limit: 100 }),
        ),
      ).rejects.toThrow("not found");
      expect((await keys.getSummary(created.item.id)).daily_cost_limit).toBe(
        10,
      );
      expect(await source.getRepository(BudgetRule).count()).toBe(2);
    });

    it("serializes the audit head across concurrent service instances, including an initially empty chain", async () => {
      const other =
        source.options.type === "postgres"
          ? await new DataSource({
              ...source.options,
              synchronize: false,
            }).initialize()
          : source;
      try {
        const second = services(other).audit;
        const results = await Promise.all(
          Array.from({ length: 6 }, (_, index) =>
            (index % 2 ? second : audit).record({
              action: "synthetic.append",
              resourceType: "test",
              resourceId: String(index),
            }),
          ),
        );
        expect(results.every(Boolean)).toBe(true);
        const rows = await source
          .getRepository(ManagementAuditEvent)
          .find({ order: { id: "ASC" } });
        expect(rows).toHaveLength(6);
        expect(rows[0].previous_hash).toBeNull();
        for (let index = 1; index < rows.length; index++)
          expect(rows[index].previous_hash).toBe(rows[index - 1].event_hash);
      } finally {
        if (other !== source) await other.destroy();
      }
    });

    it("rolls back a manual reset, epoch and audit when audit persistence fails", async () => {
      const created = await createKey();
      await credit(created.item, "7.000000000000000001");
      const rule = await source
        .getRepository(BudgetRule)
        .findOneByOrFail({ api_key_id: created.item.id, type: "daily_cost" });
      const fail = failInsert(ManagementAuditEvent);
      try {
        await expect(budgets.resetRule(rule.id)).rejects.toThrow(
          "synthetic atomic write failure",
        );
      } finally {
        fail.mockRestore();
      }
      expect(await exact(created.item.id)).toBe("7.000000000000000001");
      expect(
        (
          await source
            .getRepository(BudgetRule)
            .findOneByOrFail({ id: rule.id })
        ).period_start,
      ).toEqual(rule.period_start);
      expect(await source.getRepository(ManagementAuditEvent).count()).toBe(0);
      await budgets.resetRule(rule.id);
      const event = await source
        .getRepository(ManagementAuditEvent)
        .findOneByOrFail({ action: "budget.rule.reset" });
      expect(JSON.parse(event.before_summary_json!).current_exact).toBe(
        "7.000000000000000001",
      );
      expect(await exact(created.item.id)).toBe("0.000000000000000000");
    });

    it("rejects a nontransactional or foreign-database audit manager", async () => {
      await expect(
        audit.record(
          { action: "invalid", resourceType: "test" },
          source.manager,
        ),
      ).rejects.toThrow("active transaction");
      const other = await connect();
      try {
        await expect(
          other.source.transaction((manager) =>
            audit.record({ action: "foreign", resourceType: "test" }, manager),
          ),
        ).rejects.toThrow("same database");
      } finally {
        await other.source.destroy();
        await other.cleanup();
      }
      expect(await source.getRepository(ManagementAuditEvent).count()).toBe(0);
    });

    it("supports key and team administration before the pricing migration exists", async () => {
      const legacy = await connect();
      try {
        const app = services(legacy.source);
        const team = await app.teams.create({
          name: "Legacy team",
          daily_cost_limit: 5,
        });
        const created = await app.keys.create({
          name: "Legacy key",
          team_id: team.id,
          daily_cost_limit: 4,
        });
        await app.keys.update(created.item.id, { daily_cost_limit: 3 });
        expect(await app.keys.findContextByPlainKey(created.key)).toMatchObject(
          { team_id: team.id },
        );
        const runner = legacy.source.createQueryRunner();
        try {
          expect(await runner.hasTable("pricing_schema_versions")).toBe(false);
        } finally {
          await runner.release();
        }
      } finally {
        await legacy.source.destroy();
        await legacy.cleanup();
      }
    });
  });
}

writerContract("SQLite coordinated admin writers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "admin-writers-"));
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
  "PostgreSQL coordinated admin writers",
  async () => {
    if (!pgUrl) throw new Error("No isolated PostgreSQL URL");
    const schema = `admin_writers_${process.pid}_${Math.random().toString(16).slice(2)}`;
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
