export const shortId = (id: string, count = 8): string => id.slice(-count);
export const shortSha = (sha: string | null | undefined): string =>
  sha === null || sha === undefined ? "—" : sha.slice(0, 8);
export const when = (iso: string | undefined): string =>
  iso === undefined ? "—" : iso.replace("T", " ").replace(/\.\d+Z$/, "Z");
export const durationMs = (ms: number): string =>
  ms < 1000
    ? `${ms} ms`
    : ms < 60_000
      ? `${(ms / 1000).toFixed(1)} s`
      : `${(ms / 60_000).toFixed(1)} min`;
export const between = (start: string | undefined, end: string | undefined): string =>
  start === undefined || end === undefined ? "—" : durationMs(Date.parse(end) - Date.parse(start));
export const usd = (value: number): string => `$${value.toFixed(value < 1 ? 4 : 2)}`;
