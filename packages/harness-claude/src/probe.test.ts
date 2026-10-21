/**
 * The capture probe: its gate and its reductions are proven offline; the live
 * suite below is skipped by name unless `NIGHTSHIFT_CLAUDE_CAPTURE_PROBE=1`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MeasurementObservationSchema } from "@nightshift/contracts";
import type { HarnessExit, HarnessObservation, HookEvent } from "@nightshift/harness";
import { describe, expect, it } from "vitest";
import type { ClaudeCaptureReport } from "./adapter.js";
import {
  buildClaudeProbeEvidence,
  CLAUDE_CAPTURE_KEEP_ENV,
  CLAUDE_CAPTURE_PROBE_ENV,
  CLAUDE_PROBE_DIMENSIONS,
  claudeCaptureProbeGate,
  claudeProbeObjective,
  runClaudeProbeDimension,
  sanitizeClaudeProbeJournal,
} from "./probe.js";

describe("the probe gate", () => {
  it("is closed when unset, and says why", () => {
    const gate = claudeCaptureProbeGate({});
    expect(gate.enabled).toBe(false);
    expect(gate.reason).toContain("skipped");
    expect(gate.reason).toContain("sign-in");
    expect(gate.reason).toContain(CLAUDE_CAPTURE_PROBE_ENV);
    expect(gate.reason).toContain("It is skipped, not passed.");
  });

  it("is open only for exactly 1", () => {
    expect(claudeCaptureProbeGate({ [CLAUDE_CAPTURE_PROBE_ENV]: "1" }).enabled).toBe(true);
    for (const v of ["true", "0", "1 ", ""]) {
      const gate = claudeCaptureProbeGate({ [CLAUDE_CAPTURE_PROBE_ENV]: v });
      expect(gate.enabled).toBe(false);
      expect(gate.reason).toContain(JSON.stringify(v));
    }
  });

  // Closed in `npm test`; the one run that opts in is the probe itself.
  it.skipIf(process.env[CLAUDE_CAPTURE_PROBE_ENV] !== undefined)(
    "is closed in this process, so npm test spawns nothing",
    () => {
      expect(claudeCaptureProbeGate().enabled).toBe(false);
    },
  );
});

const SESSION = "11111111-aaaa-4aaa-8aaa-session000001";
const REQUEST = "req_SECRETREQUEST0001";
const CLIENT = "22222222-bbbb-4bbb-8bbb-client0000001";
const PROMPT = "33333333-cccc-4ccc-8ccc-prompt0000001";
const USER = "user-hash-abcdef0123456789";
const ERROR_TEXT = "Could not resolve authentication method for sk-ant-LEAK";

const journalLine = JSON.stringify({
  receivedAt: "2026-10-21T10:00:03.000Z",
  path: "/v1/logs",
  records: [
    {
      eventName: "api_request",
      attributes: {
        "event.name": "api_request",
        "session.id": SESSION,
        request_id: REQUEST,
        client_request_id: CLIENT,
        "prompt.id": PROMPT,
        "user.id": USER,
        error: ERROR_TEXT,
        input_tokens: 12,
        query_source: "main",
      },
      resourceAttributes: { "session.id": SESSION },
    },
  ],
});

describe("the journal sanitizer", () => {
  const out = sanitizeClaudeProbeJournal(`${journalLine}\n${journalLine}\n{"torn":`);

  it("replaces exactly the identifier keys and redacts text keys", () => {
    for (const secret of [SESSION, REQUEST, CLIENT, PROMPT, USER, ERROR_TEXT, "sk-ant"]) {
      expect(out.text).not.toContain(secret);
    }
    const first = JSON.parse(out.text.split("\n")[0] ?? "") as {
      records: { attributes: Record<string, unknown> }[];
    };
    const a = first.records[0]?.attributes ?? {};
    expect(a["session.id"]).toBe("<session.id#1>");
    expect(a.request_id).toBe("<request_id#1>");
    expect(a["client_request_id"]).toBe("<client_request_id#1>");
    expect(a["prompt.id"]).toBe("<prompt.id#1>");
    expect(a["user.id"]).toBe("<user.id#1>");
    expect(a.error).toBe("<redacted>");
    expect(a.input_tokens).toBe(12);
    expect(a.query_source).toBe("main");
    expect(a["event.name"]).toBe("api_request");
  });

  it("keeps placeholders stable across duplicate lines and drops the torn tail", () => {
    const [one, two] = out.text.split("\n");
    expect(one).toBe(two);
    expect(out.droppedLines).toBe(1);
  });
});

const event = (type: HookEvent["type"], payload: Record<string, unknown> = {}): HookEvent => ({
  type,
  occurredAt: "2026-10-21T10:00:00.000Z",
  payload,
});

const report: ClaudeCaptureReport = {
  agentId: "agent_SECRETAGENT",
  mode: "otlp",
  journalPath: "/tmp/never-read",
  result: {
    requests: 2,
    apiErrors: 1,
    droppedRecords: 0,
    droppedAttributes: 3,
    unidentifiedRequests: 0,
    requestsWithoutCounters: 0,
    complete: true,
    reasons: [],
    diagnostics: {
      transport: { paths: ["/v1/logs"], contentTypes: ["application/json"] },
      resourceAttributeKeys: ["service.name", "host.arch"],
      appVersions: ["2.1.286"],
      eventCounts: { api_request: 2, api_error: 1, [ERROR_TEXT]: 4 },
      apiRequest: {
        attributeTypes: { model: "string", input_tokens: "number" },
        present: {
          request_id: true,
          client_request_id: true,
          "session.id": true,
          cost_usd: true,
          cost_usd_micros: false,
          duration_ms: true,
          effort: false,
          speed: true,
          "agent.name": false,
          query_source: true,
          "event.timestamp": true,
          "event.sequence": true,
        },
        querySourceClasses: { main: 1, child: 1, compact: 0, other: 0 },
        withoutCounters: 0,
      },
      droppedAttributeCount: 3,
    },
  },
};

describe("the evidence builder", () => {
  const exit: HarnessExit = {
    kind: "completed",
    result: ERROR_TEXT,
    sessionId: SESSION,
    usage: { inputTokens: 1, outputTokens: 2 },
    usageScope: "session",
    coverage: "complete",
    inclusion: "includes_children",
    observedModel: "claude-sonnet-x",
  } as HarnessExit;
  const evidence = buildClaudeProbeEvidence({
    dimension: "child",
    observedAt: "2026-10-21T10:00:09.000Z",
    report,
    hookEvents: [
      event("agent.started", { harnessVersion: "2.1.286", sessionId: SESSION }),
      event("agent.subagent_created", { subagentType: "Explore", summary: ERROR_TEXT }),
      event("tool.called", { summary: ERROR_TEXT }),
    ],
    exit,
    observations: [],
  });
  const text = JSON.stringify(evidence);

  it("holds no identifier value and no text", () => {
    for (const secret of [SESSION, REQUEST, CLIENT, PROMPT, USER, ERROR_TEXT, "agent_SECRET"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("records versions, names, types, presence, counts, kinds and reasons", () => {
    expect(evidence.claudeCodeVersion).toBe("2.1.286");
    expect(evidence.captureMode).toBe("otlp");
    expect(evidence.transport?.paths).toEqual(["/v1/logs"]);
    expect(evidence.resourceAttributeKeys).toEqual(["service.name", "host.arch"]);
    expect(evidence.appVersions).toEqual(["2.1.286"]);
    expect(evidence.eventCounts).toEqual({ api_request: 2, api_error: 1 });
    expect(evidence.apiRequest?.present.cost_usd_micros).toBe(false);
    expect(evidence.requests).toBe(2);
    expect(evidence.dropped?.attributes).toBe(3);
    expect(evidence.exit).toEqual({
      kind: "completed",
      coverage: "complete",
      usageScope: "session",
      inclusion: "includes_children",
      hasUsage: true,
      observedModel: "claude-sonnet-x",
    });
    expect(evidence.stream.sawSubagent).toBe(true);
    expect(evidence.stream.sawCompactBoundary).toBe(false);
  });

  it("reports a missing capture result honestly", () => {
    const bare = buildClaudeProbeEvidence({
      dimension: "main",
      observedAt: "2026-10-21T10:00:09.000Z",
      report: undefined,
      hookEvents: [],
      exit: { kind: "failed", exitCode: 1 },
      observations: [],
      unverified: "live capability unverified: x",
    });
    expect(bare.captureMode).toBe("none");
    expect(bare.requests).toBeUndefined();
    expect(bare.unverified).toBe("live capability unverified: x");
  });
});

describe("the dimensions", () => {
  it("each ask for something different", () => {
    const objectives = CLAUDE_PROBE_DIMENSIONS.map(claudeProbeObjective);
    expect(new Set(objectives).size).toBe(4);
    expect(claudeProbeObjective("child")).toContain("Explore");
    expect(claudeProbeObjective("compaction")).toContain("/compact");
  });
});

// ---------------------------------------------------------------------------
// The live suite

const U = "01HF7YAT00GGGGGGGGGGGGGGGG";
const stamp = (o: HarnessObservation) => ({
  ...o,
  projectId: `proj_${U}`,
  programId: `prog_${U}`,
  runId: `run_${U}`,
  executionNodeId: `node_${U}`,
  receivedAt: "2026-10-21T10:00:10.000Z",
});

const gate = claudeCaptureProbeGate();
const keepDir = process.env[CLAUDE_CAPTURE_KEEP_ENV];
const GENEROUS = 300_000;

if (!gate.enabled) {
  it.skip(`claude capture probe — ${gate.reason}`, () => {});
} else {
  describe("claude capture probe (live)", () => {
    for (const dimension of CLAUDE_PROBE_DIMENSIONS) {
      it(
        `dimension: ${dimension}`,
        async () => {
          const worktree = mkdtempSync(join(tmpdir(), "nightshift-probe-"));
          try {
            const run = await runClaudeProbeDimension(dimension, {
              worktree,
              timeoutMs: GENEROUS - 30_000,
            });
            const json = `${JSON.stringify(run.evidence, null, 2)}\n`;
            if (keepDir === undefined) {
              console.log(`--- ${dimension}.evidence.json\n${json}`);
              if (run.journal !== undefined) {
                console.log(`--- ${dimension}.journal.ndjson\n${run.journal}`);
              }
            } else {
              mkdirSync(keepDir, { recursive: true });
              writeFileSync(join(keepDir, `${dimension}.evidence.json`), json);
              if (run.journal !== undefined) {
                writeFileSync(join(keepDir, `${dimension}.journal.ndjson`), run.journal);
              }
            }
            const unparsed = run.observations.filter(
              (o) => !MeasurementObservationSchema.safeParse(stamp(o)).success,
            );
            expect(unparsed).toEqual([]);
            expect(run.faults).toEqual([]);
          } finally {
            rmSync(worktree, { recursive: true, force: true });
          }
        },
        GENEROUS,
      );
    }
  });
}
