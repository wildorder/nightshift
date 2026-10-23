/**
 * The plan page (P21): a program's plan draft as the control plane holds it,
 * read-only (D-04). Answering, requesting changes, declining and ratifying are
 * done with the CLI; nothing on this page writes.
 */
import type {
  PlanDraft,
  PlanDraftCheck,
  PlanDraftVersion,
  PlannedDecision,
  ProgramContract,
} from "@nightshift/contracts";
import type { ProgramScope } from "@nightshift/core";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Markdown } from "../components/markdown.js";
import { PageHeader } from "../components/page-header.js";
import { StatusBadge } from "../components/status-badge.js";
import { shortSha, when } from "../lib/format.js";
import {
  decisionAnswers,
  describeAct,
  type IdChanges,
  type ParsedContract,
  parseContract,
  principalLabel,
  type VersionChanges,
  versionChanges,
} from "../lib/plan-draft.js";
import { readAll } from "../lib/read-all.js";
import { useStudio } from "../studio.js";
import { useProjectId } from "./project.js";

const Panel = ({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}) => (
  <Card>
    <CardHeader>
      <CardTitle>
        <h2>{title}</h2>
      </CardTitle>
    </CardHeader>
    <CardContent>{children}</CardContent>
  </Card>
);

const Muted = ({ children }: { readonly children: React.ReactNode }) => (
  <p className="text-sm text-muted-foreground">{children}</p>
);

interface Documents {
  /** Contract text by version; absent when it could not be retrieved. */
  readonly contracts: ReadonlyMap<number, ParsedContract>;
  /** The latest version's plan document, if retrievable. */
  readonly plan: string | undefined;
}

const attempt = async <T,>(read: () => Promise<T | undefined>): Promise<T | undefined> => {
  try {
    return await read();
  } catch {
    return undefined;
  }
};

const usePlanDocuments = (scope: ProgramScope, versions: readonly PlanDraftVersion[]) => {
  const { documents } = useStudio();
  const latest = versions[versions.length - 1];
  return useQuery({
    queryKey: ["plan-draft-documents", scope.programId, versions.map((v) => v.contract.sha256)],
    enabled: latest !== undefined && documents !== undefined,
    queryFn: async (): Promise<Documents> => {
      const contracts = new Map<number, ParsedContract>();
      await Promise.all(
        versions.map(async (v) => {
          const text = await attempt(
            () => documents?.planDocument(scope, v.contract.sha256) ?? Promise.resolve(undefined),
          );
          if (text !== undefined) contracts.set(v.version, parseContract(text));
        }),
      );
      const plan =
        latest === undefined
          ? undefined
          : await attempt(
              () =>
                documents?.planDocument(scope, latest.plan.sha256) ?? Promise.resolve(undefined),
            );
      return { contracts, plan };
    },
  });
};

const useDraftCheck = (scope: ProgramScope, version: number | undefined) => {
  const { drafts } = useStudio();
  return useQuery({
    queryKey: ["plan-draft-check", scope.programId, version],
    enabled: version !== undefined && drafts !== undefined,
    queryFn: async (): Promise<PlanDraftCheck | null> =>
      version === undefined || drafts === undefined
        ? null
        : ((await drafts.version(scope, version))?.check ?? null),
  });
};

const CheckPanel = ({
  available,
  check,
}: {
  readonly available: boolean;
  readonly check: PlanDraftCheck | null | undefined;
}) => (
  <Panel title="Plan check">
    {!available || check === null || check === undefined ? (
      <Muted>
        <StatusBadge status="unavailable" /> The plane's check of this version is unavailable.
      </Muted>
    ) : check.ready ? (
      <p className="text-sm">
        <StatusBadge status="passed" label="Ready" /> The plane's check finds nothing in the way of
        ratifying this version.
      </p>
    ) : (
      <div className="grid gap-2 text-sm">
        <p>
          <StatusBadge status="blocked" label="Not ready" />
        </p>
        <ul className="grid gap-1">
          {check.reasons.map((reason, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: reasons carry no id
            <li key={index}>
              <code className="font-mono text-xs">{reason.kind}</code>: {reason.message}
            </li>
          ))}
        </ul>
      </div>
    )}
  </Panel>
);

const DecisionRow = ({
  decision,
  source,
}: {
  readonly decision: PlannedDecision;
  readonly source: ReturnType<typeof decisionAnswers>[number]["source"];
}) => (
  <li className="grid gap-1 rounded-md border p-3 text-sm" data-decision={decision.id}>
    <p>
      <span className="mr-1.5 font-mono text-xs text-muted-foreground">{decision.id}</span>
      <span className="font-medium">{decision.question}</span>
    </p>
    <p className="text-muted-foreground">
      Options: {decision.options.length === 0 ? "none given" : decision.options.join(", ")}
      {decision.leaning === undefined ? "" : ` · leaning: ${decision.leaning}`}
    </p>
    {decision.answer === undefined ? (
      <p>
        <StatusBadge status="pending" label="unanswered" />
      </p>
    ) : (
      <div>
        <p>
          Answer: <span className="font-medium">{decision.answer}</span>
        </p>
        {decision.rationale === undefined ? null : (
          <p className="text-muted-foreground">Rationale: {decision.rationale}</p>
        )}
        <p className="text-muted-foreground">
          {source === undefined
            ? "answered by an unknown principal"
            : source.how === "answered"
              ? `answered by ${principalLabel(source.by)} (version ${source.version})`
              : `written into the plan by ${principalLabel(source.by)} (version ${source.version})`}
        </p>
      </div>
    )}
  </li>
);

const ContractPanels = ({
  contract,
  answers,
}: {
  readonly contract: ProgramContract;
  readonly answers: ReturnType<typeof decisionAnswers>;
}) => (
  <>
    <Panel title="Stories">
      {(contract.stories ?? []).length === 0 ? (
        <Muted>No stories.</Muted>
      ) : (
        <ul className="grid gap-2 text-sm">
          {(contract.stories ?? []).map((story) => (
            <li key={story.id}>
              <span className="mr-1.5 font-mono text-xs text-muted-foreground">{story.id}</span>
              <span className="font-medium">{story.outcome}</span>{" "}
              <span className="text-muted-foreground">for {story.who}</span>
              <p className="text-muted-foreground">Problem: {story.problem}</p>
            </li>
          ))}
        </ul>
      )}
    </Panel>
    <Panel title="Strands">
      {(contract.strands ?? []).length === 0 ? (
        <Muted>No strands.</Muted>
      ) : (
        <ul className="grid gap-2 text-sm">
          {(contract.strands ?? []).map((strand) => (
            <li key={strand.id} className="rounded-md border p-3" data-strand={strand.id}>
              <p>
                <span className="mr-1.5 font-mono text-xs text-muted-foreground">{strand.id}</span>
                <span className="font-medium">{strand.name}</span>
              </p>
              <p className="text-muted-foreground">{strand.scope.summary}</p>
              <p className="text-muted-foreground">
                Depends on:{" "}
                {strand.dependsOn.length === 0 ? "nothing" : strand.dependsOn.join(", ")}
                {" · "}Prerequisites:{" "}
                {strand.prerequisites.length === 0 ? "none" : strand.prerequisites.join(", ")}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Panel>
    <Panel title="Decisions">
      {answers.length === 0 ? (
        <Muted>No planned decisions.</Muted>
      ) : (
        <ul className="grid gap-2">
          {answers.map((answer) => (
            <DecisionRow
              key={answer.decision.id}
              decision={answer.decision}
              source={answer.source}
            />
          ))}
        </ul>
      )}
    </Panel>
    <Panel title="Human prerequisites">
      {(contract.prerequisites ?? []).length === 0 ? (
        <Muted>No prerequisites.</Muted>
      ) : (
        <ul className="grid gap-2 text-sm">
          {(contract.prerequisites ?? []).map((prerequisite) => (
            <li key={prerequisite.id} data-prerequisite={prerequisite.id}>
              <span className="mr-1.5 font-mono text-xs text-muted-foreground">
                {prerequisite.id}
              </span>
              {prerequisite.description} <StatusBadge status={prerequisite.status} />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  </>
);

const changeText = (label: string, changes: IdChanges): string[] => [
  ...(changes.added.length === 0 ? [] : [`${label} added: ${changes.added.join(", ")}`]),
  ...(changes.removed.length === 0 ? [] : [`${label} removed: ${changes.removed.join(", ")}`]),
  ...(changes.changed.length === 0 ? [] : [`${label} changed: ${changes.changed.join(", ")}`]),
];

const contractLines = (changes: VersionChanges): string[] => {
  if ("unparseable" in changes.contract) {
    return [`contract comparison unavailable: ${changes.contract.unparseable}`];
  }
  const lines = [
    ...changeText("stories", changes.contract.stories),
    ...changeText("strands", changes.contract.strands),
    ...changeText("decisions", changes.contract.decisions),
    ...changeText("prerequisites", changes.contract.prerequisites),
    ...(changes.contract.fields.length === 0
      ? []
      : [`contract fields changed: ${changes.contract.fields.join(", ")}`]),
  ];
  return lines.length === 0 && changes.contractChanged
    ? ["contract document changed (no field differences found)"]
    : lines;
};

const ChangeLines = ({ changes }: { readonly changes: VersionChanges }) => {
  const lines = [
    ...(changes.planChanged ? ["plan document changed"] : []),
    ...(changes.conversationChanged ? ["conversation changed"] : []),
    ...contractLines(changes),
  ];
  return (
    <ul className="ml-4 list-disc text-muted-foreground">
      {lines.length === 0 ? <li>no changes to the documents</li> : null}
      {lines.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
};

const VersionsPanel = ({
  versions,
  contracts,
}: {
  readonly versions: readonly PlanDraftVersion[];
  readonly contracts: ReadonlyMap<number, ParsedContract>;
}) => (
  <Panel title="Versions, newest first">
    {versions.length === 0 ? (
      <Muted>No versions.</Muted>
    ) : (
      <ol className="grid gap-3 text-sm">
        {[...versions].reverse().map((version) => {
          const previous = versions.find((v) => v.version === version.version - 1);
          return (
            <li
              key={version.version}
              className="rounded-md border p-3"
              data-version={version.version}
            >
              <p>
                <span className="font-medium">Version {version.version}</span> by{" "}
                {principalLabel(version.author)} · {describeAct(version.act)} ·{" "}
                {when(version.createdAt)}
              </p>
              {previous === undefined ? (
                <p className="text-muted-foreground">the first version</p>
              ) : (
                <ChangeLines
                  changes={versionChanges(
                    version,
                    previous,
                    contracts.get(version.version),
                    contracts.get(previous.version),
                  )}
                />
              )}
            </li>
          );
        })}
      </ol>
    )}
  </Panel>
);

const ActsPanel = ({ draft }: { readonly draft: PlanDraft }) => (
  <Panel title="Recorded acts">
    {draft.acts.length === 0 ? (
      <Muted>No acts recorded yet.</Muted>
    ) : (
      <ul className="grid gap-1 text-sm">
        {draft.acts.map((act) => (
          <li key={`${act.at}-${act.kind}-${act.version}`}>
            <span className="font-medium">{act.kind}</span> on version {act.version} by{" "}
            {principalLabel(act.by)} at {when(act.at)}
            {act.note === undefined ? "" : ` — ${act.note}`}
          </li>
        ))}
      </ul>
    )}
  </Panel>
);

export const PlanPage = () => {
  const { stores, drafts, documents } = useStudio();
  const projectId = useProjectId();
  const { programId } = useParams();
  const scope: ProgramScope = { projectId, programId: programId as ProgramScope["programId"] };
  const draftQuery = useQuery({
    queryKey: ["plan-draft", projectId, programId],
    queryFn: async () => (await stores.planDrafts.get(projectId, scope.programId)) ?? null,
  });
  const versionsQuery = useQuery({
    queryKey: ["plan-draft-versions", projectId, programId, draftQuery.data?.latestVersion],
    enabled: draftQuery.data != null,
    queryFn: () =>
      readAll((page) => stores.planDrafts.listVersions(projectId, scope.programId, page)),
  });
  const versions = versionsQuery.data ?? [];
  const latest = versions[versions.length - 1];
  const docs = usePlanDocuments(scope, versions);
  const check = useDraftCheck(scope, latest?.version);

  const crumbs = (
    <nav className="text-sm">
      <Link className="underline" to={`/projects/${projectId}`}>
        Project
      </Link>{" "}
      / <span>Plan of {scope.programId}</span>
    </nav>
  );

  if (draftQuery.isPending || (draftQuery.data != null && versionsQuery.isPending)) {
    return (
      <>
        <PageHeader title="Plan" description={crumbs} />
        <Muted>Loading…</Muted>
      </>
    );
  }
  if (draftQuery.isError || versionsQuery.isError) {
    return (
      <>
        <PageHeader title="Plan" description={crumbs} />
        <p role="alert" className="text-sm text-destructive">
          The plan draft could not be read.
        </p>
      </>
    );
  }
  const draft = draftQuery.data;
  if (draft === null || draft === undefined) {
    return (
      <>
        <PageHeader title="Plan" description={crumbs} />
        <Muted>
          This program has no plan draft in the plane. A program ratified before plans lived in the
          plane has its plan on its run pages.
        </Muted>
      </>
    );
  }

  const latestContract =
    latest === undefined ? undefined : docs.data?.contracts.get(latest.version);

  return (
    <div data-testid="plan-page">
      <PageHeader
        title={`Plan of ${scope.programId}`}
        description={crumbs}
        actions={<StatusBadge status={draft.state} />}
      />
      <div className="grid gap-4">
        <Panel title="Draft">
          <p className="text-sm">
            Program <code className="font-mono">{scope.programId}</code> · latest version{" "}
            {draft.latestVersion} · plan hash{" "}
            <code className="font-mono">{shortSha(latest?.planHash)}</code>
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            This page only reads. Answering, requesting changes and approving are done with the CLI
            (<code className="font-mono">nightshift plan ...</code>).
          </p>
        </Panel>
        <CheckPanel
          available={drafts !== undefined && !check.isError}
          check={check.isPending ? undefined : check.data}
        />
        {documents === undefined || docs.isError ? (
          <Muted>The plan's documents are not retrievable.</Muted>
        ) : docs.isPending ? (
          <Muted>Loading the documents…</Muted>
        ) : latestContract === undefined ? (
          <Muted>The plan's documents are not retrievable.</Muted>
        ) : latestContract.ok ? (
          <ContractPanels
            contract={latestContract.contract}
            answers={decisionAnswers(latestContract.contract, versions, docs.data.contracts)}
          />
        ) : (
          <Panel title="Contract">
            <p role="alert" className="text-sm text-destructive">
              The contract could not be parsed: {latestContract.reason}
            </p>
          </Panel>
        )}
        {docs.data?.plan === undefined ? null : (
          <Panel title="Plan document">
            <Markdown text={docs.data.plan} label="Plan document" />
          </Panel>
        )}
        <ActsPanel draft={draft} />
        <VersionsPanel versions={versions} contracts={docs.data?.contracts ?? new Map()} />
      </div>
    </div>
  );
};
