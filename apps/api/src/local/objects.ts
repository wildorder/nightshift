/**
 * The object store of a loopback control plane (P12, D-P12-06): what S3 is to
 * the hosted plane. The harness keeps bytes in memory; the local instance keeps
 * them as files under its state directory.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

/** The bucket name a loopback plane's URIs name. Never a real bucket. */
export const LOCAL_BUCKET = "nightshift-local";

export interface LocalBody {
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly sha256: string;
}

export interface ObjectStore {
  get(key: string): LocalBody | undefined;
  set(key: string, body: LocalBody): void;
  clear(): void;
}

export const localBodyOf = (body: Uint8Array, contentType: string): LocalBody => ({
  body,
  contentType,
  sha256: createHash("sha256").update(body).digest("hex"),
});

/** Bytes in memory, for the test harness. */
export const createMemoryObjectStore = (): ObjectStore & {
  readonly objects: Map<string, LocalBody>;
} => {
  const objects = new Map<string, LocalBody>();
  return {
    objects,
    get: (key) => objects.get(key),
    set: (key, body) => void objects.set(key, body),
    clear: () => objects.clear(),
  };
};

/**
 * Bytes as files: `<dir>/<key>`, with `<dir>/<key>.meta.json` holding the
 * content type and digest. Keys are the plane's own (`artifactObjectKey`,
 * `planDocumentObjectKey`); one that would leave `dir` is refused all the same.
 */
export const createFileObjectStore = (dir: string): ObjectStore => {
  const root = resolve(dir);
  const pathOf = (key: string): string => {
    const path = resolve(root, key);
    if (path !== root && !path.startsWith(root + sep)) {
      throw new Error(`object key leaves the store: ${key}`);
    }
    return path;
  };
  return {
    get: (key) => {
      const path = pathOf(key);
      if (!existsSync(path) || !existsSync(`${path}.meta.json`)) return undefined;
      const meta = JSON.parse(readFileSync(`${path}.meta.json`, "utf8")) as {
        contentType: string;
        sha256: string;
      };
      return { body: new Uint8Array(readFileSync(path)), ...meta };
    },
    set: (key, body) => {
      const path = pathOf(key);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, body.body);
      writeFileSync(
        `${path}.meta.json`,
        JSON.stringify({ contentType: body.contentType, sha256: body.sha256 }),
      );
    },
    clear: () => {
      rmSync(root, { recursive: true, force: true });
      mkdirSync(root, { recursive: true });
    },
  };
};

export const objectsDir = (stateDir: string): string => join(stateDir, "objects");
