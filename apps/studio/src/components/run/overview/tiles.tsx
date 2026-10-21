/**
 * The four headline summaries (P20, US-05), each a button that opens the
 * evidence behind it. No score and no arrow: a figure, its denominator and the
 * evidence it stands on. Tokens and dollars are separate lines and never share
 * a scale; a missing figure reads "not observed", never 0 and never in a
 * success tone.
 */
import type { AttemptRow, RunReport } from "@nightshift/core";
import {
  type BudgetSpend,
  budgetGapText,
  compactCount,
  consumptionOf,
  dollarsText,
  elapsedOf,
  hasObservedOperations,
  NOT_OBSERVED,
  percentText,
  spanText,
  tokensCoverageText,
  tokenTotalOf,
  totalsTokens,
  valuedText,
} from "../../../lib/overview.js";
import { type Selection, TILE_SELECTIONS, type TileId } from "./selection.js";

const Tile = ({
  id,
  label,
  selected,
  onSelect,
  children,
}: {
  readonly id: TileId;
  readonly label: string;
  readonly selected: boolean;
  readonly onSelect: (selection: Selection) => void;
  readonly children: React.ReactNode;
}) => (
  <button
    type="button"
    aria-pressed={selected}
    data-tile={id}
    onClick={() => onSelect(TILE_SELECTIONS[id])}
    className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-card p-4 text-left text-card-foreground shadow-xs outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring aria-pressed:border-ring aria-pressed:ring-1 aria-pressed:ring-ring"
  >
    <span className="text-sm font-medium text-muted-foreground">{label}</span>
    {children}
  </button>
);

const Big = ({ children }: { readonly children: React.ReactNode }) => (
  <span className="text-2xl leading-tight font-semibold tabular-nums">{children}</span>
);

const Line = ({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) => (
  <span className="block text-xs text-muted-foreground">
    <span className="font-medium text-foreground">{label}</span> {children}
  </span>
);

const OUTCOME_WORDS: Readonly<Record<string, string>> = {
  landed: "landed",
  merged_strand_not_landed: "merged, strand not landed",
  failed: "failed",
  cancelled: "cancelled",
  interrupted: "interrupted",
  verification_failed: "failed verification",
  examination_failed: "failed examination",
  unfinished: "unfinished",
};

export const Tiles = ({
  report,
  rows,
  spend,
  attemptsReady,
  selected,
  onSelect,
}: {
  readonly report: RunReport;
  readonly rows: readonly AttemptRow[] | undefined;
  readonly spend: BudgetSpend | undefined;
  readonly attemptsReady: boolean;
  readonly selected: string | undefined;
  readonly onSelect: (selection: Selection) => void;
}) => {
  const first = report.delivery.firstAttempt;
  const outcomes = Object.entries(report.delivery.outcomes.counts)
    .filter(([kind, count]) => count > 0 && kind !== "unfinished")
    .map(([kind, count]) => `${count} ${OUTCOME_WORDS[kind] ?? kind}`);

  const elapsed = elapsedOf(report);
  const waitShare =
    !hasObservedOperations(report.operations) || elapsed.ms === 0
      ? NOT_OBSERVED
      : `${percentText(report.operations.unions.wait, elapsed.ms)} of elapsed (waiting is not work)`;

  const consumed = rows === undefined ? undefined : consumptionOf(rows);
  const machine = report.infrastructure?.components.total;

  const rework = report.delivery.rework;
  const reworkTokens = totalsTokens(rework.resources.rework);
  const firstTokens = totalsTokens(rework.resources.firstAttempts);
  const share =
    reworkTokens === undefined || firstTokens === undefined || reworkTokens + firstTokens === 0
      ? NOT_OBSERVED
      : `${percentText(reworkTokens, reworkTokens + firstTokens)} of work-attempt tokens`;
  const dispositions = report.review.dispositions;
  const dispositionText = Object.entries(dispositions.byLatest)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${count} ${kind.replace("_", " ")}`)
    .join(", ");

  return (
    <fieldset
      className="m-0 grid min-w-0 gap-3 border-0 p-0 sm:grid-cols-2 xl:grid-cols-4"
      aria-label="Headline summaries for this run"
    >
      <Tile
        id="delivered"
        label="Delivered"
        selected={selected === "tile:delivered"}
        onSelect={onSelect}
      >
        {first.denominator === 0 ? (
          <Big>none settled yet</Big>
        ) : (
          <Big>
            {first.succeeded} of {first.denominator}
          </Big>
        )}
        <Line label="First-attempt success:">
          {first.denominator === 0
            ? "no job has settled"
            : `${first.succeeded} of ${first.denominator} settled jobs`}
          {first.coverage === "partial" ? " (partial coverage)" : ""}
        </Line>
        <Line label="Unfinished:">{first.unfinished} jobs, not in the denominator</Line>
        <Line label="Outcomes:">{outcomes.length === 0 ? "none yet" : outcomes.join(", ")}</Line>
      </Tile>

      <Tile id="time" label="Time" selected={selected === "tile:time"} onSelect={onSelect}>
        <Big>
          {spanText(elapsed.ms)}
          {elapsed.live ? " so far" : ""}
        </Big>
        <Line label="Elapsed completion time:">
          {elapsed.live ? "to the report's as-of time" : "start of run to its end"}
        </Line>
        <Line label="Wait share:">{waitShare}</Line>
      </Tile>

      <Tile
        id="consumed"
        label="Consumed"
        selected={selected === "tile:consumed"}
        onSelect={onSelect}
      >
        {consumed === undefined ? (
          <Big>{attemptsReady ? NOT_OBSERVED : "reading attempts…"}</Big>
        ) : consumed.input === undefined && consumed.output === undefined ? (
          <Big>{NOT_OBSERVED}</Big>
        ) : (
          <span className="grid gap-1">
            <span className="flex items-baseline gap-2">
              <Big>{compactCount(consumed.input)}</Big>
              <span className="text-xs text-muted-foreground">input tokens (incl. cache)</span>
            </span>
            <span className="flex items-baseline gap-2">
              <Big>{compactCount(consumed.output)}</Big>
              <span className="text-xs text-muted-foreground">output tokens</span>
            </span>
          </span>
        )}
        {consumed === undefined || tokenTotalOf(consumed)?.partial !== true ? null : (
          <Line label="Token total:">
            at least {compactCount(tokenTotalOf(consumed)?.value)} tokens (partial: an attempt
            reported only input or only output)
          </Line>
        )}
        {consumed === undefined ? null : (
          <Line label="Token coverage:">{tokensCoverageText(consumed)}</Line>
        )}
        <span className="block border-t border-border pt-2" />
        <Line label="API-equivalent estimate:">
          {consumed === undefined
            ? NOT_OBSERVED
            : `${dollarsText(consumed.estimatedUsd)} · ${valuedText(consumed.estimateValued, consumed.attempts, consumed.estimateIncomplete)}`}
        </Line>
        <Line label="Machine estimate:">
          {machine === undefined
            ? `${NOT_OBSERVED} (no machine recorded for this run)`
            : `${dollarsText(machine.usd)} · from the machine's recorded lifetime`}
        </Line>
        {spend === undefined || !spend.evaluation.configured || spend.evaluation.complete ? null : (
          <Line label="Budget:">
            cannot be evaluated completely: {budgetGapText(spend.evaluation)}
          </Line>
        )}
      </Tile>

      <Tile
        id="review"
        label="Repair and review"
        selected={selected === "tile:review"}
        onSelect={onSelect}
      >
        <Big>
          {rework.attempts} rework attempt{rework.attempts === 1 ? "" : "s"}
        </Big>
        <Line label="Resources:">{share}</Line>
        <Line label="Findings:">
          {report.review.findings.length === 0
            ? "none raised"
            : `${report.review.findings.length} unique${dispositionText === "" ? "" : ` — ${dispositionText}`}`}
        </Line>
        <Line label="Read with care:">association with rework is not causation</Line>
      </Tile>
    </fieldset>
  );
};
