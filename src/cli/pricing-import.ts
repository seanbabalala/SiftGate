import { constants, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { load, JSON_SCHEMA, Type } from "js-yaml";
import { planPricingConfigImport } from "../pricing/pricing-config-import";
import { PRICING_CONFIG_IMPORT_MAX_BYTES, PricingConfigImportError } from "../pricing/pricing-config-import-input";

// Keep date-like metadata as strings, while preserving legacy YAML merge keys.
// Only the built-in merge tag is added; no executable/application tags resolve.
const schema = JSON_SCHEMA.extend({ implicit: [new Type("tag:yaml.org,2002:merge", { kind: "scalar", resolve: value => value === "<<" || value === null })] });

function readInput(cwd: string, filename: string): unknown {
  let fd: number | undefined;
  try {
    fd = openSync(resolve(cwd, filename), constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > PRICING_CONFIG_IMPORT_MAX_BYTES) throw new Error("unsafe input");
    const buffer = Buffer.alloc(PRICING_CONFIG_IMPORT_MAX_BYTES + 1); let count = 0, size = 0;
    while ((size = readSync(fd, buffer, count, buffer.length - count, null)) > 0) {
      count += size; if (count > PRICING_CONFIG_IMPORT_MAX_BYTES) throw new Error("oversized input");
    }
    return load(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, count)), { schema, json: false });
  } catch {
    // YAML errors include source snippets, paths and credentials by default.
    // No input-derived text or file path belongs in the public error message.
    throw new PricingConfigImportError("pricing_import_unreadable_document", "input_file");
  } finally { if (fd !== undefined) closeSync(fd); }
}

export async function runPricingImportCommand(args: string[], io: { cwd: string; now: () => Date; stdout: (text: string) => void; stderr: (text: string) => void }): Promise<number> {
  try {
    let values: { config?: string; "catalog-file"?: string; "dry-run"?: boolean; at?: string; help?: boolean };
    try { ({ values } = parseArgs({ args, options: { config: { type: "string" }, "catalog-file": { type: "string" }, "dry-run": { type: "boolean" }, at: { type: "string" }, help: { type: "boolean", short: "h" } } })); }
    catch { throw new PricingConfigImportError("pricing_import_invalid_arguments", "arguments"); }
    if (values.help) { io.stdout("siftgate pricing-import --config FILE [--catalog-file FILE] [--at ISO_INSTANT] [--dry-run]\nRead-only pricing migration proposal. No file/database writes, secret expansion, model calls or activation. Catalog fallbacks require an explicitly supplied resolved catalog snapshot. Review node inheritance, draft prices, currencies and media metadata before separately publishing anything."); return 0; }
    if (!values.config) throw new PricingConfigImportError("pricing_import_explicit_config_required", "config");
    const plan = planPricingConfigImport(readInput(io.cwd, values.config), { catalog: values["catalog-file"] ? readInput(io.cwd, values["catalog-file"]) : undefined, evaluated_at: values.at ?? io.now().toISOString() });
    io.stdout(JSON.stringify(plan, null, 2)); return 0;
  } catch (error) {
    io.stderr(error instanceof PricingConfigImportError ? error.message : "pricing_import_invalid_document: pricing"); return 1;
  }
}
