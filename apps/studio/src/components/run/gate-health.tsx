/**
 * Gate health on the run's Status tab (P15, D-P15-09, SC-P15-09): the same
 * `RunReport.gateHealth` that `nightshift report` renders. The project's audit,
 * whether the run started red, each repair with the decision it was made under
 * and the gate definitions it landed, and each check that flaked.
 */
import type { GateHealthReport, RepairReport, RunScope } from "@nightshift/core";
import { Link } from "react-router";
import { shortId, shortSha, when } from "../../lib/format.js";
import { StatusBadge } from "../status-badge.js";

const CAUSE_WORD: Readonly<Record<RepairReport["cause"], string>> = {
  red_base: "red base",
  flaky: "flaky",
};

const isEmpty = ({ audit, red, repairs, flakes }: GateHealthReport): boolean =>
  audit === undefined && red === undefined && repairs.length === 0 && flakes.length === 0;

const Steps = ({
  title,
  steps,
}: {
  readonly title: string;
  readonly steps: readonly { readonly id: string; readonly command: string }[];
}) => (
  <div>
    <p className="text-xs text-muted-foreground">{title}</p>
    <ul className="ml-4 list-disc font-mono text-xs">
      {steps.map((step) => (
        <li key={step.id}>
          {step.id}: <code>{step.command}</code>
        </li>
      ))}
    </ul>
  </div>
);

const Repair = ({ repair, scope }: { readonly repair: RepairReport; readonly scope: RunScope }) => (
  <li className="rounded-lg border border-border p-2 text-sm" data-repair={repair.jobContractId}>
    <div className="flex flex-wrap items-baseline gap-2">
      <StatusBadge status={repair.status} />
      <span className="font-medium">
        Repair ({CAUSE_WORD[repair.cause]}) of {repair.gates.join(", ")}
      </span>
      <span className="font-mono text-xs text-muted-foreground">
        {shortId(repair.jobContractId)}
      </span>
    </div>
    <p className="text-muted-foreground">{repair.objective}</p>
    {repair.decision === undefined ? (
      <p className="text-xs text-muted-foreground">Decision: not on the record.</p>
    ) : (
      <p>
        Decision:{" "}
        <Link
          to={`/projects/${scope.projectId}/programs/${scope.programId}/runs/${scope.runId}/decisions/${repair.decision.decisionId}`}
          className="font-medium underline"
        >
          {repair.decision.choice}
        </Link>
        <span className="block text-muted-foreground">{repair.decision.rationale}</span>
      </p>
    )}
    {repair.definitionsChanged ? (
      <div className="mt-1 grid gap-1">
        <p className="text-xs font-medium">New gate definitions; later verifications use them</p>
        {repair.setup === undefined ? null : <Steps title="Setup" steps={repair.setup} />}
        {repair.verification === undefined ? null : (
          <Steps title="Verification" steps={repair.verification} />
        )}
      </div>
    ) : null}
  </li>
);

export const GateHealthView = ({
  gateHealth,
  scope,
}: {
  readonly gateHealth: GateHealthReport;
  readonly scope: RunScope;
}) => {
  if (isEmpty(gateHealth)) {
    return (
      <p className="text-sm text-muted-foreground">
        No gate-health record, no red base, no repairs and no flakes.
      </p>
    );
  }
  const { audit, red, repairs, flakes } = gateHealth;
  return (
    <div className="grid gap-3 text-sm">
      {audit === undefined ? (
        <p className="text-muted-foreground">Audit: no gate-health record for this project.</p>
      ) : (
        <div>
          <p className="flex flex-wrap items-baseline gap-2">
            Audit: <StatusBadge status={audit.verdict} /> at <code>{shortSha(audit.commit)}</code>
            <span className="text-xs text-muted-foreground">{when(audit.auditedAt)}</span>
          </p>
          {audit.findings.length === 0 ? null : (
            <ul className="ml-4 list-disc">
              {audit.findings.map((finding) => (
                <li key={finding.id}>
                  <span className="font-medium">{finding.id}</span> (rule {finding.rule}):{" "}
                  {finding.found}{" "}
                  <span className="text-muted-foreground">— decided by {finding.decisionId}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {red === undefined ? null : (
        <p className="text-status-danger-foreground">
          The base was red: {red.failing.join(", ")} failed on{" "}
          <code>{shortSha(red.baseCommit)}</code>, so the run repaired it before the strands.
        </p>
      )}
      {repairs.length === 0 ? null : (
        <div>
          <h3 className="mb-1 font-medium">Repairs</h3>
          <ul className="grid gap-2">
            {repairs.map((repair) => (
              <Repair key={repair.jobContractId} repair={repair} scope={scope} />
            ))}
          </ul>
        </div>
      )}
      {flakes.length === 0 ? null : (
        <div>
          <h3 className="mb-1 font-medium">Flakes</h3>
          <ul className="ml-4 list-disc">
            {flakes.map((flake) => (
              <li key={`${flake.verificationId}/${flake.stepId}`}>
                <code>{flake.stepId}</code> on job{" "}
                <span className="font-mono">{shortId(flake.jobContractId)}</span> at{" "}
                <code>{shortSha(flake.commitSha)}</code>
                <span className="text-muted-foreground">
                  {" "}
                  — first run exited {flake.firstExitCode}, the rerun passed
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};
