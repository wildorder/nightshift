/**
 * A program's status (P13, D-P13-09): what landed, what waits on you and why,
 * what failed, what it cost. The same component on a program's card (compact)
 * and at the top of the run's Status tab (full), from the same `programStatus`.
 */
import type { ProgramStatus, WaitingKind } from "@nightshift/core";
import { AlertTriangle, CheckCircle2, CircleDollarSign, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import { usd } from "../lib/format.js";
import { StatusBadge } from "./status-badge.js";

const KIND_STATUS: Readonly<Record<WaitingKind, string>> = {
  prerequisite: "needs you",
  finding: "findings_raised",
  failed: "failed",
  blocked: "blocked",
  provisional: "provisional",
};

const KIND_LABEL: Readonly<Record<WaitingKind, string>> = {
  prerequisite: "prerequisite",
  finding: "finding",
  failed: "failed",
  blocked: "blocked",
  provisional: "provisional",
};

const Stat = ({
  icon,
  label,
  value,
  emphasis = false,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly value: ReactNode;
  readonly emphasis?: boolean;
}) => (
  <div
    className={`flex items-center gap-2 ${emphasis ? "font-medium text-foreground" : "text-muted-foreground"}`}
  >
    {icon}
    <span className="text-foreground tabular-nums">{value}</span>
    <span>{label}</span>
  </div>
);

const spendText = (status: ProgramStatus): string => {
  const spent = `${status.spend.estimated ? "~" : ""}${usd(status.spend.usd)}`;
  const budget = status.spend.budgetUsd === undefined ? "" : ` of ${usd(status.spend.budgetUsd)}`;
  const unpriced = status.spend.unpriced > 0 ? `, ${status.spend.unpriced} unpriced` : "";
  return `${spent}${budget}${unpriced}`;
};

export const ProgramStatusSummary = ({
  status,
  compact = false,
}: {
  readonly status: ProgramStatus;
  readonly compact?: boolean;
}) => {
  const landed = `${status.jobs.landed}/${status.jobs.total}`;
  return (
    <div className="grid gap-3" data-testid="program-status">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        <StatusBadge status={status.runStatus} />
        <Stat
          icon={<CheckCircle2 className="size-4 text-status-success-foreground" />}
          value={landed}
          label="landed"
        />
        <Stat
          icon={<AlertTriangle className="size-4 text-status-warning-foreground" />}
          value={status.waiting.length}
          label="waiting on you"
          emphasis={status.waiting.length > 0}
        />
        <Stat
          icon={<XCircle className="size-4 text-status-danger-foreground" />}
          value={status.jobs.failed}
          label="failed"
        />
        <Stat icon={<CircleDollarSign className="size-4" />} value={spendText(status)} label="" />
      </div>
      {status.waiting.length === 0 ? null : (
        <ul className="grid gap-1.5">
          {(compact ? status.waiting.slice(0, 3) : status.waiting).map((item) => (
            <li key={`${item.kind}-${item.subject}`} className="flex items-baseline gap-2 text-sm">
              <StatusBadge status={KIND_STATUS[item.kind]} label={KIND_LABEL[item.kind]} />
              <span className="font-medium">{item.subject}</span>
              <span className="text-muted-foreground">{item.reason}</span>
            </li>
          ))}
          {compact && status.waiting.length > 3 ? (
            <li className="text-xs text-muted-foreground">and {status.waiting.length - 3} more</li>
          ) : null}
        </ul>
      )}
      {compact ? null : (
        <p className="text-xs text-muted-foreground">
          {status.strands.total > 0
            ? `${status.strands.succeeded} of ${status.strands.total} strands succeeded · `
            : ""}
          {status.jobs.retried} retried · {status.jobs.examined} examined by a second model
        </p>
      )}
    </div>
  );
};
