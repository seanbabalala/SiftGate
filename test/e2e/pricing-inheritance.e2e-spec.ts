import { DataSource } from "typeorm";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as yaml from "js-yaml";
import {
  createE2EHarness,
  API_KEY,
  FIXTURE_PATH,
  type E2EHarness,
} from "./setup";
import { applyPricingSchema } from "../../src/pricing/pricing-schema";
import { WorkspaceMembershipService } from "../../src/auth/workspace-membership.service";
import { PricingRecoveryService } from "../../src/pricing/pricing-recovery.service";
import { CostLedgerService } from "../../src/pricing/cost-ledger.service";
import { tokenBook, rate } from "../unit/pricing-fixtures";
import type { PricingInheritanceDefinition } from "../../src/pricing/pricing-inheritance.types";

const root = "/api/dashboard/pricing",
  workspace = "default-workspace";
describe("explicit parent-price inheritance over isolated HTTP", () => {
  let harness: E2EHarness, source: DataSource, directory: string;
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "inheritance-http-"));
    const config = yaml.load(readFileSync(FIXTURE_PATH, "utf8")) as Record<
      string,
      unknown
    >;
    config.cache = { enabled: false };
    config.budget = {
      daily_token_limit: 10000000,
      daily_cost_limit: 1000,
      alert_threshold: 0.8,
    };
    const file = join(directory, "config.yaml");
    writeFileSync(file, yaml.dump(config));
    harness = await createE2EHarness(file);
    source = harness.app.get(DataSource);
    await harness.app.get(PricingRecoveryService).onModuleDestroy();
    await applyPricingSchema(source);
  }, 30000);
  afterEach(async () => {
    jest.restoreAllMocks();
    await harness?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const options = (revision: number, model = "gpt-4o") => ({
    draft_revision: 1,
    catalog_revision: revision,
    targets: [{ level: "model", model }],
    reason: "Synthetic inherited pricing only",
    confirm: true,
  });
  async function seed() {
    const parent = await harness.agent
      .post(`${root}/books`)
      .send({ name: "Synthetic parent", content: tokenBook() });
    expect(parent.status).toBe(201);
    const published = await harness.agent
      .post(`${root}/drafts/${parent.body.draft.id}/publish`)
      .send(options(0, "parent-fixture"));
    expect(published.status).toBe(201);
    const definition: PricingInheritanceDefinition = {
      schema_version: 1,
      parent: {
        book_id: parent.body.book.id,
        version_id: published.body.version_id,
        content_hash: published.body.content_hash,
      },
      inherit: "all",
      source: {
        kind: "manual",
        reference:
          "https://user:synthetic@example.test/contract?token=synthetic#private",
      },
      rate_overrides: [rate("input", "uncached_input_tokens", "2")],
      removed_component_ids: [],
      replaced_groups: [],
      added_groups: [],
      removed_group_ids: [],
      settings: {},
      calendar: { mode: "inherit" },
    };
    return { parent: parent.body, published: published.body, definition };
  }
  async function create(definition: PricingInheritanceDefinition) {
    const child = await harness.agent
      .post(`${root}/inherited-books`)
      .send({ name: "Synthetic child", definition });
    expect(child.status).toBe(201);
    return child.body;
  }
  async function dump() {
    const result: Record<string, unknown> = {};
    for (const name of [
      "pricing_books",
      "pricing_drafts",
      "pricing_book_versions",
      "pricing_draft_inheritance",
      "pricing_version_inheritance",
      "pricing_catalog_head",
      "pricing_catalog_revisions",
      "pricing_request_snapshots",
      "pricing_audit_events",
      "budget_rules",
    ])
      result[name] = await source.query(`SELECT * FROM ${name}`);
    return result;
  }
  it("previews exact inherited content without writes then stores recipe and publishes its materialization", async () => {
    const { definition } = await seed(),
      before = await dump();
    const preview = await harness.agent
      .post(`${root}/inheritance/preview`)
      .send({ definition });
    expect(preview.status).toBe(201);
    expect(await dump()).toEqual(before);
    const child = await create(definition);
    expect(child.draft.inheritance.definition).toEqual(definition);
    expect(child.draft.content).toEqual(preview.body.content);
    const publishPreview = await harness.agent
      .post(`${root}/drafts/${child.draft.id}/preview-publication`)
      .send(options(1));
    expect(publishPreview.status).toBe(201);
    const saved = await harness.agent
      .post(`${root}/drafts/${child.draft.id}/publish`)
      .send(options(1));
    expect(saved.status).toBe(201);
    expect(saved.body.inheritance).toEqual(publishPreview.body.inheritance);
    const version = await harness.agent.get(
      `${root}/books/${child.book.id}/versions/${saved.body.version_id}`,
    );
    expect(version.status).toBe(200);
    expect(version.body.inheritance.definition).toEqual(definition);
    expect(harness.fetchMock.calls).toHaveLength(0);
  });
  it("prevents ordinary updates from flattening derived drafts and rejects stale recipe revisions", async () => {
    const { definition } = await seed(),
      child = await create(definition),
      before = await dump();
    expect(
      (
        await harness.agent
          .put(`${root}/drafts/${child.draft.id}`)
          .send({ revision: 1, content: tokenBook() })
      ).status,
    ).toBe(409);
    expect(await dump()).toEqual(before);
    const next = {
      ...definition,
      rate_overrides: [rate("input", "uncached_input_tokens", "3")],
    };
    const changed = await harness.agent
      .put(`${root}/drafts/${child.draft.id}/inheritance`)
      .send({ revision: 1, definition: next });
    expect(changed.status).toBe(200);
    expect(changed.body.revision).toBe(2);
    expect(
      (
        await harness.agent
          .put(`${root}/drafts/${child.draft.id}/inheritance`)
          .send({ revision: 1, definition })
      ).status,
    ).toBe(409);
    expect(
      (await harness.agent.get(`${root}/drafts/${child.draft.id}`)).body
        .inheritance.definition,
    ).toEqual(next);
  });
  it("exports the recipe with sanitized source and resolves imports only against an accessible fixed parent", async () => {
    const { definition } = await seed(),
      child = await create(definition),
      saved = await harness.agent
        .post(`${root}/drafts/${child.draft.id}/publish`)
        .send(options(1));
    expect(saved.status).toBe(201);
    const exported = await harness.agent.get(
      `${root}/books/${child.book.id}/export?version_id=${saved.body.version_id}`,
    );
    expect(exported.status).toBe(200);
    expect(exported.body.format).toBe("siftgate-inherited-price-book-v1");
    expect(exported.body.definition.parent).toEqual(definition.parent);
    expect(exported.body.definition.source.reference).toBe(
      "https://example.test/contract",
    );
    expect(exported.body.content).toBeUndefined();
    const before = await dump(),
      check = await harness.agent
        .post(`${root}/import/validate`)
        .send(exported.body);
    expect(check.status).toBe(201);
    expect(check.body.valid).toBe(true);
    expect(await dump()).toEqual(before);
    expect(
      (
        await harness.agent
          .post(`${root}/import/validate`)
          .send({ ...exported.body, content: child.draft.content })
      ).status,
    ).toBe(400);
    expect(
      (
        await harness.agent
          .post(`${root}/import/validate`)
          .send({
            format: "siftgate-price-book-v1",
            definition,
            content: child.draft.content,
          })
      ).status,
    ).toBe(400);
  });
  it("keeps explicit lineage on draft/version simulations without provider calls", async () => {
    const { definition } = await seed(),
      child = await create(definition);
    const body = {
      draft_id: child.draft.id,
      evidence: [
        { dimension: "total_input_tokens", value: "1000" },
        { dimension: "uncached_input_tokens", value: "1000" },
        { dimension: "output_tokens", value: "0" },
        { dimension: "cache_read_tokens", value: "0" },
        { dimension: "cache_write_tokens", value: "0" },
        { dimension: "cache_write_5m_tokens", value: "0" },
        { dimension: "cache_write_1h_tokens", value: "0" },
      ],
      context: {},
      report_currency: "USD",
    };
    const result = await harness.agent.post(`${root}/quote`).send(body);
    expect(result.status).toBe(201);
    expect(result.body.cost.report_amount).toBe("0.002000000");
    expect(
      result.body.inheritance.provenance.components.find(
        (c: { component_id: string }) => c.component_id === "input",
      ).origin,
    ).toBe("override");
    expect(harness.fetchMock.calls).toHaveLength(0);
  });
  it("protects an actual in-flight response from later parent publication", async () => {
    const { definition, parent, published } = await seed(),
      child = await create(definition);
    const childVersion = await harness.agent
      .post(`${root}/drafts/${child.draft.id}/publish`)
      .send(options(1));
    expect(childVersion.status).toBe(201);
    let entered!: () => void, finish!: () => void;
    const ready = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      release = new Promise<void>((resolve) => {
        finish = resolve;
      });
    harness.fetchMock.setHandler(async () => {
      entered();
      await release;
      return new Response(
        JSON.stringify({
          id: "synthetic",
          model: "gpt-4o",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "synthetic" },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            prompt_tokens_details: { cached_tokens: 0 },
            cache_creation_input_tokens: 0,
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const request = harness.agent
      .post("/v1/chat/completions")
      .set("Authorization", `Bearer ${API_KEY}`)
      .send({
        model: "gpt-4o",
        max_tokens: 20,
        messages: [{ role: "user", content: "synthetic test" }],
      })
      .then((value) => value);
    try {
      await ready;
      const fork = await harness.agent
        .post(`${root}/books/${parent.book.id}/drafts`)
        .send({ version_id: published.version_id });
      expect(fork.status).toBe(201);
      const content = tokenBook();
      content.groups[0].rules[0].rates[1].component.amount = "200";
      expect(
        (
          await harness.agent
            .put(`${root}/drafts/${fork.body.id}`)
            .send({ revision: 1, content })
        ).status,
      ).toBe(200);
      expect(
        (
          await harness.agent
            .post(`${root}/drafts/${fork.body.id}/publish`)
            .send({ ...options(2, "parent-fixture"), draft_revision: 2 })
        ).status,
      ).toBe(201);
    } finally {
      finish();
    }
    expect((await request).status).toBe(200);
    const rows = await source.query(
      "SELECT request_id FROM pricing_request_snapshots",
    );
    expect(rows).toHaveLength(1);
    const summary = await harness.app
      .get(CostLedgerService)
      .summary(rows[0].request_id, workspace);
    expect(summary?.amount).toBe("0.000030000000000000");
    expect(summary?.attempts[0].cost?.version_id).toBe(
      childVersion.body.version_id,
    );
    expect(harness.fetchMock.calls).toHaveLength(1);
  });
  it("denies foreign/private parents, wrong role, forged expanded input and untrusted origins", async () => {
    const { definition } = await seed();
    const foreign = await harness.agent
      .post("/api/dashboard/workspaces")
      .send({ name: "Synthetic other inheritance scope" });
    expect(foreign.status).toBe(201);
    expect(
      (
        await harness.agent
          .post(`${root}/inheritance/preview`)
          .set("x-siftgate-workspace-id", foreign.body.item.id)
          .send({ definition })
      ).status,
    ).toBe(404);
    expect(
      (
        await harness.agent
          .post(`${root}/inherited-books`)
          .send({ name: "Global should not leak", scope: "global", definition })
      ).status,
    ).toBe(404);
    expect(
      (
        await harness.agent
          .post(`${root}/inherited-books`)
          .set("Origin", "https://untrusted.invalid")
          .send({ name: "No", definition })
      ).status,
    ).toBe(403);
    expect(
      (
        await harness.agent
          .post(`${root}/inherited-books`)
          .send({ name: "No", definition, content: tokenBook() })
      ).status,
    ).toBe(400);
    const members = harness.app.get(WorkspaceMembershipService);
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
      role: "operator",
    });
    expect(
      (
        await harness.agent
          .post(`${root}/inheritance/preview`)
          .send({ definition })
      ).status,
    ).toBe(403);
    expect(
      (
        await harness.agent
          .post(`${root}/inherited-books`)
          .send({ name: "No", definition })
      ).status,
    ).toBe(403);
    expect(
      await source.query("SELECT * FROM pricing_draft_inheritance"),
    ).toHaveLength(0);
  });
});
