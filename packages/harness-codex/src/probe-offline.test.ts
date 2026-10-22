/**
 * The offline Codex probe (P20 S-03): the real `codex` binary, the real
 * adapter and the real loopback receiver, against a scripted loopback
 * Responses provider and a temporary `CODEX_HOME`. Nothing leaves the machine.
 *
 * Skipped, with the gate's reason, unless a `codex` of the verified version is
 * on PATH. `NIGHTSHIFT_MEASUREMENT_FIXTURES=write` additionally regenerates the
 * sanitized fixtures and `docs/programs/p20-measurements/codex-capability-offline.json`.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  HarnessObservation,
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCodexHarness } from "./adapter.js";
import {
  buildCapabilityMatrix,
  type CapabilityMatrix,
  codexLauncherFor,
  codexOfflineProbeGate,
  fakeResponsesProvider,
  findExecutableOnPath,
  MEASUREMENT_FIXTURES_ENV,
  type ProviderStep,
  sanitizeJournalLine,
  sanitizeRolloutLine,
  writeCapabilityMatrix,
} from "./probe.js";
import { decodeCodexTelemetry } from "./telemetry.js";

const gate = codexOfflineProbeGate();
const WRITE = process.env[MEASUREMENT_FIXTURES_ENV] === "write";
const SENTINEL = "SENTINEL-prompt-9d2e41b7-must-not-be-written";
const MODEL: RouteTarget = { harness: "codex", provider: "openai", model: "gpt-5.5" };
const FIXTURES = new URL("./__fixtures__/", import.meta.url);
const MATRIX_PATH = new URL(
  "../../../docs/programs/p20-measurements/codex-capability-offline.json",
  import.meta.url,
);

interface Launch {
  readonly exit: HarnessExit;
  readonly requests: readonly HarnessObservation[];
  readonly all: readonly HarnessObservation[];
  readonly hooks: readonly HookEvent[];
  readonly journal: string;
}

if (!gate.enabled) {
  describe("codex offline measurement probe", () => {
    it.skip(`skipped — ${gate.reason}`, () => {});
  });
} else {
  describe("codex offline measurement probe", () => {
    let root: string;
    let codex: string;
    const served: Record<
      string,
      readonly { input: number; cached: number; output: number; reasoning: number }[]
    > = {};
    let first: Launch;
    let cancelled: Launch;
    let resumed: Launch;
    let rolloutText = "";
    let matrix: CapabilityMatrix;

    const launch = async (
      home: string,
      provider: Awaited<ReturnType<typeof fakeResponsesProvider>>,
      options: {
        resume?: string;
        cancelWhen?: () => boolean;
      } = {},
    ): Promise<Launch> => {
      mkdirSync(home, { recursive: true });
      const journals: string[] = [];
      const harness = createCodexHarness({
        launcher: codexLauncherFor(provider, { tmpDir: root, codex }),
        env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: home },
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
        job: makeJobContract(fixtures, { objective: `Probe objective. ${SENTINEL}` }),
        program: makeProgramContract(fixtures),
        worktree: join(root, "work"),
        model: MODEL,
        tools: refusingWorkerTools("the offline probe starts no real job"),
        sink: { emit: (event) => void hooks.push(event) },
        measurements: sink,
        ...(options.resume === undefined ? {} : { resume: { sessionId: options.resume } }),
      };
      const handle = await harness.start(input);
      if (options.cancelWhen !== undefined) {
        const until = Date.now() + 40_000;
        while (!options.cancelWhen() && Date.now() < until) {
          await new Promise((r) => setTimeout(r, 50));
        }
        // Let Codex write the first response to its rollout, and its exporter flush a batch, before the stop.
        await new Promise((r) => setTimeout(r, 6000));
        await harness.cancel(handle, millis(5000));
      }
      const exit = await handle.exit;
      return {
        exit,
        all: sink.observations,
        requests: sink.observations.filter((o) => o.kind === "request"),
        hooks,
        journal: journals.join(""),
      };
    };

    const rolloutOf = (home: string, threadId: string): string => {
      const walk = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
          e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
        );
      const file = walk(join(home, "sessions")).find((f) => f.endsWith(`-${threadId}.jsonl`));
      if (file === undefined) throw new Error("no rollout written for the probe thread");
      return readFileSync(file, "utf8");
    };

    beforeAll(async () => {
      root = mkdtempSync(join(tmpdir(), "codex-offline-probe-"));
      mkdirSync(join(root, "work"), { recursive: true });
      codex = findExecutableOnPath("codex", process.env.PATH) ?? "codex";

      // A two-request turn, then a resume of the same thread.
      const steps: ProviderStep[] = [
        {
          functionCall: { name: "shell_command", arguments: JSON.stringify({ command: SENTINEL }) },
          usage: { input: 1007, cached: 500, output: 41, reasoning: 10 },
        },
        {
          text: `reply ${SENTINEL}`,
          usage: { input: 2007, cached: 1000, output: 42, reasoning: 20 },
        },
        { text: "resumed", usage: { input: 1007, cached: 500, output: 41, reasoning: 10 } },
      ];
      const homeA = join(root, "home-a");
      const providerA = await fakeResponsesProvider(steps);
      try {
        first = await launch(homeA, providerA);
        served.first = providerA.requests
          .filter((r) => r.n > 0 && r.n <= 2)
          .flatMap((r) => (r.usage ? [r.usage] : []));
        const threadId = first.exit.kind === "completed" ? first.exit.sessionId : undefined;
        if (threadId === undefined)
          throw new Error(
            `the first launch gave no thread: ${JSON.stringify(first.exit)} ${JSON.stringify(first.hooks.map((h) => h.payload))}`,
          );
        resumed = await launch(homeA, providerA, { resume: threadId });
        served.resume = providerA.requests
          .filter((r) => r.n === 3)
          .flatMap((r) => (r.usage ? [r.usage] : []));
        rolloutText = rolloutOf(homeA, threadId);
      } finally {
        await providerA.close();
      }

      // A stop after the first response of a two-request turn.
      const providerB = await fakeResponsesProvider([
        {
          functionCall: { name: "shell_command", arguments: JSON.stringify({ command: "true" }) },
          usage: { input: 1007, cached: 500, output: 41, reasoning: 10 },
        },
        { delayMs: 120_000 },
      ]);
      try {
        cancelled = await launch(join(root, "home-b"), providerB, {
          cancelWhen: () => providerB.requests.filter((r) => r.n > 0).length >= 2,
        });
      } finally {
        await providerB.close();
      }

      const evidence = decodeCodexTelemetry(
        [first.journal, resumed.journal]
          .join("")
          .split("\n")
          .filter((l) => l !== "")
          .map((l) => JSON.parse(l) as ReceiverEnvelope | ReceiverGap),
      );
      matrix = buildCapabilityMatrix(evidence, {
        mode: "offline",
        producedAt: new Date().toISOString(),
        rolloutFields: ["response_id", "thread_token_usage", "last_token_usage"],
        dimensions: [
          {
            name: "interrupted_run",
            status: cancelled.requests.length === 1 ? "observed" : "failed",
            note: "a stop after the first response retained exactly that request",
          },
          {
            name: "resume_continuation",
            status: resumed.requests.length === 1 ? "observed" : "failed",
            note: "a resume emitted only its own request; the thread total continued",
          },
          {
            name: "real_backend",
            status: "unverified",
            note: "a scripted loopback provider answered; the real backend was not contacted",
          },
        ],
      });
    }, 85_000);

    afterAll(() => {
      if (root !== undefined) rmSync(root, { recursive: true, force: true });
    });

    const counters = (o: HarnessObservation) => (o.kind === "request" ? o.counters : undefined);

    it("a two-request turn yields two request observations that equal what was served", () => {
      expect(first.exit.kind).toBe("completed");
      expect(first.requests).toHaveLength(2);
      const served1 = served.first ?? [];
      expect(served1).toHaveLength(2);
      first.requests.forEach((o, i) => {
        const u = served1[i];
        expect(counters(o)).toMatchObject({
          inputTokens: u?.input,
          cacheReadTokens: u?.cached,
          outputTokens: u?.output,
          reasoningTokens: u?.reasoning,
          inputIncludesCache: true,
        });
      });
    });

    it("the exit is the session total of both requests, complete", () => {
      expect(first.exit.usageScope).toBe("session");
      expect(first.exit.coverage).toBe("complete");
      const a = served.first ?? [];
      // Cached never added to input, reasoning never added to output.
      expect(first.exit.usage?.inputTokens).toBe((a[0]?.input ?? 0) + (a[1]?.input ?? 0));
      expect(first.exit.usage?.outputTokens).toBe((a[0]?.output ?? 0) + (a[1]?.output ?? 0));
    });

    it("a stop after the first response retains exactly that request as partial coverage", () => {
      expect(cancelled.exit.kind).toBe("cancelled");
      expect(cancelled.requests).toHaveLength(1);
      expect(cancelled.exit.coverage).toBe("partial");
    });

    it("a resume emits only the new request, with a thread-cumulative exit", () => {
      expect(resumed.exit.kind).toBe("completed");
      expect(resumed.requests).toHaveLength(1);
      const u = served.resume?.[0];
      expect(counters(resumed.requests[0] as HarnessObservation)).toMatchObject({
        inputTokens: u?.input,
        outputTokens: u?.output,
      });
      expect(resumed.exit.usageScope).toBe("session");
      const a = served.first ?? [];
      expect(resumed.exit.usage?.inputTokens).toBe(
        (a[0]?.input ?? 0) + (a[1]?.input ?? 0) + (u?.input ?? 0),
      );
      expect(resumed.exit.coverage).toBe("complete");
    });

    it("the matrix built from the run", () => {
      expect(matrix.mode).toBe("offline");
      expect(matrix.harnessVersion).toBe("0.155.1");
      expect(matrix.transports).toEqual(["sse"]);
      expect(matrix.nativeChildren).toBe("not_observed");
      expect(matrix.fieldsObserved).toEqual(
        expect.arrayContaining(["cache_write_token_count", "reasoning_token_count"]),
      );
      expect(matrix.dimensions.find((d) => d.name === "transport_websocket")?.status).toBe(
        "unverified",
      );
    });

    it.skipIf(!WRITE)("regenerates the sanitized fixtures and the offline matrix", () => {
      const lines = (text: string) => text.split("\n").filter((l) => l !== "");
      const files = new Map<string, string[]>([
        ["codex-rollout-measured.jsonl", lines(rolloutText).map(sanitizeRolloutLine)],
        ["codex-otlp-journal-launch1.jsonl", lines(first.journal).map(sanitizeJournalLine)],
        ["codex-otlp-journal-launch2.jsonl", lines(resumed.journal).map(sanitizeJournalLine)],
        ["codex-otlp-cancelled.jsonl", lines(cancelled.journal).map(sanitizeJournalLine)],
      ]);

      // The shape of what was committed: line types, and attribute keys per event.
      const shape = (name: string, ls: readonly string[]): Map<string, Set<string>> => {
        const out = new Map<string, Set<string>>();
        const add = (type: string, keys: Iterable<string>) => {
          const set = out.get(type) ?? new Set<string>();
          for (const k of keys) set.add(k);
          out.set(type, set);
        };
        for (const l of ls) {
          const v = JSON.parse(l) as Record<string, unknown>;
          if (name.includes("rollout")) {
            const p = (v.payload ?? {}) as Record<string, unknown>;
            add(`${String(v.type)}/${String(p.type ?? "")}`, Object.keys(p));
          } else if (Array.isArray(v.records)) {
            for (const r of v.records as { attributes: Record<string, unknown> }[]) {
              add(
                `${String(r.attributes["event.name"])}/${String(r.attributes["event.kind"] ?? "")}`,
                Object.keys(r.attributes),
              );
            }
          } else {
            add(Object.keys(v).sort().join(","), []);
          }
        }
        return out;
      };
      for (const [name, regenerated] of files) {
        const committed = shape(
          name,
          readFileSync(new URL(name, FIXTURES), "utf8")
            .split("\n")
            .filter((l) => l !== ""),
        );
        const fresh = shape(name, regenerated);
        for (const [type, keys] of committed) {
          // A stop can land before the exporter's first batch: the cancelled
          // journal then lacks the conversation start, and that is not a defect.
          if (name.includes("cancelled") && type.startsWith("codex.conversation_starts")) continue;
          const got = fresh.get(type);
          expect(got, `${name}: line type ${type}`).toBeDefined();
          for (const k of keys) expect(got?.has(k), `${name}: ${type} key ${k}`).toBe(true);
        }
      }

      const written = [...files.values()].flat().join("\n") + JSON.stringify(matrix);
      expect(written).not.toContain(SENTINEL);
      for (const [name, ls] of files) writeFileSync(new URL(name, FIXTURES), `${ls.join("\n")}\n`);
      writeCapabilityMatrix(MATRIX_PATH.pathname, matrix);
      expect(readFileSync(MATRIX_PATH, "utf8")).not.toContain(SENTINEL);
    });
  });
}
