/**
 * Progressive disclosure (P20, US-05): the breakdowns that would crowd the
 * overview. Each is a collapsible section; none is open by default. Request
 * evidence artifacts are only linked, through the signed download route, and
 * never fetched to draw anything.
 */
import type { AttemptRow, RunReport, RunScope } from "@nightshift/core";
import { filterAttempts } from "@nightshift/core";
import { ChevronDown } from "lucide-react";
import { Link } from "react-router";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  compactCount,
  exactCount,
  groupAttempts,
  NOT_OBSERVED,
  spanText,
} from "../../../lib/overview.js";
import { VerificationTime } from "../gate-health.js";
import { ArtifactLink } from "../parts.js";
import { workHref } from "./links.js";

export interface AttemptFilterState {
  readonly role: string;
  readonly model: string;
  /** "": the whole run; otherwise the attempts that started in that half of its window. */
  readonly half: "" | "first" | "second";
}

const Section = ({
  title,
  hint,
  children,
}: {
  readonly title: string;
  readonly hint: string;
  readonly children: React.ReactNode;
}) => (
  <Collapsible className="rounded-lg border border-border">
    <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 p-3 text-left text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <span>
        {title} <span className="font-normal text-muted-foreground">— {hint}</span>
      </span>
      <ChevronDown className="size-4 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
    </CollapsibleTrigger>
    <CollapsibleContent className="overflow-x-auto border-t border-border p-3">
      {children}
    </CollapsibleContent>
  </Collapsible>
);

const selectClass =
  "h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring";

export const Details = ({
  report,
  rows,
  scope,
  nodeLabels,
  filter,
  onFilter,
  window,
}: {
  readonly window: { readonly from: string; readonly to: string };
  readonly report: RunReport;
  readonly rows: readonly AttemptRow[];
  readonly scope: RunScope;
  readonly nodeLabels: ReadonlyMap<string, string>;
  readonly filter: AttemptFilterState;
  readonly onFilter: (next: AttemptFilterState) => void;
}) => {
  const byModel = groupAttempts(rows, (row) => row.model, "model unknown");
  const roles = [...new Set(rows.map((row) => row.role).filter((role) => role !== null))].sort();
  const models = [...new Set(rows.map((row) => row.model))].sort();
  const middle = new Date((Date.parse(window.from) + Date.parse(window.to)) / 2).toISOString();
  const filtered = filterAttempts(rows, {
    ...(filter.role === "" ? {} : { role: filter.role }),
    ...(filter.model === "" ? {} : { model: filter.model }),
    ...(filter.half === "first" ? { from: window.from, to: middle } : {}),
    ...(filter.half === "second" ? { from: middle } : {}),
  });
  const withLedger = rows.filter((row) => row.ledgerArtifactIds.length > 0);
  const labelOf = (nodeId: string): string => nodeLabels.get(nodeId) ?? nodeId.slice(-8);

  return (
    <div className="grid gap-2">
      <Section title="Model, cache and context" hint="tokens by model, cache reads and writes">
        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">{NOT_OBSERVED}: no attempts recorded.</p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="p-1">Model</th>
                <th className="p-1">Attempts</th>
                <th className="p-1">Input (incl. cache)</th>
                <th className="p-1">Output</th>
                <th className="p-1">Cache read</th>
                <th className="p-1">Cache write</th>
                <th className="p-1">Reasoning</th>
              </tr>
            </thead>
            <tbody>
              {byModel.map((group) => (
                <tr key={group.key} className="border-t border-border">
                  <td className="p-1 font-mono">{group.label}</td>
                  <td className="p-1">{group.consumed.attempts}</td>
                  <td className="p-1 tabular-nums">{exactCount(group.consumed.input)}</td>
                  <td className="p-1 tabular-nums">{exactCount(group.consumed.output)}</td>
                  <td className="p-1 tabular-nums">{exactCount(group.consumed.cacheRead)}</td>
                  <td className="p-1 tabular-nums">{exactCount(group.consumed.cacheWrite)}</td>
                  <td className="p-1 tabular-nums">{exactCount(group.consumed.reasoning)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          Context-window sizes are kept in each attempt's request evidence, which this page links
          but does not download.
        </p>
      </Section>

      <Section title="Attempts" hint="role, model and time; agent time vs settlement time">
        <div className="mb-2 flex flex-wrap items-center gap-3 text-xs">
          <label className="flex items-center gap-1.5">
            Role
            <select
              className={selectClass}
              value={filter.role}
              onChange={(event) => onFilter({ ...filter, role: event.target.value })}
            >
              <option value="">All roles</option>
              {roles.map((role) => (
                <option key={role} value={role as string}>
                  {role}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            Model
            <select
              className={selectClass}
              value={filter.model}
              onChange={(event) => onFilter({ ...filter, model: event.target.value })}
            >
              <option value="">All models</option>
              {models.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5">
            Time
            <select
              className={selectClass}
              value={filter.half}
              onChange={(event) =>
                onFilter({ ...filter, half: event.target.value as AttemptFilterState["half"] })
              }
            >
              <option value="">Whole run</option>
              <option value="first">First half of the run</option>
              <option value="second">Second half of the run</option>
            </select>
          </label>
          <span data-testid="attempt-sample">
            Showing {filtered.sampleSize.matched} of {filtered.sampleSize.total} attempts
          </span>
        </div>
        <table className="w-full text-xs" data-testid="attempt-table">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="p-1">Node</th>
              <th className="p-1">Role</th>
              <th className="p-1">Model</th>
              <th className="p-1">Attempt</th>
              <th className="p-1">Outcome</th>
              <th className="p-1">Agent time</th>
              <th className="p-1">Settlement time</th>
              <th className="p-1">Tokens in / out</th>
              <th className="p-1">Coverage</th>
            </tr>
          </thead>
          <tbody>
            {filtered.rows.map((row) => (
              <tr
                key={`${row.nodeId}/${row.routingDecisionId ?? "root"}/${row.measurementSummaryId ?? ""}`}
                className="border-t border-border"
              >
                <td className="p-1">
                  <Link className="underline" to={workHref(scope, row.nodeId)}>
                    {labelOf(row.nodeId)}
                  </Link>
                </td>
                <td className="p-1">{row.role ?? "unknown"}</td>
                <td className="p-1 font-mono">{row.model}</td>
                <td className="p-1">
                  {row.attempt}
                  {row.purpose === "work" ? "" : ` (${row.purpose})`}
                </td>
                <td className="p-1">{row.outcome ?? NOT_OBSERVED}</td>
                <td className="p-1">{spanText(row.agentMs)}</td>
                <td className="p-1">{spanText(row.settlementMs)}</td>
                <td className="p-1 tabular-nums">
                  {compactCount(row.resources.tokens.input)} /{" "}
                  {compactCount(row.resources.tokens.output)}
                </td>
                <td className="p-1">{row.coverage}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-muted-foreground">
          Agent time is the harness's own execution; settlement time runs until the node settled,
          and includes verification, queueing and integration.
        </p>
      </Section>

      <Section title="Request evidence" hint="per-request ledgers kept as artifacts">
        {withLedger.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {NOT_OBSERVED}: no attempt recorded request evidence (attempts before measurement, or
            summaries whose ledger was not kept).
          </p>
        ) : (
          <ul className="grid gap-1 text-xs">
            {withLedger.map((row) => (
              <li
                key={`${row.nodeId}/${row.measurementSummaryId}`}
                className="flex flex-wrap gap-2"
              >
                <span>
                  {labelOf(row.nodeId)} · {row.role ?? "unknown"} · {row.model} · attempt{" "}
                  {row.attempt}:
                </span>
                {row.ledgerArtifactIds.map((id, index) => (
                  <ArtifactLink key={id} artifactId={id} label={`request ledger ${index + 1}`} />
                ))}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Verification time" hint="where the gates' time went">
        {report.gateHealth.verificationTime.verifications === 0 ? (
          <p className="text-xs text-muted-foreground">
            {NOT_OBSERVED}: no verification is recorded for this run.
          </p>
        ) : (
          <div className="text-sm">
            <VerificationTime time={report.gateHealth.verificationTime} />
          </div>
        )}
      </Section>
    </div>
  );
};
