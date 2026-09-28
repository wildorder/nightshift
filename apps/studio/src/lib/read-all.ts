import type { Page, PageRequest } from "@nightshift/core";

/** Drains a paged list, as the CLI's commands do. */
export const readAll = async <T>(
  list: (page: PageRequest) => Promise<Page<T>>,
  limit = 100,
): Promise<readonly T[]> => {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    const page = await list(cursor === undefined ? { limit } : { limit, cursor });
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor !== undefined);
  return items;
};
