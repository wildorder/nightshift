/**
 * The models a person picks from when they set an org's role lists (D-RR-01):
 * each with the harness that runs it and a name a person reads. A suggestion
 * list for the Studio and the CLI, not a limit: a route may name any model its
 * harness can run, and routing's compatibility table is what decides that.
 */
export interface CatalogModel {
  readonly harness: string;
  readonly model: string;
  readonly label: string;
  readonly provider: "Anthropic" | "OpenAI";
}

export const MODEL_CATALOG: readonly CatalogModel[] = [
  {
    harness: "claude",
    model: "claude-fable-5-1",
    label: "Claude Fable 5.1",
    provider: "Anthropic",
  },
  { harness: "claude", model: "claude-opus-5-5", label: "Claude Opus 5.5", provider: "Anthropic" },
  {
    harness: "claude",
    model: "claude-sonnet-5-5",
    label: "Claude Sonnet 5.5",
    provider: "Anthropic",
  },
  { harness: "claude", model: "claude-sonnet-5", label: "Claude Sonnet 5", provider: "Anthropic" },
  {
    harness: "claude",
    model: "claude-haiku-5-5",
    label: "Claude Haiku 5.5",
    provider: "Anthropic",
  },
  { harness: "codex", model: "gpt-6-astra", label: "GPT-6 Astra", provider: "OpenAI" },
  { harness: "codex", model: "gpt-6-sol", label: "GPT-6 Sol", provider: "OpenAI" },
  { harness: "codex", model: "gpt-6-luna", label: "GPT-6 Luna", provider: "OpenAI" },
];

/** A model's catalog entry, when it has one. */
export const catalogEntry = (model: string): CatalogModel | undefined =>
  MODEL_CATALOG.find((entry) => entry.model === model);

/** What a person reads for a route: the catalog's name, or the model id itself. */
export const modelLabel = (model: string): string => catalogEntry(model)?.label ?? model;
