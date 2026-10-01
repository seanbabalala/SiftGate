import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';
import { CompiledPricingCatalog } from '../src/pricing/pricing-catalog';
import { pricingContentHash } from '../src/pricing/pricing-json';
import { normalizeCanonicalTokenUsage } from '../src/pricing/usage-normalizer';
import type { PricingCatalogDocument } from '../src/pricing/pricing-catalog.types';
import type { PriceBookContent } from '../src/pricing/pricing.types';

export interface PricingBenchmarkOptions { models: number; rules: number; components: number; iterations: number; warmup: number; seed: number }
export const PRICING_BENCHMARK_DEFAULTS: PricingBenchmarkOptions = { models: 1000, rules: 20, components: 12, iterations: 10000, warmup: 1000, seed: 20260928 };
const maxima: PricingBenchmarkOptions = { models: 1000, rules: 20, components: 12, iterations: 10000, warmup: 2000, seed: 4294967295 };
export function validatePricingBenchmark(options: PricingBenchmarkOptions): void {
  for (const key of Object.keys(maxima) as Array<keyof PricingBenchmarkOptions>) if (!Number.isSafeInteger(options[key]) || options[key] < (key === 'warmup' || key === 'seed' ? 0 : 1) || options[key] > maxima[key]) throw new Error(`Invalid or unsafe benchmark size: ${key}`);
}
function generator(seed: number) { let state = seed >>> 0; return () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0); }

/** Synthetic additive fee components, not vendor rates. No config, DB or network reads. */
export function pricingBenchmarkFixture(options: PricingBenchmarkOptions): PricingCatalogDocument {
  validatePricingBenchmark(options);
  const random = generator(options.seed), instant = '2026-09-01T00:00:00.000Z';
  const catalog: PricingCatalogDocument = { schema_version: 1, revision_id: 'synthetic-benchmark-v1', created_at: instant, books: [], bindings: [], fx_versions: [] };
  for (let model = 0; model < options.models; model++) {
    const id = `synthetic-${model}`, factor = random() % 7 + 1;
    const content: PriceBookContent = { schema_version: 1, currency: 'USD', money_precision: 9, money_rounding: 'half_even', source: { kind: 'manual', reference: 'Synthetic benchmark only; not supplier pricing' }, billing_dimensions: ['uncached_input_tokens'], allow_combined_media: false, groups: [{ id: 'context', order: 0, required: true, rules: [] }] };
    for (let rule = 0; rule < options.rules; rule++) content.groups[0].rules.push({ id: `tier-${rule}`, priority: rule, mode: 'whole_request', condition: { input_tokens: { min: String(rule * 1000), max: String((rule + 1) * 1000 - 1) } }, rates: Array.from({ length: options.components }, (_, component) => ({ operation: 'add', component: { id: `fee-${rule}-${component}`, dimension: 'uncached_input_tokens', amount: String(factor * (component + 1)), unit: 'token', unit_size: '1000000' } })) });
    catalog.books.push({ workspace_id: 'benchmark', book_id: id, version_id: `${id}-v1`, content_hash: pricingContentHash(content), content });
    catalog.bindings.push({ id, workspace_id: 'benchmark', book_id: id, version_id: `${id}-v1`, level: 'model', model: id, operation: 'chat_completions', effective_from: '2026-01-01T00:00:00.000Z' });
  }
  return catalog;
}
export function runPricingBenchmark(options: PricingBenchmarkOptions) {
  validatePricingBenchmark(options);
  const started = performance.now(), fixture = pricingBenchmarkFixture(options), fixtureMs = performance.now() - started;
  const compileStart = performance.now(), catalog = CompiledPricingCatalog.compile(fixture), compileMs = performance.now() - compileStart;
  const snapshot = catalog.capture({ admitted_at: '2026-09-01T00:00:00.000Z', workspace_id: 'benchmark', report_currency: 'USD' });
  const usages = Array.from({ length: options.rules }, (_, rule) => normalizeCanonicalTokenUsage({ input_tokens: rule * 1000 + 500, output_tokens: 0 }, { adapter_id: 'synthetic-benchmark', adapter_version: '1', source: 'local_measurement', quality: 'observed' }, { absent_cache_is_zero: true }));
  const random = generator(options.seed), samples: number[] = [], amounts = createHash('sha256'), visited = new Set<string>();
  const evaluate = (index: number, measured: boolean) => {
    // Round-robin model coverage with seeded context selection. No provider dispatch.
    const model = `synthetic-${index % options.models}`, usage = usages[random() % usages.length];
    const start = performance.now(), quote = snapshot.quote({ model, operation: 'chat_completions' }, usage), elapsed = performance.now() - start;
    if (quote.cost.status !== 'priced' || quote.cost.lines.length !== options.components || quote.cost.report_amount === null) throw new Error('Benchmark fixture did not exercise complete real pricing');
    if (measured) { samples.push(elapsed); amounts.update(quote.cost.report_amount + '\n'); visited.add(model); }
  };
  for (let i = 0; i < options.warmup; i++) evaluate(i, false);
  const memoryBefore = process.memoryUsage(), cpuBefore = process.cpuUsage(), measurementStart = performance.now();
  for (let i = 0; i < options.iterations; i++) evaluate(i, true);
  const measuredMs = performance.now() - measurementStart, cpu = process.cpuUsage(cpuBefore), ordered = [...samples].sort((a, b) => a - b);
  const percentile = (fraction: number) => ordered[Math.ceil(ordered.length * fraction) - 1];
  const timings = { p50_ms: percentile(.5), p95_ms: percentile(.95), p99_ms: percentile(.99), max_ms: ordered.at(-1)! };
  const fullScale = options.models === 1000 && options.rules === 20 && options.components === 12 && options.iterations === 10000;
  return { benchmark: 'pricing-pure-quote-v1', synthetic: true, workload: 'One frozen catalog; seeded context tier;12 explicitly additive same-dimension fee components per rule at full scale. No DB, admission persistence or upstream HTTP is measured.', options, fixture_hash: pricingContentHash(fixture), visited_models: visited.size, component_count: options.models * options.rules * options.components, fixture_ms: fixtureMs, compile_ms: compileMs, measured_ms: measuredMs, timings, full_scale: fullScale, quote_slo_met: fullScale && timings.p95_ms <= 2 && timings.p99_ms <= 10, gateway_http_comparison: 'not_performed', result_amount_digest: amounts.digest('hex'), runtime: { node: process.version, abi: process.versions.modules, platform: process.platform, arch: process.arch, cpu_model: cpus()[0]?.model ?? 'unknown', logical_cpus: cpus().length, total_memory_bytes: totalmem(), heap_limit_bytes: getHeapStatistics().heap_size_limit }, memory_before: memoryBefore, memory_after: process.memoryUsage(), cpu_microseconds: cpu, samples_ms: samples };
}

if (require.main === module) {
  const args = process.argv.slice(2), options = { ...PRICING_BENCHMARK_DEFAULTS };
  if (!args.includes('--confirm-isolated')) throw new Error('Run only in an isolated, resource-limited environment; pass --confirm-isolated explicitly. This does not authorize production load.');
  let output: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]; if (arg === '--confirm-isolated') continue;
    if (arg === '--output') { output = args[++i]; if (!output) throw new Error('Missing output path'); continue; }
    const key = arg.slice(2) as keyof PricingBenchmarkOptions;
    if (!arg.startsWith('--') || !Object.hasOwn(maxima, key) || !/^\d+$/.test(args[i + 1] ?? '')) throw new Error(`Unknown or invalid argument: ${arg}`);
    options[key] = Number(args[++i]);
  }
  const result = runPricingBenchmark(options), root = resolve(__dirname, '..');
  const fingerprints = Object.fromEntries(['scripts/benchmark-pricing.ts', 'package.json', 'package-lock.json', 'src/pricing/pricing-catalog.ts', 'src/pricing/pricing-compiler.ts', 'src/pricing/pricing-conditions.ts', 'src/pricing/pricing-rate-envelope.ts', 'src/pricing/usage-normalizer.ts', 'src/pricing/cost-calculator.ts', 'src/pricing/exact-decimal.ts'].map(file => [file, createHash('sha256').update(readFileSync(resolve(root, file))).digest('hex')]));
  const document = { ...result, source_fingerprints: fingerprints };
  if (output) writeFileSync(resolve(output), JSON.stringify(document, null, 2) + '\n', { flag: 'wx' });
  const { samples_ms: _samples, ...summary } = document;
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  if (result.full_scale && !result.quote_slo_met) process.exitCode = 1;
}
