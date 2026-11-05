/**
 * A project's line, one row: its branch and head, its last composition, what
 * it parked, and its live run. The line is a run of its own program, so the row
 * links to runs, never to a plan.
 */
import type {
  LineCandidate,
  LineParked,
  LineRange,
  LineRecord,
  ProgramContract,
  ProjectId,
  Run,
} from "@nightshift/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { readable, shortSha } from "../lib/format.js";
import { useStudio } from "../studio.js";
import { StatusBadge } from "./status-badge.js";

/** Parked entries shown before the rest are collapsed. */
const PARKED_SHOWN = 3;

const runPath = (projectId: ProjectId, run: Run): string =>
  `/projects/${projectId}/programs/${run.programId}/runs/${run.runId}`;

const rangesOf = (ranges: readonly LineRange[], nameOf: (programId: string) => string): string =>
  [...new Set(ranges.map((range) => nameOf(range.program)))].join(", ");

const ParkedItem = ({
  entry,
  nameOf,
}: {
  readonly entry: LineParked;
  readonly nameOf: (programId: string) => string;
}) => (
  <li className="flex flex-wrap items-baseline gap-x-3" data-testid="line-parked">
    <span className="font-mono">{rangesOf(entry.ranges, nameOf)}</span>
    <span className="text-muted-foreground">{entry.reason}</span>
  </li>
);

/**
 * Where the line's newest candidate stands, in words a person who is not an
 * engineer can act on (P25, D-P25-13). `deployable` only when Deploy may be
 * pressed: qualified, with its pull request, and main not moved past it.
 */
export const candidateWords = (
  record: Pick<LineRecord, "mainSeen" | "undeployed">,
  candidate: LineCandidate | undefined,
): {
  readonly says: string;
  readonly tone: "ready" | "busy" | "attention" | "quiet";
  readonly deployable: boolean;
} => {
  const waiting = (record.undeployed ?? []).length > 0;
  if (candidate === undefined) {
    return waiting
      ? {
          says: "Preparing: Nightshift checks what is on the line once it settles.",
          tone: "busy",
          deployable: false,
        }
      : { says: "Nothing is waiting to ship.", tone: "quiet", deployable: false };
  }
  const sha = candidate.commit.slice(0, 8);
  switch (candidate.state) {
    case "qualifying":
      return {
        says: `Checking: Nightshift is running every gate on ${sha}.`,
        tone: "busy",
        deployable: false,
      };
    case "failed":
      return {
        says: `Needs an engineer: ${candidate.detail ?? "the full verification failed"}.`,
        tone: "attention",
        deployable: false,
      };
    case "deploying":
      return { says: "Deploying: merging its pull request.", tone: "busy", deployable: false };
    case "deployed":
      return waiting
        ? {
            says: "Deployed. More has landed since: Nightshift is checking it.",
            tone: "busy",
            deployable: false,
          }
        : { says: "Deployed. Nothing new is waiting to ship.", tone: "quiet", deployable: false };
    case "superseded":
    case "closed":
      return {
        says: "Its pull request was closed. The next candidate replaces it.",
        tone: "quiet",
        deployable: false,
      };
    case "qualified": {
      if (record.mainSeen !== undefined && record.mainSeen !== candidate.mainAt) {
        return {
          says: "Updating: main changed, Nightshift is re-checking.",
          tone: "busy",
          deployable: false,
        };
      }
      if (candidate.pr === undefined) {
        return candidate.prDetail === undefined
          ? { says: "Opening its pull request.", tone: "busy", deployable: false }
          : {
              says: `Needs an engineer: ${candidate.prDetail}`,
              tone: "attention",
              deployable: false,
            };
      }
      return { says: "Ready to deploy.", tone: "ready", deployable: true };
    }
  }
};

const TONE: Readonly<Record<ReturnType<typeof candidateWords>["tone"], string>> = {
  ready: "text-status-success-foreground",
  busy: "text-muted-foreground",
  attention: "text-status-warning-foreground",
  quiet: "text-muted-foreground",
};

/** The newest candidate of one program, or of the line when it predates per-program candidates. */
const candidateFor = (record: LineRecord, program: string): LineCandidate | undefined =>
  [...(record.candidates ?? [])]
    .reverse()
    .find(
      (candidate) =>
        candidate.program === program ||
        (candidate.program === undefined &&
          candidate.programs.some((entry) => entry.program === program)),
    );

/** One program waiting to ship: where its candidate stands, its pull request, and Deploy. */
const ProgramToShip = ({
  projectId,
  branch,
  record,
  program,
  nameOf,
}: {
  readonly projectId: ProjectId;
  readonly branch: string;
  readonly record: LineRecord;
  readonly program: string;
  readonly nameOf: (programId: string) => string;
}) => {
  const { line } = useStudio();
  const client = useQueryClient();
  const candidate = candidateFor(record, program);
  const words = candidateWords(record, candidate);
  const [said, setSaid] = useState<string | undefined>(undefined);
  const deploy = useMutation({
    mutationFn: async () => {
      if (line === undefined || candidate === undefined)
        throw new Error("this Studio cannot deploy");
      return line.deploy(projectId, branch, candidate.candidateId);
    },
    onSuccess: async (answer) => {
      setSaid(answer.ok ? undefined : answer.said);
      await client.invalidateQueries({ queryKey: ["line", projectId, branch] });
    },
    onError: (error) => setSaid(String(error)),
  });
  const alsoShips = (candidate?.programs ?? [])
    .map((entry) => entry.program)
    .filter((other) => other !== program);
  return (
    <li className="grid gap-1" data-testid="line-candidate">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <span className="font-medium">{nameOf(program)}</span>
        <span className={TONE[words.tone]} data-testid="line-candidate-state">
          {words.says}
        </span>
        {candidate?.pr === undefined ? null : (
          <a className="underline-offset-4 hover:underline" href={candidate.pr.url}>
            pull request #{candidate.pr.number}
          </a>
        )}
        {words.deployable && line !== undefined ? (
          <Button size="sm" disabled={deploy.isPending} onClick={() => deploy.mutate()}>
            {deploy.isPending ? "Deploying…" : "Deploy"}
          </Button>
        ) : null}
      </div>
      {alsoShips.length === 0 ? null : (
        <p className="text-muted-foreground">
          This deploy also includes: {[...new Set(alsoShips.map(nameOf))].join(", ")}
        </p>
      )}
      {candidate?.state === "qualified" &&
      candidate.prDetail !== undefined &&
      candidate.pr !== undefined ? (
        <p className="text-status-warning-foreground">{candidate.prDetail}</p>
      ) : null}
      {said === undefined ? null : (
        <p role="alert" className="text-status-warning-foreground">
          {said}
        </p>
      )}
    </li>
  );
};

/**
 * The line as a status board (D-P25-16 … 18): each program waiting to ship,
 * with its pull request and Deploy, and each piece of work that did not ship,
 * with its draft pull request. Review happens in GitHub; this says where to look.
 */
const CandidatePanel = ({
  projectId,
  branch,
  record,
  nameOf,
}: {
  readonly projectId: ProjectId;
  readonly branch: string;
  readonly record: LineRecord;
  readonly nameOf: (programId: string) => string;
}) => {
  const waiting = [...new Set((record.undeployed ?? []).map((entry) => entry.program))];
  const drafts = (record.drafts ?? []).filter((draft) => draft.closedAt === undefined);
  const last = record.candidates?.at(-1);
  return (
    <div className="grid gap-2 rounded-md border p-2" data-testid="line-ship">
      {waiting.length === 0 ? (
        <p className="text-muted-foreground" data-testid="line-candidate-state">
          {candidateWords(record, last).says}
        </p>
      ) : (
        <ul className="grid gap-2" aria-label="Waiting to ship">
          {waiting.map((program) => (
            <ProgramToShip
              key={program}
              projectId={projectId}
              branch={branch}
              record={record}
              program={program}
              nameOf={nameOf}
            />
          ))}
        </ul>
      )}
      {drafts.length === 0 ? null : (
        <ul className="grid gap-1 border-t pt-2" aria-label="Not shipped">
          {drafts.map((draft) => (
            <li key={draft.draftId} className="grid" data-testid="line-not-shipped">
              <span>
                <span className="font-medium text-status-warning-foreground">Not shipped: </span>
                {nameOf(draft.program)}{" "}
                {draft.pr === undefined ? (
                  <span className="text-muted-foreground">(opening its draft pull request)</span>
                ) : (
                  <a className="underline-offset-4 hover:underline" href={draft.pr.url}>
                    draft #{draft.pr.number}
                  </a>
                )}
              </span>
              <span className="text-muted-foreground">{draft.reason}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export const LineRow = ({
  projectId,
  program,
  runs,
  nameOf,
  now,
}: {
  readonly projectId: ProjectId;
  readonly program: ProgramContract;
  readonly runs: readonly Run[];
  readonly nameOf: (programId: string) => string;
  readonly now: number;
}) => {
  const { stores } = useStudio();
  const branch = program.line?.branch;
  const [all, setAll] = useState(false);
  const line = useQuery({
    queryKey: ["line", projectId, branch],
    queryFn: () => stores.lines.get(projectId, branch as string),
    enabled: branch !== undefined,
  });
  const latest = [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  const live = latest !== undefined && (latest.status === "pending" || latest.status === "running");
  const record = line.data;
  const composition = record?.compositions.at(-1);
  const parked = record?.parked ?? [];
  const shown = all ? parked : parked.slice(0, PARKED_SHOWN);
  return (
    <li className="grid gap-1 border-b py-3 text-sm last:border-b-0" data-testid="line-row">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="font-mono font-medium">{branch ?? program.programId}</span>
        <span className="text-muted-foreground">
          head{" "}
          <span className="font-mono text-foreground">
            {line.isPending && branch !== undefined ? "…" : shortSha(record?.head)}
          </span>
        </span>
        {latest === undefined ? (
          <span className="text-muted-foreground">no run yet</span>
        ) : (
          <>
            <Link
              to={runPath(projectId, latest)}
              className="underline-offset-4 hover:underline"
              title={live ? "The live run" : "The last run"}
            >
              {live ? "live run" : "last run"} {readable(latest.startedAt, now)}
            </Link>
            <StatusBadge status={latest.status} />
          </>
        )}
      </div>
      {line.isError ? (
        <p role="alert" className="text-destructive">
          Could not read the line: {String(line.error)}
        </p>
      ) : null}
      {record === undefined || branch === undefined ? null : (
        <CandidatePanel projectId={projectId} branch={branch} record={record} nameOf={nameOf} />
      )}
      {composition === undefined ? (
        <p className="text-muted-foreground">No composition yet.</p>
      ) : (
        <p data-testid="line-composition">
          <span className="text-muted-foreground">last composition </span>
          <span className="font-mono">{shortSha(composition.commit)}</span>
          <span className="text-muted-foreground"> of </span>
          <span className="font-mono">{rangesOf(composition.ranges, nameOf)}</span>
          <span className="text-muted-foreground"> · verification </span>
          {composition.verification.outcome}
          <span className="text-muted-foreground"> · {readable(composition.composedAt, now)}</span>
        </p>
      )}
      {parked.length === 0 ? null : (
        <div>
          <p className="text-status-warning-foreground">
            {parked.length} parked range{parked.length === 1 ? "" : "s"}
          </p>
          <ul className="mt-1 grid gap-1 border-l pl-3" aria-label="Parked ranges">
            {shown.map((entry) => (
              <ParkedItem key={entry.compositionId} entry={entry} nameOf={nameOf} />
            ))}
          </ul>
          {parked.length > PARKED_SHOWN ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-muted-foreground"
              aria-expanded={all}
              onClick={() => setAll(!all)}
            >
              {all ? <ChevronDown /> : <ChevronRight />}
              {all ? "show fewer" : `show all ${parked.length}`}
            </Button>
          ) : null}
        </div>
      )}
    </li>
  );
};
