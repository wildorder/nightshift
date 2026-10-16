/**
 * The forecast as the gate-health record keeps it (P17, D-P17-07), and back:
 * what `nightshift gates --record` writes, and what the report reads to place
 * the forecast beside the actuals and re-price the recommendations.
 */
import type { VerificationForecast } from "@nightshift/contracts";
import { signatureLines } from "./catalogue.js";
import type { VerificationPlan } from "./model.js";
import type { ResolvedCommand } from "./resolve.js";

/** The plan and what its commands resolved to, as the record keeps them. */
export const toForecastRecord = (
  plan: VerificationPlan,
  resolved: ReadonlyMap<string, ResolvedCommand>,
  machine: string,
): VerificationForecast => ({
  machine,
  landings: plan.landings.count,
  steps: plan.steps.flatMap((step) => {
    if (step.measured === undefined) return [];
    const evidence = signatureLines(resolved.get(step.id)?.lines ?? []);
    return [
      {
        id: step.id,
        kind: step.kind,
        durationMs: step.measured.durationMs,
        quietMs: step.measured.quietMs,
        ...(step.measured.seeded === true ? { seeded: true } : {}),
        ...(evidence.length === 0 ? {} : { evidence: [...evidence] }),
      },
    ];
  }),
});

/** The evidence a record kept, in the shape the catalogue reads. */
export const resolvedFromRecord = (
  forecast: VerificationForecast | undefined,
): Map<string, ResolvedCommand> =>
  new Map(
    (forecast?.steps ?? []).flatMap((step) =>
      step.evidence === undefined
        ? []
        : [
            [
              step.id,
              { stepId: step.id, command: "", lines: [...step.evidence], unresolved: [] },
            ] as const,
          ],
    ),
  );
