import { DataSource } from "typeorm";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createE2EHarness, type E2EHarness, FIXTURE_PATH } from "./setup";
import { applyPricingSchema, PRICING_TABLE_NAMES } from "../../src/pricing/pricing-schema";
import { WorkspaceMembershipService } from "../../src/auth/workspace-membership.service";
import { DEFAULT_ORGANIZATION_ID, DEFAULT_WORKSPACE_ID } from "../../src/workspaces/workspace.constants";
import { tokenBook } from "../unit/pricing-fixtures";

describe("book responsibility and lifecycle over actual management HTTP", () => {
  let harness: E2EHarness, directory: string, config: string, db: DataSource, id: string;
  const base = "/api/dashboard/pricing";
  const payload = (owner: string | null, revision = 1) => ({ owner, revision, reason: "Synthetic ownership change", confirm: true });
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "pricing-book-management-")); config = join(directory, "gateway.yaml"); copyFileSync(FIXTURE_PATH, config);
    harness = await createE2EHarness(config); db = harness.app.get(DataSource); await applyPricingSchema(db);
  }, 30000);
  afterAll(async () => { await harness?.close(); if (directory) rmSync(directory, { recursive: true, force: true }); });
  beforeEach(async () => { const result = await harness.agent.post(`${base}/books`).send({ name: "Synthetic responsibility", content: tokenBook() }); expect(result.status).toBe(201); id = result.body.book.id; });
  const snapshot = async () => {
    const state: Record<string, string[]> = {};
    for (const table of PRICING_TABLE_NAMES.filter(table => !["pricing_book_management", "pricing_audit_events"].includes(table))) {
      const rows: unknown[] = await db.query(`SELECT * FROM ${table}`); state[table] = rows.map(row => JSON.stringify(row)).sort();
    }
    return state;
  };

  it("reads state and changes/clears ownership without provider, price, config or budget changes", async () => {
    const state = await snapshot(), file = readFileSync(config, "utf8"), calls = harness.fetchMock.calls.length;
    const initial = await harness.agent.get(`${base}/books/${id}/management`);
    expect(initial.status).toBe(200); expect(initial.body).toMatchObject({ book_id: id, owner: "dashboard", revision: 1, lifecycle: { state: "draft", draft_count: 1 } });
    const saved = await harness.agent.put(`${base}/books/${id}/owner`).send(payload("team:ops <literal>"));
    expect(saved.status).toBe(200); expect(saved.body).toMatchObject({ book_id: id, owner: "team:ops <literal>", revision: 2 });
    expect((await harness.agent.get(`${base}/books/${id}/management`)).body.owner).toBe(saved.body.owner);
    const stale = await harness.agent.put(`${base}/books/${id}/owner`).send(payload("stale"));
    expect(stale.status).toBe(409); expect(stale.body.error.code).toBe("pricing_book_metadata_conflict");
    expect((await harness.agent.put(`${base}/books/${id}/owner`).send(payload(null, 2))).body).toMatchObject({ owner: null, revision: 3 });
    expect(await snapshot()).toEqual(state); expect(readFileSync(config, "utf8")).toBe(file); expect(harness.fetchMock.calls).toHaveLength(calls);
  });

  it.each([{ owner: "x", revision: 1 }, { ...payload("x"), role: "admin" }, { ...payload("x"), workspace_id: "forged" }, { ...payload("x"), confirm: false }, { ...payload("x"), owner: "x\ny" }, { ...payload("x"), owner: {} }, { ...payload("x"), revision: -1 }])("rejects malformed/spoofed metadata updates: %j", async value => {
    const before = (await harness.agent.get(`${base}/books/${id}/management`)).body;
    expect((await harness.agent.put(`${base}/books/${id}/owner`).send(value)).status).toBe(400);
    const after = (await harness.agent.get(`${base}/books/${id}/management`)).body;
    expect(after.owner).toBe(before.owner); expect(after.revision).toBe(before.revision);
  });

  it("allows viewer inspection but blocks viewer mutation and cross-origin owner changes", async () => {
    const memberships = harness.app.get(WorkspaceMembershipService);
    await memberships.ensureMembership({ userId: "synthetic-fixture-admin", organizationId: DEFAULT_ORGANIZATION_ID, workspaceId: DEFAULT_WORKSPACE_ID, role: "admin" });
    await memberships.ensureMembership({ userId: "dashboard", organizationId: DEFAULT_ORGANIZATION_ID, workspaceId: DEFAULT_WORKSPACE_ID, role: "viewer" });
    try {
      expect((await harness.agent.get(`${base}/books/${id}/management`)).status).toBe(200);
      expect((await harness.agent.put(`${base}/books/${id}/owner`).send(payload("blocked"))).status).toBe(403);
    } finally { await memberships.ensureMembership({ userId: "dashboard", organizationId: DEFAULT_ORGANIZATION_ID, workspaceId: DEFAULT_WORKSPACE_ID, role: "admin" }); }
    expect((await harness.agent.put(`${base}/books/${id}/owner`).set("Origin", "https://untrusted.example").send(payload("blocked"))).status).toBe(403);
    expect((await harness.agent.get(`${base}/books/missing/management`)).status).toBe(404);
  });
});
