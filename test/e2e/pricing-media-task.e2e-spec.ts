import type { NativeVideoResultProfile } from "../../src/pricing/video-result-profile.types";
import type { MediaEventDispositionPreview } from "../../src/pricing/media-event-disposition.types";
import { createHmac } from "node:crypto";
import { mediaSupplierSigningInput } from "../../src/pricing/media-supplier-event";
import type { MediaSupplierEvent } from "../../src/pricing/media-supplier.types";
import { WorkspaceMembershipService } from "../../src/auth/workspace-membership.service";
import { DataSource } from "typeorm";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as yaml from "js-yaml";
import {
  createE2EHarness,
  E2EHarness,
  FIXTURE_PATH,
  API_KEY,
  API_KEY_2,
} from "./setup";
import { applyPricingSchema } from "../../src/pricing/pricing-schema";
import { MediaTaskService } from "../../src/pricing/media-task.service";
import { PricingRepository } from "../../src/pricing/pricing-repository";
import { PricingRecoveryService } from "../../src/pricing/pricing-recovery.service";
import { CostLedgerService } from "../../src/pricing/cost-ledger.service";
import { ConfigService } from "../../src/config/config.service";
import { book, rate } from "../unit/pricing-fixtures";
import type { MediaTaskRow, MediaTaskContext } from "../../src/pricing/media-task.types";

// Every price and supplier response in this suite is synthetic. No real upstream is used.
describe("durable asynchronous media pricing", () => {
  let harness: E2EHarness;
  let directory: string;
  let source: DataSource;
  let tasks: MediaTaskService;
  const base = "/api/dashboard/pricing";
  const model = "veo-3-preview";
  const payload = { model, seconds: 8, prompt: "PRIVATE-GENERATION-PROMPT" };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const completed = (seconds = "6.4", status = "completed") => ({
    id: "provider-job",
    status,
    usage: { video_seconds: seconds, generation_count: 1 },
  });
  const videoPrice = () => ({
    ...book([
      rate("duration", "video_seconds", "0.10", "1"),
      rate("base", "video_generation_count", "0.02", "1"),
    ]),
    allow_combined_media: true,
  });
  const call = (body: Record<string, unknown> = payload, key = API_KEY, idempotency?: string) => {
    const request = harness.agent
      .post("/v1/videos/generations")
      .set("Authorization", `Bearer ${key}`);
    if (idempotency) request.set("Idempotency-Key", idempotency);
    return request.send(body);
  };
  const status = (id = "provider-job", key = API_KEY) =>
    harness.agent.get(`/v1/videos/${id}`).set("Authorization", `Bearer ${key}`);
  const cancel = () =>
    harness.agent
      .post("/v1/videos/provider-job/cancel")
      .set("Authorization", `Bearer ${API_KEY}`);
  const row = async () =>
    (
      await source.query("SELECT * FROM pricing_media_tasks")
    )[0] as MediaTaskRow;
  const summary = async () => {
    const task = await row();
    return harness.app
      .get(CostLedgerService)
      .summary(task.request_id, task.workspace_id);
  };
  async function publish(
    content = videoPrice(),
    targetModel = model,
    operation = "video_generation",
  ) {
    const created = await harness.agent
      .post(`${base}/books`)
      .send({ name: "Synthetic task pricing", content });
    expect({ status: created.status, error: created.body.error }).toEqual({
      status: 201,
      error: undefined,
    });
    const revision = (await harness.agent.get(`${base}/bindings`)).body.head
      .revision;
    expect(
      (
        await harness.agent
          .post(`${base}/drafts/${created.body.draft.id}/publish`)
          .send({
            draft_revision: 1,
            catalog_revision: revision,
            reason: "Synthetic isolated test",
            confirm: true,
            targets: [{ level: "model", model: targetModel, operation }],
          })
      ).status,
    ).toBe(201);
  }
  async function actualPolicy(operation = "video_generation") {
    const head = (await harness.agent.get(`${base}/bindings`)).body.head;
    const response = await harness.agent.put(`${base}/admission-policy`).send({ catalog_revision: head.revision, scope: "workspace", operation, reason: "Synthetic actual media lifecycle", confirm: true,
      policy: { mode: "compatibility", budget_basis: "actual_upstream", token_budget: "not_applicable" } });
    expect({ status: response.status, error: response.body.error }).toEqual({ status: 200, error: undefined });
  }
  async function fx(denominator: string) {
    const head = (await harness.agent.get(`${base}/bindings`)).body.head;
    const response = await harness.agent.put(`${base}/fx`).send({ catalog_revision: head.revision, reason: "Synthetic media FX", confirm: true, scope: "workspace", versions: [{ fx: {
      version_id: "synthetic-fx", from_currency: "CNY", to_currency: "USD", numerator: "1", denominator, effective_at: new Date().toISOString(), source: "synthetic fixture",
    } }] });
    expect({ status: response.status, error: response.body.error }).toEqual({ status: 200, error: undefined });
  }
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "media-task-e2e-"));
    const config = yaml.load(readFileSync(FIXTURE_PATH, "utf8")) as Record<
      string,
      unknown
    >;
    config.budget = {
      daily_token_limit: 10000000,
      daily_cost_limit: 1000,
      alert_threshold: 0.8,
    };
    const node = (config.nodes as Record<string, unknown>[])[0];
    node.credentials = [
      { id: "task-original", api_key: "synthetic-key-a" },
      { id: "task-alternative", api_key: "synthetic-key-b" },
    ];
    node.images_status_endpoint = "/v1/images/jobs/:id";
    node.images_cancel_endpoint = "/v1/images/jobs/:id/cancel";
    node.images_content_endpoint = "/v1/images/jobs/:id/content";
    const file = join(directory, "config.yaml");
    writeFileSync(file, yaml.dump(config));
    harness = await createE2EHarness(file);
    await harness.app.get(PricingRecoveryService).onModuleDestroy();
    source = harness.app.get(DataSource);
    tasks = harness.app.get(MediaTaskService);
    await applyPricingSchema(source);
    await publish();
  }, 30000);
  afterEach(async () => {
    jest.restoreAllMocks();
    await harness?.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const signingKey = "synthetic-http-media-signing-key-not-production",
    secretName = "SIFTGATE_MEDIA_EVENT_HTTP";
  let previousSecret: string | undefined;
  beforeEach(() => {
    previousSecret = process.env[secretName];
    process.env[secretName] = signingKey;
  });
  afterEach(() => {
    if (previousSecret === undefined) delete process.env[secretName];
    else process.env[secretName] = previousSecret;
  });
  async function configureSource() {
    const task = await row();
    const attempt = (await source.query("SELECT * FROM pricing_attempts"))[0];
    const credential =
      task.credential_id ??
      JSON.parse(attempt.price_context_json).dispatch.credential_id;
    const response = await harness.agent
      .put(`${base}/media-event-sources/http-source`)
      .send({
        revision: 0,
        node_id: task.node_id,
        credential_id: credential,
        secret_env: secretName,
        enabled: true,
        reason: "Isolated supplier source test",
        confirm: true,
      });
    expect({ status: response.status, error: response.body.error }).toEqual({
      status: 200,
      error: undefined,
    });
    return response.body;
  }
  async function event(
    sequence = "1",
    seconds = "6.4",
  ): Promise<MediaSupplierEvent> {
    const task = await row();
    return {
      schema_version: 1,
      event_id: `http-event-${sequence}`,
      task_id: task.id,
      provider_job_id: "provider-job",
      sequence,
      status: "completed",
      accepted_at: task.accepted_at ?? task.created_at,
      completed_at: new Date().toISOString(),
      time_quality: "estimated",
      evidence: [
        { dimension: "video_seconds", value: seconds, quality: "observed" },
        {
          dimension: "video_generation_count",
          value: "1",
          quality: "observed",
        },
      ],
    };
  }
  function sendEvent(
    value: MediaSupplierEvent,
    revision = "1",
    signature?: string,
  ) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    return harness.agent
      .post("/api/pricing/media-events/http-source")
      .set("x-siftgate-media-time", timestamp)
      .set("x-siftgate-media-revision", revision)
      .set(
        "x-siftgate-media-signature",
        signature ??
          "v1=" +
            createHmac("sha256", signingKey)
              .update(
                mediaSupplierSigningInput(
                  "http-source",
                  revision,
                  timestamp,
                  value,
                ),
              )
              .digest("hex"),
      )
      .send(value);
  }


  async function retainedAlternative() {
    harness.fetchMock.setHandler(async () => json({ id: "provider-job", status: "queued" }));
    expect((await call()).status).toBe(200);
    await configureSource();
    expect((await sendEvent(await event())).status).toBe(202);
    const value = { ...await event("1", "8.4"), event_id: "http-alternative" }, response = await sendEvent(value);
    expect(response.body.decision).toBe("review_required");
    return `${base}/media-tasks/${(await row()).id}/supplier-events/${response.body.id}`;
  }
  async function previewDisposition(path: string, action = "accept", ordering = action === "reject" ? "unchanged" : "continue_ordered"): Promise<MediaEventDispositionPreview> {
    const basis = await harness.agent.get(`${path}/disposition-basis`);
    expect(basis.status).toBe(200);
    const response = await harness.agent.post(`${path}/disposition/preview`).send({ action, ordering, expected_basis_hash: basis.body.basis_hash, expected_event_hash: basis.body.event_hash });
    expect({ status: response.status, error: response.body.error }).toEqual({ status: 201, error: undefined });
    return response.body;
  }
  const dispositionBody = (preview: MediaEventDispositionPreview, id = "http-disposition") => ({
    id, action: preview.action, ordering: preview.ordering, expected_basis_hash: preview.basis_hash, expected_event_hash: preview.event_hash,
    expected_preview_hash: preview.preview_hash, reason: "Review original normalized media quantities", confirm: true,
  });
  const dispositionTables = ["pricing_media_tasks", "pricing_media_observations", "pricing_media_supplier_events", "pricing_media_event_heads", "pricing_media_event_dispositions", "pricing_media_event_authorities", "pricing_attempts", "pricing_cost_adjustments", "pricing_audit_events", "pricing_budget_balances", "pricing_budget_effects", "budget_rules"];
  async function dispositionRows() {
    const rows: Record<string, unknown> = {};
    for (const table of dispositionTables) rows[table] = await source.query(`SELECT * FROM ${table}`);
    return rows;
  }
  it("previews and applies a reviewed media alternative over HTTP without rewriting custody or issuing another provider call", async () => {
    const path = await retainedAlternative(), before = await dispositionRows(), calls = harness.fetchMock.calls.length;
    const preview = await previewDisposition(path), input = dispositionBody(preview);
    expect(preview).toMatchObject({ cost: { report_amount: "0.860000000" }, impact: { amount_delta: "0.200000000000000000" } });
    expect(await dispositionRows()).toEqual(before);
    const result = await harness.agent.post(`${path}/disposition`).send(input);
    expect({ status: result.status, error: result.body.error }).toEqual({ status: 201, error: undefined });
    expect(result.body).toMatchObject({ replayed: false, processing_pending: false, preview: { original_receipts_modified: false } });
    expect((await summary())?.budget_committed_usd).toBe("0.860000000000000000");
    expect(await source.query("SELECT * FROM pricing_media_supplier_events")).toEqual(before.pricing_media_supplier_events);
    const after = await dispositionRows();
    expect((await harness.agent.post(`${path}/disposition`).send(input)).body).toMatchObject({ replayed: true, record_hash: result.body.record_hash });
    expect((await harness.agent.get(`${path}/dispositions/${input.id}`)).body.record_hash).toBe(result.body.record_hash);
    expect(await dispositionRows()).toEqual(after);
    expect(harness.fetchMock.calls).toHaveLength(calls);
    expect((await harness.agent.get(`${base}/media-tasks?view=review_required`)).body.tasks).toHaveLength(0);
    expect((await harness.agent.get(path)).body).toMatchObject({ decision: "review_required", disposition: { preview: { action: "accept" } } });
  });
  it("rejects stale or forged media impact, unknown fields and untrusted-origin writes without changing the task", async () => {
    const path = await retainedAlternative(), preview = await previewDisposition(path), input = dispositionBody(preview), before = await dispositionRows();
    expect((await harness.agent.post(`${path}/disposition`).send({ ...input, expected_preview_hash: "f".repeat(64) })).status).toBe(409);
    expect((await harness.agent.post(`${path}/disposition`).send({ ...input, cost: "0" })).status).toBe(400);
    expect((await harness.agent.post(`${path}/disposition`).set("Origin", "https://untrusted.example").send(input)).status).toBe(403);
    expect(await dispositionRows()).toEqual(before);
    await sendEvent(await event("2", "10"));
    expect((await harness.agent.post(`${path}/disposition`).send(input)).status).toBe(409);
    const reject = await previewDisposition(path, "reject");
    expect((await harness.agent.post(`${path}/disposition`).send(dispositionBody(reject))).status).toBe(201);
    expect((await summary())?.amount).toBe("1.020000000000000000");
  });
  it("keeps disposition administration separate from read-only operators and rechecks revoked membership after a preview", async () => {
    const path = await retainedAlternative(), preview = await previewDisposition(path), input = dispositionBody(preview);
    const members = harness.app.get(WorkspaceMembershipService), workspace = (await row()).workspace_id;
    await members.ensureMembership({ userId: "backup-admin", workspaceId: workspace, organizationId: "default-org", role: "admin" });
    await members.ensureMembership({ userId: "dashboard", workspaceId: workspace, organizationId: "default-org", role: "operator" });
    const before = await dispositionRows();
    expect((await harness.agent.get(`${path}/disposition-basis`)).status).toBe(200);
    expect((await harness.agent.post(`${path}/disposition`).send(input)).status).toBe(403);
    expect((await harness.agent.get(`${path}/dispositions/${input.id}`)).status).toBe(403);
    expect(await dispositionRows()).toEqual(before);
    await members.ensureMembership({ userId: "dashboard", workspaceId: workspace, organizationId: "default-org", role: "viewer" });
    expect((await harness.agent.get(`${path}/disposition-basis`)).status).toBe(403);
  });
  it("requires explicit manual review after accepting unversioned evidence and can resume only from a signed reviewed sequence", async () => {
    await retainedAlternative();
    const task = await row();
    await tasks.observe(task.id, task.workspace_id, completed("9.4"));
    const events = await harness.agent.get(`${base}/media-tasks/${task.id}/supplier-events`), alternative = events.body.events.find((e: { origin: string }) => e.origin === "unversioned_observation");
    const path = `${base}/media-tasks/${task.id}/supplier-events/${alternative.id}`;
    const preview = await previewDisposition(path, "accept", "manual_review");
    expect((await harness.agent.post(`${path}/disposition`).send(dispositionBody(preview))).status).toBe(201);
    const next = await sendEvent(await event("10", "10.4"));
    expect(next.body.decision).toBe("review_required");
    expect((await summary())?.amount).toBe("0.960000000000000000");
    const nextPath = `${base}/media-tasks/${task.id}/supplier-events/${next.body.id}`, resumed = await previewDisposition(nextPath);
    expect((await harness.agent.post(`${nextPath}/disposition`).send(dispositionBody(resumed, "resume-ordering"))).status).toBe(201);
    expect((await sendEvent(await event("11", "11.4"))).body.decision).toBe("applied");
    expect((await summary())?.amount).toBe("1.160000000000000000");
  });
  it("acknowledges retained media decisions independently of interrupted financial processing", async () => {
    const path = await retainedAlternative(), preview = await previewDisposition(path), input = dispositionBody(preview);
    const failure = jest.spyOn(harness.app.get(CostLedgerService), "adjustAttempt").mockRejectedValueOnce(new Error("synthetic ledger interruption"));
    const response = await harness.agent.post(`${path}/disposition`).send(input);
    expect(response.status).toBe(201); expect(response.body.processing_pending).toBe(true);
    failure.mockRestore();
    expect((await harness.agent.get(`${path}/dispositions/${input.id}`)).status).toBe(200);
    expect((await harness.agent.post(`${path}/disposition`).send(input)).body).toMatchObject({ replayed: true, processing_pending: false });
    expect((await summary())?.budget_committed_usd).toBe("0.860000000000000000");
  });

  it.each<NativeVideoResultProfile>(['gemini-veo-rest-v1','runway-task-v1'])('uses the native %s acknowledgement, authenticated status GET and original count price over actual HTTP', async profile=>{
    const node=harness.app.get(ConfigService).getNode('mock-openai')!;node.video_result_profile=profile;
    node.video_status_endpoint=profile==='gemini-veo-rest-v1'?'/v1beta/{id}':'/v1/tasks/:id';
    node.video_endpoint=profile==='gemini-veo-rest-v1'?'/v1beta/models/{model}:predictLongRunning':'/v1/text_to_video';
    await publish(book([rate('returned-clips','video_generation_count','0.04','1')]));
    const job=profile==='gemini-veo-rest-v1'?'models/synthetic-veo/operations/task-1':'17f20503-6c24-4c16-946b-35dbbce2af2f';
    const accepted=profile==='gemini-veo-rest-v1'?{name:job}:{id:job};
    const terminal=profile==='gemini-veo-rest-v1'?{name:job,done:true,response:{generateVideoResponse:{generatedSamples:[{video:{uri:'https://private.invalid/a'}},{video:{uri:'https://private.invalid/b'}}]}}}:{id:job,status:'SUCCEEDED',createdAt:'2026-09-27T00:00:00Z',output:['https://private.invalid/a','https://private.invalid/b'],cost:{credits:999}};
    harness.fetchMock.setHandler(async(_url,init)=>json(init?.method==='GET'?terminal:accepted));
    const nativePayload=profile==='gemini-veo-rest-v1'?{model,instances:[{prompt:'PRIVATE-NATIVE-PROMPT'}],parameters:{durationSeconds:8,sampleCount:2}}:{model,promptText:'PRIVATE-NATIVE-PROMPT',duration:8,ratio:'1280:720'};
    const response=await call(nativePayload);expect({status:response.status,error:response.body.error}).toEqual({status:200,error:undefined});
    const task=await row();expect(task.state).toBe('pending');expect(task.provider_job_id).toBe(job);
    expect(JSON.parse(task.context_json)).toMatchObject({video_result_profile:profile,request_usage:{quantities:{requested_video_seconds:{value:'8'}}}});
    const requestCall=harness.fetchMock.calls.find(c=>c.method==='POST')!;
    expect(requestCall.body).toBeDefined();
    if(profile==='gemini-veo-rest-v1')expect(requestCall.body).not.toHaveProperty('model');
    // New prices and newly selected profiles do not change an in-flight task.
    await publish(book([rate('new-clips','video_generation_count','99','1')]));node.video_result_profile='generic-v1';
    expect((await status(task.id)).status).toBe(200);
    expect((await summary())?.amount).toBe('0.080000000000000000');
    const cost=(await summary())?.attempts[0].effective_cost;
    expect(cost?.usage).toMatchObject({adapter_id:profile,quantities:{video_generation_count:{value:'2'},video_seconds:{value:null,quality:'unsupported'}}});
    expect(harness.fetchMock.calls.filter(c=>c.method==='POST')).toHaveLength(1);
    const get=harness.fetchMock.calls.find(c=>c.method==='GET')!;
    expect(get.url).toContain(profile==='gemini-veo-rest-v1'?'/v1beta/'+job:'/v1/tasks/'+job);
    expect(JSON.stringify(await source.query('SELECT * FROM pricing_media_observations'))).not.toMatch(/PRIVATE-NATIVE|private.invalid/);
    const first=await source.query('SELECT * FROM pricing_settlement_intents');await status(task.id);expect(await source.query('SELECT * FROM pricing_settlement_intents')).toEqual(first);
  });
  it('does not dispatch a native request to an unconfigured generic node or a mismatched native request schema', async()=>{
    const response=await call({model,promptText:'synthetic',duration:8});expect(response.status).toBe(400);expect(harness.fetchMock.calls).toHaveLength(0);
    harness.app.get(ConfigService).getNode('mock-openai')!.video_result_profile='runway-task-v1';
    const mismatched=await call({model,instances:[{prompt:'synthetic'}],parameters:{durationSeconds:8}});expect(mismatched.status).toBe(400);expect(harness.fetchMock.calls).toHaveLength(0);
  });
  it('exposes only supported video profile choices through node CRUD and preserves them during unrelated edits', async()=>{
    expect((await harness.agent.put('/api/dashboard/nodes/mock-openai').send({video_result_profile:'made-up'})).status).toBe(400);
    expect((await harness.agent.put('/api/dashboard/nodes/mock-openai').send({video_result_profile:'runway-task-v1'})).status).toBe(200);
    expect((await harness.agent.put('/api/dashboard/nodes/mock-openai').send({name:'Synthetic unchanged profile'})).status).toBe(200);
    const nodes=await harness.agent.get('/api/dashboard/nodes');expect(nodes.status).toBe(200);
    const list=Array.isArray(nodes.body)?nodes.body:nodes.body.nodes;expect(list.find((n:{id:string})=>n.id==='mock-openai').video_result_profile).toBe('runway-task-v1');
  });
  it("accepts only signed media events, pins original prices, ignores stale events and preserves unordered alternatives", async () => {
    harness.fetchMock.setHandler(async () =>
      json({ id: "provider-job", status: "queued" }),
    );
    expect((await call()).status).toBe(200);
    await configureSource();
    const value = await event();
    expect(
      (
        await harness.agent
          .post("/api/pricing/media-events/http-source")
          .send(value)
      ).status,
    ).toBe(401);
    expect((await sendEvent(value, "1", "v1=" + "0".repeat(64))).status).toBe(
      401,
    );
    const next = videoPrice();
    next.groups[0].rules[0].rates[0].component.amount = "99";
    await publish(next);
    const calls = harness.fetchMock.calls.length;
    const received = await sendEvent(value);
    expect(received.status).toBe(202);
    expect(received.body).toMatchObject({
      decision: "applied",
      processing_pending: false,
      supplier_invoice_confirmed: false,
    });
    expect((await sendEvent(value)).body.replayed).toBe(true);
    expect((await summary())?.amount).toBe("0.660000000000000000");
    const old = await event("0", "2");
    expect((await sendEvent(old)).body.decision).toBe("ignored_stale");
    expect(harness.fetchMock.calls).toHaveLength(calls);
    harness.fetchMock.setHandler(async () => json(completed("9.4")));
    await status();
    expect((await summary())?.amount).toBe("0.660000000000000000");
    const history = await harness.agent.get(
      `${base}/media-tasks/${(await row()).id}/supplier-events`,
    );
    expect(history.status).toBe(200);
    expect(
      history.body.events.some(
        (e: { origin: string; decision: string }) =>
          e.origin === "unversioned_observation" &&
          e.decision === "review_required",
      ),
    ).toBe(true);
    expect((await sendEvent(await event("2", "7.4"))).status).toBe(202);
    expect((await summary())?.budget_committed_usd).toBe(
      "0.760000000000000000",
    );
    const text = JSON.stringify(
      await source.query("SELECT * FROM pricing_media_supplier_events"),
    );
    expect(text).not.toMatch(
      /PRIVATE-GENERATION|synthetic-key|synthetic-http-media-signing-key/,
    );
  });
  it("recovers an unknown provider job after lost submission response without dispatching another generation", async () => {
    harness.fetchMock.setHandler(async () => {
      throw new Error("synthetic media response lost");
    });
    await call();
    const task = await row();
    expect(task.state).toBe("uncertain");
    await configureSource();
    const calls = harness.fetchMock.calls.length;
    const response = await sendEvent(await event());
    expect({ status: response.status, error: response.body.error }).toEqual({
      status: 202,
      error: undefined,
    });
    expect(await row()).toMatchObject({
      state: "settled",
      provider_job_id: "provider-job",
    });
    expect((await summary())?.amount).toBe("0.660000000000000000");
    expect(harness.fetchMock.calls).toHaveLength(calls);
  });
  it("requires source administration, trusted origin and workspace-scoped inspection independently of callback signatures", async () => {
    harness.fetchMock.setHandler(async () =>
      json({ id: "provider-job", status: "queued" }),
    );
    await call();
    const configured = await configureSource();
    const body = {
      revision: 1,
      node_id: configured.node_id,
      credential_id: configured.credential_id,
      secret_env: secretName,
      enabled: false,
      reason: "Synthetic disable",
      confirm: true,
    };
    expect(
      (
        await harness.agent
          .put(`${base}/media-event-sources/http-source`)
          .set("Origin", "https://untrusted.example")
          .send(body)
      ).status,
    ).toBe(403);
    const members = harness.app.get(WorkspaceMembershipService);
    await members.ensureMembership({
      userId: "backup-admin",
      workspaceId: (await row()).workspace_id,
      organizationId: "default-org",
      role: "admin",
    });
    await members.ensureMembership({
      userId: "dashboard",
      workspaceId: (await row()).workspace_id,
      organizationId: "default-org",
      role: "viewer",
    });
    expect(
      (
        await harness.agent
          .put(`${base}/media-event-sources/http-source`)
          .send(body)
      ).status,
    ).toBe(403);
    expect(
      (await harness.agent.get(`${base}/media-event-sources`)).status,
    ).toBe(403);
    expect((await sendEvent(await event())).status).toBe(202);
  });
  it("rejects revoked source revisions and unknown payload fields without creating observations", async () => {
    harness.fetchMock.setHandler(async () =>
      json({ id: "provider-job", status: "queued" }),
    );
    await call();
    const configured = await configureSource(),
      value = await event();
    const before = await source.query(
      "SELECT * FROM pricing_media_observations",
    );
    const malformed = { ...value, raw_response: { prompt: "not retained" } };
    expect((await sendEvent(malformed)).status).toBe(400);
    const updated = await harness.agent
      .put(`${base}/media-event-sources/http-source`)
      .send({
        revision: 1,
        node_id: configured.node_id,
        credential_id: configured.credential_id,
        secret_env: secretName,
        enabled: false,
        reason: "Synthetic disable",
        confirm: true,
      });
    expect(updated.status).toBe(200);
    expect((await sendEvent(value)).status).toBe(401);
    expect(
      await source.query("SELECT * FROM pricing_media_observations"),
    ).toEqual(before);
    expect(
      await source.query("SELECT * FROM pricing_media_supplier_events"),
    ).toHaveLength(0);
  });

  const lookupRoute = async () => `${base}/media-tasks/${(await row()).id}`;
  async function loseSubmission() {
    harness.fetchMock.setHandler(async () => {
      throw new Error("synthetic response lost");
    });
    await call();
    expect((await row()).state).toBe("uncertain");
    harness.fetchMock.setHandler(async () => json(completed()));
    return lookupRoute();
  }
  const lookupBody = (preview: {
    basis_hash: string;
    observation_hash: string;
    cost_hash: string;
  }) => ({
    id: "http-lookup",
    provider_job_id: "provider-job",
    expected_basis_hash: preview.basis_hash,
    expected_observation_hash: preview.observation_hash,
    expected_cost_hash: preview.cost_hash,
    reason: "Administrator verified unknown supplier job",
    confirm: true,
  });
  async function lookupPreview(path: string) {
    const basis = await harness.agent.get(`${path}/job-lookup-basis`);
    expect(basis.status).toBe(200);
    const preview = await harness.agent
      .post(`${path}/job-lookup/preview`)
      .send({
        provider_job_id: "provider-job",
        expected_basis_hash: basis.body.basis_hash,
      });
    expect({ status: preview.status, error: preview.body.error }).toEqual({
      status: 201,
      error: undefined,
    });
    return preview.body;
  }

  it("previews and applies administrator-attested job correlation with original credentials and frozen prices over HTTP", async () => {
    const path = await loseSubmission(),
      before = await source.query("SELECT * FROM pricing_media_tasks"),
      calls = harness.fetchMock.calls.length,
      preview = await lookupPreview(path);
    expect(await source.query("SELECT * FROM pricing_media_tasks")).toEqual(
      before,
    );
    expect(
      await source.query("SELECT * FROM pricing_media_job_reconciliations"),
    ).toHaveLength(0);
    expect(preview).toMatchObject({
      dry_run: true,
      association_source: "administrator_attestation",
      supplier_invoice_confirmed: false,
    });
    const expensive = videoPrice();
    expensive.groups[0].rules[0].rates[0].component.amount = "99";
    await publish(expensive);
    const result = await harness.agent
      .post(`${path}/job-lookup`)
      .send(lookupBody(preview));
    expect({ status: result.status, error: result.body.error }).toEqual({
      status: 201,
      error: undefined,
    });
    expect(result.body).toMatchObject({
      replayed: false,
      processing_pending: false,
    });
    expect((await summary())?.amount).toBe("0.660000000000000000");
    const count = harness.fetchMock.calls.length;
    const repeated = await harness.agent
      .post(`${path}/job-lookup`)
      .send(lookupBody(preview));
    expect(repeated.body.replayed).toBe(true);
    expect(harness.fetchMock.calls).toHaveLength(count);
    expect(
      harness.fetchMock.calls.slice(calls).every((c) => c.method === "GET"),
    ).toBe(true);
    expect(
      (await harness.agent.get(`${path}/job-lookups/http-lookup`)).body
        .record_hash,
    ).toBe(result.body.record_hash);
    expect((await harness.agent.get(path)).body.ledger.amount).toBe(
      "0.660000000000000000",
    );
    expect(
      JSON.stringify(
        await source.query("SELECT * FROM pricing_media_job_reconciliations"),
      ),
    ).not.toMatch(/PRIVATE-GENERATION|synthetic-key/);
  });
  it("keeps lookup writes scoped, rejects stale evidence and prevents unauthorized provider IO", async () => {
    const path = await loseSubmission(),
      preview = await lookupPreview(path);
    harness.fetchMock.setHandler(async () => json(completed("9.4")));
    expect(
      (await harness.agent.post(`${path}/job-lookup`).send(lookupBody(preview)))
        .status,
    ).toBe(409);
    expect((await row()).provider_job_id).toBeNull();
    const members = harness.app.get(WorkspaceMembershipService),
      workspace = (await row()).workspace_id;
    await members.ensureMembership({
      userId: "backup-admin",
      workspaceId: workspace,
      organizationId: "default-org",
      role: "admin",
    });
    await members.ensureMembership({
      userId: "dashboard",
      workspaceId: workspace,
      organizationId: "default-org",
      role: "viewer",
    });
    const count = harness.fetchMock.calls.length;
    expect(
      (
        await harness.agent.post(`${path}/job-lookup/preview`).send({
          provider_job_id: "provider-job",
          expected_basis_hash: preview.basis_hash,
        })
      ).status,
    ).toBe(403);
    expect((await harness.agent.get(`${base}/media-tasks`)).status).toBe(403);
    expect(harness.fetchMock.calls).toHaveLength(count);
  });
  it("revokes administrator authority during external lookup before returning a usable preview", async () => {
    const path = await loseSubmission(),
      basis = (await harness.agent.get(`${path}/job-lookup-basis`)).body,
      members = harness.app.get(WorkspaceMembershipService),
      workspace = (await row()).workspace_id;
    await members.ensureMembership({
      userId: "backup-admin",
      workspaceId: workspace,
      organizationId: "default-org",
      role: "admin",
    });
    harness.fetchMock.setHandler(async () => {
      await members.ensureMembership({
        userId: "dashboard",
        workspaceId: workspace,
        organizationId: "default-org",
        role: "viewer",
      });
      return json(completed());
    });
    const result = await harness.agent.post(`${path}/job-lookup/preview`).send({
      provider_job_id: "provider-job",
      expected_basis_hash: basis.basis_hash,
    });
    expect(result.status).toBe(403);
    expect((await row()).provider_job_id).toBeNull();
    expect(
      await source.query("SELECT * FROM pricing_media_job_reconciliations"),
    ).toHaveLength(0);
  });
  it("paginates signed source/event inventories and exposes only scoped task evidence", async () => {
    harness.fetchMock.setHandler(async () =>
      json({ id: "provider-job", status: "queued" }),
    );
    await call();
    await configureSource();
    for (let i = 0; i < 3; i++) await sendEvent(await event(String(i)));
    const path = await lookupRoute(),
      first = await harness.agent.get(`${path}/supplier-events?limit=1`);
    expect(first.status).toBe(200);
    expect(first.body.events).toHaveLength(1);
    expect(first.body.next_cursor).toBeTruthy();
    const next = await harness.agent.get(
      `${path}/supplier-events?limit=1&cursor=${encodeURIComponent(first.body.next_cursor)}`,
    );
    expect(next.body.events[0].id).not.toBe(first.body.events[0].id);
    const full = await harness.agent.get(
      `${path}/supplier-events/${first.body.events[0].id}`,
    );
    expect(full.status).toBe(200);
    expect(full.body.document.task_id).toBe((await row()).id);
    expect(
      (
        await harness.agent.get(
          `${base}/media-event-sources?cursor=${encodeURIComponent(first.body.next_cursor)}`,
        )
      ).status,
    ).toBe(400);
    const tasks = await harness.agent.get(
      `${base}/media-tasks?view=settled&limit=1`,
    );
    expect(tasks.status).toBe(200);
    expect(tasks.body.tasks).toHaveLength(1);
    expect(JSON.stringify(tasks.body)).not.toMatch(
      /context_json|PRIVATE-GENERATION|synthetic-key/,
    );
  });

  it("preserves absent provider timestamps after a manually linked job is polled again", async () => {
    const path = await loseSubmission(),
      preview = await lookupPreview(path);
    expect(
      (await harness.agent.post(`${path}/job-lookup`).send(lookupBody(preview)))
        .status,
    ).toBe(201);
    harness.fetchMock.setHandler(async () => json(completed("7.4")));
    const refreshed = await status();
    expect(refreshed.status).toBe(200);
    expect((await summary())?.amount).toBe("0.760000000000000000");
    const observations = await source.query(
      "SELECT * FROM pricing_media_observations ORDER BY revision",
    );
    expect(observations).toHaveLength(2);
    for (const row of observations) {
      expect(JSON.parse(row.context_json).provider_accepted_at).toBeUndefined();
      expect(JSON.parse(row.context_json).completed_at).toBeUndefined();
    }
  });

  it('reads and safely disables an existing source after its live node configuration changes',async()=>{
    harness.fetchMock.setHandler(async()=>json({id:'provider-job',status:'queued'}));await call();const original=await configureSource();expect((await harness.agent.get(`${base}/media-event-sources/http-source`)).body.config_hash).toBe(original.config_hash);
    harness.app.get(ConfigService).getNode(original.node_id)!.base_url='http://changed.invalid';delete process.env[secretName];
    const disabled=await harness.agent.put(`${base}/media-event-sources/http-source`).send({revision:1,node_id:original.node_id,credential_id:original.credential_id,secret_env:secretName,enabled:false,reason:'Revoke obsolete source',confirm:true});expect(disabled.status).toBe(200);expect(disabled.body).toMatchObject({enabled:0,connection_hash:original.connection_hash});expect((await sendEvent(await event())).status).toBe(401);
  });

  it("pins price and FX identity through actual HTTP completion, late correction and new admission", async () => {
    const cnyPrice = { ...book([rate("duration", "video_seconds", "0.70", "1"), rate("base", "video_generation_count", "0.14", "1")]), currency: "CNY", allow_combined_media: true };
    await publish(cnyPrice); await fx("7"); await actualPolicy();
    harness.fetchMock.setHandler(async () => json({ id: "provider-job", status: "queued" }));
    expect((await call()).status).toBe(200);
    const first = await row();
    const snapshot = (await source.query("SELECT * FROM pricing_request_snapshots"))[0];
    const expensive = structuredClone(cnyPrice);
    expensive.groups[0].rules[0].rates[0].component.amount = "1.40";
    expensive.groups[0].rules[0].rates[1].component.amount = "0.28";
    await publish(expensive); await fx("14");
    harness.fetchMock.setHandler(async () => json(completed()));
    expect((await status()).status).toBe(200);
    const original = (await source.query("SELECT * FROM pricing_attempts"))[0], cost = JSON.parse(original.cost_json);
    expect(cost).toMatchObject({ amount: "4.620000000", currency: "CNY", report_currency: "USD", report_amount: "0.660000000" });
    expect((await summary())?.budget_committed_usd).toBe("0.660000000000000000");
    harness.fetchMock.setHandler(async () => json(completed("7.4")));
    expect((await status()).status).toBe(200);
    const correction = JSON.parse((await source.query("SELECT * FROM pricing_cost_adjustments"))[0].cost_json);
    expect(correction).toMatchObject({ amount: "5.320000000", report_amount: "0.760000000", version_id: cost.version_id, fx_version_id: cost.fx_version_id });
    expect((await summary())?.budget_committed_usd).toBe("0.760000000000000000");
    expect((await source.query("SELECT * FROM pricing_request_snapshots"))[0]).toEqual(snapshot);
    harness.fetchMock.setHandler(async () => json({ ...completed(), id: "provider-new" }));
    expect((await call()).status).toBe(200);
    const all = await source.query("SELECT * FROM pricing_attempts"), next = all.find((a: { request_id: string }) => a.request_id !== first.request_id);
    expect(all.find((a: { id: string }) => a.id === original.id)).toEqual(original);
    const nextCost = JSON.parse(next.cost_json);
    expect(nextCost).toMatchObject({ amount: "9.240000000", report_amount: "0.660000000" });
    expect(nextCost.version_id).not.toBe(cost.version_id); expect(nextCost.fx_version_id).not.toBe(cost.fx_version_id);
  });

  it.each(["completed", "failed"])("keeps actual paid %s generation cost when content delivery fails", async terminal => {
    await actualPolicy();
    harness.fetchMock.setHandler(async () => json(completed("2.5", terminal)));
    expect((await call()).status).toBe(200);
    expect((await summary())?.budget_committed_usd).toBe("0.270000000000000000");
    const attempts = await source.query("SELECT * FROM pricing_attempts"), effects = await source.query("SELECT * FROM pricing_budget_effects ORDER BY id");
    harness.fetchMock.setHandler(async () => json({ error: "PRIVATE-CONTENT-ERROR" }, 500));
    const response = await harness.agent.get("/v1/videos/provider-job/content").set("Authorization", `Bearer ${API_KEY}`);
    expect(response.status).toBe(502);
    expect(response.body.error).toMatchObject({
      code: "media_content_unavailable",
      type: "video_proxy_error",
      message: "Media content delivery failed; incurred generation costs are unchanged",
    });
    expect(response.body.error.request_id).toBe(attempts[0].request_id);
    expect(response.headers["x-request-id"]).toBe(attempts[0].request_id);
    expect(JSON.stringify(response.body)).not.toContain("PRIVATE-CONTENT-ERROR");
    expect(await source.query("SELECT * FROM pricing_attempts")).toEqual(attempts);
    expect(await source.query("SELECT * FROM pricing_budget_effects ORDER BY id")).toEqual(effects);
    expect((await summary())?.budget_committed_usd).toBe("0.270000000000000000");
    expect(harness.fetchMock.calls.filter(call => call.method === "POST")).toHaveLength(1);
  });

  it("retains actual holds after cancellation acknowledgement, accounts paid cancellation and records later zero-usage correction", async () => {
    await actualPolicy();
    harness.fetchMock.setHandler(async () => json({ id: "provider-job", status: "pending" })); await call();
    harness.fetchMock.setHandler(async () => new Response(null, { status: 204 }));
    expect((await cancel()).body.status).toBe("pending");
    expect((await source.query("SELECT * FROM pricing_reservations"))[0].state).toBe("reserved");
    harness.fetchMock.setHandler(async () => json({ id: "provider-job", status: "cancelled" }));
    expect((await status()).status).toBe(200);
    expect((await source.query("SELECT * FROM pricing_reservations"))[0].state).toBe("reserved");
    harness.fetchMock.setHandler(async () => json(completed("2.5", "cancelled")));
    expect((await status()).status).toBe(200);
    expect((await summary())?.budget_committed_usd).toBe("0.270000000000000000");
    const original = await source.query("SELECT * FROM pricing_attempts");
    harness.fetchMock.setHandler(async () => json({ id: "provider-job", status: "cancelled", usage: { video_seconds: "0", generation_count: 0 } }));
    expect((await status()).status).toBe(200);
    expect((await summary())?.budget_committed_usd).toBe("0.000000000000000000");
    expect(await source.query("SELECT * FROM pricing_attempts")).toEqual(original);
    expect(await source.query("SELECT * FROM pricing_cost_adjustments")).toHaveLength(2);
    expect(harness.fetchMock.calls.filter(call => call.method === "POST" && !call.url.endsWith("/cancel"))).toHaveLength(1);
  });

  it("uses actual policy for reviewed unknown-job lookup without repeating paid submission", async () => {
    await actualPolicy();
    const path = await loseSubmission(), before = await source.query("SELECT * FROM pricing_media_tasks");
    const preview = await lookupPreview(path);
    expect(await source.query("SELECT * FROM pricing_media_tasks")).toEqual(before);
    const expensive = videoPrice(); expensive.groups[0].rules[0].rates[0].component.amount = "99";
    await publish(expensive);
    const applied = await harness.agent.post(`${path}/job-lookup`).send(lookupBody(preview));
    expect({ status: applied.status, error: applied.body.error }).toEqual({ status: 201, error: undefined });
    expect(applied.body).toMatchObject({ preview: { association_source: "administrator_attestation", supplier_invoice_confirmed: false }, processing_pending: false });
    expect((await summary())?.budget_committed_usd).toBe("0.660000000000000000");
    const count = harness.fetchMock.calls.length;
    expect((await harness.agent.post(`${path}/job-lookup`).send(lookupBody(preview))).body).toMatchObject({ replayed: true, processing_pending: false });
    expect(harness.fetchMock.calls).toHaveLength(count);
    expect(harness.fetchMock.calls.filter(call => call.method === "POST")).toHaveLength(1);
    expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toHaveLength(1);
  });

  it.each([
    ["generations", "image_generation", false], ["edits", "image_edit", false], ["variations", "image_variation", false],
    ["generations", "image_generation", true], ["edits", "image_edit", true], ["variations", "image_variation", true],
  ] as const)("bills actual image %s / %s async=%s by returned count, not requested count", async (endpoint, operation, asyncJob) => {
    await publish(book([rate("actual-image", "image_count", "0.04", "1")]), "gpt-image-1", operation);
    await actualPolicy(operation);
    const imageBody = { model: "gpt-image-1", n: 4, prompt: "PRIVATE-IMAGE-PROMPT" };
    const boundary = "actual-image-lifecycle";
    const multipart = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-image-1\r\n--${boundary}\r\nContent-Disposition: form-data; name="n"\r\n\r\n4\r\n--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="private-image.png"\r\nContent-Type: image/png\r\n\r\nPRIVATE-IMAGE-BYTES\r\n--${boundary}--\r\n`);
    const request = () => {
      const q = harness.agent.post(`/v1/images/${endpoint}`).set("Authorization", `Bearer ${API_KEY}`).set("Idempotency-Key", "actual-image-request");
      return endpoint === "generations" ? q.send(imageBody) : q.set("Content-Type", `multipart/form-data; boundary=${boundary}`).send(multipart);
    };
    harness.fetchMock.setHandler(async () => json(asyncJob ? { id: "actual-image-job", status: "pending" } : { data: [{ b64_json: "PRIVATE-OUTPUT-A" }, { url: "https://private.invalid/b" }, { b64_json: "PRIVATE-OUTPUT-C" }, { error: { code: "failed" } }] }, asyncJob ? 202 : 200));
    expect((await request()).status).toBe(200);
    if (asyncJob) {
      expect((await source.query("SELECT * FROM pricing_reservations"))[0].state).toBe("reserved");
      harness.fetchMock.setHandler(async () => json({ id: "actual-image-job", status: "completed", usage: { image_count: 3 } }));
      expect((await harness.agent.get("/v1/images/jobs/actual-image-job").set("Authorization", `Bearer ${API_KEY}`)).status).toBe(200);
    }
    const result = (await summary())!;
    expect(result.budget_committed_usd).toBe("0.120000000000000000");
    const attempt = (await source.query("SELECT * FROM pricing_attempts"))[0], cost = JSON.parse(attempt.cost_json);
    expect(cost.usage.quantities.image_count.value).toBe("3");
    expect(cost.usage.quantities.requested_image_count.value).toBe("4");
    expect((await row()).state).toBe(asyncJob ? "settled" : "synchronous");
    const count = harness.fetchMock.calls.length;
    expect((await request()).body).toMatchObject({ idempotent_replay: true, output_retained: false });
    expect(harness.fetchMock.calls).toHaveLength(count);
    expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toHaveLength(1);
    const stored = JSON.stringify([await source.query("SELECT * FROM pricing_media_tasks"), await source.query("SELECT cost_json,price_context_json FROM pricing_attempts"), await source.query("SELECT usage_json,context_json FROM pricing_media_observations")]);
    expect(stored).not.toMatch(/PRIVATE-IMAGE|PRIVATE-OUTPUT|private\.invalid|private-image/);
  });

  it("settles independently polled retained sibling tasks once through the real HTTP status routes", async () => {
    const head = (await harness.agent.get(`${base}/bindings`)).body.head;
    expect((await harness.agent.put(`${base}/admission-policy`).send({ catalog_revision: head.revision, scope: "workspace", operation: "video_generation", reason: "Synthetic sibling HTTP fixture", confirm: true, policy: { mode: "compatibility", budget_basis: "actual_upstream", token_budget: "not_applicable" } })).status).toBe(200);
    harness.fetchMock.setHandler(async () => json({ id: "provider-job", status: "queued" }));
    expect((await call()).status).toBe(200);
    const first = await row(), context = JSON.parse(first.context_json) as MediaTaskContext;
    const ledger = harness.app.get(CostLedgerService);
    // Seed the second retained dispatch; the status path must never redispatch
    // either generation merely to complete the financial cohort.
    await ledger.beginAttempt({ id: "sibling-task", requestId: first.request_id, workspace: first.workspace_id, reservationId: first.reservation_id, target: context.target, feeSource: "provider", dispatchedAt: new Date().toISOString(), priceContext: { context: context.pricing, legacyPrice: context.legacy_price }, mediaTask: tasks.descriptor("sibling-task", first.request_id, first.reservation_id, context, null) });
    await tasks.markSubmitted("sibling-task", first.workspace_id);
    await tasks.accept("sibling-task", first.workspace_id, { id: "sibling-job", status: "queued" }, first.credential_id!);
    harness.fetchMock.setHandler(async url => json(String(url).includes("sibling-job") ? { ...completed("3.4"), id: "sibling-job" } : completed()));
    expect((await status()).status).toBe(200);
    expect(await source.query("SELECT * FROM pricing_actual_budget_cohorts")).toHaveLength(0);
    expect((await tasks.get(first.id, first.workspace_id))?.state).toBe("terminal");
    expect((await status("sibling-job")).status).toBe(200);
    expect((await summary())?.budget_committed_usd).toBe("1.020000000000000000");
    expect((await source.query("SELECT state FROM pricing_media_tasks ORDER BY id")).map((task: { state: string }) => task.state)).toEqual(["settled", "settled"]);
    await Promise.all([status(), status("sibling-job")]);
    expect(await source.query("SELECT * FROM pricing_budget_effects WHERE kind = 'commit'")).toHaveLength(1);
    expect(harness.fetchMock.calls.filter(call => call.method === "POST")).toHaveLength(1);
  });

  it.each([undefined, "reported_tokens", "not_applicable"] as const)("keeps default HTTP token rules and honors explicit token policy %s", async token_budget => {
    const head = (await harness.agent.get(`${base}/bindings`)).body.head;
    const policy = await harness.agent.put(`${base}/admission-policy`).send({ catalog_revision: head.revision, scope: "workspace", operation: "video_generation", reason: "Synthetic explicit token policy", confirm: true, policy: { mode: "compatibility", budget_basis: "actual_upstream", ...(token_budget ? { token_budget } : {}) } });
    expect(policy.status).toBe(200);
    const rules = await source.query("SELECT * FROM budget_rules WHERE type = 'daily_tokens' ORDER BY id");
    expect(rules.length).toBeGreaterThan(0);
    harness.fetchMock.setHandler(async () => json({ id: "provider-job", status: "queued" }));
    expect((await call()).status).toBe(200);
    harness.fetchMock.setHandler(async () => json(completed()));
    expect((await status()).status).toBe(200);
    const reservation = (await source.query("SELECT * FROM pricing_reservations"))[0];
    expect(reservation.state).toBe(token_budget === "not_applicable" ? "committed" : "reserved");
    if (token_budget === "not_applicable") {
      expect((await summary())?.budget_committed_usd).toBe("0.660000000000000000");
      expect(JSON.parse(reservation.holds_json).some((hold: { type: string }) => hold.type === "daily_tokens")).toBe(false);
      expect(await source.query("SELECT * FROM budget_rules WHERE type = 'daily_tokens' ORDER BY id")).toEqual(rules);
    }
    expect(harness.fetchMock.calls.filter(c => c.method === "POST")).toHaveLength(1);
  });

  it("blocks a mixed-price media request before provider IO when token quota is inapplicable", async () => {
    const head = (await harness.agent.get(`${base}/bindings`)).body.head;
    expect((await harness.agent.put(`${base}/admission-policy`).send({ catalog_revision: head.revision, scope: "workspace", operation: "video_generation", reason: "Synthetic non-token policy", confirm: true, policy: { mode: "compatibility", budget_basis: "actual_upstream", token_budget: "not_applicable" } })).status).toBe(200);
    await publish({ ...book([rate("duration", "video_seconds", "0.1", "1"), rate("tokens", "output_tokens", "0", "1")]), allow_combined_media: true });
    const response = await call();
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("pricing_token_budget_incompatible");
    expect(harness.fetchMock.calls).toHaveLength(0);
    expect(await source.query("SELECT * FROM pricing_reservations")).toHaveLength(0);
  });

  it.each([false, true])("uses explicit actual media policy with an original daily-token hold present=%s", async tokenHold => {
    // Cost-only is an explicit isolated fixture, not an exemption for the default
    // deployment. A retained daily-token hold must keep missing tokens unknown.
    if (!tokenHold) await source.createQueryBuilder().delete().from("budget_rules").where("type = :type", { type: "daily_tokens" }).execute();
    const head = (await harness.agent.get(`${base}/bindings`)).body.head;
    const policy = await harness.agent.put(`${base}/admission-policy`).send({
      catalog_revision: head.revision, scope: "workspace", operation: "video_generation", reason: "Synthetic actual media fixture", confirm: true,
      policy: { mode: "compatibility", budget_basis: "actual_upstream" },
    });
    expect({ status: policy.status, error: policy.body.error }).toEqual({ status: 200, error: undefined });
    harness.fetchMock.setHandler(async () => json({ id: "provider-job", status: "queued" }));
    expect((await call()).status).toBe(200);
    expect((await source.query("SELECT * FROM pricing_reservations"))[0]).toMatchObject({ budget_basis: "actual_upstream", state: "reserved" });
    harness.fetchMock.setHandler(async () => json(completed()));
    expect((await status()).status).toBe(200);
    const reservation = (await source.query("SELECT * FROM pricing_reservations"))[0];
    expect(reservation.state).toBe(tokenHold ? "reserved" : "committed");
    expect((await row()).state).toBe(tokenHold ? "terminal" : "settled");
    if (!tokenHold) expect((await summary())?.budget_committed_usd).toBe("0.660000000000000000");
    const effects = await source.query("SELECT * FROM pricing_budget_effects ORDER BY id");
    expect((await status()).status).toBe(200);
    expect(await source.query("SELECT * FROM pricing_budget_effects ORDER BY id")).toEqual(effects);
    expect(harness.fetchMock.calls.filter(c => c.method === "POST")).toHaveLength(1);
    expect(await source.query("SELECT * FROM pricing_actual_budget_cohorts")).toHaveLength(1);
    expect(await source.query("SELECT * FROM pricing_audit_events WHERE action = 'cost.actual_media_observation'")).toHaveLength(1);
  });

  it("holds pending work, uses frozen pricing after publication, settles once and appends one usage correction", async () => {
    harness.fetchMock.setHandler(async () =>
      json({ id: "provider-job", status: "queued" }),
    );
    expect((await call()).status).toBe(200);
    expect((await summary())?.status).toBe("pending");
    expect(await source.query("SELECT * FROM video_jobs")).toHaveLength(0);
    const content = videoPrice();
    content.groups[0].rules[0].rates[0].component.amount = "99";
    await publish(content);
    harness.fetchMock.setHandler(async () => json(completed()));
    const result = await status();
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      status: "completed",
      pricing_status: "settled",
      cost: { amount: "0.660000000000000000" },
    });
    expect(JSON.stringify(result.body)).not.toMatch(
      /price_context|attempts|credential|book_id/,
    );
    await Promise.all([status(), status()]);
    expect((await summary())?.budget_committed_usd).toBe(
      "0.660000000000000000",
    );
    expect(
      await source.query("SELECT * FROM pricing_settlement_intents"),
    ).toHaveLength(1);
    expect(
      await source.query("SELECT * FROM pricing_cost_adjustments"),
    ).toHaveLength(0);
    harness.fetchMock.setHandler(async () => json(completed("7.4")));
    await status();
    await status();
    expect((await summary())?.amount).toBe("0.760000000000000000");
    expect((await summary())?.budget_committed_usd).toBe(
      "0.760000000000000000",
    );
    expect(
      await source.query("SELECT * FROM pricing_cost_adjustments"),
    ).toHaveLength(1);
    expect(
      (await harness.agent.get("/api/dashboard/logs")).body.data[0].cost_usd,
    ).toBeCloseTo(0.76);
    const task = await row();
    expect(["task-original", "task-alternative"]).toContain(task.credential_id);
    expect(
      harness.fetchMock.calls
        .filter((c) => c.method === "GET")
        .every(
          (c) =>
            c.headers.Authorization ===
            harness.fetchMock.calls[0].headers.Authorization,
        ),
    ).toBe(true);
    const persisted = JSON.stringify([
      await source.query("SELECT * FROM pricing_media_tasks"),
      await source.query("SELECT * FROM pricing_media_observations"),
    ]);
    expect(persisted).not.toMatch(/PRIVATE-GENERATION|synthetic-key/);
  });

  it("does not mistake cancel acknowledgement for cancellation, or missing usage for free work", async () => {
    harness.fetchMock.setHandler(async () =>
      json({ id: "provider-job", status: "pending" }),
    );
    await call();
    harness.fetchMock.setHandler(
      async () => new Response(null, { status: 204 }),
    );
    expect((await cancel()).body.status).toBe("pending");
    expect((await summary())?.status).toBe("pending");
    harness.fetchMock.setHandler(async () =>
      json({
        id: "provider-job",
        status: "cancelled",
        error: { message: "PRIVATE-ERROR-PROMPT" },
      }),
    );
    await status();
    expect((await summary())?.amount).toBeNull();
    expect(Number((await summary())?.budget_committed_usd)).toBeGreaterThan(0);
    expect((await row()).last_error).toBe("provider_media_job_error");
    harness.fetchMock.setHandler(async () =>
      json({
        id: "provider-job",
        status: "cancelled",
        usage: { video_seconds: "0", generation_count: 0 },
      }),
    );
    await status();
    expect((await summary())?.amount).toBe("0.000000000000000000");
    expect((await summary())?.budget_committed_usd).toBe(
      "0.000000000000000000",
    );
  });

  it("retains partial failed generation costs when content delivery fails", async () => {
    harness.fetchMock.setHandler(async () => json(completed("2.5", "failed")));
    await call();
    expect((await summary())?.amount).toBe("0.270000000000000000");
    const initial = await source.query(
      "SELECT * FROM pricing_settlement_intents",
    );
    harness.fetchMock.setHandler(async () =>
      json({ error: "PRIVATE-CONTENT-ERROR" }, 500),
    );
    const result = await harness.agent
      .get("/v1/videos/provider-job/content")
      .set("Authorization", `Bearer ${API_KEY}`);
    expect(result.status).toBe(502);
    expect(
      await source.query("SELECT * FROM pricing_settlement_intents"),
    ).toEqual(initial);
    expect((await summary())?.amount).toBe("0.270000000000000000");
  });

  it("scopes colliding provider IDs to the API key and refuses ambiguity within one key", async () => {
    harness.fetchMock.setHandler(async () =>
      json({ id: "provider-job", status: "pending" }),
    );
    const first = await call();
    expect((await status("provider-job", API_KEY_2)).status).toBe(404);
    const second = await call(payload, API_KEY_2);
    expect((await status()).body.request_id).toBe(
      first.headers["x-request-id"],
    );
    expect((await status("provider-job", API_KEY_2)).body.request_id).toBe(
      second.headers["x-request-id"],
    );
    await call();
    expect((await status()).status).toBe(409);
    expect((await status(first.headers["x-request-id"])).status).toBe(200);
  });

  it("concurrent client idempotency never dispatches or holds twice, and changed payload conflicts", async () => {
    harness.fetchMock.setHandler(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return json({ id: "provider-job", status: "pending" });
    });
    const responses = await Promise.all([
      call(payload, API_KEY, "private-client-token"),
      call(payload, API_KEY, "private-client-token"),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(harness.fetchMock.calls).toHaveLength(1);
    expect(
      await source.query("SELECT * FROM pricing_reservations"),
    ).toHaveLength(1);
    expect(
      (await call(payload, API_KEY, "private-client-token")).body
        .idempotent_replay,
    ).toBe(true);
    expect(
      (
        await call(
          { ...payload, prompt: "different" },
          API_KEY,
          "private-client-token",
        )
      ).status,
    ).toBe(409);
    expect(harness.fetchMock.calls).toHaveLength(1);
    expect(
      JSON.stringify(
        await source.query("SELECT * FROM pricing_media_submissions"),
      ),
    ).not.toContain("private-client-token");
  });

  it("replays an existing idempotent submission even after current pricing becomes unavailable", async () => {
    harness.fetchMock.setHandler(async () =>
      json({ id: "provider-job", status: "pending" }),
    );
    const created = await call(payload, API_KEY, "retained-task");
    const capture = jest
      .spyOn(harness.app.get(PricingRepository), "capture")
      .mockResolvedValue(null);
    const replay = await call(payload, API_KEY, "retained-task");
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({
      request_id: created.headers["x-request-id"],
      idempotent_replay: true,
    });
    expect(capture).not.toHaveBeenCalled();
    expect(harness.fetchMock.calls).toHaveLength(1);
    expect(
      await source.query("SELECT * FROM pricing_reservations"),
    ).toHaveLength(1);
  });

  it("recognizes image operation-name/done shapes and immediate terminal jobs without retaining output URLs", async () => {
    await publish(
      book([rate("images", "image_count", "0.04", "1")]),
      "gpt-image-1",
      "image_generation",
    );
    harness.fetchMock.setHandler(async () =>
      json({ name: "operations/image-job", done: false }),
    );
    const request = () =>
      harness.agent
        .post("/v1/images/generations")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({ model: "gpt-image-1", n: 4, prompt: "test" });
    await request();
    const task = await row();
    expect(task).toMatchObject({
      provider_job_id: "operations/image-job",
      state: "pending",
    });
    harness.fetchMock.setHandler(async () =>
      json({
        name: "operations/image-job",
        done: true,
        usage: { image_count: 3 },
      }),
    );
    const result = await harness.agent
      .get(`/v1/images/jobs/${task.request_id}`)
      .set("Authorization", `Bearer ${API_KEY}`);
    expect(result.body.cost.amount).toBe("0.120000000000000000");
    expect(harness.fetchMock.calls[1].url).toContain("operations%2Fimage-job");
    harness.fetchMock.setHandler(async () =>
      json({
        id: "immediate-image",
        status: "completed",
        usage: { image_count: 2 },
      }),
    );
    await request();
    expect(
      (
        await source.query(
          "SELECT * FROM pricing_media_tasks WHERE provider_job_id = 'immediate-image'",
        )
      )[0].state,
    ).toBe("settled");
  });

  it("uncertain submit does not retry another credential, generate again, fall back or free its hold", async () => {
    harness.fetchMock.setHandler(async () => {
      throw new TypeError("simulated lost response");
    });
    const result = await call(payload, API_KEY, "lost-submit");
    expect(result.status).toBe(502);
    expect(harness.fetchMock.calls).toHaveLength(1);
    expect((await row()).state).toBe("uncertain");
    expect((await summary())?.status).toBe("pending");
    expect((await call(payload, API_KEY, "lost-submit")).body.status).toBe(
      "unknown",
    );
    await tasks.recover();
    expect(harness.fetchMock.calls).toHaveLength(1);
    expect(
      await source.query("SELECT * FROM pricing_settlement_intents"),
    ).toHaveLength(0);
  });

  it("recovers a prepared terminal decision without repeating paid submission", async () => {
    const ledger = harness.app.get(CostLedgerService);
    const settle = jest
      .spyOn(ledger, "settle")
      .mockRejectedValueOnce(new Error("isolated storage failure"));
    harness.fetchMock.setHandler(async () => json(completed()));
    expect((await call()).status).toBe(200);
    expect((await row()).state).toBe("terminal");
    expect(
      (await source.query("SELECT * FROM pricing_media_observations"))[0],
    ).toMatchObject({ action: "initial", processed: 0 });
    settle.mockRestore();
    const task = await row();
    await Promise.all([
      tasks.process(task.id, task.workspace_id),
      new MediaTaskService(
        source,
        harness.app.get(PricingRepository),
        ledger,
        harness.app.get(ConfigService),
      ).process(task.id, task.workspace_id),
    ]);
    await tasks.process(task.id, task.workspace_id);
    expect((await summary())?.amount).toBe("0.660000000000000000");
    expect((await row()).state).toBe("settled");
    expect(harness.fetchMock.calls).toHaveLength(1);
  });

  it("CALC-11 honors whole-second rounding and content success never creates another generation fee", async () => {
    const content = videoPrice();
    content.groups[0].rules[0].rates[0].component.quantity_rounding = {
      increment: "1",
      mode: "ceil",
    };
    await publish(content);
    harness.fetchMock.setHandler(async () => json(completed()));
    await call();
    expect((await summary())?.amount).toBe("0.720000000000000000");
    harness.fetchMock.setHandler(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "application/octet-stream" },
        }),
    );
    const download = await harness.agent
      .get("/v1/videos/provider-job/content")
      .set("Authorization", `Bearer ${API_KEY}`);
    expect(download.status).toBe(200);
    expect(download.body).toEqual(Buffer.from([1, 2, 3]));
    expect((await summary())?.budget_committed_usd).toBe(
      "0.720000000000000000",
    );
  });

  it("synchronous image replay explicitly reports that original output bytes are not retained", async () => {
    await publish(
      book([rate("images", "image_count", "0.04", "1")]),
      "gpt-image-1",
      "image_generation",
    );
    harness.fetchMock.setHandler(async () =>
      json({ data: [{ b64_json: "PRIVATE-IMAGE-BYTES" }] }),
    );
    const request = () =>
      harness.agent
        .post("/v1/images/generations")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Idempotency-Key", "sync-image")
        .send({ model: "gpt-image-1", n: 1, prompt: "PRIVATE-IMAGE-PROMPT" });
    expect((await request()).body.data[0].b64_json).toBe("PRIVATE-IMAGE-BYTES");
    const replay = await request();
    expect(replay.body).toMatchObject({
      status: "completed",
      idempotent_replay: true,
      output_retained: false,
      output_unavailable_reason: "synchronous_output_not_retained",
    });
    expect(replay.body.data).toBeUndefined();
    expect(harness.fetchMock.calls).toHaveLength(1);
    expect(
      JSON.stringify(await source.query("SELECT * FROM pricing_media_tasks")),
    ).not.toContain("PRIVATE-IMAGE");
  });

  it("async images use the same scoped lifecycle and metadata-only idempotent replay", async () => {
    await publish(
      book([rate("images", "image_count", "0.04", "1")]),
      "gpt-image-1",
      "image_generation",
    );
    harness.fetchMock.setHandler(async () =>
      json({ id: "image-job", status: "pending" }, 202),
    );
    const request = () =>
      harness.agent
        .post("/v1/images/generations")
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Idempotency-Key", "image-submission")
        .send({ model: "gpt-image-1", n: 4, prompt: "PRIVATE-IMAGE" });
    expect((await request()).status).toBe(200);
    harness.fetchMock.setHandler(async () =>
      json({ id: "image-job", status: "completed", usage: { image_count: 3 } }),
    );
    const result = await harness.agent
      .get("/v1/images/jobs/image-job")
      .set("Authorization", `Bearer ${API_KEY}`);
    expect(result.status).toBe(200);
    expect(result.body.cost.amount).toBe("0.120000000000000000");
    expect((await request()).body).toMatchObject({
      idempotent_replay: true,
      output_retained: false,
      status: "completed",
    });
    expect(harness.fetchMock.calls).toHaveLength(2);
    expect(
      (
        await harness.agent
          .get("/v1/images/jobs/image-job")
          .set("Authorization", `Bearer ${API_KEY_2}`)
      ).status,
    ).toBe(404);
  });
});
