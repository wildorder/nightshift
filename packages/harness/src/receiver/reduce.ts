/**
 * Metadata-only reduction of OTLP/JSON telemetry (P20 S-01, F-04).
 *
 * Pure and dependency-free: the receiver child calls it before anything is
 * written, so log bodies, span events/links, exemplars and every attribute
 * outside the configured allowlist are dropped without being retained.
 */

export type Scalar = string | number | boolean;
export type ReceiverSignal = "logs" | "metrics" | "traces";

export interface ReceiverRecord {
  readonly kind: "log" | "metric" | "span";
  readonly timeUnixNano?: string;
  readonly observedTimeUnixNano?: string;
  readonly startTimeUnixNano?: string;
  readonly endTimeUnixNano?: string;
  readonly severityText?: string;
  readonly eventName?: string;
  readonly name?: string;
  readonly unit?: string;
  readonly value?: number;
  readonly sum?: number;
  readonly count?: number;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly parentSpanId?: string;
  readonly statusCode?: number;
  readonly attributes: Record<string, Scalar>;
  readonly resourceAttributes: Record<string, Scalar>;
  /** Attributes (record and resource) dropped from this record; what was dropped is not retained. */
  readonly droppedAttributeCount: number;
}

export type AttributeType = "count" | "number" | "boolean" | "enum" | "id" | "timestamp";
export interface AttributeSpec {
  readonly key: string;
  readonly type: AttributeType;
  /** Required for `enum`: the only accepted strings. */
  readonly values?: readonly string[];
}

/** Exact attribute key/value pairs; a record matches when all pairs match. */
export type RecordFilterRule = Readonly<Record<string, Scalar>>;

/** Allowed attributes: a bare key map entry (`undefined`) keeps any scalar; a spec constrains it. */
export type AllowedAttributes =
  | ReadonlySet<string>
  | ReadonlyMap<string, AttributeSpec | undefined>;

/** Build the allowed-attribute map from bare keys and specs (a spec wins over a bare key). */
export const buildAllowed = (
  entries: readonly (string | AttributeSpec)[],
): ReadonlyMap<string, AttributeSpec | undefined> => {
  const map = new Map<string, AttributeSpec | undefined>();
  for (const e of entries) if (typeof e === "string" && !map.has(e)) map.set(e, undefined);
  for (const e of entries) if (typeof e !== "string") map.set(e.key, e);
  return map;
};

const ATTRIBUTE_TYPES: readonly string[] = [
  "count",
  "number",
  "boolean",
  "enum",
  "id",
  "timestamp",
];

/** `undefined` when `value` is a well-formed spec, otherwise a reason. */
export const attributeSpecProblem = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return "attribute spec must be an object";
  const v = value as { key?: unknown; type?: unknown; values?: unknown };
  if (typeof v.key !== "string" || v.key === "" || /[,\n]/.test(v.key))
    return "attribute spec key must be a non-empty string without commas or newlines";
  if (typeof v.type !== "string" || !ATTRIBUTE_TYPES.includes(v.type))
    return `attribute spec ${v.key} has an unknown type`;
  if (v.type === "enum") {
    if (
      !Array.isArray(v.values) ||
      v.values.length === 0 ||
      !v.values.every((x) => typeof x === "string")
    )
      return `enum attribute spec ${v.key} needs a non-empty string values list`;
  } else if (v.values !== undefined) return `attribute spec ${v.key}: values only applies to enum`;
  return undefined;
};

/** `undefined` when `value` is a well-formed list of flat scalar rules, otherwise a reason. */
export const recordFilterProblem = (value: unknown): string | undefined => {
  if (!Array.isArray(value)) return "record filter must be an array of rules";
  for (const rule of value) {
    if (typeof rule !== "object" || rule === null || Array.isArray(rule))
      return "record filter rules must be flat objects";
    for (const v of Object.values(rule))
      if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean")
        return "record filter rule values must be strings, numbers or booleans";
  }
  return undefined;
};

const ID_RE = /^[A-Za-z0-9._:/+-]{1,160}$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** The value as stored when it satisfies `spec`, else `undefined`. */
export const coerceAttribute = (spec: AttributeSpec, value: Scalar): Scalar | undefined => {
  const numeric = (v: Scalar): number | undefined => {
    if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
    if (typeof v === "string" && v.trim() !== "") {
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    }
    return undefined;
  };
  switch (spec.type) {
    case "count": {
      if (typeof value === "string" && !/^\d+$/.test(value)) return undefined;
      const n = typeof value === "boolean" ? undefined : numeric(value);
      return n !== undefined && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
    }
    case "number":
      return typeof value === "boolean" ? undefined : numeric(value);
    case "boolean":
      if (typeof value === "boolean") return value;
      return value === "true" ? true : value === "false" ? false : undefined;
    case "enum":
      return typeof value === "string" && (spec.values ?? []).includes(value) ? value : undefined;
    case "id":
      return typeof value === "string" && ID_RE.test(value) ? value : undefined;
    case "timestamp":
      return typeof value === "string" && TIMESTAMP_RE.test(value) ? value : undefined;
  }
};

export const MAX_STRING_CHARS = 256;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const truncate = (s: string): string =>
  s.length > MAX_STRING_CHARS ? s.slice(0, MAX_STRING_CHARS) : s;
const str = (v: unknown): string | undefined => (typeof v === "string" ? truncate(v) : undefined);
const nano = (v: unknown): string | undefined =>
  typeof v === "string" ? truncate(v) : typeof v === "number" ? String(v) : undefined;
const num = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v !== "" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
};

const scalarOf = (value: unknown): Scalar | undefined => {
  if (!isObj(value)) return undefined;
  if (typeof value.stringValue === "string") return truncate(value.stringValue);
  if (typeof value.boolValue === "boolean") return value.boolValue;
  const i = num(value.intValue);
  if (i !== undefined) return i;
  if (typeof value.doubleValue === "number" && Number.isFinite(value.doubleValue))
    return value.doubleValue;
  return undefined; // arrays, maps, bytes, malformed
};

interface Reduced {
  readonly kept: Record<string, Scalar>;
  readonly dropped: number;
  readonly eventName?: string;
}

const specOf = (allowed: AllowedAttributes, key: string): AttributeSpec | undefined =>
  allowed instanceof Set
    ? undefined
    : (allowed as ReadonlyMap<string, AttributeSpec | undefined>).get(key);

const reduceAttributes = (attributes: unknown, allowed: AllowedAttributes): Reduced => {
  const kept: Record<string, Scalar> = {};
  let dropped = 0;
  let eventName: string | undefined;
  for (const attribute of arr(attributes)) {
    const key = isObj(attribute) ? attribute.key : undefined;
    if (typeof key !== "string") {
      dropped++;
      continue;
    }
    const value = scalarOf((attribute as Obj).value);
    const spec = specOf(allowed, key);
    const stored = value !== undefined && spec !== undefined ? coerceAttribute(spec, value) : value;
    if (
      key === "event.name" &&
      typeof value === "string" &&
      (spec === undefined || stored !== undefined)
    )
      eventName = truncate(value);
    if (!allowed.has(key) || stored === undefined) {
      dropped++;
      continue;
    }
    kept[key] = stored;
  }
  return eventName === undefined ? { kept, dropped } : { kept, dropped, eventName };
};

const defined = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

const make = (
  kind: ReceiverRecord["kind"],
  fields: Obj,
  attributes: unknown,
  resource: Reduced,
  allowed: AllowedAttributes,
): ReceiverRecord => {
  const own = reduceAttributes(attributes, allowed);
  return defined({
    kind,
    ...fields,
    attributes: own.kept,
    resourceAttributes: resource.kept,
    droppedAttributeCount: own.dropped + resource.dropped,
  }) as unknown as ReceiverRecord;
};

const eachScope = (
  root: Obj,
  resourceKey: string,
  scopeKey: string,
  itemKey: string,
  allowed: AllowedAttributes,
  visit: (item: Obj, resource: Reduced) => void,
): void => {
  for (const rs of arr(root[resourceKey])) {
    if (!isObj(rs)) continue;
    const resource = reduceAttributes(
      isObj(rs.resource) ? rs.resource.attributes : undefined,
      allowed,
    );
    for (const scope of arr(rs[scopeKey]))
      if (isObj(scope))
        for (const item of arr(scope[itemKey])) if (isObj(item)) visit(item, resource);
  }
};

const metricPoints = (metric: Obj): Obj[] => {
  const out: Obj[] = [];
  for (const kind of ["gauge", "sum", "histogram", "exponentialHistogram", "summary"]) {
    const body = metric[kind];
    if (isObj(body)) for (const p of arr(body.dataPoints)) if (isObj(p)) out.push(p);
  }
  return out;
};

const sameScalar = (actual: Scalar, expected: Scalar): boolean =>
  actual === expected ||
  ((typeof actual === "number" || typeof expected === "number") &&
    typeof actual !== "boolean" &&
    typeof expected !== "boolean" &&
    String(actual) === String(expected));

/** Whether the record's own raw attributes satisfy any rule; no rules keeps everything. */
const passesFilter = (
  attributes: unknown,
  rules: readonly RecordFilterRule[] | undefined,
): boolean => {
  if (rules === undefined || rules.length === 0) return true;
  const raw = new Map<string, Scalar>();
  for (const attribute of arr(attributes)) {
    if (!isObj(attribute) || typeof attribute.key !== "string") continue;
    const value = scalarOf(attribute.value);
    if (value !== undefined) raw.set(attribute.key, value);
  }
  return rules.some((rule) =>
    Object.entries(rule).every(([k, v]) => {
      const actual = raw.get(k);
      return actual !== undefined && sameScalar(actual, v);
    }),
  );
};

export interface FilteredReduction {
  readonly records: ReceiverRecord[];
  /** Records deliberately excluded by the filter; not lost evidence. */
  readonly filteredRecordCount: number;
}

/**
 * Reduce one parsed OTLP/JSON export request to metadata-only records,
 * excluding (and counting) records no filter rule matches.
 */
export const reduceOtlpFiltered = (
  signal: ReceiverSignal,
  root: unknown,
  allowed: AllowedAttributes,
  filter?: readonly RecordFilterRule[],
): FilteredReduction => {
  const records: ReceiverRecord[] = [];
  let filteredRecordCount = 0;
  const emit = (rawAttributes: unknown, build: () => ReceiverRecord): void => {
    if (passesFilter(rawAttributes, filter)) records.push(build());
    else filteredRecordCount++;
  };
  if (!isObj(root)) return { records, filteredRecordCount };
  if (signal === "logs") {
    eachScope(root, "resourceLogs", "scopeLogs", "logRecords", allowed, (log, resource) =>
      emit(log.attributes, () => {
        const own = reduceAttributes(log.attributes, allowed);
        return make(
          "log",
          {
            timeUnixNano: nano(log.timeUnixNano),
            observedTimeUnixNano: nano(log.observedTimeUnixNano),
            severityText: str(log.severityText),
            eventName: str(log.eventName) ?? own.eventName,
          },
          log.attributes,
          resource,
          allowed,
        );
      }),
    );
  } else if (signal === "metrics") {
    eachScope(root, "resourceMetrics", "scopeMetrics", "metrics", allowed, (metric, resource) => {
      for (const point of metricPoints(metric))
        emit(point.attributes, () =>
          make(
            "metric",
            {
              name: str(metric.name),
              unit: str(metric.unit),
              value: num(point.asInt) ?? num(point.asDouble),
              sum: num(point.sum),
              count: num(point.count),
              timeUnixNano: nano(point.timeUnixNano),
            },
            point.attributes,
            resource,
            allowed,
          ),
        );
    });
  } else {
    eachScope(root, "resourceSpans", "scopeSpans", "spans", allowed, (span, resource) =>
      emit(span.attributes, () =>
        make(
          "span",
          {
            name: str(span.name),
            traceId: str(span.traceId),
            spanId: str(span.spanId),
            parentSpanId: str(span.parentSpanId),
            startTimeUnixNano: nano(span.startTimeUnixNano),
            endTimeUnixNano: nano(span.endTimeUnixNano),
            statusCode: isObj(span.status) ? num(span.status.code) : undefined,
          },
          span.attributes,
          resource,
          allowed,
        ),
      ),
    );
  }
  return { records, filteredRecordCount };
};

/** Reduce one parsed OTLP/JSON export request to metadata-only records. */
export const reduceOtlp = (
  signal: ReceiverSignal,
  root: unknown,
  allowed: AllowedAttributes,
): ReceiverRecord[] => reduceOtlpFiltered(signal, root, allowed).records;

/** Parse a JSON or NDJSON body; `undefined` when it does not parse as JSON objects. */
export const parseBody = (text: string, ndjson: boolean): unknown[] | undefined => {
  try {
    if (!ndjson) {
      const parsed: unknown = JSON.parse(text);
      return isObj(parsed) ? [parsed] : undefined;
    }
    const out: unknown[] = [];
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      const parsed: unknown = JSON.parse(line);
      if (!isObj(parsed)) return undefined;
      out.push(parsed);
    }
    return out;
  } catch {
    return undefined;
  }
};
