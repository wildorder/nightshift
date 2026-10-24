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

/** How long ago `ms` milliseconds is, in the largest unit that says it: `5 min ago`, `3 h ago`, `2 d ago`. */
export const ago = (ms: number): string => {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
};

/**
 * A time a person reads at a glance, in their own time zone: `Oct 24, 3:12 PM`,
 * with how long ago when `now` is given. `—` for none.
 */
export const readable = (iso: string | undefined, now?: number): string => {
  if (iso === undefined) return "—";
  const at = Date.parse(iso);
  const shown = new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return now === undefined ? shown : `${shown} · ${ago(now - at)}`;
};
