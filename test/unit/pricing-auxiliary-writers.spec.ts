import { BadRequestException, Logger } from '@nestjs/common';
import {
  DataSource,
  DeleteQueryBuilder,
  InsertQueryBuilder,
  type ObjectLiteral,
} from 'typeorm';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Request } from 'express';
import { AgentProfileService } from '../../src/agent-profiles/agent-profile.service';
import {
  GatewayApiKeyService,
  type GatewayApiKeyContext,
} from '../../src/auth/gateway-api-key.service';
import { BatchJobStoreService } from '../../src/batch/batch-job-store.service';
import { BatchApiProxyService } from '../../src/batch/batch-api-proxy.service';
import type { BatchProviderAdapterService } from '../../src/batch/batch-provider-adapter.service';
import { BudgetService } from '../../src/budget/budget.service';
import { DashboardController } from '../../src/dashboard/dashboard.controller';
import { ProviderCompatibilityService } from '../../src/dashboard/provider-compatibility.service';
import {
  AgentProfile,
  BatchJob,
  BudgetRule,
  CallLog,
  EvalDataset,
  EvalExperimentRun,
  EvalSampleResult,
  GatewayApiKey,
  LocalTeam,
  PromptTemplate,
  ProviderCompatibilityResult,
  RouteDecisionLog,
  ShadowTrafficResult,
} from '../../src/database/entities';
import {
  coordinatedRepositoryOperation,
  withCoordinatedRepository,
} from '../../src/database/coordinated-repository';
import {
  EvaluationService,
  type EvalRecordedRunInput,
} from '../../src/evaluation/evaluation.service';
import { SemanticPlatformService } from '../../src/semantic-platform/semantic-platform.service';
import { ShadowTrafficService } from '../../src/shadow/shadow-traffic.service';
import { WorkspaceContextService } from '../../src/workspaces/workspace-context.service';
import type { CapabilityService } from '../../src/config/capability.service';
import type { NodeConfig } from '../../src/config/gateway.config';
import type { PromptCacheService } from '../../src/cache/prompt-cache.service';
import type { ProviderClientService } from '../../src/providers/provider-client.service';
import type { TelemetryService } from '../../src/telemetry/telemetry.service';
import type { PipelineService } from '../../src/pipeline/pipeline.service';
import { CostLedgerService } from '../../src/pricing/cost-ledger.service';
import { PricingRepository } from '../../src/pricing/pricing-repository';
import { applyPricingSchema } from '../../src/pricing/pricing-schema';
import {
  makeRequest,
  makeCanonicalResponse,
  mockConfigService,
} from '../helpers';
import { tokenBook, tokens } from './pricing-fixtures';

const entities = [
  AgentProfile,
  BatchJob,
  BudgetRule,
  CallLog,
  EvalDataset,
  EvalExperimentRun,
  EvalSampleResult,
  GatewayApiKey,
  LocalTeam,
  PromptTemplate,
  ProviderCompatibilityResult,
  RouteDecisionLog,
  ShadowTrafficResult,
];
const workspace = 'default-workspace';
const node = {
  id: 'synthetic-node',
  name: 'Synthetic',
  protocol: 'chat_completions',
  base_url: 'http://127.0.0.1:9',
  endpoint: '/v1/chat/completions',
  api_key: 'TEST_ONLY',
  models: ['synthetic-model'],
  timeout_ms: 1000,
} as NodeConfig;
const log = (id: string) => ({
  request_id: id,
  workspace_id: workspace,
  source_format: 'chat_completions',
  tier: 'direct',
  score: 0,
  node_id: node.id,
  model: 'synthetic-model',
});
const recordInput: EvalRecordedRunInput = {
  dataset: { name: 'Synthetic evaluation' },
  primary: { model: 'synthetic-model' },
  candidate: { model: 'synthetic-model' },
  samples: [
    {
      sample_hash: 'hash-only-1',
      primary: { success: true },
      candidate: { success: true },
    },
    { sample_hash: 'hash-only-2', primary: {}, candidate: {} },
  ],
};
const gate = () => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release };
};
type Fixture = { source: DataSource; cleanup: () => Promise<void> };
function contract(
  label: string,
  connect: () => Promise<Fixture>,
  run = describe,
) {
  run(label, () => {
    let source: DataSource,
      cleanup: Fixture['cleanup'],
      contexts: WorkspaceContextService;
    let ledger: CostLedgerService, budgets: BudgetService;
    const peers: DataSource[] = [];
    const config = mockConfigService({
      nodes: [node],
      database: { log_retention_days: 1 },
      shadowTraffic: {
        enabled: true,
        sample_rate: 1,
        target_node: node.id,
        target_model: 'synthetic-model',
        timeout_ms: 1000,
        max_recent_results: 2,
        compare: { store_prompts: false, store_responses: false },
      },
    });
    config.semanticPlatform.prompt_registry = {
      enabled: true,
      store_template_content: false,
      max_versions_per_key: 2,
    };
    config.getFullConfig.mockReturnValue({
      evaluation: { store_samples: false, max_sample_chars: 100 },
    });
    config.getNode.mockImplementation((id: string) =>
      id === node.id ? node : undefined,
    );
    const pipeline = { process: jest.fn() };
    const provider = { forward: jest.fn() };
    const adapter = { cancel: jest.fn() };
    const telemetry = { recordCallMetrics: jest.fn() };
    const makeServices = (db: DataSource) => {
      const keys = new GatewayApiKeyService(
        config,
        contexts,
        db.getRepository(GatewayApiKey),
        db.getRepository(LocalTeam),
        db.getRepository(BudgetRule),
        db.getRepository(CallLog),
      );
      const jobs = new BatchJobStoreService(
        contexts,
        db.getRepository(BatchJob),
      );
      return {
        keys,
        jobs,
        profiles: new AgentProfileService(
          config,
          keys,
          contexts,
          db.getRepository(AgentProfile),
        ),
        evaluation: new EvaluationService(
          config,
          db.getRepository(EvalDataset),
          db.getRepository(EvalExperimentRun),
          db.getRepository(EvalSampleResult),
          db.getRepository(CallLog),
          contexts,
          pipeline as unknown as PipelineService,
        ),
        prompts: new SemanticPlatformService(
          config,
          contexts,
          {} as CapabilityService,
          {} as PromptCacheService,
          db.getRepository(PromptTemplate),
          db.getRepository(CallLog),
          db.getRepository(RouteDecisionLog),
        ),
        shadow: new ShadowTrafficService(
          config,
          provider as unknown as ProviderClientService,
          contexts,
          db.getRepository(ShadowTrafficResult),
          db.getRepository(CallLog),
        ),
        compatibility: new ProviderCompatibilityService(
          contexts,
          db.getRepository(ProviderCompatibilityResult),
        ),
        batch: new BatchApiProxyService(
          config,
          budgets,
          adapter as unknown as BatchProviderAdapterService,
          jobs,
          telemetry as unknown as TelemetryService,
          contexts,
          db.getRepository(CallLog),
        ),
      };
    };
    let app: ReturnType<typeof makeServices>;
    const peer = async () => {
      if (source.options.type !== 'postgres') return makeServices(source);
      const other = await new DataSource({
        ...source.options,
        synchronize: false,
      }).initialize();
      peers.push(other);
      return makeServices(other);
    };
    beforeEach(async () => {
      ({ source, cleanup } = await connect());
      contexts = new WorkspaceContextService();
      await applyPricingSchema(source);
      await source
        .getRepository(BudgetRule)
        .save({
          workspace_id: workspace,
          type: 'daily_cost',
          limit_value: 100,
          current_value: 0,
          alert_threshold: 0.8,
          period_start: new Date(),
          is_active: true,
        });
      budgets = new BudgetService(
        config,
        contexts,
        source.getRepository(BudgetRule),
      );
      ledger = new CostLedgerService(source, budgets);
      app = makeServices(source);
      pipeline.process
        .mockReset()
        .mockResolvedValue({
          statusCode: 200,
          body: { output_text: '{"score":0.5,"label":"tie"}' },
        });
      provider.forward
        .mockReset()
        .mockResolvedValue(
          makeCanonicalResponse({
            model: 'synthetic-model',
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
      adapter.cancel
        .mockReset()
        .mockResolvedValue({
          statusCode: 204,
          body: '',
          contentType: 'text/plain',
          headers: {},
          latencyMs: 1,
        });
      telemetry.recordCallMetrics.mockReset();
      jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('{}', { status: 200 }));
    });
    afterEach(async () => {
      jest.restoreAllMocks();
      budgets?.onModuleDestroy();
      for (const other of peers.splice(0))
        if (other.isInitialized) await other.destroy();
      if (source?.isInitialized) await source.destroy();
      await cleanup?.();
    });
    const seedJob = (
      requestId = 'batch-request',
      apiKey?: GatewayApiKeyContext,
    ) =>
      app.jobs.createFromProvider({
        requestId,
        nodeId: node.id,
        model: 'synthetic-model',
        requestBody: {
          endpoint: '/v1/chat/completions',
          metadata: { private_prompt: 'never stored' },
        },
        providerBody: { id: 'provider-job', status: 'in_progress' },
        apiKey,
      });
    const count = (target: (typeof entities)[number]) =>
      source.getRepository(target).count();
    const cleanupLogs = () => {
      // Invoke only the real database-only maintenance method, never module timers or the live app.
      const controller = Object.assign(
        Object.create(DashboardController.prototype) as {
          cleanupOldLogs(): Promise<void>;
        },
        {
          config,
          callLogRepo: source.getRepository(CallLog),
          routeDecisionRepo: source.getRepository(RouteDecisionLog),
          cleanupStopped: false,
          logger: new Logger('SyntheticCleanup'),
        },
      );
      return controller.cleanupOldLogs();
    };
    async function prepareLedger() {
      const prices = new PricingRepository(source),
        actor = {
          id: 'synthetic-admin',
          role: 'admin' as const,
          workspace_id: workspace,
          global_admin: true,
        };
      const book = await prices.createBook(actor, {
        name: 'Synthetic auxiliary writer fixture',
        scope: 'workspace',
        content: tokenBook(),
      });
      await prices.publishDraft(actor, book.draft.id, {
        draft_revision: 1,
        catalog_revision: 0,
        reason: 'Fixture only',
        confirm: true,
        targets: [{ level: 'model', model: 'synthetic-model' }],
      });
      const snapshot = (await prices.capture({
        request_id: 'priced-request',
        workspace_id: workspace,
        report_currency: 'USD',
      }))!;
      await ledger.reserve({
        id: 'priced-reservation',
        requestId: 'priced-request',
        identity: {
          workspaceId: workspace,
          apiKeyName: null,
          apiKeyId: null,
          namespaceId: null,
          teamId: null,
        },
        target: { node_id: node.id, model: 'synthetic-model' },
        estimate: snapshot.quote(
          { node_id: node.id, model: 'synthetic-model' },
          tokens({ input_tokens: 1000 }),
        ).cost,
        tokens: '1000',
        costUsd: '0.5',
        budgetBasis: 'legacy_logical',
        leaseOwner: 'synthetic-owner',
        leaseUntil: new Date(Date.now() + 60000).toISOString(),
      });
      await ledger.queueSettlement(
        'priced-reservation',
        workspace,
        'commit',
        '1000',
        '0.001',
      );
    }
    async function duringLedgerRollback(action: () => Promise<unknown>) {
      await prepareLedger();
      const beforeEffects = await source.query(
        'SELECT * FROM pricing_budget_effects',
      );
      const reached = gate(),
        resume = gate();
      const execute = InsertQueryBuilder.prototype.execute;
      const fault = jest
        .spyOn(InsertQueryBuilder.prototype, 'execute')
        .mockImplementation(async function (
          this: InsertQueryBuilder<ObjectLiteral>,
        ) {
          const result = await execute.call(this);
          if (
            this.expressionMap.mainAlias?.tablePath === 'pricing_budget_effects'
          ) {
            reached.release();
            await resume.ready;
            throw new Error('synthetic ledger rollback');
          }
          return result;
        });
      const settlement = ledger
        .applySettlement('priced-reservation', workspace)
        .then(
          () => new Error('Expected rollback'),
          (error) => error as Error,
        );
      let writer: Promise<unknown> | undefined;
      try {
        await Promise.race([
          reached.ready,
          settlement.then((error) => {
            throw error;
          }),
        ]);
        let completed = false;
        writer = action().then((result) => {
          completed = true;
          return result;
        });
        // Both promise outcomes are observed before deliberately releasing the fault.
        void writer.catch(() => undefined);
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (source.options.type === 'better-sqlite3')
          expect(completed).toBe(false);
      } finally {
        resume.release();
        expect((await settlement).message).toBe('synthetic ledger rollback');
        fault.mockRestore();
      }
      await writer;
      expect(
        await source.query('SELECT * FROM pricing_budget_effects'),
      ).toEqual(beforeEffects);
      expect(
        (
          await source
            .getRepository(BudgetRule)
            .findOneByOrFail({ type: 'daily_cost' })
        ).current_value,
      ).toBe(0.5);
      await ledger.applySettlement('priced-reservation', workspace);
      await ledger.applySettlement('priced-reservation', workspace);
      expect(
        await source.query('SELECT * FROM pricing_budget_effects'),
      ).toHaveLength(beforeEffects.length + 1);
      expect(
        (
          await source
            .getRepository(BudgetRule)
            .findOneByOrFail({ type: 'daily_cost' })
        ).current_value,
      ).toBeCloseTo(0.001, 8);
    }

    it.each([
      'batch_create',
      'batch_update',
      'batch_cancel',
      'batch_call_log',
      'evaluation_record',
      'evaluation_runner',
      'prompt_create',
      'prompt_archive',
      'profile_create',
      'profile_update',
      'profile_render',
      'profile_delete',
      'shadow_result',
      'compatibility_result',
      'dashboard_cleanup',
    ] as const)(
      'isolates %s from an actual rolled-back pricing settlement',
      async (kind) => {
        let action: () => Promise<unknown>, verify: () => Promise<void>;
        if (kind.startsWith('batch_')) {
          const apiKey = await app.keys.create({
            name: 'Synthetic batch key',
            allow_direct: true,
          });
          const context = await app.keys.getContextById(apiKey.item.id);
          const job =
            kind === 'batch_create'
              ? null
              : await seedJob('batch-request', context);
          action =
            kind === 'batch_create'
              ? () => seedJob('batch-request', context)
              : kind === 'batch_update'
                ? () =>
                    app.jobs.updateFromProvider(job!, {
                      status: 'completed',
                      output_file_id: 'file-output',
                    })
                : kind === 'batch_cancel'
                  ? () => app.jobs.markCancelled(job!)
                  : () =>
                      app.batch.cancel({
                        id: job!.request_id,
                        req: {} as Request,
                        context: {
                          requestId: 'batch-log',
                          operation: 'cancel',
                          apiKey: context,
                          headers: {},
                          startedAt: Date.now(),
                        },
                      });
          verify = async () => {
            expect(await count(BatchJob)).toBe(1);
            const row = await source
              .getRepository(BatchJob)
              .findOneByOrFail({ request_id: 'batch-request' });
            if (kind === 'batch_update')
              expect(row.output_file_id).toBe('file-output');
            if (kind === 'batch_cancel' || kind === 'batch_call_log')
              expect(row.status).toBe('cancelled');
            if (kind === 'batch_call_log') {
              expect(await count(CallLog)).toBe(1);
              expect(adapter.cancel).toHaveBeenCalledTimes(1);
              expect(telemetry.recordCallMetrics).toHaveBeenCalledTimes(1);
            }
            expect(JSON.stringify(row)).not.toContain('never stored');
          };
        } else if (kind.startsWith('evaluation_')) {
          action =
            kind === 'evaluation_record'
              ? () => app.evaluation.recordRun(recordInput)
              : () =>
                  app.evaluation.runComparison({
                    dataset: { name: 'Synthetic run' },
                    primary: { model: 'synthetic-model' },
                    candidate: { model: 'synthetic-model' },
                    samples: [{ prompt: 'never persist raw synthetic prompt' }],
                  });
          verify = async () => {
            expect(await count(EvalExperimentRun)).toBe(1);
            expect(await count(EvalSampleResult)).toBe(
              kind === 'evaluation_record' ? 2 : 1,
            );
            expect(
              JSON.stringify(
                await source.getRepository(EvalSampleResult).find(),
              ),
            ).not.toContain('never persist raw');
          };
        } else if (kind.startsWith('prompt_')) {
          const prior =
            kind === 'prompt_archive'
              ? await app.prompts.createPromptTemplate({
                  prompt_key: 'synthetic',
                  template: 'never persist raw prompt',
                })
              : null;
          action = prior
            ? () => app.prompts.archivePromptTemplate(prior.item.id)
            : () =>
                app.prompts.createPromptTemplate({
                  prompt_key: 'synthetic',
                  template: 'never persist raw prompt',
                });
          verify = async () => {
            const row = await source
              .getRepository(PromptTemplate)
              .findOneByOrFail({ prompt_key: 'synthetic' });
            expect(row.template_content).toBeNull();
            expect(row.status).toBe(prior ? 'archived' : 'active');
          };
        } else if (kind.startsWith('profile_')) {
          const key = await app.keys.create({ name: 'Synthetic linked key' });
          const dto = {
            name: 'Synthetic profile',
            connector: 'generic_openai' as const,
            api_key_id: key.item.id,
          };
          const prior =
            kind === 'profile_create' ? null : await app.profiles.create(dto);
          action =
            kind === 'profile_create'
              ? () => app.profiles.create(dto)
              : kind === 'profile_update'
                ? () =>
                    app.profiles.update(prior!.id, { description: 'changed' })
                : kind === 'profile_render'
                  ? () => app.profiles.render(prior!.id)
                  : () => app.profiles.remove(prior!.id);
          verify = async () => {
            expect(await count(AgentProfile)).toBe(
              kind === 'profile_delete' ? 0 : 1,
            );
            if (kind === 'profile_render')
              expect(
                (await app.profiles.list())[0].last_generated_at,
              ).toBeInstanceOf(Date);
          };
        } else if (kind === 'shadow_result') {
          action = () =>
            app.shadow.dispatchChat(
              'shadow-request',
              makeRequest('never persist raw prompt'),
              makeCanonicalResponse(),
              node.id,
              'synthetic-model',
            );
          verify = async () => {
            expect(await count(ShadowTrafficResult)).toBe(1);
            expect((await app.shadow.recent())[0].prompt_sample).toBeNull();
            expect(provider.forward).toHaveBeenCalledTimes(1);
          };
        } else if (kind === 'compatibility_result') {
          action = () =>
            app.compatibility.runNodeMatrix(node, { capabilities: ['chat'] });
          verify = async () => {
            expect(await count(ProviderCompatibilityResult)).toBe(1);
            expect(globalThis.fetch).toHaveBeenCalledTimes(1);
          };
        } else {
          await source
            .getRepository(CallLog)
            .save({
              ...log('old-log'),
              timestamp: new Date(Date.now() - 2 * 86400000),
            });
          await source
            .getRepository(RouteDecisionLog)
            .save({
              request_id: 'old-decision',
              trace_json: '{}',
              workspace_id: workspace,
              source_format: 'chat_completions',
              tier: 'direct',
              score: 0,
              timestamp: new Date(Date.now() - 2 * 86400000),
            });
          action = cleanupLogs;
          verify = async () => {
            expect(await count(CallLog)).toBe(0);
            expect(await count(RouteDecisionLog)).toBe(0);
          };
        }
        await duringLedgerRollback(action);
        await verify();
      },
      20000,
    );

    it('rolls back dataset, run and every imported sample on a later sample failure', async () => {
      const insert = InsertQueryBuilder.prototype.execute;
      const fault = jest
        .spyOn(InsertQueryBuilder.prototype, 'execute')
        .mockImplementation(function (this: InsertQueryBuilder<ObjectLiteral>) {
          if (
            this.expressionMap.mainAlias?.tablePath?.endsWith(
              'eval_sample_results',
            )
          )
            return Promise.reject(new Error('synthetic sample failure'));
          return insert.call(this);
        });
      await expect(app.evaluation.recordRun(recordInput)).rejects.toThrow(
        'synthetic sample failure',
      );
      fault.mockRestore();
      for (const target of [EvalDataset, EvalExperimentRun, EvalSampleResult])
        expect(await count(target)).toBe(0);
    });
    it('allows target/judge work to acquire the same database queue without a nested transaction', async () => {
      pipeline.process.mockImplementation(async (canonical) => {
        await withCoordinatedRepository(
          source.getRepository(CallLog),
          true,
          (repo) =>
            repo.save({
              ...log(canonical.metadata.session_key),
              session_key: canonical.metadata.session_key,
            }),
        );
        return {
          statusCode: 200,
          body: { output_text: '{"score":0.5,"label":"tie"}' },
        };
      });
      const report = await app.evaluation.runComparison({
        dataset: { name: 'Synthetic unlocked calls' },
        primary: { model: 'synthetic-model' },
        candidate: { model: 'synthetic-model' },
        samples: [{ prompt: 'private synthetic request' }],
      });
      expect(report?.run.status).toBe('completed');
      expect(pipeline.process).toHaveBeenCalledTimes(3);
      expect(await count(CallLog)).toBe(3);
    });
    it('allocates concurrent prompt versions and prunes atomically across connections', async () => {
      const other = await peer();
      await Promise.all(
        Array.from({ length: 4 }, (_, index) =>
          (index % 2 ? app : other).prompts.createPromptTemplate({
            prompt_key: 'same-key',
            template: `Synthetic ${index}`,
          }),
        ),
      );
      const rows = await source
        .getRepository(PromptTemplate)
        .find({ where: { prompt_key: 'same-key' }, order: { version: 'ASC' } });
      expect(rows.map((row) => row.version)).toEqual([3, 4]);
      expect(rows.every((row) => row.template_content === null)).toBe(true);
    });
    it('rolls back new prompt version and old-version deletion when retention fails', async () => {
      await app.prompts.createPromptTemplate({
        prompt_key: 'same-key',
        template: 'one',
      });
      await app.prompts.createPromptTemplate({
        prompt_key: 'same-key',
        template: 'two',
      });
      const remove = DeleteQueryBuilder.prototype.execute;
      const fault = jest
        .spyOn(DeleteQueryBuilder.prototype, 'execute')
        .mockImplementation(function (this: DeleteQueryBuilder<ObjectLiteral>) {
          if (
            this.expressionMap.mainAlias?.tablePath?.endsWith(
              'prompt_templates',
            )
          )
            return Promise.reject(new Error('synthetic prune failure'));
          return remove.call(this);
        });
      await expect(
        app.prompts.createPromptTemplate({
          prompt_key: 'same-key',
          template: 'three',
        }),
      ).rejects.toThrow('synthetic prune failure');
      fault.mockRestore();
      expect(
        (
          await source
            .getRepository(PromptTemplate)
            .find({ order: { version: 'ASC' } })
        ).map((row) => row.version),
      ).toEqual([1, 2]);
    });
    it('does not restore stale provider-independent job fields when polling or cancelling', async () => {
      const stale = await seedJob();
      await source
        .getRepository(BatchJob)
        .update(stale.id, {
          api_key_name: 'new-key-name',
          output_file_id: 'new-output',
        });
      await app.jobs.updateFromProvider(stale, { status: 'completed' });
      await app.jobs.markCancelled(stale);
      expect(
        await source.getRepository(BatchJob).findOneByOrFail({ id: stale.id }),
      ).toMatchObject({
        api_key_name: 'new-key-name',
        output_file_id: 'new-output',
        status: 'cancelled',
      });
    });
    it('does not interpret sparse polling metadata as a new validating status', async () => {
      const job = await seedJob();
      await app.jobs.updateFromProvider(job, { status: 'completed' });
      await app.jobs.updateFromProvider(job, { output_file_id: 'late-output' });
      expect(
        await source.getRepository(BatchJob).findOneByOrFail({ id: job.id }),
      ).toMatchObject({ status: 'completed', output_file_id: 'late-output' });
    });
    it('filters batch identities and single-node compatibility views before selecting rows', async () => {
      const own = await app.keys.create({ name: 'Own key' }),
        context = await app.keys.getContextById(own.item.id);
      const foreign = {
        ...context,
        id: 'foreign-key',
        workspace_id: 'other-workspace',
      };
      await seedJob('foreign-batch', foreign);
      await seedJob('other-key-batch', { ...context, id: 'other-key' });
      await seedJob('other-namespace-batch', {
        ...context,
        namespace_id: 'other-namespace',
      });
      await seedJob('own-batch', context);
      expect(
        (await app.jobs.findAccessible('provider-job', context))?.request_id,
      ).toBe('own-batch');
      expect(
        await app.jobs.findAccessible('foreign-batch', context),
      ).toBeNull();
      expect(await app.jobs.findAccessible('own-batch', foreign)).toBeNull();
      await source
        .getRepository(ProviderCompatibilityResult)
        .save({
          workspace_id: 'other-workspace',
          node_id: node.id,
          capability: 'chat',
          configured: true,
          tested: true,
          last_status: 'fail',
          failure_reason: 'foreign-private-reason',
        });
      expect(
        JSON.stringify(await app.compatibility.matrixForNode(node)),
      ).not.toContain('foreign-private-reason');
      await expect(
        app.compatibility.runNodeMatrix(node, { capabilities: ['chat'] }),
      ).rejects.toThrow();
      expect(
        (
          await source
            .getRepository(ProviderCompatibilityResult)
            .findOneByOrFail({ node_id: node.id })
        ).workspace_id,
      ).toBe('other-workspace');
    });
    it('serializes compatibility natural-key updates without duplicate records across connections', async () => {
      const other = await peer();
      await Promise.all([
        app.compatibility.runNodeMatrix(node, { capabilities: ['chat'] }),
        other.compatibility.runNodeMatrix(node, { capabilities: ['chat'] }),
      ]);
      expect(await count(ProviderCompatibilityResult)).toBe(1);
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });
    it('does not hold the database queue during shadow or compatibility network work', async () => {
      const touch = () =>
        withCoordinatedRepository(source.getRepository(CallLog), true, (repo) =>
          repo.save(log(`network-${Date.now()}-${Math.random()}`)),
        );
      provider.forward.mockImplementation(async () => {
        await touch();
        return makeCanonicalResponse();
      });
      jest.mocked(globalThis.fetch).mockImplementation(async () => {
        await touch();
        return new Response('{}', { status: 200 });
      });
      await app.shadow.dispatchChat(
        'shadow',
        makeRequest('private'),
        makeCanonicalResponse(),
        node.id,
        'synthetic-model',
      );
      await app.compatibility.runNodeMatrix(node, { capabilities: ['chat'] });
      expect(await count(CallLog)).toBe(2);
    });
    it('keeps profile edits and rendered timestamps consistent across concurrent connections', async () => {
      const key = await app.keys.create({ name: 'Linked key' });
      const profile = await app.profiles.create({
        name: 'Profile',
        connector: 'generic_openai',
        api_key_id: key.item.id,
      });
      const other = await peer();
      await Promise.all([
        app.profiles.render(profile.id),
        other.profiles.update(profile.id, {
          name: 'Changed',
          status: 'disabled',
        }),
      ]);
      const saved = (await app.profiles.list())[0];
      expect(saved).toMatchObject({
        name: 'Changed',
        status: 'disabled',
        api_key_id: key.item.id,
      });
      expect(saved.last_generated_at).toBeInstanceOf(Date);
      expect(saved.api_key?.name).toBe('Linked key');
      const results = await Promise.allSettled([
        app.profiles.create({ name: 'Duplicate', connector: 'generic_openai' }),
        other.profiles.create({
          name: 'Duplicate',
          connector: 'generic_openai',
        }),
      ]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        (
          results.find(
            (result) => result.status === 'rejected',
          ) as PromiseRejectedResult
        ).reason,
      ).toBeInstanceOf(BadRequestException);
    });
    it('rejects inactive or foreign managers for transaction-scoped key summaries', async () => {
      const key = await app.keys.create({ name: 'Key' });
      expect(() =>
        app.keys.getSummaryInTransaction(key.item.id, source.manager),
      ).toThrow('active transaction');
      const other = await connect();
      try {
        await other.source.transaction(async (manager) => {
          expect(() =>
            app.keys.getSummaryInTransaction(key.item.id, manager),
          ).toThrow('same database');
        });
      } finally {
        await other.source.destroy();
        await other.cleanup();
      }
      await coordinatedRepositoryOperation(
        source.getRepository(GatewayApiKey),
        true,
        async (manager) => {
          expect(
            (await app.keys.getSummaryInTransaction(key.item.id, manager!))
              .name,
          ).toBe('Key');
        },
      );
    });
    it('keeps a committed shadow result when best-effort retention fails', async () => {
      const remove = DeleteQueryBuilder.prototype.execute;
      const fault = jest
        .spyOn(DeleteQueryBuilder.prototype, 'execute')
        .mockImplementation(function (this: DeleteQueryBuilder<ObjectLiteral>) {
          if (
            this.expressionMap.mainAlias?.tablePath?.endsWith(
              'shadow_traffic_results',
            )
          )
            return Promise.reject(new Error('synthetic retention failure'));
          return remove.call(this);
        });
      for (let index = 0; index < 3; index++)
        await app.shadow.dispatchChat(
          `shadow-${index}`,
          makeRequest('private'),
          makeCanonicalResponse(),
          node.id,
          'synthetic-model',
        );
      fault.mockRestore();
      expect(await count(ShadowTrafficResult)).toBe(3);
      expect(provider.forward).toHaveBeenCalledTimes(3);
    });
    it('bounds each cleanup batch and preserves pricing evidence and recent logs', async () => {
      await prepareLedger();
      await source
        .getRepository(CallLog)
        .save(
          Array.from({ length: 503 }, (_, index) => ({
            ...log(`old-${index}`),
            timestamp: new Date(Date.now() - 2 * 86400000),
          })),
        );
      await source.getRepository(CallLog).save(log('recent'));
      const before = await source.query('SELECT * FROM pricing_reservations');
      const deletedSizes: number[] = [];
      const execute = DeleteQueryBuilder.prototype.execute;
      const fault = jest
        .spyOn(DeleteQueryBuilder.prototype, 'execute')
        .mockImplementation(function (this: DeleteQueryBuilder<ObjectLiteral>) {
          if (this.expressionMap.mainAlias?.tablePath?.endsWith('call_logs'))
            deletedSizes.push(Object.keys(this.getParameters()).length);
          return execute.call(this);
        });
      await cleanupLogs();
      fault.mockRestore();
      expect(deletedSizes).toEqual([500, 3]);
      expect(await count(CallLog)).toBe(1);
      expect(await source.query('SELECT * FROM pricing_reservations')).toEqual(
        before,
      );
    });
    it('does not expose uncommitted profile or prompt changes to ordinary service readers', async () => {
      const profile = await app.profiles.create({
        name: 'Stable profile',
        connector: 'generic_openai',
      });
      const prompt = await app.prompts.createPromptTemplate({
        prompt_key: 'stable',
        template: 'private',
      });
      const ready = gate(),
        release = gate();
      const change = coordinatedRepositoryOperation(
        source.getRepository(AgentProfile),
        true,
        async (manager) => {
          await manager!
            .getRepository(AgentProfile)
            .update(profile.id, { name: 'Uncommitted profile' });
          await manager!
            .getRepository(PromptTemplate)
            .update(prompt.item.id, { name: 'Uncommitted prompt' });
          ready.release();
          await release.ready;
          throw new Error('synthetic rollback');
        },
      ).catch((error) => error as Error);
      let reads: Promise<unknown[]> | undefined;
      try {
        await ready.ready;
        reads = Promise.all([
          app.profiles.list(),
          app.prompts.listPromptTemplates(),
        ]);
        if (source.options.type === 'postgres')
          expect(JSON.stringify(await reads)).not.toContain('Uncommitted');
      } finally {
        release.release();
        await change;
      }
      expect(JSON.stringify(await reads)).not.toContain('Uncommitted');
    });
  });
}

contract('SQLite WAL auxiliary writer boundaries', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'auxiliary-writers-'));
  const source = await new DataSource({
    type: 'better-sqlite3',
    database: join(directory, 'database.sqlite'),
    entities,
    synchronize: true,
  }).initialize();
  await source.query('PRAGMA journal_mode=WAL');
  return {
    source,
    cleanup: async () => rmSync(directory, { recursive: true, force: true }),
  };
});
const pgUrl = process.env.SIFTGATE_PRICING_TEST_POSTGRES_URL;
if (
  pgUrl &&
  (new URL(pgUrl).hostname !== '127.0.0.1' ||
    !/^\/pricing_goal_[a-z0-9_]+$/.test(new URL(pgUrl).pathname))
)
  throw new Error('Use only the task-owned PostgreSQL fixture');
contract(
  'PostgreSQL auxiliary writer boundaries',
  async () => {
    if (!pgUrl) throw new Error('No isolated PostgreSQL URL');
    const schema = `auxiliary_writers_${process.pid}_${Math.random().toString(16).slice(2)}`;
    const admin = await new DataSource({
      type: 'postgres',
      url: pgUrl,
      synchronize: false,
    }).initialize();
    let source: DataSource | undefined,
      created = false;
    try {
      await admin.query(
        'CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public',
      );
      await admin.query(`CREATE SCHEMA "${schema}"`);
      created = true;
      source = await new DataSource({
        type: 'postgres',
        url: pgUrl,
        schema,
        installExtensions: false,
        extra: { options: `-c search_path=${schema},public`, max: 6 },
        entities,
        synchronize: true,
      }).initialize();
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
