/**
 * `ComputeControl` over EC2 (P10, D-P10-15, D-P10-18): the machines, their
 * workspace volumes and the warm snapshots, for the dispatch Lambda and the
 * reconciler. `FirstTokenStore` over SSM beside it: the parameter a machine's
 * first token waits in.
 */
import {
  CreateSnapshotCommand,
  DeleteSnapshotCommand,
  DeleteVolumeCommand,
  DescribeImagesCommand,
  DescribeInstancesCommand,
  DescribeSnapshotsCommand,
  type EC2Client,
  RunInstancesCommand,
  TerminateInstancesCommand,
} from "@aws-sdk/client-ec2";
import { DeleteParameterCommand, PutParameterCommand, type SSMClient } from "@aws-sdk/client-ssm";
import type { ComputeControl, FirstTokenStore, InstanceDescription } from "@nightshift/core";

export interface Ec2ComputeOptions {
  readonly ec2: EC2Client;
  readonly launchTemplateId: string;
  /** The tag the image pipeline writes (`AMI_VERSION_TAG`). */
  readonly imageVersionTag: string;
}

const tagList = (tags: Readonly<Record<string, string>>) =>
  Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));

export const createEc2Compute = (options: Ec2ComputeOptions): ComputeControl => {
  const { ec2 } = options;
  return {
    latestImage: async (imageVersion, architecture) => {
      const images = await ec2.send(
        new DescribeImagesCommand({
          Owners: ["self"],
          Filters: [
            { Name: `tag:${options.imageVersionTag}`, Values: [imageVersion] },
            { Name: "architecture", Values: [architecture] },
            { Name: "state", Values: ["available"] },
          ],
        }),
      );
      const newest = [...(images.Images ?? [])].sort((a, b) =>
        (b.CreationDate ?? "").localeCompare(a.CreationDate ?? ""),
      )[0];
      return newest?.ImageId;
    },
    launch: async (request) => {
      const launched = await ec2.send(
        new RunInstancesCommand({
          LaunchTemplate: { LaunchTemplateId: options.launchTemplateId },
          ImageId: request.imageId,
          InstanceType: request.instanceType as never,
          SubnetId: request.subnetId,
          MinCount: 1,
          MaxCount: 1,
          // The workspace, made at launch from the warm snapshot or empty, and
          // kept when the instance goes: it is the recovery point (D-P10-15).
          BlockDeviceMappings: [
            {
              DeviceName: request.volume.device,
              Ebs: {
                VolumeType: "gp3",
                VolumeSize: request.volume.sizeGiB,
                DeleteOnTermination: false,
                ...(request.volume.iops === undefined ? {} : { Iops: request.volume.iops }),
                ...(request.volume.throughputMiBps === undefined
                  ? {}
                  : { Throughput: request.volume.throughputMiBps }),
                ...(request.volume.fromSnapshotId === undefined
                  ? {}
                  : { SnapshotId: request.volume.fromSnapshotId }),
              },
            },
          ],
          TagSpecifications: [
            { ResourceType: "instance", Tags: tagList(request.tags) },
            { ResourceType: "volume", Tags: tagList(request.tags) },
          ],
        }),
      );
      const instanceId = launched.Instances?.[0]?.InstanceId;
      if (instanceId === undefined) throw new Error("RunInstances returned no instance");
      return { instanceId };
    },
    describe: async (instanceId) => {
      const described = await ec2
        .send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }))
        .catch((error: unknown) => {
          if ((error as { name?: string }).name === "InvalidInstanceID.NotFound") return undefined;
          throw error;
        });
      const instance = described?.Reservations?.[0]?.Instances?.[0];
      if (instance === undefined) return undefined;
      const workspace = instance.BlockDeviceMappings?.find(
        (mapping) => mapping.DeviceName !== instance.RootDeviceName,
      );
      const description: InstanceDescription = {
        instanceId,
        state: (instance.State?.Name ?? "pending") as InstanceDescription["state"],
        ...(instance.Placement?.AvailabilityZone === undefined
          ? {}
          : { availabilityZone: instance.Placement.AvailabilityZone }),
        ...(workspace?.Ebs?.VolumeId === undefined
          ? {}
          : { workspaceVolumeId: workspace.Ebs.VolumeId }),
      };
      return description;
    },
    terminate: async (instanceId) => {
      await ec2
        .send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }))
        .catch((error: unknown) => {
          if ((error as { name?: string }).name === "InvalidInstanceID.NotFound") return;
          throw error;
        });
    },
    snapshot: async ({ volumeId, tags }) => {
      const created = await ec2.send(
        new CreateSnapshotCommand({
          VolumeId: volumeId,
          Description: "Nightshift warm workspace",
          TagSpecifications: [{ ResourceType: "snapshot", Tags: tagList(tags) }],
        }),
      );
      if (created.SnapshotId === undefined) throw new Error("CreateSnapshot returned no id");
      return { snapshotId: created.SnapshotId };
    },
    describeSnapshot: async (snapshotId) => {
      const described = await ec2
        .send(new DescribeSnapshotsCommand({ SnapshotIds: [snapshotId] }))
        .catch((error: unknown) => {
          if ((error as { name?: string }).name === "InvalidSnapshot.NotFound") return undefined;
          throw error;
        });
      const snapshot = described?.Snapshots?.[0];
      if (snapshot === undefined) return undefined;
      const state =
        snapshot.State === "completed"
          ? "completed"
          : snapshot.State === "error"
            ? "error"
            : "pending";
      return { snapshotId, state };
    },
    deleteVolume: async (volumeId) => {
      await ec2.send(new DeleteVolumeCommand({ VolumeId: volumeId })).catch((error: unknown) => {
        if ((error as { name?: string }).name === "InvalidVolume.NotFound") return;
        throw error;
      });
    },
    deleteSnapshot: async (snapshotId) => {
      await ec2
        .send(new DeleteSnapshotCommand({ SnapshotId: snapshotId }))
        .catch((error: unknown) => {
          if ((error as { name?: string }).name === "InvalidSnapshot.NotFound") return;
          throw error;
        });
    },
  };
};

export const createSsmFirstTokens = (ssm: SSMClient): FirstTokenStore => ({
  put: async (name, token) => {
    await ssm.send(
      new PutParameterCommand({ Name: name, Value: token, Type: "SecureString", Overwrite: true }),
    );
  },
  delete: async (name) => {
    await ssm.send(new DeleteParameterCommand({ Name: name })).catch((error: unknown) => {
      if ((error as { name?: string }).name === "ParameterNotFound") return;
      throw error;
    });
  },
});
