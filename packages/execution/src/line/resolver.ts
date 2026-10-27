import type { LineFailure, LineResolution, LineResolverPorts } from "./ports.js";

export const resolveLineFailure = async (
  _ports: LineResolverPorts,
  _failure: LineFailure,
): Promise<LineResolution> => {
  throw new Error("not implemented");
};
