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

const reduceAttributes = (attributes: unknown, allowed: ReadonlySet<string>): Reduced => {
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
    if (key === "event.name" && typeof value === "string") eventName = truncate(value);
    if (!allowed.has(key) || value === undefined) {
      dropped++;
      continue;
    }
    kept[key] = value;
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
  allowed: ReadonlySet<string>,
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
  allowed: ReadonlySet<string>,
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

/** Reduce one parsed OTLP/JSON export request to metadata-only records. */
export const reduceOtlp = (
  signal: ReceiverSignal,
  root: unknown,
  allowed: ReadonlySet<string>,
): ReceiverRecord[] => {
  const records: ReceiverRecord[] = [];
  if (!isObj(root)) return records;
  if (signal === "logs") {
    eachScope(root, "resourceLogs", "scopeLogs", "logRecords", allowed, (log, resource) => {
      const own = reduceAttributes(log.attributes, allowed);
      const rec = make(
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
      records.push(rec);
    });
  } else if (signal === "metrics") {
    eachScope(root, "resourceMetrics", "scopeMetrics", "metrics", allowed, (metric, resource) => {
      for (const point of metricPoints(metric))
        records.push(
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
    eachScope(root, "resourceSpans", "scopeSpans", "spans", allowed, (span, resource) => {
      records.push(
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
      );
    });
  }
  return records;
};

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
