import { describe, expect, it } from "vitest";
import type { Machine } from "./machine.js";
import { findLocalDisk } from "./volume.js";

const machineListing = (stdout: string): Machine => ({
  exec: async () => ({ exitCode: 0, stdout, stderr: "" }),
  readFile: async () => undefined,
  writeFile: async () => undefined,
  http: async () => ({ status: 404, text: "" }),
  sleep: async () => undefined,
  now: () => 0,
});

describe("workspace local disk discovery on process restart", () => {
  it("recognizes the existing local workspace mount so sidecar syncing continues", async () => {
    const machine = machineListing(
      "/dev/nvme0n1 disk Amazon Elastic Block Store\n" +
        "/dev/nvme1n1 disk /workspace-sidecar Amazon Elastic Block Store\n" +
        "/dev/nvme2n1 disk /workspace Amazon EC2 NVMe Instance Storage\n",
    );
    expect(await findLocalDisk(machine, "/workspace")).toBe("/dev/nvme2n1");
    expect(await findLocalDisk(machine)).toBeUndefined();
  });

  it("prefers the surviving workspace over another empty local disk", async () => {
    const machine = machineListing(
      "/dev/nvme1n1 disk Amazon EC2 NVMe Instance Storage\n" +
        "/dev/nvme2n1 disk /workspace Amazon EC2 NVMe Instance Storage\n",
    );
    expect(await findLocalDisk(machine, "/workspace")).toBe("/dev/nvme2n1");
  });

  it("never adopts a local disk mounted at a different path or a prefix match", async () => {
    const machine = machineListing(
      "/dev/nvme1n1 disk /other Amazon EC2 NVMe Instance Storage\n" +
        "/dev/nvme2n1 disk /workspace-other Amazon EC2 NVMe Instance Storage\n",
    );
    expect(await findLocalDisk(machine, "/workspace")).toBeUndefined();
  });

  it("still discovers an unmounted local disk on first boot", async () => {
    expect(
      await findLocalDisk(
        machineListing("/dev/nvme2n1 disk Amazon EC2 NVMe Instance Storage\n"),
        "/workspace",
      ),
    ).toBe("/dev/nvme2n1");
  });

  it("does not confuse a mounted EBS workspace with instance storage", async () => {
    expect(
      await findLocalDisk(
        machineListing("/dev/nvme1n1 disk /workspace Amazon Elastic Block Store\n"),
        "/workspace",
      ),
    ).toBeUndefined();
  });
});
