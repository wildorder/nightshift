import type { Project } from "@nightshift/contracts";
import { useQuery } from "@tanstack/react-query";
import { useStudio } from "./studio.js";

/** The acting organisation's projects, shared by the switcher and the projects page. */
export const useProjects = () => {
  const { stores, orgId } = useStudio();
  return useQuery({
    queryKey: ["projects", orgId],
    queryFn: async (): Promise<readonly Project[]> =>
      orgId === undefined ? [] : (await stores.projects.listByOrg(orgId, { limit: 100 })).items,
  });
};
