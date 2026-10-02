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
const archFlag = process.argv.indexOf("--arch");
const arch = archFlag === -1 ? "all" : process.argv[archFlag + 1];
const wanted = {
  arm64: output("ImagePipelineArn"),
  x86_64: output("ImagePipelineArnX86"),
};
const pipelines = Object.entries(wanted).filter(
  ([name, arn]) => arn !== undefined && (arch === "all" || arch === name),
);
if (pipelines.length === 0) {
  console.error(
    `the runner stack for ${stage} has no pipeline for --arch ${arch}; deploy it first`,
  );
  process.exit(1);
}
console.log(
  `Image version ${output("ImageVersion")}; runner at ${output("RunnerCommit")}; building ${pipelines
    .map(([name]) => name)
    .join(" and ")}.`,
);

const started = pipelines.map(([name, arn]) => ({
  name,
  imageArn: JSON.parse(
    aws(["imagebuilder", "start-image-pipeline-execution", "--image-pipeline-arn", arn]),
  ).imageBuildVersionArn,
}));
for (const build of started) console.log(`Started ${build.name}: ${build.imageArn}.`);
console.log("This takes a while: the toolchain installs and the runner builds.");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pending = new Set(started.map((build) => build.name));
let failed = false;
while (pending.size > 0) {
  for (const build of started) {
    if (!pending.has(build.name)) continue;
    const image = JSON.parse(
      aws(["imagebuilder", "get-image", "--image-build-version-arn", build.imageArn]),
    ).image;
    const state = image.state?.status;
    process.stdout.write(`  ${new Date().toISOString()} ${build.name} ${state}\n`);
    if (state === "AVAILABLE") {
      for (const ami of image.outputResources?.amis ?? []) {
        console.log(`AMI ${ami.image} in ${ami.region} (${build.name}): ${ami.name}`);
      }
      pending.delete(build.name);
    } else if (state === "FAILED" || state === "CANCELLED" || state === "DEPRECATED") {
      console.error(
        `image build ${build.name} ${state}: ${image.state?.reason ?? "no reason given"}`,
      );
      pending.delete(build.name);
      failed = true;
    }
  }
  if (pending.size > 0) await sleep(30_000);
}
if (failed) process.exit(1);
