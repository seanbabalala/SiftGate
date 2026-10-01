import { DataSource, DeleteQueryBuilder, type ObjectLiteral } from 'typeorm';
import { createE2EHarness, type E2EHarness, API_KEY } from './setup';
import { ConfigService } from '../../src/config/config.service';
import {
  AgentProfile,
  BatchJob,
  EvalSampleResult,
  GatewayApiKey,
  PromptTemplate,
  ProviderCompatibilityResult,
} from '../../src/database/entities';
import { applyPricingSchema } from '../../src/pricing/pricing-schema';
import { tokenBook } from '../unit/pricing-fixtures';

const root = '/api/dashboard';
describe('auxiliary writer boundaries over isolated HTTP', () => {
  let harness: E2EHarness, source: DataSource;
  beforeEach(async () => {
    harness = await createE2EHarness();
    source = harness.app.get(DataSource);
    await applyPricingSchema(source);
  }, 30000);
  afterEach(async () => {
    jest.restoreAllMocks();
    await harness?.close();
  });
  const publish = async () => {
    const created = await harness.agent
      .post(`${root}/pricing/books`)
      .send({ name: 'Synthetic writer price', content: tokenBook() });
    expect(created.status).toBe(201);
    const head = (await harness.agent.get(`${root}/pricing/bindings`)).body
      .head;
    const published = await harness.agent
      .post(`${root}/pricing/drafts/${created.body.draft.id}/publish`)
      .send({
        draft_revision: 1,
        catalog_revision: head.revision,
        reason: 'Synthetic fixture only',
        confirm: true,
        targets: [
          { level: 'model', model: 'gpt-4o' },
          { level: 'model', model: 'gpt-4o-mini' },
        ],
      });
    expect(published.status).toBe(201);
    harness.fetchMock.setHandler(async (_url, init) => {
      const body = JSON.parse(String(init.body || '{}')) as { model?: string };
      return new Response(
        JSON.stringify({
          id: 'synthetic-writer-response',
          model: body.model || 'gpt-4o',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: '{"score":0.5,"label":"tie"}',
              },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            prompt_tokens_details: { cached_tokens: 0 },
            cache_creation_input_tokens: 0,
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    });
  };
  const traffic = () =>
    harness.agent
      .post('/v1/chat/completions')
      .set('Authorization', `Bearer ${API_KEY}`)
      .send({
        model: 'gpt-4o',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'Synthetic writer test only' }],
      });

  it('keeps priced traffic, concurrent prompt versions and linked profile writes independent', async () => {
    await publish();
    const key = await source
      .getRepository(GatewayApiKey)
      .findOneByOrFail({ name: 'test-default' });
    const created = await harness.agent
      .post(`${root}/agent-profiles`)
      .send({
        name: 'Synthetic linked profile',
        connector: 'generic_openai',
        api_key_id: key.id,
      });
    expect(created.status).toBe(201);
    const id = created.body.item.id as string;
    const responses = await Promise.all([
      traffic(),
      harness.agent
        .post(`${root}/semantic-platform/prompt-templates`)
        .send({
          prompt_key: 'concurrent',
          template: 'PRIVATE_SYNTHETIC_PROMPT_ONE',
        }),
      harness.agent
        .post(`${root}/semantic-platform/prompt-templates`)
        .send({
          prompt_key: 'concurrent',
          template: 'PRIVATE_SYNTHETIC_PROMPT_TWO',
        }),
      harness.agent
        .put(`${root}/agent-profiles/${id}`)
        .send({ name: 'Renamed profile' }),
      harness.agent.post(`${root}/agent-profiles/${id}/render`).send({}),
    ]);
    expect(responses.map((response) => response.status)).toEqual([
      200, 201, 201, 200, 201,
    ]);
    expect(
      (
        await source
          .getRepository(PromptTemplate)
          .find({ order: { version: 'ASC' } })
      ).map((row) => row.version),
    ).toEqual([1, 2]);
    const profile = await source
      .getRepository(AgentProfile)
      .findOneByOrFail({ id });
    expect(profile.name).toBe('Renamed profile');
    expect(profile.last_generated_at).toBeInstanceOf(Date);
    expect(
      await source.query(
        "SELECT * FROM pricing_attempts WHERE state = 'terminal'",
      ),
    ).toHaveLength(1);
    expect(harness.fetchMock.calls).toHaveLength(1);
    expect(
      JSON.stringify(await source.getRepository(PromptTemplate).find()),
    ).not.toContain('PRIVATE_SYNTHETIC');
    expect(
      JSON.stringify(responses.slice(1).map((response) => response.body)),
    ).not.toContain('PRIVATE_SYNTHETIC');
  });

  it('runs evaluation targets and judge through the real priced pipeline without a held writer transaction', async () => {
    await publish();
    const target = { node_id: 'mock-openai', model: 'gpt-4o' };
    const response = await harness.agent
      .post(`${root}/evals/runs`)
      .send({
        dataset: { name: 'Synthetic priced evaluation' },
        primary: target,
        candidate: { ...target, model: 'gpt-4o-mini' },
        judge: target,
        samples: [{ id: 'one', prompt: 'PRIVATE_SYNTHETIC_EVAL' }],
      });
    expect(response.status).toBe(201);
    expect(response.body.run.status).toBe('completed');
    expect(harness.fetchMock.calls).toHaveLength(3);
    expect(
      await source.query(
        "SELECT * FROM pricing_attempts WHERE state = 'terminal'",
      ),
    ).toHaveLength(3);
    const samples = await source.getRepository(EvalSampleResult).find();
    expect(samples).toHaveLength(1);
    expect(JSON.stringify(samples)).not.toContain('PRIVATE_SYNTHETIC_EVAL');
    expect(
      (await harness.agent.get(`${root}/evals/reports/${response.body.run.id}`))
        .status,
    ).toBe(200);
  });

  it('rejects a failed prompt retention transaction without committing the new version', async () => {
    const config = harness.app.get(ConfigService);
    jest
      .spyOn(config, 'semanticPlatform', 'get')
      .mockReturnValue({
        ...config.semanticPlatform,
        prompt_registry: {
          ...config.semanticPlatform.prompt_registry,
          max_versions_per_key: 1,
        },
      });
    const first = await harness.agent
      .post(`${root}/semantic-platform/prompt-templates`)
      .send({ prompt_key: 'atomic', template: 'Synthetic one' });
    expect(first.status).toBe(201);
    const execute = DeleteQueryBuilder.prototype.execute;
    const failure = jest
      .spyOn(DeleteQueryBuilder.prototype, 'execute')
      .mockImplementation(function (this: DeleteQueryBuilder<ObjectLiteral>) {
        if (
          this.expressionMap.mainAlias?.tablePath?.endsWith('prompt_templates')
        )
          return Promise.reject(
            new Error('synthetic required retention failure'),
          );
        return execute.call(this);
      });
    const failed = await harness.agent
      .post(`${root}/semantic-platform/prompt-templates`)
      .send({ prompt_key: 'atomic', template: 'Synthetic two' });
    expect(failed.status).toBe(500);
    failure.mockRestore();
    expect(
      (await source.getRepository(PromptTemplate).find()).map((row) => row.id),
    ).toEqual([first.body.item.id]);
    expect(harness.fetchMock.calls).toHaveLength(0);
  });

  it('preserves fresh batch metadata and returns cancelled after an empty successful upstream cancellation', async () => {
    const created = await harness.agent
      .post('/v1/batches')
      .set('Authorization', `Bearer ${API_KEY}`)
      .send({
        input_file_id: 'file-test',
        endpoint: '/v1/chat/completions',
        completion_window: '24h',
        model: 'gpt-4o-mini',
      });
    expect(created.status).toBe(200);
    const job = await source
      .getRepository(BatchJob)
      .findOneByOrFail({ provider_batch_id: created.body.id });
    harness.fetchMock.reset();
    harness.fetchMock.setHandler(async () => {
      // Happens while the old in-memory job is at the mocked upstream boundary.
      await source
        .getRepository(BatchJob)
        .update(job.id, { output_file_id: 'fresh-file-after-read' });
      return new Response(null, { status: 204 });
    });
    const cancelled = await harness.agent
      .post(`/v1/batches/${created.body.id}/cancel`)
      .set('Authorization', `Bearer ${API_KEY}`);
    expect(cancelled.status).toBe(204);
    expect(
      await source.getRepository(BatchJob).findOneByOrFail({ id: job.id }),
    ).toMatchObject({
      status: 'cancelled',
      output_file_id: 'fresh-file-after-read',
    });
    expect(harness.fetchMock.calls).toHaveLength(1);
  });

  it('does not reveal another workspace compatibility result from the single-node test response', async () => {
    await source
      .getRepository(ProviderCompatibilityResult)
      .save({
        workspace_id: 'foreign-workspace',
        node_id: 'mock-openai',
        capability: 'images',
        configured: true,
        tested: true,
        last_status: 'fail',
        failure_reason: 'FOREIGN_PRIVATE_REASON',
      });
    const result = await harness.agent
      .post(`${root}/nodes/mock-openai/test`)
      .send({ capabilities: ['chat'] });
    expect(result.status).toBe(201);
    expect(JSON.stringify(result.body)).not.toContain('FOREIGN_PRIVATE_REASON');
    const foreign = await source
      .getRepository(ProviderCompatibilityResult)
      .findOneByOrFail({ capability: 'images' });
    expect(foreign.workspace_id).toBe('foreign-workspace');
    expect(foreign.failure_reason).toBe('FOREIGN_PRIVATE_REASON');
  });
});
