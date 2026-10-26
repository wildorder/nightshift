/**
 * Gate health on the run's Status tab (P15, D-P15-09, SC-P15-09): the same
 * `RunReport.gateHealth` that `nightshift report` renders. The project's audit,
 * whether the run started red, an environment fault side by side (P16 D-07),
 * each repair with the decision it was made under
 * and the gate definitions it landed, and each check that flaked.
 */
import { type EnvironmentFaultPayload, VERIFICATION_PHASES } from "@nightshift/contracts";
import type {
  GateHealthReport,
  RepairReport,
  RunScope,
  VerificationTimeReport,
} from "@nightshift/core";
import { humanDuration } from "@nightshift/core";
import { Link } from "react-router";
import { shortId, shortSha, when } from "../../lib/format.js";
import { StatusBadge } from "../status-badge.js";

const CAUSE_WORD: Readonly<Record<RepairReport["cause"], string>> = {
  red_base: "red base",
  flaky: "flaky",
};

const isEmpty = ({
  audit,
  red,
  environmentFault,
  repairs,
  flakes,
  verificationTime,
}: GateHealthReport): boolean =>
  audit === undefined &&
  red === undefined &&
  environmentFault === undefined &&
  repairs.length === 0 &&
  flakes.length === 0 &&
  verificationTime.verifications === 0;

/**
 * Where the verification time went (P17, D-P17-07): each step's runs and total
 * by phase, the forecast's one run beside it, and what would save time.
 */
export const VerificationTime = ({ time }: { readonly time: VerificationTimeReport }) => {
  if (time.verifications === 0) return null;
  const forecast = time.forecast;
  return (
    <div data-verification-time="">
      <h3 className="mb-1 font-medium">Verification time</h3>
      <p className="mb-2">
        {humanDuration(time.totalMs)} across {time.verifications} verification
        {time.verifications === 1 ? "" : "s"} and {time.landings} landing
        {time.landings === 1 ? "" : "s"}
        {forecast === undefined ? null : (
          <span className="text-muted-foreground">
            {" "}
            — the forecast assumed {forecast.landings} landings at{" "}
            {humanDuration(forecast.landingMs)} each, ≈ {humanDuration(forecast.projectedMs)},
            measured on {forecast.machine}
          </span>
        )}
      </p>
      <table className="w-full text-left text-xs">
        <thead className="text-muted-foreground">
          <tr>
            <th className="p-1">Step</th>
            <th className="p-1">Runs</th>
            <th className="p-1">Total</th>
            <th className="p-1">Per run</th>
            <th className="p-1">Quiet start</th>
            <th className="p-1">Queue / candidate / end</th>
            <th className="p-1">Forecast per run</th>
          </tr>
        </thead>
        <tbody>
          {time.steps.map((step) => (
            <tr key={step.id}>
              <td className="p-1">
                <code>{step.id}</code>
              </td>
              <td className="p-1">{step.runs}</td>
              <td className="p-1">{humanDuration(step.totalMs)}</td>
              <td className="p-1">
                {step.runs === 0 ? "—" : humanDuration(step.totalMs / step.runs)}
              </td>
              <td className="p-1">
                {step.runs === 0 ? "—" : humanDuration(step.quietMs / step.runs)}
              </td>
              <td className="p-1">
                {VERIFICATION_PHASES.map((phase) => step.byPhase[phase].runs).join(" / ")}
              </td>
              <td className="p-1">
                {step.forecastMs === undefined ? "—" : humanDuration(step.forecastMs)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {time.recommendations.length === 0 ? null : (
        <ul className="ml-4 mt-2 list-disc">
          {time.recommendations.map((recommendation) => (
            <li key={`${recommendation.stepId}/${recommendation.title}`}>
              <span className="font-medium">{recommendation.title}</span>
              {recommendation.rule === undefined ? null : ` (rule ${recommendation.rule})`}: saves ≈{" "}
              {humanDuration(recommendation.savingMs ?? 0)}{" "}
              <span className="text-muted-foreground">
                — {recommendation.formula}. {recommendation.evidence.join("; ")}. Fix:{" "}
                {recommendation.fix}.
                {recommendation.edit === undefined
                  ? null
                  : ` Edit the contract: on ${recommendation.edit.stepId}, set ${Object.entries(
                      recommendation.edit.set,
                    )
                      .map(([key, value]) => `"${key}": "${value}"`)
                      .join(", ")}.`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

const nodeOf = (version: string | undefined): string =>
  version === undefined ? "no Node" : `Node ${version}`;

/** One side of a faulted gate: its verdict, and the last of its output. */
const Side = ({
  verdict,
  tail,
  side,
}: {
  readonly verdict: string;
  readonly tail: string | undefined;
  readonly side: "reference" | "machine";
}) => (
  <td className="p-2 align-top" data-side={side}>
    <StatusBadge status={verdict} />
    {tail === undefined ? (
      <p className="mt-1 text-xs text-muted-foreground">No output was kept.</p>
    ) : (
      <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-xs">
        {tail}
      </pre>
    )}
  </td>
);

/**
 * Green on the laptop, red on the machine (P16 D-07): each gate with the
 * reference's verdict and output beside the machine's, under both Nodes.
 */
const EnvironmentFault = ({ fault }: { readonly fault: EnvironmentFaultPayload }) => (
  <div data-environment-fault="">
    <h3 className="mb-1 font-medium text-status-danger-foreground">Environment fault</h3>
    <p className="mb-2">
      {fault.gates.length === 1 ? "A gate" : `${fault.gates.length} gates`} passed in the reference
      audit of <code>{shortSha(fault.baseCommit)}</code> and failed on the run's machine. The
      machine is at fault, not the project: nothing was repaired, and the run was cancelled.
    </p>
    <table className="w-full table-fixed border-collapse text-left">
      <thead>
        <tr className="border-b border-border text-xs text-muted-foreground">
          <th className="w-1/5 p-2 font-medium">Gate</th>
          <th className="p-2 font-medium">Reference ({nodeOf(fault.referenceNode)})</th>
          <th className="p-2 font-medium">Machine ({nodeOf(fault.machineNode)})</th>
        </tr>
      </thead>
      <tbody>
        {fault.gates.map((gate) => (
          <tr key={gate.id} className="border-b border-border" data-gate={gate.id}>
            <td className="p-2 align-top">
              <span className="font-medium">{gate.id}</span>
              <code className="block break-all text-xs text-muted-foreground">{gate.command}</code>
            </td>
            <Side verdict={gate.reference} tail={gate.referenceTail} side="reference" />
            <Side verdict={gate.machine} tail={gate.machineTail} side="machine" />
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

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
  const { audit, red, environmentFault, repairs, flakes, verificationTime } = gateHealth;
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
      {environmentFault === undefined ? null : <EnvironmentFault fault={environmentFault} />}
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
                <code>{flake.stepId}</code>{" "}
                {flake.jobContractId === null ? (
                  "in the end gates"
                ) : (
                  <>
                    on job <span className="font-mono">{shortId(flake.jobContractId)}</span>
                  </>
                )}{" "}
                at <code>{shortSha(flake.commitSha)}</code>
                <span className="text-muted-foreground">
                  {" "}
                  — first run exited {flake.firstExitCode}, the rerun passed
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <VerificationTime time={verificationTime} />
    </div>
  );
};
