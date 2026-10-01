import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import * as yaml from 'js-yaml';
import * as bcrypt from 'bcryptjs';
import { createE2EHarness, FIXTURE_PATH, type E2EHarness } from '../e2e/setup';
import { PricingRecoveryService } from '../../src/pricing/pricing-recovery.service';
import { applyPricingSchema } from '../../src/pricing/pricing-schema';
import { book, rate } from '../unit/pricing-fixtures';
import type { PriceBookContent } from '../../src/pricing/pricing.types';

export const SPEC_API = '/api/dashboard/pricing';
export function specificationTariff(operation: 'image_generation' | 'video_generation', fixed: string | null = '1024x1024'): PriceBookContent {
  const dimension = operation === 'image_generation' ? 'image_count' : 'video_generation_count';
  const content = book([rate('base', dimension, '0.1', '1')]);
  content.media_specification = { fixed: fixed === null ? {} : { size: fixed } };
  content.groups.push({ id: 'specification', order: 1, required: true, rules: ['512x512', '1024x1024'].map(size => ({ id: size, priority: 0, mode: 'whole_request', condition: { media: { size: [size] } }, rates: [{ operation: 'replace', component: rate('at-' + size, dimension, size === '512x512' ? '0.1' : '0.2', '1') }] })) });
  return content;
}
export async function mediaSpecificationHarness(directory: string, frontendRoot?: string, password?: string): Promise<E2EHarness> {
  const config = yaml.load(readFileSync(FIXTURE_PATH, 'utf8')) as Record<string, unknown>;
  config.cache = { enabled: false }; config.semantic_cache = { enabled: false };
  config.budget = { daily_token_limit: 10000000, daily_cost_limit: 1000, alert_threshold: .8 };
  if (password) config.dashboard = { auth_required: true, allow_legacy_token_auth: false, password: bcrypt.hashSync(password, 4), session_secret: 'synthetic-media-specification-session-secret' };
  const file = join(directory, 'config.yaml'); writeFileSync(file, yaml.dump(config));
  const h = await createE2EHarness(file, { frontendRoot });
  await h.app.get(PricingRecoveryService).onModuleDestroy(); await applyPricingSchema(h.app.get(DataSource));
  if (password) assert.equal((await h.agent.post('/api/auth/login').send({ password })).status, 201);
  return h;
}
export async function publishSpecification(h: E2EHarness, content: PriceBookContent, model = 'gpt-image-1', operation = 'image_generation') {
  const created = await h.agent.post(SPEC_API + '/books').send({ name: 'Synthetic specification contract', content });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const head = (await h.agent.get(SPEC_API + '/bindings')).body.head;
  const input = { draft_revision: 1, catalog_revision: head.revision, reason: 'Synthetic explicit specification contract', confirm: true, targets: [{ level: 'model', model, operation }] };
  const preview = await h.agent.post(`${SPEC_API}/drafts/${created.body.draft.id}/preview-publication`).send(input);
  assert.equal(preview.status, 201, JSON.stringify(preview.body)); assert.equal(preview.body.metering.can_publish, true);
  const published = await h.agent.post(`${SPEC_API}/drafts/${created.body.draft.id}/publish`).send({ ...input, metering_assessment_hash: preview.body.metering.assessment_hash });
  assert.equal(published.status, 201, JSON.stringify(published.body));
  return { created: created.body, published: published.body, preview: preview.body };
}
