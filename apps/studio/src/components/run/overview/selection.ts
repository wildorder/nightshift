/**
 * What the Overview has selected: a headline tile or a chart segment. Plain
 * data, resolved against the current report each render, so a poll that
 * refreshes the report refreshes the open sheet and keeps the selection.
 */
import type { MetricId } from "@nightshift/core";

export type TileId = "delivered" | "time" | "consumed" | "review";

export type SelectionScope =
  | { readonly kind: "tile"; readonly tile: TileId }
  | { readonly kind: "role"; readonly value: string }
  | { readonly kind: "model"; readonly value: string }
  | { readonly kind: "cause"; readonly value: string }
  | { readonly kind: "interval"; readonly id: string };

export interface Selection {
  /** Stable across refreshes; marks the selected tile or segment. */
  readonly key: string;
  readonly title: string;
  readonly metrics: readonly MetricId[];
  readonly scope: SelectionScope;
}

export const TILE_SELECTIONS: Readonly<Record<TileId, Selection>> = {
  delivered: {
    key: "tile:delivered",
    title: "Delivered",
    metrics: ["first_attempt_success", "delivered_outcomes", "human_verdict"],
    scope: { kind: "tile", tile: "delivered" },
  },
  time: {
    key: "tile:time",
    title: "Time",
    metrics: ["elapsed_completion_time", "wait_time"],
    scope: { kind: "tile", tile: "time" },
  },
  consumed: {
    key: "tile:consumed",
    title: "Consumed",
    metrics: [
      "tokens_input",
      "tokens_output",
      "api_equivalent_estimate",
      "infrastructure_estimate",
    ],
    scope: { kind: "tile", tile: "consumed" },
  },
  review: {
    key: "tile:review",
    title: "Repair and review",
    metrics: ["rework_attempts", "rework_by_cause", "examiner_dispositions", "review_overhead"],
    scope: { kind: "tile", tile: "review" },
  },
};
