import { DataSource, type EntityManager } from "typeorm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BudgetService,
  BudgetExceededError,
} from "../../src/budget/budget.service";
import { BudgetRule } from "../../src/database/entities/budget-rule.entity";
import type { AlertService } from "../../src/alerts/alert.service";
import type { GatewayAlertEvent } from "../../src/alerts/alert.types";
import type { TelemetryService } from "../../src/telemetry/telemetry.service";
import { WorkspaceContextService } from "../../src/workspaces/workspace-context.service";
import { DEFAULT_WORKSPACE_ID } from "../../src/workspaces/workspace.constants";
import { serializeDatabaseAccess } from "../../src/database/database-serialization";
import { applyPricingSchema } from "../../src/pricing/pricing-schema";
import { mockConfigService } from "../helpers";

const workspace = DEFAULT_WORKSPACE_ID;
const identity = {
  workspaceId: workspace,
  apiKeyName: null,
  apiKeyId: null,
  namespaceId: null,
  teamId: null,
};
type Fixture = { source: DataSource; cleanup: () => Promise<void> };

function observerContract(
  name: string,
  connect: () => Promise<Fixture>,
  run: typeof describe = describe,
) {
  run(name, () => {
    let source: DataSource,
      cleanup: Fixture["cleanup"],
      budgets: BudgetService,
      rule: BudgetRule;
    let alerts: { emit: jest.Mock<void, [GatewayAlertEvent]> };
    let metricReader:
      | ((observer: { observe: (value: number) => void }) => void)
      | undefined;
    beforeEach(async () => {
      ({ source, cleanup } = await connect());
      await applyPricingSchema(source);
      const repo = source.getRepository(BudgetRule);
      rule = await repo.save(
        repo.create({
          workspace_id: workspace,
          type: "daily_cost",
          current_value: 0,
          limit_value: 10,
          alert_threshold: 0.8,
          period_start: new Date(),
          is_active: true,
          api_key_id: null,
          api_key_name: null,
          namespace_id: null,
          team_id: null,
        }),
      );
      alerts = { emit: jest.fn() };
      budgets = new BudgetService(
        mockConfigService(),
        new WorkspaceContextService(),
        repo,
        alerts as unknown as AlertService,
        {
          budgetUsageRatio: {
            addCallback: (callback: typeof metricReader) => {
              metricReader = callback;
            },
          },
        } as unknown as TelemetryService,
      );
      budgets.enableExactLedger();
    });
    afterEach(async () => {
      jest.restoreAllMocks();
      if (source?.isInitialized) await source.destroy();
      await cleanup?.();
    });
    const commit = <T>(action: (manager: EntityManager) => Promise<T>) =>
      budgets.withCommittedBudgetEffects(() =>
        serializeDatabaseAccess(source, () => source.transaction(action)),
      );
    const reserve = (amount: string) =>
      commit((manager) =>
        budgets.reserveLedger(manager, identity, "0", amount),
      );
    const sampleMetrics = () => {
      const values: number[] = [];
      metricReader?.({ observe: (value) => values.push(value) });
      return values;
    };

    it("refreshes ledger telemetry only after an observed budget change commits", async () => {
      await budgets.getStatus();
      const refresh = jest.spyOn(budgets, "refreshAfterLedgerMutation");
      await budgets.withCommittedBudgetEffects(
        () => serializeDatabaseAccess(source, () => source.transaction(async (manager) => {
          await manager.query("SELECT 1");
          return "unchanged";
        })),
        { refreshLedgerMetrics: true },
      );
      expect(refresh).not.toHaveBeenCalled();
      await budgets.withCommittedBudgetEffects(
        () => serializeDatabaseAccess(source, () => source.transaction(async (manager) => {
          await budgets.reserveLedger(manager, identity, "0", "9");
          expect(refresh).not.toHaveBeenCalled();
          expect(sampleMetrics()).toEqual([0]);
        })),
        { refreshLedgerMetrics: true },
      );
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(sampleMetrics()).toEqual([0.9]);
    });

    it("defers nested ledger metric refresh until the outer commit and discards it on rollback", async () => {
      await budgets.getStatus();
      const refresh = jest.spyOn(budgets, "refreshAfterLedgerMutation");
      const nested = (manager: EntityManager) => budgets.withCommittedBudgetEffects(
        () => manager.transaction((child) => budgets.reserveLedger(child, identity, "0", "9")),
        { refreshLedgerMetrics: true },
      );
      await expect(commit(async (manager) => {
        await nested(manager);
        expect(refresh).not.toHaveBeenCalled();
        expect(sampleMetrics()).toEqual([0]);
        throw new Error("outer rollback after nested ledger write");
      })).rejects.toThrow("outer rollback");
      expect(refresh).not.toHaveBeenCalled();
      expect(sampleMetrics()).toEqual([0]);
      await commit(async (manager) => {
        await nested(manager);
        expect(refresh).not.toHaveBeenCalled();
        expect(sampleMetrics()).toEqual([0]);
      });
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(sampleMetrics()).toEqual([0.9]);
    });

    it("does not propagate a rolled-back savepoint's metric refresh into a successful outer transaction", async () => {
      await budgets.getStatus();
      const refresh = jest.spyOn(budgets, "refreshAfterLedgerMutation");
      await budgets.withCommittedBudgetEffects(
        () => serializeDatabaseAccess(source, () => source.transaction(async (manager) => {
          await expect(budgets.withCommittedBudgetEffects(
            () => manager.transaction(async (child) => {
              await budgets.reserveLedger(child, identity, "0", "9");
              throw new Error("nested ledger rollback");
            }),
            { refreshLedgerMetrics: true },
          )).rejects.toThrow("nested ledger rollback");
          await manager.query("SELECT 1");
        })),
        { refreshLedgerMetrics: true },
      );
      expect(refresh).not.toHaveBeenCalled();
      expect(sampleMetrics()).toEqual([0]);
      expect(alerts.emit).not.toHaveBeenCalled();
    });

    it("coalesces successful nested ledger refreshes without changing threshold observations", async () => {
      await budgets.getStatus();
      const refresh = jest.spyOn(budgets, "refreshAfterLedgerMutation");
      await commit(async (manager) => {
        for (const amount of ["4", "5"]) {
          await budgets.withCommittedBudgetEffects(
            () => manager.transaction((child) => budgets.reserveLedger(child, identity, "0", amount)),
            { refreshLedgerMetrics: true },
          );
        }
        expect(refresh).not.toHaveBeenCalled();
        expect(alerts.emit).not.toHaveBeenCalled();
      });
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(sampleMetrics()).toEqual([0.9]);
      expect(alerts.emit).toHaveBeenCalledTimes(1);
      expect(alerts.emit.mock.calls[0][0].details?.current_exact).toBe("9.000000000000000000");
    });

    it("does not refresh current-period telemetry for a correction confined to an older epoch", async () => {
      const holds = await reserve("7");
      const charged = await commit((manager) => budgets.settleLedger(manager, identity, holds, "0", "7"));
      await budgets.resetRule(rule.id);
      const refresh = jest.spyOn(budgets, "refreshAfterLedgerMutation");
      await budgets.withCommittedBudgetEffects(
        () => serializeDatabaseAccess(source, () => source.transaction((manager) =>
          budgets.adjustLedger(manager, identity, charged, "0", "2"),
        )),
        { refreshLedgerMetrics: true },
      );
      expect(refresh).not.toHaveBeenCalled();
      expect(sampleMetrics()).toEqual([0]);
      expect(alerts.emit).not.toHaveBeenCalled();
    });

    it("discards thresholds on rollback and publishes only after the actual commit", async () => {
      await expect(
        commit(async (manager) => {
          await budgets.reserveLedger(manager, identity, "0", "9");
          expect(alerts.emit).not.toHaveBeenCalled();
          throw new Error("synthetic rollback after budget writes");
        }),
      ).rejects.toThrow("synthetic rollback");
      expect(alerts.emit).not.toHaveBeenCalled();
      expect(
        (
          await source
            .getRepository(BudgetRule)
            .findOneByOrFail({ id: rule.id })
        ).current_value,
      ).toBe(0);
      let committed = false;
      alerts.emit.mockImplementation(() => {
        expect(committed).toBe(true);
      });
      await budgets.withCommittedBudgetEffects(async () => {
        await serializeDatabaseAccess(source, () =>
          source.transaction(async (manager) => {
            await budgets.reserveLedger(manager, identity, "0", "9");
            expect(alerts.emit).not.toHaveBeenCalled();
          }),
        );
        committed = true;
      });
      expect(alerts.emit).toHaveBeenCalledTimes(1);
      expect(alerts.emit.mock.calls[0][0]).toMatchObject({
        type: "budget_threshold",
        details: {
          workspace_id: workspace,
          current_exact: "9.000000000000000000",
          limit_exact: "10.000000000000000000",
        },
      });
    });

    it("aggregates temporary release/reapply changes within the same transaction", async () => {
      await commit(async (manager) => {
        const holds = await budgets.reserveLedger(manager, identity, "0", "9");
        await budgets.settleLedger(manager, identity, holds, "0", "0");
      });
      expect(alerts.emit).not.toHaveBeenCalled();
      const holds = await reserve("9");
      expect(alerts.emit).toHaveBeenCalledTimes(1);
      await commit((manager) =>
        budgets.settleLedger(manager, identity, holds, "0", "9"),
      );
      expect(alerts.emit).toHaveBeenCalledTimes(1);
    });

    it("coalesces multiple member effects into one final committed threshold value", async () => {
      await reserve("7");
      await commit(async (manager) => {
        await budgets.reserveLedger(manager, identity, "0", "1");
        await budgets.reserveLedger(manager, identity, "0", "1");
        expect(alerts.emit).not.toHaveBeenCalled();
      });
      expect(alerts.emit).toHaveBeenCalledTimes(1);
      expect(alerts.emit.mock.calls[0][0].details?.current_exact).toBe(
        "9.000000000000000000",
      );
    });

    it("observes net settlement overruns and signed corrections, not temporary hold release", async () => {
      const holds = await reserve("4");
      const charged = await commit((manager) =>
        budgets.settleLedger(manager, identity, holds, "0", "7"),
      );
      expect(alerts.emit).not.toHaveBeenCalled();
      await commit((manager) =>
        budgets.adjustLedger(manager, identity, charged, "0", "2"),
      );
      expect(alerts.emit).toHaveBeenCalledTimes(1);
      expect(alerts.emit.mock.calls[0][0].details?.current_exact).toBe(
        "9.000000000000000000",
      );
      await commit((manager) =>
        budgets.adjustLedger(manager, identity, charged, "0", "-2"),
      );
      expect(alerts.emit).toHaveBeenCalledTimes(1);
      await commit((manager) =>
        budgets.settleLedger(manager, identity, [], "0", "2"),
      );
      expect(alerts.emit).toHaveBeenCalledTimes(2);
    });

    it("uses exact comparisons across a threshold invisible to floating-point projections", async () => {
      // Use 0.5, exactly representable even in the legacy PostgreSQL real field.
      await source
        .getRepository(BudgetRule)
        .update(rule.id, { limit_value: 1, alert_threshold: 0.5 });
      await reserve("0.499999999999999999");
      expect(alerts.emit).not.toHaveBeenCalled();
      await reserve("0.000000000000000002");
      expect(alerts.emit).toHaveBeenCalledTimes(1);
      expect(alerts.emit.mock.calls[0][0].details?.current_exact).toBe(
        "0.500000000000000001",
      );
    });

    it("reports rejected admission only after rollback and never as a committed threshold", async () => {
      await source
        .getRepository(BudgetRule)
        .save(
          source
            .getRepository(BudgetRule)
            .create({
              ...rule,
              id: undefined,
              limit_value: 1,
              api_key_id: "synthetic-key-id",
            }),
        );
      let finished = false;
      alerts.emit.mockImplementation(() => {
        expect(finished).toBe(true);
      });
      await expect(
        budgets.withCommittedBudgetEffects(async () => {
          try {
            return await serializeDatabaseAccess(source, () =>
              source.transaction((manager) =>
                budgets.reserveLedger(
                  manager,
                  { ...identity, apiKeyId: "synthetic-key-id" },
                  "0",
                  "9",
                ),
              ),
            );
          } finally {
            finished = true;
          }
        }),
      ).rejects.toBeInstanceOf(BudgetExceededError);
      expect(alerts.emit).toHaveBeenCalledTimes(1);
      expect(alerts.emit.mock.calls[0][0]).toMatchObject({
        type: "budget_exceeded",
        details: {
          scope: "api_key",
          api_key_id: "synthetic-key-id",
          current_exact: "9.000000000000000000",
        },
      });
      expect(
        (await source.getRepository(BudgetRule).find()).every(
          (entry) => entry.current_value === 0,
        ),
      ).toBe(true);
    });

    it("keeps committed usage successful if the notification sink throws", async () => {
      alerts.emit.mockImplementation(() => {
        throw new Error("synthetic unavailable sink");
      });
      await expect(reserve("9")).resolves.toHaveLength(1);
      expect(
        (
          await source
            .getRepository(BudgetRule)
            .findOneByOrFail({ id: rule.id })
        ).current_value,
      ).toBe(9);
    });

    it("holds nested savepoint observations until the outer transaction commits", async () => {
      await expect(
        commit(async (manager) => {
          await budgets.withCommittedBudgetEffects(() =>
            manager.transaction((nested) =>
              budgets.reserveLedger(nested, identity, "0", "9"),
            ),
          );
          expect(alerts.emit).not.toHaveBeenCalled();
          throw new Error("outer rollback");
        }),
      ).rejects.toThrow("outer rollback");
      expect(alerts.emit).not.toHaveBeenCalled();
      await commit(async (manager) => {
        await budgets.withCommittedBudgetEffects(() =>
          manager.transaction((nested) =>
            budgets.reserveLedger(nested, identity, "0", "9"),
          ),
        );
        expect(alerts.emit).not.toHaveBeenCalled();
      });
      expect(alerts.emit).toHaveBeenCalledTimes(1);
    });

    it("does not merge rolled-back nested observations when an outer operation continues", async () => {
      await commit(async (manager) => {
        await expect(
          budgets.withCommittedBudgetEffects(() =>
            manager.transaction(async (nested) => {
              await budgets.reserveLedger(nested, identity, "0", "9");
              throw new Error("savepoint rollback");
            }),
          ),
        ).rejects.toThrow("savepoint rollback");
        await budgets.reserveLedger(manager, identity, "0", "1");
      });
      expect(alerts.emit).not.toHaveBeenCalled();
      expect(
        (
          await source
            .getRepository(BudgetRule)
            .findOneByOrFail({ id: rule.id })
        ).current_value,
      ).toBe(1);
    });

    it("does not publish an uncommitted telemetry snapshot from ordinary budget mutations", async () => {
      await budgets.getStatus();
      expect(sampleMetrics()).toEqual([0]);
      const actual = source.manager.transaction.bind(source.manager);
      const run = jest
        .spyOn(source.manager, "transaction")
        .mockImplementation(((
          first: unknown,
          second?: (manager: EntityManager) => Promise<unknown>,
        ) => {
          const action =
            typeof first === "function"
              ? (first as (manager: EntityManager) => Promise<unknown>)
              : second!;
          return actual(async (manager) => {
            await action(manager);
            expect(sampleMetrics()).toEqual([0]);
            throw new Error("before commit failure");
          });
        }) as EntityManager["transaction"]);
      try {
        await expect(budgets.record(0, 9)).rejects.toThrow(
          "before commit failure",
        );
      } finally {
        run.mockRestore();
      }
      expect(sampleMetrics()).toEqual([0]);
      expect(alerts.emit).not.toHaveBeenCalled();
      await budgets.record(0, 9);
      expect(sampleMetrics()).toEqual([0.9]);
      expect(alerts.emit).toHaveBeenCalledTimes(1);
    });

    it("preserves rollback-safe alerts on a genuinely unmigrated legacy database", async () => {
      const legacy = await connect();
      const repo = legacy.source.getRepository(BudgetRule);
      const service = new BudgetService(
        mockConfigService({
          budget: {
            daily_token_limit: 100000,
            daily_cost_limit: 10,
            alert_threshold: 0.8,
          },
        }),
        new WorkspaceContextService(),
        repo,
        alerts as unknown as AlertService,
      );
      try {
        await service.onModuleInit();
        const runner = legacy.source.createQueryRunner();
        try {
          expect(await runner.hasTable("pricing_schema_versions")).toBe(false);
        } finally {
          await runner.release();
        }
        const actual = legacy.source.manager.transaction.bind(
          legacy.source.manager,
        );
        const fail = jest
          .spyOn(legacy.source.manager, "transaction")
          .mockImplementation(((
            first: unknown,
            second?: (manager: EntityManager) => Promise<unknown>,
          ) => {
            const action =
              typeof first === "function"
                ? (first as (manager: EntityManager) => Promise<unknown>)
                : second!;
            return actual(async (manager) => {
              await action(manager);
              throw new Error("legacy rollback");
            });
          }) as EntityManager["transaction"]);
        try {
          await expect(service.record(0, 9)).rejects.toThrow("legacy rollback");
        } finally {
          fail.mockRestore();
        }
        expect(alerts.emit).not.toHaveBeenCalled();
        expect(
          (await repo.findOneByOrFail({ type: "daily_cost" })).current_value,
        ).toBe(0);
        await service.record(0, 9);
        expect(alerts.emit).toHaveBeenCalledTimes(1);
      } finally {
        service.onModuleDestroy();
        await legacy.source.destroy();
        await legacy.cleanup();
      }
    });

    it("keeps workspace and reset epochs distinct in notification deduplication", async () => {
      const other = "other-observer-workspace";
      await source
        .getRepository(BudgetRule)
        .save(
          source
            .getRepository(BudgetRule)
            .create({ ...rule, id: undefined, workspace_id: other }),
        );
      await Promise.all([
        reserve("9"),
        commit((manager) =>
          budgets.reserveLedger(
            manager,
            { ...identity, workspaceId: other },
            "0",
            "9",
          ),
        ),
      ]);
      expect(alerts.emit).toHaveBeenCalledTimes(2);
      const events = alerts.emit.mock.calls.map(([event]) => event);
      expect(
        new Set(events.map((event) => event.details?.workspace_id)),
      ).toEqual(new Set([workspace, other]));
      expect(new Set(events.map((event) => event.dedupeKey)).size).toBe(2);
      const initial = events.find(
        (event) => event.details?.workspace_id === workspace,
      )!;
      await budgets.resetRule(rule.id);
      await reserve("9");
      expect(alerts.emit).toHaveBeenCalledTimes(3);
      expect(alerts.emit.mock.calls[2][0].dedupeKey).not.toBe(
        initial.dedupeKey,
      );
    });

    it("does not emit a current-period alert for an adjustment to an older epoch", async () => {
      const holds = await reserve("7");
      const charged = await commit((manager) =>
        budgets.settleLedger(manager, identity, holds, "0", "7"),
      );
      await budgets.resetRule(rule.id);
      await commit((manager) =>
        budgets.adjustLedger(manager, identity, charged, "0", "2"),
      );
      expect(alerts.emit).not.toHaveBeenCalled();
      expect(
        (
          await source
            .getRepository(BudgetRule)
            .findOneByOrFail({ id: rule.id })
        ).current_value,
      ).toBe(0);
    });
  });
}

observerContract("SQLite post-commit budget observers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "budget-observers-"));
  const source = await new DataSource({
    type: "better-sqlite3",
    database: join(directory, "budget.db"),
    entities: [BudgetRule],
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
observerContract(
  "PostgreSQL post-commit budget observers",
  async () => {
    if (!pgUrl) throw new Error("No isolated PostgreSQL URL");
    const schema = `budget_observers_${process.pid}_${Math.random().toString(16).slice(2)}`;
    const admin = await new DataSource({
      type: "postgres",
      url: pgUrl,
      synchronize: false,
    }).initialize();
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const source = await new DataSource({
      type: "postgres",
      url: pgUrl,
      schema,
      extra: { options: `-c search_path=${schema}` },
      entities: [BudgetRule],
      synchronize: true,
    }).initialize();
    return {
      source,
      cleanup: async () => {
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.destroy();
      },
    };
  },
  pgUrl ? describe : describe.skip,
);
