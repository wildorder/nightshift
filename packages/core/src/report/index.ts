/**
 * The read models a run is shown through (P7 … P9; moved here in P11, D-P11-07).
 *
 * Written from the control plane alone: every fact is a record read through
 * the store ports, so the terminal's `nightshift report`, the MCP server and
 * the Studio render one computation. Pure over `ProjectStores`, which is why
 * these live in `core` and not above the execution layer.
 */
export {
  type CorrectionReport,
  type DecisionPlace,
  type DecisionReport,
  gatherCorrections,
  gatherDecisionGraph,
  renderCorrections,
  renderDecisionGraph,
} from "./decision-graph.js";
export { environmentFaultOf, renderEnvironmentFault } from "./environment-fault.js";
export {
  DEPARTURE_PREFIX,
  type FlakeReport,
  type GateHealthReport,
  gatherReport,
  type JobReport,
  type RepairReport,
  type RulingReport,
  type RunReport,
  renderReport,
  type StrandReport,
  type UsageRow,
} from "./report.js";
export {
  type ProgramStatus,
  programStatus,
  type WaitingItem,
  type WaitingKind,
} from "./status.js";
export {
  plannedDecisionIdOf,
  type StoryRecords,
  type StoryStatus,
  type StoryTarget,
  storiesOf,
  storiesOfStrands,
  storyStatuses,
  strandOfNode,
  strandsOfDecision,
} from "./stories.js";
