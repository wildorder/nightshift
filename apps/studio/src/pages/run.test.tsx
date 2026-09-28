/**
 * The run page over the memory stores (T4; SC-P11-03, SC-P11-04 offline).
 */
import {
  makeAgent,
  makeCheckpoint,
  makeDecision,
  makeEvent,
  makeFailedVerification,
  makeJobContract,
  makeNode,
  makeProgramContract,
  makeProject,
  makeRootNode,
  makeRun,
  makeVerification,
} from "@nightshift/core";
import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { mountStudio, runPathOf } from "../test-support.js";

describe("the run page", () => {
  it("shows the tree, agents, jobs, verifications, criteria, cost, timeline, checkpoints and decisions", async () => {
    const opened: string[] = [];
    await mountStudio(
      async (stores, f, orgId) => {
        await stores.projects.put(makeProject(f, { orgId, name: "keyart" }));
        await stores.programContracts.put(
          makeProgramContract(f, {
            objective: "Add billing",
            successCriteria: [
              { id: "SC-01", outcome: "Invoices persist" },
              { id: "SC-02", outcome: "Webhooks are idempotent" },
            ],
          }),
        );
        await stores.runs.put(
          makeRun(f, {
            status: "failed",
            endedAt: "2026-09-15T12:30:00.000Z",
            outcomeReason: "a job failed verification",
          }),
        );
        const root = makeRootNode(f, { status: "failed" });
        await stores.executionNodes.put(root);
        const job1 = makeJobContract(f, { objective: "Persist invoices" });
        const job2 = makeJobContract(f, {
          jobContractId: f.ids.next("job"),
          objective: "Idempotent webhooks",
        });
        await stores.jobContracts.put(job1);
        await stores.jobContracts.put(job2);
        const n1 = makeNode(f, root.executionNodeId, {
          kind: "job",
          status: "verified",
          jobContractId: job1.jobContractId,
          commitSha: "a".repeat(40),
        });
        const n2 = makeNode(f, root.executionNodeId, {
          kind: "job",
          status: "verification_failed",
          jobContractId: job2.jobContractId,
          outcomeReason: "npm test failed",
        });
        await stores.executionNodes.put(n1);
        await stores.executionNodes.put(n2);
        await stores.agents.put(
          makeAgent(f, n1.executionNodeId, {
            status: "completed",
            model: "claude-haiku-4-5-20251001",
            exitCode: 0,
          }),
        );
        await stores.verifications.put(makeVerification(f, n1));
        await stores.verifications.put(
          makeFailedVerification(f, n2, {
            commands: [
              {
                stepId: "test",
                command: "npm test",
                exitCode: 1,
                durationMs: 4200,
                logArtifactId: "art_00000000000000000000000009",
              },
            ],
          }),
        );
        await stores.checkpoints.put(makeCheckpoint(f, root.executionNodeId, { label: "initial" }));
        await stores.decisions.put(
          makeDecision(f, n1.executionNodeId, {
            context: "Which table holds invoices?",
            choice: "One table per tenant",
            alternatives: [{ summary: "One shared table", rejectedBecause: "isolation" }],
            produced: { commits: ["a".repeat(40)] },
          }),
        );
        await stores.events.append(
          makeEvent(f, {
            sequence: 0,
            type: "run.started",
            occurredAt: "2026-09-15T12:00:00.000Z",
          }),
        );
        await stores.events.append(
          makeEvent(f, {
            sequence: 1,
            type: "node.progress",
            executionNodeId: n1.executionNodeId,
            payload: { message: "writing the migration" },
            occurredAt: "2026-09-15T12:01:00.000Z",
          }),
        );
      },
      {
        at: runPathOf,
        artifacts: {
          downloadUrl: async (_scope, artifactId) => {
            opened.push(artifactId);
            return `https://signed.example/${artifactId}`;
          },
        },
      },
    );

    await waitFor(() => expect(screen.getByRole("heading", { name: /Run/ })).toBeTruthy());
    expect(screen.getByText("a job failed verification")).toBeTruthy();
    expect(screen.queryByTestId("live")).toBeNull();

    // Jobs, with their agents, verifications and reasons.
    await waitFor(() => expect(screen.getByText("Persist invoices")).toBeTruthy());
    const jobs = screen.getByRole("heading", { name: "Jobs" }).parentElement;
    if (jobs === null) throw new Error("no jobs section");
    await waitFor(() => expect(within(jobs).getByText(/claude-haiku-4-5-20251001/)).toBeTruthy());
    expect(within(jobs).getByText("npm test failed")).toBeTruthy();
    await waitFor(() => expect(within(jobs).getByText("exit 1")).toBeTruthy());
    expect(within(jobs).getByText("4.2 s")).toBeTruthy();

    // Criteria, unmet on an unplanned run.
    expect(screen.getByText("Invoices persist")).toBeTruthy();

    // The tree: root and two children.
    const tree = screen.getByRole("heading", { name: "Execution tree" }).parentElement;
    if (tree === null) throw new Error("no tree");
    expect(tree.querySelectorAll("[data-tree-node]")).toHaveLength(3);

    // The timeline, in sequence order, narrated.
    const timeline = screen.getByTestId("timeline");
    const lines = within(timeline)
      .getAllByRole("listitem")
      .map((li) => li.textContent ?? "");
    expect(lines[0]).toContain("run started");
    expect(lines[1]).toContain("“writing the migration”");

    // Checkpoints and the decision graph.
    expect(screen.getByText(/initial/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "One table per tenant" })).toBeTruthy();
    expect(screen.getByText(/One shared table \(isolation\)/)).toBeTruthy();

    // A log opens through the signed URL.
    window.open = () => null;
    await userEvent.click(within(jobs).getByRole("button", { name: "log" }));
    await waitFor(() => expect(opened).toEqual(["art_00000000000000000000000009"]));
  });

  it("follows a live run: a new event appears and the node it names is re-read", async () => {
    const seeded = await mountStudio(
      async (stores, f, orgId) => {
        await stores.projects.put(makeProject(f, { orgId }));
        await stores.programContracts.put(makeProgramContract(f));
        await stores.runs.put(makeRun(f, { status: "running" }));
        await stores.executionNodes.put(makeRootNode(f));
        await stores.events.append(makeEvent(f, { sequence: 0, type: "run.started" }));
      },
      { at: runPathOf, pollMs: 20 },
    );
    const { stores, f } = seeded;
    await waitFor(() => expect(screen.getByTestId("live")).toBeTruthy());
    await waitFor(() =>
      expect(screen.getByTestId("timeline").textContent).toContain("run started"),
    );

    // The run moves on: a job is delegated and starts.
    const job = makeJobContract(f, { objective: "A new job" });
    await stores.jobContracts.put(job);
    const node = makeNode(f, f.rootNodeId, {
      kind: "job",
      status: "running",
      jobContractId: job.jobContractId,
    });
    await stores.executionNodes.put(node);
    await stores.events.append(
      makeEvent(f, { sequence: 1, type: "node.delegated", executionNodeId: node.executionNodeId }),
    );
    await stores.events.append(
      makeEvent(f, { sequence: 2, type: "node.started", executionNodeId: node.executionNodeId }),
    );

    await waitFor(() => expect(screen.getByTestId("timeline").textContent).toContain("delegated"));
    // The tree and the jobs list both re-read the node and its contract.
    await waitFor(() => expect(screen.getAllByText("A new job").length).toBeGreaterThanOrEqual(2), {
      timeout: 3000,
    });
  });
});
