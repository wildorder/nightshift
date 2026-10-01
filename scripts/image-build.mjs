#!/usr/bin/env node
/**
 * Build the Nightshift runner image (P10, T2, D-P10-16), from a developer
 * machine only:
 *
 *   AWS_PROFILE=nightshift npm run image:build [-- --stage dev]
 *
 * Starts the runner stack's Image Builder pipeline, waits for the image, and
 * prints the AMI id and the version it carries. Refuses to start outside the
 * v1 account. An image is a version and a version is a decision, so nothing
 * schedules this; an operator runs it when the runner or its toolchain changed
 * and the runner stack was deployed with the new commit.
 */
import { execFileSync } from "node:child_process";
import { assertNightshiftAccount, EXPECTED_REGION, SHELL } from "./aws-account.mjs";

const identity = assertNightshiftAccount();
console.log(`Building the runner image as ${identity.arn} (${identity.account}).`);

const stageFlag = process.argv.indexOf("--stage");
const stage = stageFlag === -1 ? "dev" : process.argv[stageFlag + 1];

const aws = (args) =>
  execFileSync("aws", [...args, "--region", EXPECTED_REGION, "--output", "json"], {
    encoding: "utf8",
    shell: SHELL,
    stdio: ["ignore", "pipe", "inherit"],
  });

const outputs = JSON.parse(
  aws([
    "cloudformation",
    "describe-stacks",
    "--stack-name",
    `nightshift-${stage}-runner`,
    "--query",
    "Stacks[0].Outputs",
  ]),
);
const output = (key) => outputs.find((entry) => entry.OutputKey === key)?.OutputValue;
const pipelineArn = output("ImagePipelineArn");
if (pipelineArn === undefined) {
  console.error(`the runner stack for ${stage} has no ImagePipelineArn output; deploy it first`);
  process.exit(1);
}
console.log(
  `Pipeline ${pipelineArn}; image version ${output("ImageVersion")}; runner at ${output("RunnerCommit")}.`,
);

const started = JSON.parse(
  aws(["imagebuilder", "start-image-pipeline-execution", "--image-pipeline-arn", pipelineArn]),
);
const imageArn = started.imageBuildVersionArn;
console.log(
  `Started ${imageArn}. This takes a while: the toolchain installs and the runner builds.`,
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
for (;;) {
  const image = JSON.parse(
    aws(["imagebuilder", "get-image", "--image-build-version-arn", imageArn]),
  ).image;
  const state = image.state?.status;
  process.stdout.write(`  ${new Date().toISOString()} ${state}\n`);
  if (state === "AVAILABLE") {
    const amis = image.outputResources?.amis ?? [];
    for (const ami of amis) console.log(`AMI ${ami.image} in ${ami.region}: ${ami.name}`);
    break;
  }
  if (state === "FAILED" || state === "CANCELLED" || state === "DEPRECATED") {
    console.error(`image build ${state}: ${image.state?.reason ?? "no reason given"}`);
    process.exit(1);
  }
  await sleep(30_000);
}
