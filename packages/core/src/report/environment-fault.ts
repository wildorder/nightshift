/**
 * An environment fault, as a reader is shown it (P16 S-02, D-07): each gate
 * green in the laptop's reference audit and red on the run's machine, both
 * verdicts, the last of both outputs, and both Node versions, side by side.
 *
 * The report's gate-health section and `nightshift remote status` render it
 * from here; the Studio draws the same `EnvironmentFaultPayload`. Pure.
 */
import {
  type EnvironmentFaultPayload,
  EnvironmentFaultPayloadSchema,
  type Event,
} from "@nightshift/contracts";

/**
 * The run's environment fault, from its events: every part's gates together,
 * in order, each once. `undefined` when the run had none.
 */
export const environmentFaultOf = (
  events: readonly Pick<Event, "type" | "payload">[],
): EnvironmentFaultPayload | undefined => {
  const parts = events.flatMap((event) => {
    if (event.type !== "environment.fault") return [];
    const parsed = EnvironmentFaultPayloadSchema.safeParse(event.payload);
    return parsed.success ? [parsed.data] : [];
  });
  const [first] = [...parts].sort((a, b) => (a.part ?? 1) - (b.part ?? 1));
  if (first === undefined) return undefined;
  const seen = new Set<string>();
  const gates = [...parts]
    .sort((a, b) => (a.part ?? 1) - (b.part ?? 1))
    .flatMap((part) => part.gates)
    .filter((gate) => {
      if (seen.has(gate.id)) return false;
      seen.add(gate.id);
      return true;
    });
  const { part: _part, parts: _parts, ...whole } = first;
  return { ...whole, gates };
};

/** A fence no backtick run in `text` can close. */
const fenced = (text: string): string[] => {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = "`".repeat(longest + 1);
  return [`${fence}text`, text, fence];
};

const nodeOf = (version: string | undefined): string =>
  version === undefined ? "no Node" : `Node ${version}`;

/**
 * The fault in Markdown: a table of each gate with both verdicts under both
 * Nodes, then each gate's two output tails, the reference's then the machine's.
 */
export const renderEnvironmentFault = (fault: EnvironmentFaultPayload): string[] => {
  const reference = nodeOf(fault.referenceNode);
  const machine = nodeOf(fault.machineNode);
  return [
    `Environment fault: ${fault.gates.length === 1 ? "a gate" : `${fault.gates.length} gates`} passed in the ` +
      `reference audit of \`${fault.baseCommit.slice(0, 8)}\` and failed on the run's machine. The machine ` +
      "is at fault, not the project: nothing was repaired, and the run was cancelled.",
    "",
    `| Gate | Command | Reference (${reference}) | Machine (${machine}) |`,
    "|---|---|---|---|",
    ...fault.gates.map(
      (gate) =>
        `| \`${gate.id}\` | \`${gate.command.replace(/\|/g, "\\|")}\` | ${gate.reference} | ${gate.machine} |`,
    ),
    "",
    ...fault.gates.flatMap((gate) => [
      `\`${gate.id}\`, the reference (${reference}), ${gate.reference}:`,
      "",
      ...(gate.referenceTail === undefined ? ["(no output was kept)"] : fenced(gate.referenceTail)),
      "",
      `\`${gate.id}\`, the machine (${machine}), ${gate.machine}:`,
      "",
      ...(gate.machineTail === undefined ? ["(no output was kept)"] : fenced(gate.machineTail)),
      "",
    ]),
  ];
};
