/**
 * Git's smart HTTP protocol, the receive-pack half, in `fetch` (P10, T4,
 * D-P10-22).
 *
 * The publisher pushes a program branch from a Lambda that has no `git`
 * binary and must not need one: the push is two HTTP requests. The first,
 * `GET …/info/refs?service=git-receive-pack`, advertises the remote's refs and
 * its capabilities. The second, `POST …/git-receive-pack`, carries one command
 * line, `<old> <new> <ref>`, and the packfile of every object the remote lacks.
 * The remote accepts the command only when `<old>` is what the ref holds at
 * that moment: that compare-and-set **is** `--force-with-lease=<ref>:<old>`,
 * done where the race actually is, and it is why a conflict here is never a
 * force. The pack is not thin (`git pack-objects` without `--thin`), so the
 * remote needs nothing from the pusher but what the pack holds.
 *
 * Only what GitHub speaks is implemented: protocol v0 ref advertisement,
 * `report-status`, no side-band, no push options, no v2.
 */

export interface AdvertisedRefs {
  /** Ref name → object id, as advertised. */
  readonly refs: ReadonlyMap<string, string>;
  readonly capabilities: ReadonlySet<string>;
}

export type PushOutcome =
  | { readonly kind: "ok" }
  /** The remote refused the ref update; `reason` is its word, e.g. `non-fast-forward`, `protected branch hook declined`. */
  | { readonly kind: "rejected"; readonly reason: string }
  /** The pack did not unpack, or the response was not a report. */
  | { readonly kind: "error"; readonly detail: string };

export type FetchLike = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: Uint8Array;
  },
) => Promise<{
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}>;

export const ZERO_OID = "0".repeat(40);
const AGENT = "agent=nightshift-publisher";

export class SmartHttpError extends Error {
  override readonly name = "SmartHttpError";
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(detail);
  }
}

// --- pkt-line --------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** One pkt-line: a four-hex-digit length including itself, then the payload. */
export const pktLine = (payload: Uint8Array | string): Uint8Array => {
  const bytes = typeof payload === "string" ? encoder.encode(payload) : payload;
  const length = (bytes.length + 4).toString(16).padStart(4, "0");
  const out = new Uint8Array(bytes.length + 4);
  out.set(encoder.encode(length), 0);
  out.set(bytes, 4);
  return out;
};

export const FLUSH_PKT = encoder.encode("0000");

/** Every pkt-line in `bytes`, in order; a flush is an empty entry. */
export const readPktLines = (bytes: Uint8Array): Uint8Array[] => {
  const lines: Uint8Array[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const length = Number.parseInt(decoder.decode(bytes.subarray(offset, offset + 4)), 16);
    if (Number.isNaN(length)) throw new SmartHttpError(0, "malformed pkt-line length");
    if (length === 0) {
      lines.push(new Uint8Array());
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > bytes.length) {
      throw new SmartHttpError(0, "truncated pkt-line");
    }
    lines.push(bytes.subarray(offset + 4, offset + length));
    offset += length;
  }
  return lines;
};

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

const text = (line: Uint8Array): string => decoder.decode(line).replace(/\n$/, "");

// --- the two requests -------------------------------------------------------------

export interface SmartHttpOptions {
  /** `https://github.com/owner/name.git`, or any smart-HTTP remote. */
  readonly repositoryUrl: string;
  /** The `Authorization` header value: `Basic …` with `x-access-token:<token>` for GitHub. */
  readonly authorization: string;
  readonly fetch?: FetchLike;
}

const auth = (options: SmartHttpOptions): Record<string, string> => ({
  authorization: options.authorization,
  "user-agent": "nightshift-publisher",
});

const base = (url: string): string => url.replace(/\/+$/, "");

/** `GET …/info/refs?service=git-receive-pack`: what the remote holds, and what it can do. */
export const advertiseReceivePack = async (options: SmartHttpOptions): Promise<AdvertisedRefs> => {
  const doFetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const response = await doFetch(
    `${base(options.repositoryUrl)}/info/refs?service=git-receive-pack`,
    {
      method: "GET",
      headers: { ...auth(options), accept: "*/*" },
    },
  );
  if (response.status !== 200) {
    throw new SmartHttpError(
      response.status,
      `ref advertisement answered ${response.status}: ${(await response.text()).slice(0, 300)}`,
    );
  }
  const lines = readPktLines(new Uint8Array(await response.arrayBuffer()));
  const refs = new Map<string, string>();
  const capabilities = new Set<string>();
  let first = true;
  for (const line of lines) {
    if (line.length === 0) continue;
    const content = text(line);
    if (content.startsWith("#")) continue; // `# service=git-receive-pack`
    const nul = content.indexOf("\0");
    const refPart = nul === -1 ? content : content.slice(0, nul);
    if (first && nul !== -1) {
      for (const capability of content.slice(nul + 1).split(" ")) {
        if (capability !== "") capabilities.add(capability);
      }
    }
    first = false;
    const [oid, name] = refPart.split(" ");
    // An empty repository advertises `<zero> capabilities^{}` and nothing else.
    if (oid !== undefined && name !== undefined && name !== "capabilities^{}") refs.set(name, oid);
  }
  return { refs, capabilities };
};

export interface PushInput extends SmartHttpOptions {
  /** `refs/heads/<branch>`. */
  readonly ref: string;
  /** What the ref must hold now, or `ZERO_OID` to create it. The remote checks. */
  readonly expectedOld: string;
  readonly newOid: string;
  /** The packfile of every object the remote lacks; empty when it lacks none. */
  readonly pack: Uint8Array;
}

/**
 * `POST …/git-receive-pack`: one command and the pack. The outcome is the
 * remote's `report-status`: `ok` for the ref, or `ng` with its reason.
 */
export const pushReceivePack = async (input: PushInput): Promise<PushOutcome> => {
  const doFetch = input.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const command = `${input.expectedOld} ${input.newOid} ${input.ref}\0report-status ${AGENT}\n`;
  const body = concat([pktLine(command), FLUSH_PKT, input.pack]);
  const response = await doFetch(`${base(input.repositoryUrl)}/git-receive-pack`, {
    method: "POST",
    headers: {
      ...auth(input),
      "content-type": "application/x-git-receive-pack-request",
      accept: "application/x-git-receive-pack-result",
    },
    body,
  });
  if (response.status !== 200) {
    throw new SmartHttpError(
      response.status,
      `receive-pack answered ${response.status}: ${(await response.text()).slice(0, 300)}`,
    );
  }
  const lines = readPktLines(new Uint8Array(await response.arrayBuffer()))
    .filter((line) => line.length > 0)
    .map(text);
  const unpack = lines.find((line) => line.startsWith("unpack "));
  if (unpack === undefined)
    return { kind: "error", detail: `no report-status in: ${lines.join(" | ")}` };
  if (unpack !== "unpack ok") return { kind: "error", detail: unpack };
  const status = lines.find((line) => line.startsWith("ok ") || line.startsWith("ng "));
  if (status === undefined)
    return { kind: "error", detail: `no ref status in: ${lines.join(" | ")}` };
  if (status.startsWith("ok ")) return { kind: "ok" };
  const [, , ...reason] = status.split(" ");
  return { kind: "rejected", reason: reason.join(" ") || "refused" };
};

/** The `Authorization` GitHub wants for an installation token. */
export const installationAuthorization = (token: string): string =>
  `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
