import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dump } from "js-yaml";
import { runCli } from "../../src/cli/siftgate";
import { pricingConfigImportFixture, pricingCatalogImportFixture } from "../helpers/pricing-config-import-fixture";

describe("explicit offline pricing-import CLI", () => {
  let dir: string, output: string[], errors: string[];
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "pricing-config-import-")); output = []; errors = []; });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const run = (args: string[]) => runCli(["pricing-import", ...args], { cwd: dir, env: {}, now: () => new Date("2026-09-29T00:00:00Z"), stdout: value => output.push(value), stderr: value => errors.push(value) });
  it("requires an explicit file, rejects apply/output flags, and never creates a default config or database", async () => {
    expect(await run([])).toBe(1); expect(await run(["--apply"])).toBe(1); expect(await run(["--output", "PRIVATE"])).toBe(1);
    expect(readdirSync(dir)).toEqual([]); expect(output).toEqual([]); expect(errors.join(" ")).not.toContain("PRIVATE");
  });
  it("checks whole YAML and supplied catalog with byte-identical inputs and no writes", async () => {
    const config = join(dir, "input.yaml"), catalog = join(dir, "catalog.json"); writeFileSync(config, dump(pricingConfigImportFixture())); writeFileSync(catalog, JSON.stringify(pricingCatalogImportFixture()));
    const files = readdirSync(dir), before = files.map(file => readFileSync(join(dir, file)));
    expect(await run(["--config", config, "--catalog-file", catalog])).toBe(0);
    expect(JSON.parse(output[0])).toMatchObject({ dry_run: true, complete_source_resolution: true, requires_review: true });
    expect(await run(["--config", config, "--catalog-file", catalog, "--dry-run"])).toBe(0); expect(output[1]).toBe(output[0]);
    expect(readdirSync(dir)).toEqual(files); expect(files.map(file => readFileSync(join(dir, file)))).toEqual(before);
  });
  it("preserves YAML anchors/merge precedence and treats date-like provenance as text", async () => {
    writeFileSync(join(dir, "merge.yaml"), "base: &base {input: 1, output: 2, last_updated: 2026-09-01}\nmodels_pricing:\n  model: {<<: *base, input: 0.0000004}\n");
    expect(await run(["--config", "merge.yaml"])).toBe(0);
    expect(JSON.parse(output[0]).entries[0].declared).toMatchObject({ input: "0.0000004", output: "2", last_updated: "2026-09-01" });
  });
  it("round-trips opaque Unicode and @-prefixed model identities without rewriting them", async () => {
    const model = "@cf/模型-v1"; writeFileSync(join(dir, "identity.yaml"), dump({ models_pricing: { [model]: { input: 1, output: 2 } } }));
    const bytes = readFileSync(join(dir, "identity.yaml")); expect(await run(["--config", "identity.yaml"])).toBe(0);
    expect(JSON.parse(output[0]).entries[0].target.model).toBe(model); expect(readFileSync(join(dir, "identity.yaml"))).toEqual(bytes);
  });
  it("refuses directories, oversized files and invalid UTF-8 without writing or leaking a path", async () => {
    expect(await run(["--config", dir])).toBe(1);
    writeFileSync(join(dir, "large.yaml"), "x".repeat(4 * 1024 * 1024 + 1)); expect(await run(["--config", "large.yaml"])).toBe(1);
    writeFileSync(join(dir, "bytes.yaml"), Buffer.from([0xff, 0xfe, 0x61])); expect(await run(["--config", "bytes.yaml"])).toBe(1);
    expect(output).toEqual([]); expect(errors.join(" ")).not.toContain(dir); expect(readdirSync(dir).sort()).toEqual(["bytes.yaml", "large.yaml"]);
  });
  it.each([
    'api_key: PRIVATE\nmodels_pricing: [broken\n',
    'models_pricing: {model: {input: 1, input: 2, output: 1}}',
    'models_pricing: !!js/function "function(){return PRIVATE}"',
    'loop: &loop {again: *loop}',
    'models_pricing: {model: {input: .nan, output: 1}}',
  ])("refuses malformed, ambiguous or non-data YAML without echoing snippets", async document => {
    writeFileSync(join(dir, "invalid.yaml"), document); expect(await run(["--config", "invalid.yaml"])).toBe(1);
    expect(output).toEqual([]); expect(errors.join(" ")).not.toMatch(/PRIVATE|function\(\)|models_pricing:|invalid\.yaml/);
  });
});
