/**
 * Where the run's time went, one row per node (P20, US-05). The picture is an
 * SVG with a name and a text twin; the segments a person can press are real
 * buttons laid over it. Intervals are drawn as observed and never summed:
 * overlapping work shares the row in lanes. An interval never observed to end
 * is drawn to the report's as-of time and says so.
 */
import type { RunReport } from "@nightshift/core";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  clockText,
  type DrawnInterval,
  elapsedOf,
  hasObservedOperations,
  intervalLabel,
  metricOfPhase,
  NOT_OBSERVED,
  PHASE_GROUPS,
  type PhaseGroup,
  spanText,
  timelineOf,
} from "../../../lib/overview.js";
import type { Selection } from "./selection.js";

const WIDTH = 960;
const LABEL_W = 190;
const RIGHT = 14;
const AXIS_H = 26;
const LANE_H = 20;
const ROW_PAD = 10;

/** Chart tokens per phase group; the waiting bar is lighter so its label reads over it. */
const FILL: Readonly<Record<PhaseGroup, string>> = {
  work: "fill-chart-1",
  wait: "fill-chart-2",
  queue: "fill-chart-3",
  integration: "fill-chart-4",
  examination: "fill-chart-5",
  other: "fill-muted-foreground",
};
const SWATCH: Readonly<Record<PhaseGroup, string>> = {
  work: "bg-chart-1",
  wait: "bg-chart-2/40 border border-chart-2",
  queue: "bg-chart-3",
  integration: "bg-chart-4",
  examination: "bg-chart-5",
  other: "bg-muted-foreground/60",
};
const GROUP_WORD: Readonly<Record<PhaseGroup, string>> = {
  work: "work",
  wait: "wait",
  queue: "queue",
  integration: "integration",
  examination: "examination, answer, arbitration",
  other: "provisioning, startup, setup",
};

export const Timeline = ({
  report,
  nodeLabels,
  selected,
  onSelect,
}: {
  readonly report: RunReport;
  readonly nodeLabels: ReadonlyMap<string, string>;
  readonly selected: string | undefined;
  readonly onSelect: (selection: Selection) => void;
}) => {
  const [asText, setAsText] = useState(false);
  const operations = report.operations;
  const model = timelineOf(operations);
  const elapsed = elapsedOf(report);
  const labelOf = (nodeId: string): string => nodeLabels.get(nodeId) ?? `node ${nodeId.slice(-8)}`;

  if (!hasObservedOperations(operations)) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="timeline-empty">
        Time by node: {NOT_OBSERVED}. This run recorded no lifecycle observations (it predates them,
        or its machine did not report them), so no interval can be drawn and waiting, queueing and
        integration time are unknown, not zero.
        {operations.legacyWorkMs > 0
          ? ` Agents were running for ${spanText(operations.legacyWorkMs)} by their own start and end times.`
          : ""}
      </p>
    );
  }

  const plotW = WIDTH - LABEL_W - RIGHT;
  const x = (at: number): number => LABEL_W + ((at - model.from) / (model.to - model.from)) * plotW;
  let y = AXIS_H;
  const rowTop = new Map<string, { top: number; height: number }>();
  for (const row of model.rows) {
    const height = row.lanes * LANE_H + ROW_PAD;
    rowTop.set(row.nodeId, { top: y, height });
    y += height;
  }
  const height = y + 4;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => model.from + f * (model.to - model.from));
  const drawn = model.intervals.filter((iv) => iv.from !== undefined && iv.to !== undefined);
  const geometry = (iv: DrawnInterval) => {
    const row = rowTop.get(iv.nodeId) as { top: number; height: number };
    const left = x(iv.from as number);
    const right = x(iv.to as number);
    return {
      left,
      width: Math.max(4, right - left),
      top: row.top + ROW_PAD / 2 + iv.lane * LANE_H,
      height: LANE_H - 4,
    };
  };
  const summary = `Timeline of ${model.rows.length} node${model.rows.length === 1 ? "" : "s"}: ${model.rows
    .map((row) => labelOf(row.nodeId))
    .join(", ")}. ${elapsed.live ? "Elapsed so far" : "Total elapsed"} ${spanText(elapsed.ms)}.`;
  const withBlockers = Object.entries(operations.unions.waitByBlockerKind);

  return (
    <div className="grid gap-3" data-testid="timeline-chart">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        {PHASE_GROUPS.map((group) => (
          <span key={group} className="inline-flex items-center gap-1.5">
            <span
              className={`inline-block size-3 rounded-sm ${SWATCH[group]}`}
              aria-hidden="true"
            />
            {GROUP_WORD[group]}
          </span>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="ml-auto"
          aria-pressed={asText}
          onClick={() => setAsText((current) => !current)}
        >
          {asText ? "Hide text" : "Show as text"}
        </Button>
      </div>

      <div className="overflow-x-auto">
        <div className="relative min-w-[720px]">
          <svg
            viewBox={`0 0 ${WIDTH} ${height}`}
            className="block h-auto w-full"
            role="img"
            aria-label={summary}
          >
            {ticks.map((tick) => (
              <g key={tick}>
                <line
                  x1={x(tick)}
                  x2={x(tick)}
                  y1={AXIS_H - 4}
                  y2={height}
                  className="stroke-border"
                  strokeWidth={1}
                />
                <text
                  x={x(tick)}
                  y={14}
                  textAnchor={tick === ticks[ticks.length - 1] ? "end" : "middle"}
                  className="fill-muted-foreground"
                  fontSize={12}
                >
                  {clockText(new Date(tick).toISOString())}
                </text>
              </g>
            ))}
            {model.rows.map((row) => {
              const place = rowTop.get(row.nodeId) as { top: number; height: number };
              return (
                <g key={row.nodeId}>
                  <line
                    x1={0}
                    x2={WIDTH}
                    y1={place.top}
                    y2={place.top}
                    className="stroke-border"
                    strokeWidth={1}
                  />
                  <text
                    x={4}
                    y={place.top + place.height / 2 + 4}
                    className="fill-foreground"
                    fontSize={13}
                  >
                    {labelOf(row.nodeId).slice(0, 26)}
                  </text>
                </g>
              );
            })}
            {drawn.map((iv) => {
              const g = geometry(iv);
              const waiting = iv.group === "wait";
              return (
                <g key={iv.id}>
                  <rect
                    x={g.left}
                    y={g.top}
                    width={g.width}
                    height={g.height}
                    rx={3}
                    className={`${FILL[iv.group]} ${waiting ? "stroke-chart-2" : ""}`}
                    fillOpacity={waiting ? 0.35 : iv.group === "other" ? 0.6 : 1}
                    strokeDasharray={iv.open ? "5 3" : undefined}
                    strokeWidth={waiting || iv.open ? 1.5 : 0}
                  />
                  {waiting && iv.blockers.length > 0 && g.width > 110 ? (
                    <text
                      x={g.left + 6}
                      y={g.top + g.height - 5}
                      className="fill-foreground"
                      fontSize={11}
                    >
                      waits on {iv.blockers[0]}
                      {iv.blockers.length > 1 ? ` +${iv.blockers.length - 1}` : ""}
                    </text>
                  ) : null}
                </g>
              );
            })}
            {elapsed.live ? (
              <g>
                <line
                  x1={x(model.asOf)}
                  x2={x(model.asOf)}
                  y1={AXIS_H - 4}
                  y2={height}
                  className="stroke-foreground"
                  strokeWidth={1.5}
                  strokeDasharray="3 3"
                />
                <text
                  x={x(model.asOf) - 4}
                  y={AXIS_H - 8}
                  textAnchor="end"
                  className="fill-foreground"
                  fontSize={11}
                >
                  as of
                </text>
              </g>
            ) : null}
          </svg>
          {drawn.map((iv) => {
            const g = geometry(iv);
            const key = `interval:${iv.id}`;
            return (
              <button
                key={iv.id}
                type="button"
                aria-label={`${labelOf(iv.nodeId)}: ${intervalLabel(iv)}`}
                aria-pressed={selected === key}
                onClick={() =>
                  onSelect({
                    key,
                    title: `${labelOf(iv.nodeId)}: ${iv.phase}`,
                    metrics: [metricOfPhase(iv.phase)],
                    scope: { kind: "interval", id: iv.id },
                  })
                }
                className="absolute rounded-sm outline-none hover:ring-2 hover:ring-ring focus-visible:ring-2 focus-visible:ring-ring aria-pressed:ring-2 aria-pressed:ring-foreground"
                style={{
                  left: `${(g.left / WIDTH) * 100}%`,
                  top: `${(g.top / height) * 100}%`,
                  width: `${(g.width / WIDTH) * 100}%`,
                  height: `${(g.height / height) * 100}%`,
                }}
              />
            );
          })}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Each bar is one observed interval; overlapping work shares a row and is never summed. Total
        elapsed {spanText(elapsed.ms)}
        {elapsed.live ? " so far" : ""}; wait {spanText(operations.unions.wait)}
        {withBlockers.length === 0
          ? ""
          : ` (${withBlockers.map(([kind, ms]) => `${kind} ${spanText(ms)}`).join(", ")})`}
        ; work {spanText(operations.unions.work)}, queue {spanText(operations.unions.queue)},
        integration {spanText(operations.unions.integration)}, examination{" "}
        {spanText(operations.unions.examination)} — each the union of its intervals, so overlapping
        time counts once.
        {elapsed.live ? " Dashed bars are still open and are drawn to the as-of time." : ""}
      </p>

      {asText ? (
        <div className="overflow-x-auto">
          <table className="w-full text-xs" data-testid="timeline-text">
            <caption className="sr-only">Every observed interval</caption>
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="p-1">Node</th>
                <th className="p-1">Phase</th>
                <th className="p-1">Start</th>
                <th className="p-1">End</th>
                <th className="p-1">Duration</th>
                <th className="p-1">Blockers</th>
              </tr>
            </thead>
            <tbody>
              {model.intervals.map((iv) => (
                <tr key={iv.id} className="border-t border-border">
                  <td className="p-1">{labelOf(iv.nodeId)}</td>
                  <td className="p-1">{iv.phase}</td>
                  <td className="p-1 font-mono">
                    {iv.startedAt === undefined ? NOT_OBSERVED : clockText(iv.startedAt)}
                  </td>
                  <td className="p-1 font-mono">
                    {iv.endedAt !== undefined
                      ? clockText(iv.endedAt)
                      : iv.open
                        ? "still open"
                        : NOT_OBSERVED}
                  </td>
                  <td className="p-1">
                    {iv.durationMs !== undefined
                      ? spanText(iv.durationMs)
                      : iv.from !== undefined && iv.to !== undefined
                        ? `${spanText(iv.to - iv.from)} so far`
                        : NOT_OBSERVED}
                  </td>
                  <td className="p-1">
                    {iv.blockers.length === 0 ? "none" : iv.blockers.join(", ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
};
