import type { ProgramScope } from "@nightshift/core";

/** The Studio route of a program's plan page. */
export const planPathOf = (scope: ProgramScope): string =>
  `/projects/${scope.projectId}/programs/${scope.programId}/plan`;
