/**
 * The live Codex probe (P20 S-03): the operator's existing Codex login and the
 * real backend. Gated on `NIGHTSHIFT_MEASUREMENT_PROBE=codex`; without it this
 * file only registers a skipped test that says why, so a plain `npm test`
 * never reaches the network or a login.
 *
 * Four runs (main work, a request to spawn a sub-agent, an interrupted run, a
 * resume) are made through the real adapter and receiver. What they show is
 * written to `docs/programs/p20-measurements/codex-capability-live.json`.
 * A missing login is recorded as a failed dimension and is never repaired.
 * Every dimension not observed is listed `unverified`.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionNode, RouteTarget } from "@nightshift/contracts";
import {
  createFixtures,
  makeAgent,
  makeJobContract,
  makeProgramContract,
  makeRootNode,
} from "@nightshift/core";
import type {
  HarnessExit,
  HarnessStartInput,
  HookEvent,
  ReceiverEnvelope,
  ReceiverGap,
} from "@nightshift/harness";
import {
  millis,
  recordingMeasurementSink,
  refusingWorkerTools,
  startLocalReceiver,
} from "@nightshift/harness";
import { describe, expect, it } from "vitest";
import { createCodexHarness } from "./adapter.js";
import {
  buildCapabilityMatrix,
  type CapabilityDimension,
  codexLiveProbeGate,
  writeCapabilityMatrix,
} from "./probe.js";
import { type CodexTelemetryEvidence, decodeCodexTelemetry } from "./telemetry.js";

const gate = codexLiveProbeGate();
const MODEL: RouteTarget = { harness: "codex", provider: "openai", model: "gpt-5.5" };
const OUTPUT = new URL(
  "../../../docs/programs/p20-measurements/codex-capability-live.json",
  import.meta.url,
);

interface Run {
  readonly name: string;
  readonly exit: HarnessExit;
  readonly requests: number;
  readonly children: number;
  readonly evidence: CodexTelemetryEvidence;
}

const LOGIN_WORDS = /log ?in|sign ?in|auth|api key|credential|unauthori[sz]ed|401/i;

if (!gate.enabled) {
  describe("codex live measurement probe", () => {
    it.skip(`skipped — ${gate.reason}`, () => {});
  });
} else {
  describe("codex live measurement probe", () => {
    it("records the capability matrix from the real backend", async () => {
      const root = mkdtempSync(join(tmpdir(), "codex-live-probe-"));
      const worktree = join(root, "work");
      mkdirSync(worktree, { recursive: true });
      try {
        const runOnce = async (
          name: string,
          objective: string,
          options: { resume?: string; cancelAfterMs?: number } = {},
        ): Promise<Run & { hooks: HookEvent[] }> => {
          const journals: string[] = [];
          const harness = createCodexHarness({
            // The operator's own environment: their CODEX_HOME and login.
            env: process.env,
            startReceiver: async (opts) => {
              const receiver = await startLocalReceiver(opts);
              return {
                ...receiver,
                stop: async (grace) => {
                  const stopped = await receiver.stop(grace);
                  journals.push(readFileSync(receiver.journalPath, "utf8"));
                  return stopped;
                },
              };
            },
          });
          const fixtures = createFixtures();
          const node: ExecutionNode = makeRootNode(fixtures);
          const sink = recordingMeasurementSink();
          const hooks: HookEvent[] = [];
          const input: HarnessStartInput = {
            agent: makeAgent(fixtures, node.executionNodeId),
            node,
            job: makeJobContract(fixtures, { objective }),
            program: makeProgramContract(fixtures),
            worktree,
            model: MODEL,
            tools: refusingWorkerTools("the live probe starts no real job"),
            sink: { emit: (event) => void hooks.push(event) },
            measurements: sink,
            ...(options.resume === undefined ? {} : { resume: { sessionId: options.resume } }),
          };
          const handle = await harness.start(input);
          if (options.cancelAfterMs !== undefined) {
            await new Promise((r) => setTimeout(r, options.cancelAfterMs));
            await harness.cancel(handle, millis(10_000));
          }
          const exit = await handle.exit;
          const ending = hooks.find((h) => h.type.startsWith("agent.") && "outcome" in h.payload);
          const children = Number(ending?.payload.childConversations ?? 0);
          const evidence = decodeCodexTelemetry(
            journals
              .join("")
              .split("\n")
              .filter((l) => l !== "")
              .map((l) => JSON.parse(l) as ReceiverEnvelope | ReceiverGap),
          );
          return {
            name,
            exit,
            requests: sink.observations.filter((o) => o.kind === "request").length,
            children,
            evidence,
            hooks,
          };
        };

        const main = await runOnce("main", "Reply with the single word READY. Do nothing else.");
        const threadId = main.exit.kind === "completed" ? main.exit.sessionId : undefined;
        const spawn = await runOnce(
          "spawn",
          "Spawn one sub-agent whose only task is to reply with the word DONE, wait for it, then reply FINISHED. If you cannot spawn a sub-agent, say so and stop.",
        );
        const interrupted = await runOnce(
          "interrupted",
          "Count slowly from 1 to 500, one number per line, running `sleep 1` between lines.",
          { cancelAfterMs: 6000 },
        );
        const resumed =
          threadId === undefined
            ? undefined
            : await runOnce("resume", "Reply with the single word AGAIN.", { resume: threadId });

        const loginMissing = [main, spawn].some((r) => {
          const said = r.hooks.map((h) => String(h.payload.summary ?? "")).join(" ");
          return r.exit.kind === "failed" && LOGIN_WORDS.test(said);
        });

        const dimensions: CapabilityDimension[] = [];
        if (loginMissing || main.exit.kind === "failed") {
          dimensions.push({
            name: "real_backend",
            status: "failed",
            note: loginMissing
              ? "no usable Codex login for the operator; it was not repaired"
              : "the main run failed before a response was reported",
          });
        } else {
          dimensions.push({ name: "real_backend", status: "observed" });
        }
        dimensions.push(
          interrupted.exit.kind === "cancelled"
            ? {
                name: "interrupted_run",
                status: "observed",
                note: `cancelled; ${interrupted.requests} request(s) retained, coverage ${interrupted.exit.coverage ?? "unknown"}`,
              }
            : {
                name: "interrupted_run",
                status: "unverified",
                note: `run ended ${interrupted.exit.kind}`,
              },
          resumed === undefined
            ? {
                name: "resume_continuation",
                status: "unverified",
                note: "the main run gave no thread to resume",
              }
            : resumed.exit.kind === "completed"
              ? {
                  name: "resume_continuation",
                  status: "observed",
                  note: `${resumed.requests} request(s) in the resumed launch`,
                }
              : {
                  name: "resume_continuation",
                  status: "failed",
                  note: `resume ended ${resumed.exit.kind}`,
                },
        );

        // Observed only if a second conversation id or a child rollout appeared.
        const spawned = spawn.evidence.conversations.length > 1 || spawn.children > 0;
        const runs = [main, spawn, interrupted, ...(resumed === undefined ? [] : [resumed])];
        const evidence: CodexTelemetryEvidence = {
          conversations: runs.flatMap((r) => r.evidence.conversations),
          lossGaps: runs.flatMap((r) => r.evidence.lossGaps),
          filteredRecordCount: 0,
          droppedRecords: 0,
        };
        const matrix = buildCapabilityMatrix(evidence, {
          mode: "live",
          producedAt: new Date().toISOString(),
          nativeChildren: spawned ? "observed" : "unverified",
          rolloutFields: ["response_id", "thread_token_usage", "last_token_usage"],
          dimensions,
          notes: [
            "Metadata only: no prompt, response or tool text was written.",
            "A dimension that is not 'observed' is unverified: absence in one run is not proof.",
            "To trust a websocket transport, add 'websocket' to CODEX_VERIFIED_TRANSPORTS in packages/harness-codex/src/telemetry.ts only after a committed matrix lists transport_websocket as observed.",
            "To trust native child visibility, set CODEX_VERIFIED_NATIVE_CHILDREN to true in the same file only after a committed matrix reports nativeChildren 'observed'.",
          ],
        });
        writeCapabilityMatrix(OUTPUT.pathname, matrix);
        expect(matrix.harness).toBe("codex");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, 900_000);
  });
}
