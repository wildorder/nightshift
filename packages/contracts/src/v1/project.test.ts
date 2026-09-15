import { describe, expect, it } from "vitest";
import { AGGREGATE_EXAMPLES } from "./examples.js";
import { CrossAccountAccessSchema, ProjectSchema } from "./project.js";

const project = AGGREGATE_EXAMPLES.Project as Record<string, unknown>;

const withCrossAccount = (crossAccount: unknown) => ({ ...project, crossAccount });

describe("Project cross-account fields (D-P2-14, reserved)", () => {
  it("accepts a project with no cross-account access", () => {
    const { crossAccount: _omitted, ...bare } = project;
    expect(ProjectSchema.safeParse(bare).success).toBe(true);
  });

  it("accepts a role ARN with an external ID", () => {
    const result = ProjectSchema.safeParse(
      withCrossAccount({
        roleArn: "arn:aws:iam::123456789012:role/path/nightshift-workload",
        externalId: "a8Kq-2f:z@x",
      }),
    );
    expect(result.error?.issues ?? []).toEqual([]);
  });

  it("requires both halves together", () => {
    expect(
      ProjectSchema.safeParse(
        withCrossAccount({ roleArn: "arn:aws:iam::123456789012:role/nightshift" }),
      ).success,
    ).toBe(false);
    expect(ProjectSchema.safeParse(withCrossAccount({ externalId: "abc" })).success).toBe(false);
  });

  it("rejects an ARN that is not an IAM role", () => {
    for (const roleArn of [
      "arn:aws:iam::123456789012:user/someone",
      "arn:aws:s3:::bucket",
      "arn:aws:iam::12345:role/short-account",
      "role/nightshift",
    ]) {
      expect(CrossAccountAccessSchema.safeParse({ roleArn, externalId: "abc" }).success).toBe(
        false,
      );
    }
  });

  it("enforces the AWS external ID bounds", () => {
    const roleArn = "arn:aws:iam::123456789012:role/nightshift";
    expect(CrossAccountAccessSchema.safeParse({ roleArn, externalId: "a" }).success).toBe(false);
    expect(
      CrossAccountAccessSchema.safeParse({ roleArn, externalId: "a".repeat(1225) }).success,
    ).toBe(false);
    expect(CrossAccountAccessSchema.safeParse({ roleArn, externalId: "has space" }).success).toBe(
      false,
    );
  });
});
