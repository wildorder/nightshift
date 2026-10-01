/**
 * One runner machine, from the latest image, to its first heartbeat and back
 * (P10, T2). Run by `npm run runner:boot`, never by `npm test`.
 *
 * The plane is the deployed one. This suite plays the dispatch Lambda's part
 * by hand (T3 moves it into the function): a throwaway org, project, ratified
 * program and remote run; a dispatch on `good`; a volume; a first engine token
 * in SSM; a machine from the launch template. Then it watches the dispatch
 * record for `ready`, measures the machine over SSM (D-P10-17's rootless
 * Docker, a browser, Rust), cancels, and removes what it made. The seconds
 * from launch to the first heartbeat are the number T2 promised.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { KMSClient } from "@aws-sdk/client-kms";
import { S3Client } from "@aws-sdk/client-s3";
import {
  COMPUTE_TIERS,
  type Dispatch,
  DispatchSchema,
  PlanDocumentUploadResponseSchema,
  ProgramContractSchema,
  UserIdSchema,
} from "@nightshift/contracts";
import {
  createUlidIdGenerator,
  type Fixtures,
  makeProgramContract,
  makeProject,
  makeRootNode,
  makeRun,
  nowIso,
  planHash,
  systemClock,
  transitionDispatch,
} from "@nightshift/core";
import { createAwsClients, createAwsStores, keys } from "@nightshift/persistence/aws";
import { afterAll, describe, expect, it } from "vitest";
import { createKmsExecutionTokenSigner } from "../tokens/kms.js";
import { mintEngineToken } from "../tokens/mint.js";
import { deleteObjectsUnder, deletePartitions } from "./cleanup.js";
import { fetchMachineToken, loadSmokeContext, REGION, subjectOf } from "./context.js";
import { smokeApiClient } from "./http.js";

const say = (line: string): void => {
  process.stdout.write(`[runner-boot] ${line}\n`);
};

const aws = (args: readonly string[]): string =>
  execFileSync("aws", [...args, "--region", REGION, "--output", "json"], {
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

const sha256Hex = (input: string): string => createHash("sha256").update(input).digest("hex");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const context = await loadSmokeContext();
const stage = context.stage;
const clients = createAwsClients({ region: REGION });
const stores = createAwsStores({ tableName: context.tableName, table: clients.table });
const token = await fetchMachineToken(context);
const machineSubject = UserIdSchema.parse(subjectOf(token));
const endpoint = context.apiCustomEndpoint;
if (endpoint === undefined) {
  throw new Error("the API stack is zone-only; the runner needs the stable hostname as its issuer");
}
const api = smokeApiClient(endpoint, token);

/** The runner stack's outputs. */
const runnerOutputs = async (): Promise<Record<string, string>> => {
  const cfn = new CloudFormationClient({ region: REGION });
  const described = await cfn.send(
    new DescribeStacksCommand({ StackName: `nightshift-${stage}-runner` }),
  );
  const outputs: Record<string, string> = {};
  for (const output of described.Stacks?.[0]?.Outputs ?? []) {
    if (output.OutputKey !== undefined && output.OutputValue !== undefined) {
      outputs[output.OutputKey] = output.OutputValue;
    }
  }
  return outputs;
};

/** The newest AMI the pipeline built for this image version. */
const latestAmi = (imageVersion: string): string => {
  const images = JSON.parse(
    aws([
      "ec2",
      "describe-images",
      "--owners",
      "self",
      "--filters",
      `Name=tag:nightshift:amiVersion,Values=${imageVersion}`,
      "Name=state,Values=available",
      "--query",
      "Images[].{id:ImageId,created:CreationDate}",
    ]),
  ) as { id: string; created: string }[];
  const newest = [...images].sort((a, b) => b.created.localeCompare(a.created))[0];
  if (newest === undefined) {
    throw new Error(
      `no available AMI tagged nightshift:amiVersion=${imageVersion}; run npm run image:build`,
    );
  }
  return newest.id;
};

// --- What this run writes ---------------------------------------------------------
const ids = createUlidIdGenerator();
const label = `runner-boot-${ids.next("evt").slice("evt_".length)}`;
const orgId = ids.next("org");
const f: Fixtures = {
  ids,
  scope: { projectId: ids.next("proj"), programId: ids.next("prog"), runId: ids.next("run") },
  rootNodeId: ids.next("node"),
};
const projectPath = `/projects/${f.scope.projectId}`;
const programPath = `${projectPath}/programs/${f.scope.programId}`;
const runPath = `${programPath}/runs/${f.scope.runId}`;
const parameterName = `/nightshift/${stage}/dispatch/${f.scope.runId}/1`;

const made = {
  instanceId: undefined as string | undefined,
  volumeId: undefined as string | undefined,
};
const keep = process.env.NIGHTSHIFT_RUNNER_BOOT_KEEP === "1";
const findings: Record<string, unknown> = {};

const expectStatus = (result: { status: number; body: unknown }, status: number): void => {
  expect(result.status, JSON.stringify(result.body)).toBe(status);
};

describe("a runner machine boots to its first heartbeat (P10, T2)", () => {
  it("seeds a ratified remote run, dispatches it, launches the machine, and hears it", async () => {
    const outputs = await runnerOutputs();
    const amiId = latestAmi(outputs.ImageVersion ?? "");
    say(`image ${amiId} (version ${outputs.ImageVersion}, runner at ${outputs.RunnerCommit})`);

    // The org and its one member: the machine principal this suite calls as.
    await stores.memberships.put({
      schemaVersion: 1,
      userId: machineSubject,
      orgId,
      createdAt: nowIso(systemClock),
    });
    expectStatus(
      await api.put(projectPath, { ...makeProject(f, { orgId, name: label }), orgId: undefined }),
      201,
    );

    // A planned program, its document uploaded and ratified (D-P10-09).
    const plan = `# ${label}\n\n## Strands\n\n### S-01 The only strand\n\nA module exists.\n`;
    const contract = makeProgramContract(f, {
      status: "planning",
      strands: [
        {
          id: "S-01",
          name: "The only strand",
          scope: { summary: "the source tree", includes: ["src/**"], excludes: [] },
          acceptance: ["its tests pass"],
          successCriteria: ["SC-01"],
          dependsOn: [],
          prerequisites: [],
        },
      ],
    });
    expectStatus(await api.put(programPath, contract), 201);
    const hash = planHash(contract, plan, sha256Hex);
    const signed = await api.post(`${programPath}/plan-documents/${hash.plan}/upload-url`, {
      sizeBytes: Buffer.byteLength(plan),
    });
    expectStatus(signed, 200);
    const target = PlanDocumentUploadResponseSchema.parse(signed.body);
    const uploaded = await fetch(target.uploadUrl, {
      method: "PUT",
      headers: {
        "content-type": target.contentType,
        "content-length": String(Buffer.byteLength(plan)),
      },
      body: plan,
    });
    expect(uploaded.status, await uploaded.text()).toBe(200);
    const ratified = await api.post(`${programPath}/ratifications`, {
      contract,
      planHash: hash.hash,
      planSha256: hash.plan,
    });
    expectStatus(ratified, 200);
    const program = ProgramContractSchema.parse(ratified.body);

    // A pending remote run and its root, then the dispatch (D-P10-18).
    expectStatus(
      await api.put(runPath, makeRun(f, { status: "pending", location: "remote" })),
      201,
    );
    expectStatus(
      await api.put(
        `${runPath}/nodes/${f.rootNodeId}`,
        makeRootNode(f, {
          status: "validated",
          // A ratified plan's root carries the plan it runs (D-P7-02).
          plan: { planHash: program.planHash, planDocument: program.planDocument },
        }),
      ),
      201,
    );
    const dispatched = await api.post(`${runPath}/dispatch`, {
      tier: "good",
      idempotencyKey: `${f.scope.runId}:boot`,
      input: {
        repositoryUrl: "https://github.com/wildorder/nightshift-remote-fixture",
        branch: "program/runner-boot",
        baseSha: "0".repeat(40),
        planHash: program.planHash,
      },
    });
    expectStatus(dispatched, 201);
    let dispatch = DispatchSchema.parse(dispatched.body);
    say(
      `dispatch requested: ${dispatch.tier} ${dispatch.instanceType} at $${dispatch.usdPerHour}/h`,
    );

    // The dispatch Lambda's part, by hand (T3): a volume, a first token, a machine.
    const subnets = (outputs.MachineSubnetIds ?? "").split(",");
    const subnetId = subnets[0];
    if (subnetId === undefined || subnetId === "")
      throw new Error("the runner stack has no subnets");
    const zone = JSON.parse(
      aws([
        "ec2",
        "describe-subnets",
        "--subnet-ids",
        subnetId,
        "--query",
        "Subnets[0].AvailabilityZone",
      ]),
    ) as string;
    const volume = JSON.parse(
      aws([
        "ec2",
        "create-volume",
        "--availability-zone",
        zone,
        "--size",
        String(COMPUTE_TIERS.good.volumeGiB),
        "--volume-type",
        "gp3",
        "--tag-specifications",
        `ResourceType=volume,Tags=[{Key=nightshift:managed,Value=true},{Key=nightshift-run,Value=${f.scope.runId}},{Key=Name,Value=${label}}]`,
      ]),
    ) as { VolumeId: string };
    made.volumeId = volume.VolumeId;

    const run = makeRun(f, { status: "pending", location: "remote" });
    const minted = await mintEngineToken(
      createKmsExecutionTokenSigner({
        kms: new KMSClient({ region: REGION }),
        keyId: context.executionTokenKeyId,
      }),
      { dispatch, run, program, issuer: endpoint, now: Date.now() },
    );
    aws([
      "ssm",
      "put-parameter",
      "--name",
      parameterName,
      "--type",
      "SecureString",
      "--value",
      minted.token,
      "--overwrite",
    ]);

    const tags = [
      ["nightshift:managed", "true"],
      ["nightshift-project", f.scope.projectId],
      ["nightshift-program", f.scope.programId],
      ["nightshift-run", f.scope.runId],
      ["nightshift-generation", "1"],
      ["nightshift-stage", stage],
      ["nightshift-api", endpoint],
      ["Name", label],
    ]
      .map(([key, value]) => `{Key=${key},Value=${value}}`)
      .join(",");
    const launchedAt = Date.now();
    const launched = JSON.parse(
      aws([
        "ec2",
        "run-instances",
        "--launch-template",
        `LaunchTemplateId=${outputs.LaunchTemplateId}`,
        "--image-id",
        amiId,
        "--instance-type",
        dispatch.instanceType,
        "--subnet-id",
        subnetId,
        "--count",
        "1",
        "--tag-specifications",
        `ResourceType=instance,Tags=[${tags}]`,
      ]),
    ) as { Instances: { InstanceId: string }[] };
    const instanceId = launched.Instances[0]?.InstanceId;
    if (instanceId === undefined) throw new Error("run-instances returned no instance");
    made.instanceId = instanceId;
    say(`launched ${instanceId} in ${zone}`);

    dispatch = transitionDispatch(
      {
        ...dispatch,
        instanceId,
        volumeId: volume.VolumeId,
        availabilityZone: zone,
        amiVersion: outputs.ImageVersion ?? dispatch.amiVersion,
      },
      "provision",
      nowIso(systemClock),
    );
    await stores.dispatches.put(dispatch);

    aws(["ec2", "wait", "instance-running", "--instance-ids", instanceId]);
    aws([
      "ec2",
      "attach-volume",
      "--volume-id",
      volume.VolumeId,
      "--instance-id",
      instanceId,
      "--device",
      "/dev/xvdf",
    ]);
    say("running; volume attached; waiting for the first heartbeat");

    // The runner mounts the volume and reports `ready`.
    let ready: Dispatch | undefined;
    for (let waited = 0; waited < 10 * 60_000; waited += 10_000) {
      await sleep(10_000);
      const current = await api.get(`${runPath}/dispatch`);
      const record = DispatchSchema.parse(current.body);
      if (record.status === "ready" || record.status === "running") {
        ready = record;
        break;
      }
    }
    expect(ready, "the runner never reported ready").toBeDefined();
    findings.secondsToFirstHeartbeat = Math.round((Date.now() - launchedAt) / 1000);
    say(`ready after ${findings.secondsToFirstHeartbeat}s; lease to ${ready?.leaseExpiresAt}`);
    expect(ready?.leaseExpiresAt).toBeDefined();

    // D-P10-17's measurements, over SSM, as a worker user.
    findings.measurements = await measure(instanceId);
    say(`measurements: ${JSON.stringify(findings.measurements)}`);

    // Cancel: the runner hears `stop` on its next heartbeat and reports `stopped`.
    expectStatus(await api.post(`${runPath}/dispatch/cancel`, undefined), 200);
    let stopped = false;
    for (let waited = 0; waited < 3 * 60_000; waited += 10_000) {
      await sleep(10_000);
      const record = DispatchSchema.parse((await api.get(`${runPath}/dispatch`)).body);
      if (record.status === "stopped") {
        stopped = true;
        break;
      }
    }
    expect(stopped, "the runner never reported stopped").toBe(true);
    say("stopped as told");
  });
});

/** The capability table T2 owes the contract (§15), as the machine answers it. */
const measure = async (instanceId: string): Promise<Record<string, string>> => {
  const script = [
    "set +e",
    'echo "node=$(node --version)"',
    'echo "boot_to_runner=$(systemctl show nightshift-runner.service -p ActiveEnterTimestampMonotonic --value)"',
    "sudo -u worker-1 -i bash -c 'dockerd-rootless-setuptool.sh install >/dev/null 2>&1; export DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock; docker run --rm -d --name pg -e POSTGRES_PASSWORD=x -p 15432:5432 postgres:16 >/dev/null 2>&1 && sleep 15 && docker exec pg pg_isready -U postgres >/dev/null 2>&1 && echo rootless_docker_postgres=pass || echo rootless_docker_postgres=fail; docker rm -f pg >/dev/null 2>&1'",
    "sudo -u worker-1 -i bash -c 'export DOCKER_HOST=unix:///run/user/$(id -u)/docker.sock; mkdir -p /tmp/b && printf \"FROM public.ecr.aws/docker/library/alpine:3.20\\nRUN echo hi\\n\" > /tmp/b/Dockerfile && docker build -q -t nightshift-probe /tmp/b >/dev/null 2>&1 && echo docker_build=pass || echo docker_build=fail'",
    "sudo -u worker-1 -i bash -c 'cd /tmp && cargo new --quiet hello >/dev/null 2>&1 && cd hello && cargo build --quiet >/dev/null 2>&1 && echo cargo_build=pass || echo cargo_build=fail'",
    'sudo -u worker-1 -i bash -c \'cd /tmp && mkdir -p pw && cd pw && npm init -y >/dev/null 2>&1 && npm install --no-audit --no-fund playwright@1.56.1 >/dev/null 2>&1 && npx playwright install chromium >/dev/null 2>&1 && node -e "const {chromium}=require(\\"playwright\\");chromium.launch().then(async b=>{const p=await b.newPage();await p.setContent(\\"<h1>hi</h1>\\");console.log(await p.textContent(\\"h1\\"));await b.close()})" 2>/dev/null | grep -q hi && echo chromium=pass || echo chromium=fail\'',
    "curl -s -m 2 http://169.254.169.254/latest/meta-data/ >/dev/null 2>&1 && echo imds_from_engine=reachable || echo imds_from_engine=blocked",
    "sudo -u worker-1 curl -s -m 2 http://169.254.169.254/latest/meta-data/ >/dev/null 2>&1 && echo imds_from_worker=reachable || echo imds_from_worker=blocked",
  ];
  // Through a file: the Windows shell the CLI runs under would strip the quotes
  // out of JSON passed as an argument.
  const parameters = join(tmpdir(), `nightshift-runner-boot-${process.pid}.json`);
  writeFileSync(parameters, JSON.stringify({ commands: script, executionTimeout: ["1500"] }));
  const sent = JSON.parse(
    aws([
      "ssm",
      "send-command",
      "--instance-ids",
      instanceId,
      "--document-name",
      "AWS-RunShellScript",
      "--timeout-seconds",
      "1500",
      "--parameters",
      `file://${parameters.replaceAll("\\", "/")}`,
    ]),
  ) as { Command: { CommandId: string } };
  rmSync(parameters, { force: true });
  for (let waited = 0; waited < 25 * 60_000; waited += 15_000) {
    await sleep(15_000);
    const invocation = JSON.parse(
      aws([
        "ssm",
        "get-command-invocation",
        "--command-id",
        sent.Command.CommandId,
        "--instance-id",
        instanceId,
      ]),
    ) as { Status: string; StandardOutputContent: string; StandardErrorContent: string };
    if (["Success", "Failed", "TimedOut", "Cancelled"].includes(invocation.Status)) {
      const results: Record<string, string> = { status: invocation.Status };
      for (const line of invocation.StandardOutputContent.split("\n")) {
        const match = /^(\w+)=(.*)$/.exec(line.trim());
        if (match?.[1] !== undefined && match[2] !== undefined) results[match[1]] = match[2];
      }
      if (invocation.StandardErrorContent.trim().length > 0) {
        results.stderr = invocation.StandardErrorContent.trim().slice(0, 2000);
      }
      return results;
    }
  }
  return { status: "no answer within 25 minutes" };
};

afterAll(async () => {
  const problems: string[] = [];
  const step = (label: string, work: () => void | Promise<unknown>) =>
    Promise.resolve()
      .then(work)
      .then(() => say(`cleanup: ${label}`))
      .catch((error: unknown) => {
        problems.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      });

  if (keep) {
    say(`--keep: leaving ${made.instanceId ?? "no instance"} and ${made.volumeId ?? "no volume"}`);
  } else {
    if (made.instanceId !== undefined) {
      const instanceId = made.instanceId;
      await step("terminate the machine", () => {
        aws(["ec2", "terminate-instances", "--instance-ids", instanceId]);
        aws(["ec2", "wait", "instance-terminated", "--instance-ids", instanceId]);
      });
    }
    if (made.volumeId !== undefined) {
      const volumeId = made.volumeId;
      await step("delete the volume", () => {
        aws(["ec2", "delete-volume", "--volume-id", volumeId]);
      });
    }
  }
  await step("delete the first token, if it is still there", () => {
    try {
      aws(["ssm", "delete-parameter", "--name", parameterName]);
    } catch {
      // Already taken by the runner, which is the point.
    }
  });
  await step("delete the records", () =>
    deletePartitions(clients.table, context.tableName, [
      keys.orgProject(orgId, f.scope.projectId).PK,
      keys.project(f.scope.projectId).PK,
      keys.run(f.scope, f.scope.runId).PK,
      keys.runRecord(f.scope, "NODE", f.rootNodeId).PK,
      // The org's partition holds its project listing and its compute ledger.
      keys.event(f.scope, f.rootNodeId).PK,
    ]),
  );
  await step("delete the membership", () =>
    clients.table.delete({
      TableName: context.tableName,
      Key: keys.membership(machineSubject, orgId),
    }),
  );
  await step("delete the plan document", () =>
    deleteObjectsUnder(
      new S3Client({ region: REGION }),
      context.bucketName,
      `plans/${f.scope.projectId}/`,
    ),
  );
  say(`findings ${JSON.stringify(findings)}`);
  if (problems.length > 0) {
    console.error(`cleanup problems:\n  ${problems.join("\n  ")}`);
    throw new Error("cleanup left something behind; see above");
  }
});
