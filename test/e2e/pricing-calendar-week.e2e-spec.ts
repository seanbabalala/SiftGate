import { DataSource } from 'typeorm';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as yaml from 'js-yaml';
import * as bcrypt from 'bcryptjs';
import * as request from 'supertest';
import { WorkspaceMembershipService } from '../../src/auth/workspace-membership.service';
import { pricingContentHash } from '../../src/pricing/pricing-json';
import { createE2EHarness, type E2EHarness, FIXTURE_PATH } from './setup';
import { PricingRecoveryService } from '../../src/pricing/pricing-recovery.service';
import { applyPricingSchema, PRICING_TABLE_NAMES } from '../../src/pricing/pricing-schema';

const fixture = () => ({ schema_version: 1, version_id: 'synthetic-week', time_zone: 'Asia/Shanghai', tzdb_version: process.versions.tz, valid_from: '2026-01-01', valid_to: '2027-01-01', default_tag: 'offpeak', weekly: [{ weekdays: [7], windows: [{ start: '22:00', end: '02:00', tag: 'night' }] }], holidays: [], date_overrides: [] });
describe('calendar week preview HTTP', () => {
  let h: E2EHarness, db: DataSource, directory: string;
  beforeEach(async () => { directory = mkdtempSync(join(tmpdir(), 'calendar-week-http-')); const config = yaml.load(readFileSync(FIXTURE_PATH, 'utf8')) as Record<string, unknown>; config.dashboard = { auth_required: true, allow_legacy_token_auth: false, password: bcrypt.hashSync('synthetic-calendar-password', 4), session_secret: 'synthetic-calendar-session-secret' }; const file = join(directory, 'config.yaml'); writeFileSync(file, yaml.dump(config)); h = await createE2EHarness(file); expect((await h.agent.post('/api/auth/login').send({ password: 'synthetic-calendar-password' })).status).toBe(201); await h.app.get(PricingRecoveryService).onModuleDestroy(); db = h.app.get(DataSource); await applyPricingSchema(db); });
  afterEach(async () => { await h?.close(); if (directory) rmSync(directory, { recursive: true, force: true }); });
  async function state() { const rows: Record<string, unknown> = {}; for (const name of [...PRICING_TABLE_NAMES, 'call_logs', 'budget_rules']) rows[name] = await db.query(`SELECT * FROM ${name}`); return rows; }
  it('previews seven overlaid civil dates without pricing, budget or provider writes', async () => {
    const before = await state();
    const res = await h.agent.post('/api/dashboard/pricing/calendar/week-preview').send({ calendar: fixture(), date: '2026-09-30' });
    expect({ status: res.status, error: res.body.error }).toEqual({ status: 201, error: undefined });
    expect(res.body).toMatchObject({ read_only: true, simulation: true, complete: true, week_start: '2026-09-28', interpretation: 'civil_schedule_not_elapsed_time' });
    expect(res.body.days).toHaveLength(7); const { evidence_hash, ...body } = res.body; expect(evidence_hash).toBe(pricingContentHash(body));
    expect(res.body.days[0].segments[0]).toEqual({ start: '00:00', end: '02:00', tag: 'night', source: 'weekly', anchor_date: '2026-09-27' });
    expect(await state()).toEqual(before); expect(h.fetchMock.calls).toHaveLength(0);
  });
  it('requires authentication even though the operation is read-only', async () => {
    const body = { calendar: fixture(), date: '2026-09-30' };
    expect((await request(h.app.getHttpServer()).post('/api/dashboard/pricing/calendar/week-preview').send(body)).status).toBe(401);
    expect((await request(h.app.getHttpServer()).post('/api/dashboard/pricing/calendar/week-preview').set('Authorization', 'Bearer invalid').send(body)).status).toBe(401);
  });
  it('permits a stored viewer to preview supplied calendar data without publishing or reading another price book', async () => {
    const members = h.app.get(WorkspaceMembershipService);
    await members.ensureMembership({ userId: 'calendar-backup-admin', workspaceId: 'default-workspace', organizationId: 'default-org', role: 'admin' });
    await members.ensureMembership({ userId: 'dashboard', workspaceId: 'default-workspace', organizationId: 'default-org', role: 'viewer' });
    const before = await state(), payload = { calendar: fixture(), date: '2026-09-30' };
    expect((await h.agent.post('/api/dashboard/pricing/calendar/week-preview').send(payload)).status).toBe(201);
    expect((await h.agent.post('/api/dashboard/pricing/calendar/week-preview').send({ ...payload, book_id: 'private', workspace_id: 'other', role: 'admin' })).status).toBe(400);
    expect(await state()).toEqual(before);
  });
  it('preserves the single-date preview contract and matches its normalized segments', async () => {
    const calendar = fixture(), date = '2026-09-30';
    const one = await h.agent.post('/api/dashboard/pricing/calendar/preview').send({ calendar, date });
    const week = await h.agent.post('/api/dashboard/pricing/calendar/week-preview').send({ calendar, date });
    expect(one.status).toBe(201); expect(week.status).toBe(201); expect(week.body.days[2].segments).toEqual(one.body.segments);
  });
  it('rejects invalid dates, ambiguous windows and incompatible timezone data with structured errors', async () => {
    const path = '/api/dashboard/pricing/calendar/week-preview';
    for (const body of [{ calendar: fixture(), date: '2026-02-30' }, { calendar: fixture(), date: 'bad' }, { calendar: { ...fixture(), time_zone: '+08:00' }, date: '2026-09-30' }]) {
      const res = await h.agent.post(path).send(body); expect(res.status).toBe(400); expect(res.body.error.type).toBe('pricing_error');
    }
    const res = await h.agent.post(path).send({ calendar: { ...fixture(), tzdb_version: 'not-available' }, date: '2026-09-30' });
    expect(res.status).toBe(409); expect(res.body.error.code).toBe('pricing_calendar_unavailable');
  });
  it('keeps out-of-coverage dates explicit and never creates a default billable tag for them', async () => {
    const res = await h.agent.post('/api/dashboard/pricing/calendar/week-preview').send({ calendar: { ...fixture(), valid_from: '2026-09-30', valid_to: '2026-10-02' }, date: '2026-09-30' });
    expect(res.status).toBe(201); expect(res.body.days.filter((d: { covered: boolean }) => !d.covered)).toHaveLength(5);
    expect(res.body.days.filter((d: { covered: boolean }) => !d.covered).every((d: { segments: unknown[] }) => d.segments.length === 0)).toBe(true);
  });
  it('applies existing JSON/origin/body-size limits before calendar work', async () => {
    const path = '/api/dashboard/pricing/calendar/week-preview', payload = { calendar: fixture(), date: '2026-09-30' };
    expect((await h.agent.post(path).type('form').send({ date: '2026-09-30' })).status).toBe(403);
    expect((await h.agent.post(path).set('Origin', 'https://foreign.example.test').send(payload)).status).toBe(403);
    expect((await h.agent.post(path).send({ ...payload, padding: 'x'.repeat(1100000) })).status).toBe(413);
    expect(h.fetchMock.calls).toHaveLength(0);
  });

});
