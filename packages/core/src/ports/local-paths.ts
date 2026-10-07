/**
 * Where local machinery puts things on this machine (D-P3-10).
 *
 * A port rather than a module, for the same reason the stores are: the execution
 * layer needs worktrees, spools and transcript paths, and it must not reach into
 * `persistence` to get them. The implementation lives beside the rest of the
 * local session in `@nightshift/persistence/http`, where the config and state
 * directories and their platform defaults already are, and an application wires
 * the two together.
 *
 * Declaring it here is what makes the two agree: a change to either side that
 * broke the other fails to compile, rather than producing two modules with
 * slightly different ideas about where a spool file lives.
 *
 * Nothing here is ever inside the program checkout. Nightshift writes into the
 * operator's repository only by fast-forwarding its branch (A-29).
 */

export interface LocalPaths {
  /**
   * The isolated worktree for one node.
   *
   * Kept short: Windows still enforces a 260-character limit in many APIs and a
   * worktree holds a whole checkout, so an implementation should not spend the
   * budget on full identifiers. The full ids are on the node's record.
   */
  worktree(runId: string, nodeId: string): string;
  /** One run's local state: the spool, and the agents' directories. */
  runDir(runId: string): string;
  /** The outbox's spill file for a run, replayed by the next server to attach. */
  spool(runId: string): string;
  /** Where an adapter writes an agent's raw transcript until it is uploaded. */
  transcript(runId: string, agentId: string): string;
  /**
   * The temp directory every process in `checkout` is given (P15): one per
   * checkout, on the state directory's disk, never the machine's shared `/tmp`.
   *
   * Short and of fixed length, whatever the checkout's own path: a temp
   * directory is where tools put unix sockets, and a socket's path may not
   * exceed 104 bytes on macOS (108 on Linux). Derived from the checkout so that
   * whoever cleans up finds it again. A directory beside the checkout inherited
   * the checkout's length, and tsx's IPC socket under a gate audit's checkout
   * reached 114 bytes and failed every migration (keki-backend, 2026-10-07).
   */
  scratch(checkout: string): string;
}
