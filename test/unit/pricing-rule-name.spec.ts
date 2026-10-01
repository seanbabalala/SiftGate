import { compilePriceBook } from "../../src/pricing/pricing-compiler";
import { pricingContentHash } from "../../src/pricing/pricing-json";
import { runtimeOutcomeDocument } from "../../src/pricing/pricing-outcome-document";
import { resolvePricingInheritance } from "../../src/pricing/pricing-inheritance";
import { validPricingRuleName } from "../../src/pricing/pricing-rule-name";
import type { PricingInheritanceDefinition } from "../../src/pricing/pricing-inheritance.types";
import { tokenBook, tokens, quote } from "./pricing-fixtures";

const usage = () => tokens({ input_tokens: 1000, output_tokens: 100 });
describe("immutable rule display names", () => {
  it("keeps the pre-name price, trace and receipt hashes unchanged when metadata is absent", () => {
    const compiled = compilePriceBook(tokenBook(), { book_id: "stable-book", version_id: "stable-version" });
    const cost = quote(tokenBook(), usage());
    expect(compiled.contentHash).toBe("c0974e1ef6215d21833be2ccdf53cf15eee9cd441e9fbbaf18f7e4e09501d1a4");
    expect(pricingContentHash(cost.selection)).toBe("61bc576f38b51da4fa5e0b9a4119bae58196417653bebadbf8f9f7aa35a4f3a8");
    expect(pricingContentHash(cost)).toBe("f2efa5332bd8b8a8c37bb6fd74ecc988c89d1f0bd4ca6c6bec02a2b7118cd661");
    expect(compiled.document().groups[0].rules[0]).not.toHaveProperty("name");
    expect(cost.selection!.evaluations[0]).not.toHaveProperty("rule_name");
  });
  it("preserves literal Unicode/display text while leaving IDs, matching, units and amounts unchanged", () => {
    const plain = tokenBook(), named = tokenBook(), name = '夜间费率 <strong title="literal"> & 规则'; named.groups[0].rules[0].name = name;
    const before = quote(plain, usage()), after = quote(named, usage());
    expect(after.amount).toBe(before.amount); expect(after.lines).toEqual(before.lines); expect(after.selected_rule_ids).toEqual(before.selected_rule_ids);
    expect(after.content_hash).not.toBe(before.content_hash);
    expect(after.selection!.evaluations[0]).toEqual({ ...before.selection!.evaluations[0], rule_name: name });
    const outcome = runtimeOutcomeDocument({ type: "attempt", workspace: "workspace", reservationId: "reserve", attemptId: "attempt", cost: after, errorCode: null });
    expect(outcome.outcome).toMatchObject({ cost: { selection: { evaluations: [{ rule_name: name }] } } });
  });
  it.each(["", "   ", "x".repeat(129), null, 7, "line\nname", "bad\u0000name"])("rejects invalid name %p in both price definitions and retained evidence", name => {
    const content = tokenBook(); Object.assign(content.groups[0].rules[0], { name });
    expect(validPricingRuleName(name)).toBe(false); expect(() => compilePriceBook(content, { book_id: "invalid", version_id: "v1" })).toThrow();
    const cost = quote(tokenBook(), usage()); Object.assign(cost.selection!.evaluations[0], { rule_name: name });
    expect(() => runtimeOutcomeDocument({ type: "attempt", workspace: "workspace", reservationId: "reserve", attemptId: "attempt", cost, errorCode: null })).toThrow();
  });
  it("inherits the pinned rule name and preserves explicit name overrides as group replacements", () => {
    const content = tokenBook(); content.groups[0].rules[0].name = "Original parent label";
    const compiled = compilePriceBook(content, { book_id: "parent", version_id: "v1" });
    const reference = { book_id: "parent", version_id: "v1", content_hash: compiled.contentHash };
    const definition: PricingInheritanceDefinition = { schema_version: 1, parent: reference, inherit: "all", source: { kind: "manual" }, rate_overrides: [], removed_component_ids: [], replaced_groups: [], added_groups: [], removed_group_ids: [], settings: {}, calendar: { mode: "inherit" } };
    const parent = { reference, content: compiled.document() }, child = { book_id: "child", version_id: "v1" };
    const inherited = resolvePricingInheritance(definition, parent, child); expect(inherited.content.groups[0].rules[0].name).toBe("Original parent label");
    const replacement = structuredClone(content.groups[0]); replacement.rules[0].name = "Child label";
    const override = resolvePricingInheritance({ ...definition, replaced_groups: [replacement] }, parent, child);
    expect(override.content.groups[0].rules[0]).toMatchObject({ id: "base-rate", name: "Child label" });
    expect(quote(override.content, usage()).amount).toBe(quote(inherited.content, usage()).amount);
    expect(parent.content.groups[0].rules[0].name).toBe("Original parent label");
  });
});
