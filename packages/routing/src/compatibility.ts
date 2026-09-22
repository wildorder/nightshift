/**
 * Which harness can run which provider's models, and how each pair
 * authenticates (P5 §4.3, D-P5-04).
 *
 * **A harness is not a provider.** P3 had one adapter and one provider and could
 * treat the two as the same word; they are not. Claude Code runs Anthropic's
 * models directly on the operator's subscription, and the same models through
 * Bedrock on an instance role. Codex runs OpenAI's. P10's AgentCore harness runs
 * whatever Bedrock offers. So the table is `harness → [provider × model family]`
 * and never a 1:1 map, and a route is a `(harness, provider, model)` triple the
 * table allows *and* the Program Contract's policy allows.
 *
 * It describes what an adapter **can** run, not what is cheapest or best. Until
 * P8, the first compatible pair in the policy's own order wins (a stated
 * non-guarantee of P5).
 *
 * Rows marked `availableFrom` are here so P10 fills in a row rather than changing
 * a shape. A route through one is refused, by name, until then.
 */

/** How a harness proves who is paying for a provider. Never a secret, only its kind. */
export type RouteAuthentication =
  /** The operator's own signed-in CLI, on the operator's machine (D-P5-07). */
  | "operator-login"
  /** The role of the runtime instance the harness runs on (P10, A-14). */
  | "instance-role";

export interface CompatibleProvider {
  readonly provider: string;
  /** Model name patterns: a literal, or a prefix ending in `*`. */
  readonly models: readonly string[];
  /** Chosen when the policy allows this provider and names no model for it. */
  readonly defaultModel?: string;
  readonly authentication: RouteAuthentication;
  /** The program that makes this pair routable. Absent when it already is. */
  readonly availableFrom?: string;
}

export interface HarnessCompatibility {
  readonly harness: string;
  readonly providers: readonly CompatibleProvider[];
}

export const HARNESS_COMPATIBILITY: readonly HarnessCompatibility[] = [
  {
    harness: "claude",
    providers: [
      {
        provider: "anthropic",
        models: ["claude-*", "opus", "sonnet", "haiku"],
        defaultModel: "claude-sonnet-5",
        authentication: "operator-login",
      },
      {
        provider: "bedrock",
        models: ["anthropic.*", "*.anthropic.*"],
        authentication: "instance-role",
        availableFrom: "P10",
      },
    ],
  },
  {
    harness: "codex",
    providers: [
      {
        provider: "openai",
        models: ["gpt-*", "o1*", "o3*", "o4*", "codex-*"],
        defaultModel: "gpt-5.5",
        authentication: "operator-login",
      },
    ],
  },
  {
    // The row P10 implements. Its shape is fixed here; its adapter is not written.
    harness: "agentcore",
    providers: [
      {
        provider: "bedrock",
        models: ["*"],
        authentication: "instance-role",
        availableFrom: "P10",
      },
    ],
  },
];

export const KNOWN_HARNESSES: readonly string[] = HARNESS_COMPATIBILITY.map((row) => row.harness);

/** Whether `model` matches a pattern: a literal, or a prefix ending in `*`. */
export const matchesModelPattern = (pattern: string, model: string): boolean => {
  if (!pattern.includes("*")) return pattern === model;
  const parts = pattern.split("*");
  let at = 0;
  for (const [index, part] of parts.entries()) {
    if (part === "") continue;
    const found = index === 0 ? (model.startsWith(part) ? 0 : -1) : model.indexOf(part, at);
    if (found < 0) return false;
    at = found + part.length;
  }
  const last = parts.at(-1) ?? "";
  return last === "" || model.endsWith(last);
};

export const canRunModel = (pair: CompatibleProvider, model: string): boolean =>
  pair.models.some((pattern) => matchesModelPattern(pattern, model));

/** Every `(harness, provider)` pair in the table, in table order. */
export const compatiblePairs = (): readonly (CompatibleProvider & { readonly harness: string })[] =>
  HARNESS_COMPATIBILITY.flatMap((row) =>
    row.providers.map((pair) => ({ harness: row.harness, ...pair })),
  );
