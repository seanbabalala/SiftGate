import { parseMediaSpecification } from './media-specification';
import { compilePriceBook, PricingCompileError } from "./pricing-compiler";
import { pricingContentHash } from "./pricing-json";
import { PricingSchemaReader } from "./pricing-schema-reader";
import type {
  PriceBookContent,
  PriceBookIdentity,
  PricingRuleGroup,
  PricingSource,
  RateComponent,
} from "./pricing.types";
import type {
  PriceBookParentReference,
  PricingInheritanceDefinition,
  ResolvedPricingInheritance,
} from "./pricing-inheritance.types";

const MAX_DOCUMENT_BYTES = 512000;
const fail = (path: string, message: string): never => {
  throw new PricingCompileError([
    { code: "pricing_invalid_document", path, message },
  ]);
};
function boundedCopy<T>(value: T): T {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    return fail("inheritance", "Expected a bounded JSON document");
  }
  if (!json || Buffer.byteLength(json) > MAX_DOCUMENT_BYTES)
    fail("inheritance", "Inheritance documents must fit within 500 KiB");
  return JSON.parse(json) as T;
}
function uniqueIds(
  reader: PricingSchemaReader,
  value: unknown,
  path: string,
  max: number,
): string[] {
  const result = reader
    .array(value, path, max)
    .map((id, index) => reader.string(id, `${path}.${index}`));
  if (new Set(result).size !== result.length)
    reader.invalid(path, "Identifiers must be unique");
  return result;
}

/** Parse the recipe only. Parent authorization and immutable version lookup belong to the repository transaction. */
export function parsePricingInheritance(
  value: unknown,
): PricingInheritanceDefinition {
  const reader = new PricingSchemaReader();
  const raw = reader.object(boundedCopy(value), "inheritance", [
    "schema_version",
    "parent",
    "inherit",
    "source",
    "rate_overrides",
    "removed_component_ids",
    "replaced_groups",
    "added_groups",
    "removed_group_ids",
    "settings",
    "calendar",
  ]);
  const parent = reader.object(raw.parent, "inheritance.parent", [
    "book_id",
    "version_id",
    "content_hash",
  ]);
  const reference: PriceBookParentReference = {
    book_id: reader.string(parent.book_id, "inheritance.parent.book_id"),
    version_id: reader.string(
      parent.version_id,
      "inheritance.parent.version_id",
    ),
    content_hash: reader.string(
      parent.content_hash,
      "inheritance.parent.content_hash",
      64,
    ),
  };
  if (!/^[a-f0-9]{64}$/.test(reference.content_hash))
    reader.invalid(
      "inheritance.parent.content_hash",
      "Use the exact immutable parent hash",
    );
  if (raw.schema_version !== 1)
    reader.invalid(
      "inheritance.schema_version",
      "Only inheritance schema version 1 is supported",
    );
  if (raw.inherit !== "all")
    reader.invalid(
      "inheritance.inherit",
      "Explicit complete-parent inheritance is required",
    );
  const settings = reader.object(raw.settings, "inheritance.settings", [
    "money_precision",
    "money_rounding",
    "billing_dimensions",
    "allow_combined_media",
    "media_specification",
  ]);
  if (settings.media_specification !== undefined && settings.media_specification !== null)
    settings.media_specification = parseMediaSpecification(settings.media_specification, reader, "inheritance.settings.media_specification");
  const source = reader.object(raw.source, "inheritance.source", [
    "kind",
    "reference",
    "verified_at",
  ]);
  const calendar = reader.object(raw.calendar, "inheritance.calendar", [
    "mode",
    "document",
    "time_basis",
  ]);
  if (!["inherit", "remove", "replace"].includes(String(calendar.mode)))
    reader.invalid(
      "inheritance.calendar.mode",
      "Choose inherit, remove or replace",
    );
  if (
    calendar.mode !== "replace" &&
    (calendar.document !== undefined || calendar.time_basis !== undefined)
  )
    reader.invalid(
      "inheritance.calendar",
      "Only replacement may supply calendar content or time basis",
    );
  if (
    calendar.mode === "replace" &&
    (!calendar.document || !calendar.time_basis)
  )
    reader.invalid(
      "inheritance.calendar",
      "Replacement requires a complete calendar and time basis",
    );
  const rates = reader.array(
    raw.rate_overrides,
    "inheritance.rate_overrides",
    4096,
  ) as RateComponent[];
  const replaced = reader.array(
    raw.replaced_groups,
    "inheritance.replaced_groups",
    16,
  ) as PricingRuleGroup[];
  const added = reader.array(
    raw.added_groups,
    "inheritance.added_groups",
    16,
  ) as PricingRuleGroup[];
  // Inner rate/group semantics are validated on the fully expanded price book;
  // do not attempt to compile an incomplete overlay as if it were a base tariff.
  for (const [name, values] of [
    ["rate_overrides", rates],
    ["replaced_groups", replaced],
    ["added_groups", added],
  ] as const) {
    const ids = values.map((entry, index) =>
      reader.string(
        entry && typeof entry === "object" ? entry.id : undefined,
        `inheritance.${name}.${index}.id`,
      ),
    );
    if (new Set(ids).size !== ids.length)
      reader.invalid(`inheritance.${name}`, "Identifiers must be unique");
  }
  const definition: PricingInheritanceDefinition = {
    schema_version: 1,
    parent: reference,
    inherit: "all",
    source: source as unknown as PricingSource,
    rate_overrides: rates,
    removed_component_ids: uniqueIds(
      reader,
      raw.removed_component_ids,
      "inheritance.removed_component_ids",
      4096,
    ),
    replaced_groups: replaced,
    added_groups: added,
    removed_group_ids: uniqueIds(
      reader,
      raw.removed_group_ids,
      "inheritance.removed_group_ids",
      16,
    ),
    settings: settings as PricingInheritanceDefinition["settings"],
    calendar: calendar as PricingInheritanceDefinition["calendar"],
  };
  if (reader.diagnostics.length)
    throw new PricingCompileError(reader.diagnostics);
  return definition;
}

/** Deterministically expand one authorized immutable parent. Never fetch prices, infer rates or mutate inputs. */
export function resolvePricingInheritance(
  value: unknown,
  parent: { reference: PriceBookParentReference; content: PriceBookContent },
  identity: PriceBookIdentity,
): ResolvedPricingInheritance {
  const definition = parsePricingInheritance(value);
  if (
    pricingContentHash(definition.parent) !==
    pricingContentHash(parent.reference)
  )
    fail(
      "inheritance.parent",
      "Resolved parent identity differs from the explicitly selected version",
    );
  if (
    definition.parent.book_id === identity.book_id &&
    definition.parent.version_id === identity.version_id
  )
    fail("inheritance.parent", "A version cannot inherit itself");
  const compiledParent = compilePriceBook(
    boundedCopy(parent.content),
    definition.parent,
  );
  if (compiledParent.contentHash !== definition.parent.content_hash)
    fail(
      "inheritance.parent.content_hash",
      "Parent contents differ from their immutable hash",
    );
  const base = compiledParent.document();
  if (base.source.kind === "reference")
    fail(
      "inheritance.parent",
      "Reference-only prices must be explicitly approved before becoming a live parent",
    );
  const groups = new Map(base.groups.map((group) => [group.id, group]));
  const touchedGroups = new Set<string>();
  const localGroups = new Set<string>();
  for (const id of definition.removed_group_ids) {
    if (!groups.has(id))
      fail("inheritance.removed_group_ids", `Unknown parent group: ${id}`);
    groups.delete(id);
    touchedGroups.add(id);
  }
  for (const group of definition.replaced_groups) {
    if (!groups.has(group.id) || touchedGroups.has(group.id))
      fail(
        "inheritance.replaced_groups",
        "Replace only one existing parent group, without also removing it",
      );
    groups.set(group.id, structuredClone(group));
    touchedGroups.add(group.id);
    localGroups.add(group.id);
  }
  for (const group of definition.added_groups) {
    if (groups.has(group.id) || touchedGroups.has(group.id))
      fail(
        "inheritance.added_groups",
        "New groups must have new identities; use replacement for a parent group",
      );
    groups.set(group.id, structuredClone(group));
    touchedGroups.add(group.id);
    localGroups.add(group.id);
  }
  const components = new Map<
    string,
    {
      group: string;
      rule: PricingRuleGroup["rules"][number];
      entry: PricingRuleGroup["rules"][number]["rates"][number];
    }
  >();
  for (const group of base.groups)
    if (!touchedGroups.has(group.id))
      for (const rule of group.rules)
        for (const entry of rule.rates)
          components.set(entry.component.id, { group: group.id, rule, entry });
  const touchedRates = new Set<string>();
  for (const id of definition.removed_component_ids) {
    const original = components.get(id);
    if (!original)
      fail(
        "inheritance.removed_component_ids",
        `Only untouched inherited components can be removed: ${id}`,
      );
    original!.rule.rates = original!.rule.rates.filter(
      (entry) => entry.component.id !== id,
    );
    touchedRates.add(id);
  }
  for (const replacement of definition.rate_overrides) {
    const original = components.get(replacement.id);
    if (!original || touchedRates.has(replacement.id))
      fail(
        "inheritance.rate_overrides",
        "Override one inherited component only; do not combine with component removal or whole-group replacement",
      );
    if (
      original!.entry.component.dimension !== replacement.dimension ||
      original!.entry.component.unit !== replacement.unit
    )
      fail(
        "inheritance.rate_overrides",
        "A rate override cannot repurpose the inherited billing dimension or unit",
      );
    original!.entry.component = structuredClone(replacement);
    touchedRates.add(replacement.id);
  }
  const { media_specification: specification, ...settings } = definition.settings;
  const effective: PriceBookContent = {
    ...base,
    ...settings,
    source: definition.source,
    groups: [...groups.values()],
  };
  if (specification === null) delete effective.media_specification;
  else if (specification !== undefined) effective.media_specification = structuredClone(specification);
  if (definition.calendar.mode === "remove") {
    delete effective.calendar;
    delete effective.time_basis;
  } else if (definition.calendar.mode === "replace") {
    effective.calendar = structuredClone(definition.calendar.document);
    effective.time_basis = definition.calendar.time_basis;
  }
  const compiled = compilePriceBook(boundedCopy(effective), identity),
    content = compiled.document();
  return {
    definition: boundedCopy(definition),
    content,
    provenance: {
      parent: { ...definition.parent },
      parent_source: { ...base.source },
      definition_hash: pricingContentHash(definition),
      resolved_content_hash: compiled.contentHash,
      groups: content.groups.map((group) => ({
        group_id: group.id,
        origin: localGroups.has(group.id) ? "local" : "parent",
      })),
      components: content.groups.flatMap((group) =>
        group.rules.flatMap((rule) =>
          rule.rates.map((entry) => ({
            group_id: group.id,
            rule_id: rule.id,
            component_id: entry.component.id,
            origin: localGroups.has(group.id)
              ? ("local" as const)
              : touchedRates.has(entry.component.id)
                ? ("override" as const)
                : ("parent" as const),
          })),
        ),
      ),
      calendar: !content.calendar
        ? "none"
        : definition.calendar.mode === "replace"
          ? "local"
          : "parent",
    },
  };
}
