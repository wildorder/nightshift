/**
 * Additive bars (P20, US-05): tokens by role and by model on one scale of
 * tokens, and rework by cause on a scale of attempts. Each bar is labelled
 * directly with its figure, the parts add to the stated total, and dollars are
 * never drawn on these scales. A group with no observed counters has no bar and
 * says "not observed".
 */
import type { CompletionRework, RunReport } from "@nightshift/core";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  type BarGroup,
  compactCount,
  consumptionOf,
  exactCount,
  NOT_OBSERVED,
  tokensCoverageText,
  tokenTotalOf,
  totalsTokens,
} from "../../../lib/overview.js";
import type { Selection } from "./selection.js";

export interface Bar {
  readonly key: string;
  readonly label: string;
  /** Undefined draws no bar. */
  readonly value?: number;
  readonly valueText: string;
  readonly detail: string;
  readonly selection: Selection;
}

const SHADES = ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4", "bg-chart-5"] as const;

export const BarChart = ({
  title,
  unit,
  bars,
  totalText,
  selected,
  onSelect,
  color,
}: {
  readonly title: string;
  readonly unit: string;
  readonly bars: readonly Bar[];
  readonly totalText: string;
  readonly selected: string | undefined;
  readonly onSelect: (selection: Selection) => void;
  readonly color: number;
}) => {
  const [asText, setAsText] = useState(false);
  const [active, setActive] = useState(0);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const here = Math.min(active, Math.max(0, bars.length - 1));
  const onArrow = (event: React.KeyboardEvent, index: number) => {
    const target =
      event.key === "ArrowDown"
        ? Math.min(bars.length - 1, index + 1)
        : event.key === "ArrowUp"
          ? Math.max(0, index - 1)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? bars.length - 1
              : undefined;
    if (target === undefined) return;
    event.preventDefault();
    setActive(target);
    buttons.current[target]?.focus();
  };
  const max = Math.max(1, ...bars.map((bar) => bar.value ?? 0));
  return (
    <section className="grid gap-2" aria-label={title}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-pressed={asText}
          aria-label={`${asText ? "Hide text" : "Show as text"}: ${title}`}
          onClick={() => setAsText((current) => !current)}
        >
          {asText ? "Hide text" : "Show as text"}
        </Button>
      </div>
      {bars.length === 0 ? (
        <p className="text-xs text-muted-foreground">{NOT_OBSERVED}: nothing to draw.</p>
      ) : (
        <ul className="grid gap-1.5" aria-label={`${title}, bars in ${unit}`}>
          {bars.map((bar, index) => (
            <li key={bar.key}>
              <button
                type="button"
                ref={(el) => {
                  buttons.current[index] = el;
                }}
                tabIndex={index === here ? 0 : -1}
                onFocus={() => setActive(index)}
                onKeyDown={(event) => onArrow(event, index)}
                aria-pressed={selected === bar.selection.key}
                aria-label={`${bar.label}: ${bar.valueText}`}
                onClick={() => onSelect(bar.selection)}
                className="grid w-full gap-1 rounded-md p-1 text-left text-xs outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring aria-pressed:ring-2 aria-pressed:ring-foreground"
              >
                <span className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate font-medium" title={bar.label}>
                    {bar.label}
                  </span>
                  <span className="shrink-0 tabular-nums">{bar.valueText}</span>
                </span>
                <span className="block h-3 w-full rounded-sm bg-muted" aria-hidden="true">
                  {bar.value === undefined ? null : (
                    <span
                      className={`block h-3 rounded-sm ${SHADES[color % SHADES.length]}`}
                      style={{ width: `${Math.max(1, (bar.value / max) * 100)}%` }}
                    />
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground" data-testid="bar-total">
        {totalText}
      </p>
      {asText ? (
        <table className="w-full text-xs">
          <caption className="sr-only">{title} as text</caption>
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="p-1">Component</th>
              <th className="p-1">{unit}</th>
              <th className="p-1">Detail</th>
            </tr>
          </thead>
          <tbody>
            {bars.map((bar) => (
              <tr key={bar.key} className="border-t border-border">
                <td className="p-1">{bar.label}</td>
                <td className="p-1 tabular-nums">
                  {bar.value === undefined ? NOT_OBSERVED : exactCount(bar.value)}
                </td>
                <td className="p-1">{bar.detail}</td>
              </tr>
            ))}
            <tr className="border-t border-border font-medium">
              <td className="p-1">Total</td>
              <td className="p-1 tabular-nums" colSpan={2}>
                {totalText}
              </td>
            </tr>
          </tbody>
        </table>
      ) : null}
    </section>
  );
};

const tokenBars = (groups: readonly BarGroup[], kind: "role" | "model"): Bar[] =>
  groups.map((group) => ({
    key: `${kind}:${group.key}`,
    label: group.label,
    ...(group.tokens === undefined ? {} : { value: group.tokens }),
    valueText:
      group.tokens === undefined
        ? `${NOT_OBSERVED}`
        : `${group.tokensPartial === true ? "at least " : ""}${compactCount(group.tokens)} tokens`,
    detail: `${compactCount(group.consumed.input)} in (incl. cache), ${compactCount(group.consumed.output)} out; ${tokensCoverageText(group.consumed)}`,
    selection: {
      key: `bar:${kind}:${group.key}`,
      title: `${kind === "role" ? "Role" : "Model"}: ${group.label}`,
      metrics: ["tokens_input", "tokens_output"],
      scope:
        kind === "role" ? { kind: "role", value: group.key } : { kind: "model", value: group.key },
    },
  }));

const totalLine = (groups: readonly BarGroup[], noun: string): string => {
  const all = groups.flatMap((group) => group.rows);
  const consumed = consumptionOf(all);
  const total = tokenTotalOf(consumed);
  return total === undefined
    ? `Total: ${NOT_OBSERVED} (no attempt reported token counters)`
    : `Total: ${total.partial ? "at least " : ""}${exactCount(total.value)} tokens${total.partial ? " (partial: an attempt reported only input or only output)" : ""} (input incl. cache + output) across ${consumed.tokenAttempts} of ${consumed.attempts} attempts that reported tokens; the ${noun} add to this total`;
};

export const ResourceBars = ({
  byRole,
  byModel,
  selected,
  onSelect,
}: {
  readonly byRole: readonly BarGroup[];
  readonly byModel: readonly BarGroup[];
  readonly selected: string | undefined;
  readonly onSelect: (selection: Selection) => void;
}) => (
  <div className="grid gap-5">
    <BarChart
      title="Tokens by role"
      unit="tokens"
      bars={tokenBars(byRole, "role")}
      totalText={totalLine(byRole, "roles")}
      selected={selected}
      onSelect={onSelect}
      color={0}
    />
    <BarChart
      title="Tokens by model"
      unit="tokens"
      bars={tokenBars(byModel, "model")}
      totalText={totalLine(byModel, "models")}
      selected={selected}
      onSelect={onSelect}
      color={1}
    />
  </div>
);

export const ReworkBars = ({
  report,
  selected,
  onSelect,
}: {
  readonly report: RunReport;
  readonly selected: string | undefined;
  readonly onSelect: (selection: Selection) => void;
}) => {
  const rework = report.delivery.rework;
  const rows = [
    ...rework.byCause.map((row) => ({
      key: row.kind,
      label: row.kind.replaceAll("_", " "),
      attempts: row.attempts,
      tokens: totalsTokens(row.resources),
      shared: row.sharedAttempts,
    })),
    ...(rework.unknownCause.attempts > 0
      ? [
          {
            key: "unknown",
            label: "cause unknown",
            attempts: rework.unknownCause.attempts,
            tokens: totalsTokens(rework.unknownCause.resources),
            shared: 0,
          },
        ]
      : []),
  ];
  const bars: Bar[] = rows.map((row) => ({
    key: row.key,
    label: row.label,
    value: row.attempts,
    valueText: `${row.attempts} attempt${row.attempts === 1 ? "" : "s"}`,
    detail: `${compactCount(row.tokens)} tokens${row.tokens === undefined ? "" : " (input incl. cache + output)"}${row.shared > 0 ? `; ${row.shared} also counted under another cause` : ""}`,
    selection: {
      key: `bar:cause:${row.key}`,
      title: `Rework cause: ${row.label}`,
      metrics: ["rework_by_cause", "rework_attempts"],
      scope: { kind: "cause", value: row.key },
    },
  }));
  return (
    <BarChart
      title="Rework by cause"
      unit="attempts"
      bars={bars}
      totalText={`Total: ${rework.attempts} rework attempt${rework.attempts === 1 ? "" : "s"}, each counted once; an attempt with several causes appears under each, so the bars can add to more.`}
      selected={selected}
      onSelect={onSelect}
      color={2}
    />
  );
};

/** Rework by cause across a history's members; each attempt counted once, so the parts are additive. */
export const HistoryReworkBars = ({
  rework,
  onSelect,
}: {
  readonly rework: CompletionRework;
  readonly onSelect: (selection: Selection) => void;
}) => {
  const rows = [
    ...rework.byCause.map((row) => ({
      key: row.kind,
      label: row.kind.replaceAll("_", " "),
      attempts: row.attempts,
      cross: row.crossRunAttempts,
      shared: row.sharedAttempts,
    })),
    ...(rework.unknownCause > 0
      ? [
          {
            key: "unknown",
            label: "cause unknown",
            attempts: rework.unknownCause,
            cross: 0,
            shared: 0,
          },
        ]
      : []),
  ];
  const bars: Bar[] = rows.map((row) => ({
    key: row.key,
    label: row.label,
    value: row.attempts,
    valueText: `${row.attempts} attempt${row.attempts === 1 ? "" : "s"}`,
    detail: `${row.cross} from a later run re-attempting${row.shared > 0 ? `; ${row.shared} also counted under another cause` : ""}`,
    selection: {
      key: `history-bar:cause:${row.key}`,
      title: "Repair and review",
      metrics: ["rework_by_cause"],
      scope: { kind: "cause", value: row.key },
    },
  }));
  return (
    <BarChart
      title="Rework by cause"
      unit="attempts"
      bars={bars}
      totalText={`Total: ${rework.attempts} rework attempt${rework.attempts === 1 ? "" : "s"} across the member runs, each counted once (${rework.crossRunAttempts} from a later run re-attempting); an attempt with several causes appears under each, so the bars can add to more. Counts only; tokens and dollars are not drawn here.`}
      selected={undefined}
      onSelect={onSelect}
      color={2}
    />
  );
};
