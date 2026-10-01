import type {
  PriceBookContent,
  PricingRuleGroup,
  PricingSource,
  RateComponent,
} from "./pricing.types";

export interface PriceBookParentReference {
  book_id: string;
  version_id: string;
  content_hash: string;
}

/** A declarative draft recipe, not a runnable price book or a reference to the current catalog. */
export interface PricingInheritanceDefinition {
  schema_version: 1;
  parent: PriceBookParentReference;
  inherit: "all";
  source: PricingSource;
  rate_overrides: RateComponent[];
  removed_component_ids: string[];
  replaced_groups: PricingRuleGroup[];
  added_groups: PricingRuleGroup[];
  removed_group_ids: string[];
  settings: Partial<
    Pick<
      PriceBookContent,
      | "money_precision"
      | "money_rounding"
      | "billing_dimensions"
      | "allow_combined_media"
    >
  > & { media_specification?: PriceBookContent["media_specification"] | null };
  calendar:
    | { mode: "inherit" }
    | { mode: "remove" }
    | {
        mode: "replace";
        document: NonNullable<PriceBookContent["calendar"]>;
        time_basis: NonNullable<PriceBookContent["time_basis"]>;
      };
}

export interface PricingInheritanceProvenance {
  parent: PriceBookParentReference;
  parent_source: PricingSource;
  definition_hash: string;
  resolved_content_hash: string;
  groups: Array<{ group_id: string; origin: "parent" | "local" }>;
  components: Array<{
    group_id: string;
    rule_id: string;
    component_id: string;
    origin: "parent" | "override" | "local";
  }>;
  calendar: "parent" | "local" | "none";
}

export interface ResolvedPricingInheritance {
  definition: PricingInheritanceDefinition;
  content: PriceBookContent;
  provenance: PricingInheritanceProvenance;
}

export interface PricingInheritanceView {
  definition: PricingInheritanceDefinition;
  provenance: PricingInheritanceProvenance;
  /** Immediate parent first. Every hash refers to an immutable version. */
  ancestors: Array<PriceBookParentReference & { lineage_hash: string | null }>;
  lineage_hash: string;
}
