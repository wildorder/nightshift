/**
 * A healthy gate-health record for a suite's program (P15, D-P15-08), so a
 * suite about something else can get past `plan check` and `plan ratify`
 * without running the gates. Fingerprinted exactly as `nightshift gates
 * --record` does it, with the CLI's own helper, on the program branch's head.
 */
import { execFileSync } from "node:child_process";
import { fingerprintAtCommit, gitBlobReader, readProgramFiles } from "@nightshift/cli";
import type { GateHealth } from "@nightshift/contracts";
import {
  createFetchTransport,
  createHttpStores,
  staticTokenProvider,
} from "@nightshift/persistence/http";
import type { Operator } from "./operator.js";

export const recordHealthyGates = async (
  op: Pick<Operator, "plane" | "orgId">,
  repo: string,
  id: string,
): Promise<GateHealth> => {
  const files = await readProgramFiles(repo, id);
  const commit = execFileSync("git", ["rev-parse", files.contract.repository.programBranch], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
  const record: GateHealth = {
    schemaVersion: 1,
    projectId: files.contract.projectId,
    programId: files.contract.programId,
    commit: commit as GateHealth["commit"],
    fingerprint: await fingerprintAtCommit(gitBlobReader(repo), commit, files.contract, []),
    verdict: "healthy",
    findings: [],
    machinery: [],
    // The control plane records its caller here, whatever this says.
    auditedBy: { kind: "user", userId: "suite-operator" as never, orgId: op.orgId },
    auditedAt: new Date().toISOString(),
  };
  const stores = createHttpStores({
    transport: createFetchTransport({
      endpoint: op.plane.url,
      tokens: staticTokenProvider("ignored-by-the-local-plane"),
    }),
    actingOrg: op.orgId,
  });
  await stores.gateHealth.put(record);
  return record;
};
