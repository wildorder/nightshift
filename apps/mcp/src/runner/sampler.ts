/**
 * What the machine is being asked to do (P10, D-P10-14b).
 *
 * Pure readers over the Linux files the runner samples every interval: memory
 * from `/proc/meminfo`, CPU from two readings of `/proc/stat`, disk from `df`,
 * swap from `/proc/meminfo`, and out-of-memory kills from the kernel log. Each
 * is a function of text, so the folding the API does is tested against real
 * file contents without a Linux box.
 */
import type { UtilizationSample } from "@nightshift/contracts";
import type { Machine } from "./machine.js";

export interface CpuTimes {
  readonly idle: number;
  readonly total: number;
}

/** The first `cpu` line of `/proc/stat`, as idle and total jiffies. */
export const parseCpuTimes = (procStat: string): CpuTimes | undefined => {
  const line = procStat.split("\n").find((candidate) => candidate.startsWith("cpu "));
  if (line === undefined) return undefined;
  const fields = line.trim().split(/\s+/).slice(1).map(Number);
  if (fields.length < 4 || fields.some((field) => Number.isNaN(field))) return undefined;
  const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
  const total = fields.reduce((sum, field) => sum + field, 0);
  return { idle, total };
};

/** CPU busy between two readings, as a percentage. */
export const cpuBusyPct = (before: CpuTimes, after: CpuTimes): number => {
  const total = after.total - before.total;
  if (total <= 0) return 0;
  const idle = after.idle - before.idle;
  return Math.max(0, Math.min(100, ((total - idle) / total) * 100));
};

export interface MemoryReading {
  readonly memoryPct: number;
  readonly swapUsed: boolean;
}

/** `/proc/meminfo`: used over total, with "used" as total minus available. */
export const parseMeminfo = (meminfo: string): MemoryReading | undefined => {
  const values = new Map<string, number>();
  for (const line of meminfo.split("\n")) {
    const match = /^(\w+):\s+(\d+)/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      values.set(match[1], Number.parseInt(match[2], 10));
    }
  }
  const total = values.get("MemTotal");
  const available = values.get("MemAvailable");
  if (total === undefined || available === undefined || total === 0) return undefined;
  const swapTotal = values.get("SwapTotal") ?? 0;
  const swapFree = values.get("SwapFree") ?? swapTotal;
  return {
    memoryPct: Math.max(0, Math.min(100, ((total - available) / total) * 100)),
    swapUsed: swapTotal - swapFree > 0,
  };
};

/** `df --output=pcent <path>`: the use percentage. */
export const parseDiskPct = (df: string): number | undefined => {
  const match = /(\d+)%/.exec(df);
  return match?.[1] === undefined ? undefined : Number.parseInt(match[1], 10);
};

/** Kernel log lines that record an out-of-memory kill. */
export const countOomKills = (dmesg: string): number =>
  dmesg.split("\n").filter((line) => /Out of memory|oom-kill|Killed process/.test(line)).length;

export interface Sampler {
  /** One sample, from the readings since the last. */
  sample(): Promise<UtilizationSample | undefined>;
}

/** A sampler over a machine, keeping the previous CPU reading between samples. */
export const createSampler = (machine: Machine, workspace: string): Sampler => {
  let previous: CpuTimes | undefined;
  return {
    sample: async () => {
      const [stat, meminfo, df, dmesg] = await Promise.all([
        machine.readFile("/proc/stat"),
        machine.readFile("/proc/meminfo"),
        machine.exec("df", ["--output=pcent", workspace]),
        machine.exec("dmesg", ["--level=err,warn", "--notime"]),
      ]);
      const cpu = stat === undefined ? undefined : parseCpuTimes(stat);
      const memory = meminfo === undefined ? undefined : parseMeminfo(meminfo);
      if (cpu === undefined || memory === undefined) return undefined;
      const cpuPct = previous === undefined ? 0 : cpuBusyPct(previous, cpu);
      previous = cpu;
      return {
        memoryPct: memory.memoryPct,
        cpuPct,
        diskPct: df.exitCode === 0 ? (parseDiskPct(df.stdout) ?? 0) : 0,
        swapUsed: memory.swapUsed,
        oomKills: dmesg.exitCode === 0 ? countOomKills(dmesg.stdout) : 0,
      };
    },
  };
};
