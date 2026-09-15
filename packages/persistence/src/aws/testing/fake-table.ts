/**
 * An in-process stand-in for the Nightshift DynamoDB table, **for tests only**.
 *
 * It lets the DynamoDB adapter run the shared conformance suite inside
 * `npm test`, with no credentials, so an adapter bug is found in seconds rather
 * than at the first deploy. It is not proof of DynamoDB behaviour — the smoke
 * suite runs the same suite against the real table for that — so where it has to
 * choose, it is stricter than DynamoDB rather than looser:
 *
 * - conditions, transactions and cancellation reasons behave like the service,
 *   including refusing two operations on one item in a transaction;
 * - `Limit` returns a `LastEvaluatedKey` whenever the limit is reached, even if
 *   nothing follows, exactly as DynamoDB does, and `pageItemCap` imitates the 1 MB
 *   page cap so callers are forced to follow pages;
 * - an `ExclusiveStartKey` outside the query's key condition is refused;
 * - items over 400 KB are refused.
 *
 * Every write is also appended to an in-memory stream, in commit order, so the
 * sequence materializer can be driven exactly as DynamoDB Streams would drive it.
 */
import type {
  DeleteCommandInput,
  DeleteCommandOutput,
  GetCommandInput,
  GetCommandOutput,
  PutCommandInput,
  PutCommandOutput,
  QueryCommandInput,
  QueryCommandOutput,
  ScanCommandInput,
  ScanCommandOutput,
  TransactWriteCommandInput,
  TransactWriteCommandOutput,
  UpdateCommandInput,
  UpdateCommandOutput,
} from "@aws-sdk/lib-dynamodb";
import { NODE_INDEX_NAME } from "../keys.js";
import type { TableClient } from "../table-client.js";
import {
  applyUpdate,
  evaluate,
  type Item,
  type Names,
  PlaceholderUsage,
  parseCondition,
  type Values,
  validationError,
} from "./expressions.js";

export interface FakeStreamRecord {
  readonly eventName: "INSERT" | "MODIFY" | "REMOVE";
  /** Monotonic, like a shard's sequence numbers. */
  readonly sequenceNumber: string;
  readonly keys: { readonly PK: string; readonly SK: string };
  readonly newImage?: Item;
  readonly oldImage?: Item;
}

export interface FakeTableOptions {
  readonly tableName: string;
  /** At most this many items per query or scan page, imitating the 1 MB cap. */
  readonly pageItemCap?: number;
}

const MAX_ITEM_BYTES = 400 * 1024;

/** Deep copy through JSON, which also drops `undefined` as `removeUndefinedValues` does. */
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const awsError = (name: string, message: string, extra: object = {}): Error =>
  Object.assign(new Error(message), { name, ...extra });

const keyString = (pk: unknown, sk: unknown): string => {
  if (typeof pk !== "string" || typeof sk !== "string") {
    throw validationError("every item and key needs string PK and SK attributes");
  }
  return JSON.stringify([pk, sk]);
};

type KeySchema = readonly [hash: string, range: string];
const TABLE_KEYS: KeySchema = ["PK", "SK"];
const INDEX_KEYS: KeySchema = ["GSI1PK", "GSI1SK"];

/** Sort order within a query: the range key, then the table key as a tie-break. */
const compareForSchema =
  ([, range]: KeySchema) =>
  (a: Item, b: Item): number => {
    const parts = [range, "PK", "SK"];
    for (const part of parts) {
      const left = String(a[part] ?? "");
      const right = String(b[part] ?? "");
      if (left < right) return -1;
      if (left > right) return 1;
    }
    return 0;
  };

/** Where a page starts: just after `exclusiveStartKey` in query order. */
const startAfter = (
  ordered: readonly Item[],
  schema: KeySchema,
  exclusiveStartKey: Item | undefined,
  forward: boolean | undefined,
): number => {
  if (exclusiveStartKey === undefined) return 0;
  const compare = compareForSchema(schema);
  const direction = forward === false ? -1 : 1;
  const index = ordered.findIndex((item) => direction * compare(item, exclusiveStartKey) > 0);
  return index === -1 ? ordered.length : index;
};

/** The `LastEvaluatedKey` for an item: its index keys and its table keys. */
const keyAttributes = (item: Item, [hash, range]: KeySchema): Item =>
  Object.fromEntries([...new Set([hash, range, "PK", "SK"])].map((name) => [name, item[name]]));

/** The error DynamoDB raises when a condition fails, for a single write or a transaction. */
const refusal = (failures: readonly boolean[], mode: "single" | "transaction"): Error =>
  mode === "single"
    ? awsError("ConditionalCheckFailedException", "The conditional request failed")
    : awsError("TransactionCanceledException", "Transaction cancelled", {
        CancellationReasons: failures.map((failed) =>
          failed
            ? { Code: "ConditionalCheckFailed", Message: "The conditional request failed" }
            : { Code: "None" },
        ),
      });

type WriteOperation =
  | { readonly kind: "put"; readonly key: string; readonly item: Item; readonly check?: Check }
  | {
      readonly kind: "update";
      readonly key: string;
      readonly keyItem: Item;
      readonly expression: string;
      readonly names: Names;
      readonly values: Values;
      readonly usage: PlaceholderUsage;
      readonly check?: Check;
    }
  | { readonly kind: "delete"; readonly key: string; readonly check?: Check }
  | { readonly kind: "check"; readonly key: string; readonly check: Check };

interface Check {
  readonly expression: string;
  readonly names: Names;
  readonly values: Values;
}

export class FakeTable implements TableClient {
  private readonly items = new Map<string, Item>();
  private readonly stream: FakeStreamRecord[] = [];
  private streamSequence = 0;

  constructor(private readonly options: FakeTableOptions) {}

  /** Every stored item, for assertions about what actually reached the table. */
  allItems(): readonly Item[] {
    return [...this.items.values()].map(copy);
  }

  /** Stream records not yet drained, in commit order. */
  drainStream(): readonly FakeStreamRecord[] {
    return this.stream.splice(0, this.stream.length);
  }

  async get(input: GetCommandInput): Promise<GetCommandOutput> {
    this.assertTable(input.TableName);
    const item = this.items.get(keyString(input.Key?.PK, input.Key?.SK));
    return item === undefined ? { $metadata: {} } : { $metadata: {}, Item: copy(item) };
  }

  async put(input: PutCommandInput): Promise<PutCommandOutput> {
    this.assertTable(input.TableName);
    this.commit([this.putOperation(input)], "single");
    return { $metadata: {} };
  }

  async update(input: UpdateCommandInput): Promise<UpdateCommandOutput> {
    this.assertTable(input.TableName);
    const operation = this.updateOperation(input);
    this.commit([operation], "single");
    if (input.ReturnValues === "ALL_NEW") {
      return { $metadata: {}, Attributes: copy(this.items.get(operation.key) ?? {}) };
    }
    return { $metadata: {} };
  }

  async delete(input: DeleteCommandInput): Promise<DeleteCommandOutput> {
    this.assertTable(input.TableName);
    this.commit([this.deleteOperation(input)], "single");
    return { $metadata: {} };
  }

  async transactWrite(input: TransactWriteCommandInput): Promise<TransactWriteCommandOutput> {
    const requests = input.TransactItems ?? [];
    if (requests.length === 0 || requests.length > 100) {
      throw validationError("a transaction needs between 1 and 100 operations");
    }
    const operations = requests.map((request): WriteOperation => {
      if (request.Put !== undefined) {
        this.assertTable(request.Put.TableName);
        return this.putOperation(request.Put);
      }
      if (request.Update !== undefined) {
        this.assertTable(request.Update.TableName);
        return this.updateOperation(request.Update);
      }
      if (request.Delete !== undefined) {
        this.assertTable(request.Delete.TableName);
        return this.deleteOperation(request.Delete);
      }
      if (request.ConditionCheck !== undefined) {
        const check = request.ConditionCheck;
        this.assertTable(check.TableName);
        return {
          kind: "check",
          key: keyString(check.Key?.PK, check.Key?.SK),
          check: {
            expression: check.ConditionExpression ?? "",
            names: check.ExpressionAttributeNames,
            values: check.ExpressionAttributeValues,
          },
        };
      }
      throw validationError(
        "a transaction operation must be Put, Update, Delete or ConditionCheck",
      );
    });

    const keys = new Set(operations.map((operation) => operation.key));
    if (keys.size !== operations.length) {
      throw validationError("Transaction request cannot include multiple operations on one item");
    }
    this.commit(operations, "transaction");
    return { $metadata: {} };
  }

  async query(input: QueryCommandInput): Promise<QueryCommandOutput> {
    this.assertTable(input.TableName);
    if (input.IndexName !== undefined && input.IndexName !== NODE_INDEX_NAME) {
      throw validationError(`the table has no index named ${input.IndexName}`);
    }
    if (input.IndexName !== undefined && input.ConsistentRead === true) {
      throw validationError("consistent reads are not supported on global secondary indexes");
    }
    if (input.KeyConditionExpression === undefined) {
      throw validationError("a query needs a KeyConditionExpression");
    }
    const schema = input.IndexName === undefined ? TABLE_KEYS : INDEX_KEYS;
    const usage = new PlaceholderUsage();
    const names = input.ExpressionAttributeNames;
    const values = input.ExpressionAttributeValues;
    const keyCondition = parseCondition(input.KeyConditionExpression, names, values, usage);
    const filter =
      input.FilterExpression === undefined
        ? undefined
        : parseCondition(input.FilterExpression, names, values, usage);
    usage.assertAllUsed(names, values);

    const [hash, range] = schema;
    const matching = [...this.items.values()]
      .filter((item) => typeof item[hash] === "string" && typeof item[range] === "string")
      .filter((item) => evaluate(keyCondition, item))
      .sort(compareForSchema(schema));
    if (input.ScanIndexForward === false) matching.reverse();

    if (input.ExclusiveStartKey !== undefined && !evaluate(keyCondition, input.ExclusiveStartKey)) {
      throw validationError("The provided starting key is outside query boundaries");
    }
    return this.page(
      matching,
      schema,
      input.Limit,
      input.ExclusiveStartKey,
      filter,
      input.ScanIndexForward,
    );
  }

  async scan(input: ScanCommandInput): Promise<ScanCommandOutput> {
    this.assertTable(input.TableName);
    const usage = new PlaceholderUsage();
    const names = input.ExpressionAttributeNames;
    const values = input.ExpressionAttributeValues;
    const filter =
      input.FilterExpression === undefined
        ? undefined
        : parseCondition(input.FilterExpression, names, values, usage);
    usage.assertAllUsed(names, values);
    const all = [...this.items.values()].sort(compareForSchema(TABLE_KEYS));
    return this.page(all, TABLE_KEYS, input.Limit, input.ExclusiveStartKey, filter, true);
  }

  private page(
    ordered: readonly Item[],
    schema: KeySchema,
    limit: number | undefined,
    exclusiveStartKey: Item | undefined,
    filter: ReturnType<typeof parseCondition> | undefined,
    forward: boolean | undefined,
  ): { $metadata: object; Items: Item[]; Count: number; LastEvaluatedKey?: Item } {
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw validationError("Limit must be at least 1");
    }
    const remaining = ordered.slice(startAfter(ordered, schema, exclusiveStartKey, forward));
    const cap = Math.min(
      limit ?? Number.POSITIVE_INFINITY,
      this.options.pageItemCap ?? Number.POSITIVE_INFINITY,
    );
    const evaluated = remaining.slice(0, cap);
    // DynamoDB reports a last key whenever it stopped at the limit, more or not.
    const stoppedEarly =
      (limit !== undefined && evaluated.length === limit) || remaining.length > cap;
    const items = (
      filter === undefined ? evaluated : evaluated.filter((item) => evaluate(filter, item))
    ).map(copy);

    const base = { $metadata: {}, Items: items, Count: items.length };
    const last = evaluated.at(-1);
    return stoppedEarly && last !== undefined
      ? { ...base, LastEvaluatedKey: keyAttributes(last, schema) }
      : base;
  }

  private putOperation(input: PutCommandInput): WriteOperation {
    const item = copy(input.Item ?? {});
    const key = keyString(item.PK, item.SK);
    if (new TextEncoder().encode(JSON.stringify(item)).length > MAX_ITEM_BYTES) {
      throw validationError("Item size has exceeded the maximum allowed size");
    }
    return input.ConditionExpression === undefined
      ? { kind: "put", key, item }
      : {
          kind: "put",
          key,
          item,
          check: {
            expression: input.ConditionExpression,
            names: input.ExpressionAttributeNames,
            values: input.ExpressionAttributeValues,
          },
        };
  }

  private updateOperation(input: UpdateCommandInput): Extract<WriteOperation, { kind: "update" }> {
    if (input.UpdateExpression === undefined)
      throw validationError("an update needs an UpdateExpression");
    const keyItem = { PK: input.Key?.PK, SK: input.Key?.SK };
    const base = {
      kind: "update" as const,
      key: keyString(keyItem.PK, keyItem.SK),
      keyItem,
      expression: input.UpdateExpression,
      names: input.ExpressionAttributeNames,
      values: input.ExpressionAttributeValues,
      usage: new PlaceholderUsage(),
    };
    return input.ConditionExpression === undefined
      ? base
      : {
          ...base,
          check: {
            expression: input.ConditionExpression,
            names: input.ExpressionAttributeNames,
            values: input.ExpressionAttributeValues,
          },
        };
  }

  private deleteOperation(input: DeleteCommandInput): WriteOperation {
    const key = keyString(input.Key?.PK, input.Key?.SK);
    return input.ConditionExpression === undefined
      ? { kind: "delete", key }
      : {
          kind: "delete",
          key,
          check: {
            expression: input.ConditionExpression,
            names: input.ExpressionAttributeNames,
            values: input.ExpressionAttributeValues,
          },
        };
  }

  /**
   * Checks every condition against the current state, then applies every write.
   * Nothing is applied if any condition fails, so a transaction is atomic here as
   * it is in DynamoDB.
   */
  private commit(operations: readonly WriteOperation[], mode: "single" | "transaction"): void {
    const failures = operations.map((operation) => this.conditionFails(operation));

    if (failures.some(Boolean)) throw refusal(failures, mode);
    for (const operation of operations) this.apply(operation);
  }

  /** Applies one already-checked write and streams it. */
  private apply(operation: WriteOperation): void {
    const existing = this.items.get(operation.key);
    if (operation.kind === "check") return;
    if (operation.kind === "delete") {
      if (existing === undefined) return;
      this.items.delete(operation.key);
      this.record("REMOVE", existing, undefined, existing);
      return;
    }
    const next =
      operation.kind === "put"
        ? operation.item
        : applyUpdate(
            existing ?? operation.keyItem,
            operation.expression,
            operation.names,
            operation.values,
            new PlaceholderUsage(),
          );
    if (new TextEncoder().encode(JSON.stringify(next)).length > MAX_ITEM_BYTES) {
      throw validationError("Item size has exceeded the maximum allowed size");
    }
    this.items.set(operation.key, copy(next));
    this.record(existing === undefined ? "INSERT" : "MODIFY", next, next, existing);
  }

  /**
   * Whether `operation`'s condition fails against the current state. Also
   * validates its expressions, including the update's, so a malformed
   * transaction is refused before anything is applied.
   */
  private conditionFails(operation: WriteOperation): boolean {
    const existing = this.items.get(operation.key);
    // Placeholders are shared between the condition and the update, so usage is
    // tracked across both before checking nothing was left unused.
    const usage = operation.kind === "update" ? operation.usage : new PlaceholderUsage();
    const check = operation.check;
    const passes =
      check === undefined ||
      evaluate(parseCondition(check.expression, check.names, check.values, usage), existing);

    if (operation.kind === "update") {
      const base = existing ?? operation.keyItem;
      applyUpdate(base, operation.expression, operation.names, operation.values, usage);
      usage.assertAllUsed(operation.names, operation.values);
    } else if (check !== undefined) {
      usage.assertAllUsed(check.names, check.values);
    }
    return !passes;
  }

  private record(
    eventName: FakeStreamRecord["eventName"],
    keySource: Item,
    newImage: Item | undefined,
    oldImage: Item | undefined,
  ): void {
    this.streamSequence += 1;
    this.stream.push({
      eventName,
      sequenceNumber: String(this.streamSequence).padStart(21, "0"),
      keys: { PK: String(keySource.PK), SK: String(keySource.SK) },
      ...(newImage === undefined ? {} : { newImage: copy(newImage) }),
      ...(oldImage === undefined ? {} : { oldImage: copy(oldImage) }),
    });
  }

  private assertTable(tableName: string | undefined): void {
    if (tableName !== this.options.tableName) {
      throw awsError(
        "ResourceNotFoundException",
        `Requested resource not found: ${String(tableName)}`,
      );
    }
  }
}
