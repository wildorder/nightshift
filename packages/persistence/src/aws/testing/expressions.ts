/**
 * A small interpreter for the DynamoDB expression language, for `FakeTable`.
 *
 * It covers what the adapter uses — comparisons, `BETWEEN`, `AND`/`OR`/`NOT`,
 * `attribute_exists`, `attribute_not_exists`, `attribute_type`, `begins_with`,
 * and `SET`/`ADD`/`REMOVE` updates — and it is deliberately **stricter** than
 * DynamoDB in two ways, so code that passes here does not fail against the real
 * service for a reason the fake hid:
 *
 * - A bare attribute name is refused. Real DynamoDB accepts one unless it is a
 *   reserved word, and the reserved-word list is long enough (`status`, `name`,
 *   `data` …) that always using `#placeholders` is the only safe habit.
 * - Every supplied placeholder must be used, which DynamoDB also enforces.
 */

export type Item = Record<string, unknown>;
export type Names = Readonly<Record<string, string>> | undefined;
export type Values = Readonly<Record<string, unknown>> | undefined;

export const validationError = (message: string): Error =>
  Object.assign(new Error(message), { name: "ValidationException" });

type Operand =
  | { readonly kind: "path"; readonly name: string }
  | { readonly kind: "value"; readonly value: unknown };

type Comparator = "=" | "<>" | "<" | "<=" | ">" | ">=";

export type Condition =
  | { readonly kind: "and"; readonly left: Condition; readonly right: Condition }
  | { readonly kind: "or"; readonly left: Condition; readonly right: Condition }
  | { readonly kind: "not"; readonly operand: Condition }
  | {
      readonly kind: "compare";
      readonly op: Comparator;
      readonly left: Operand;
      readonly right: Operand;
    }
  | {
      readonly kind: "between";
      readonly target: Operand;
      readonly low: Operand;
      readonly high: Operand;
    }
  | { readonly kind: "function"; readonly name: string; readonly args: readonly Operand[] };

const COMPARATORS = new Set<string>(["=", "<>", "<", "<=", ">", ">="]);
const FUNCTIONS = new Set([
  "attribute_exists",
  "attribute_not_exists",
  "attribute_type",
  "begins_with",
]);
const TOKEN = /\s*(<>|<=|>=|[=<>(),+]|[#:]?[A-Za-z_][A-Za-z0-9_]*)/y;

export const tokenize = (expression: string): string[] => {
  const tokens: string[] = [];
  let index = 0;
  while (expression.slice(index).trim() !== "") {
    TOKEN.lastIndex = index;
    const match = TOKEN.exec(expression);
    const token = match?.[1];
    if (match === null || token === undefined) {
      throw validationError(`cannot parse expression near "${expression.slice(index)}"`);
    }
    tokens.push(token);
    index = TOKEN.lastIndex;
  }
  return tokens;
};

/** Records which placeholders a request's expressions used. */
export class PlaceholderUsage {
  private readonly names = new Set<string>();
  private readonly values = new Set<string>();

  resolveName(token: string, names: Names): string {
    const name = names?.[token];
    if (name === undefined) throw validationError(`undefined attribute name ${token}`);
    this.names.add(token);
    return name;
  }

  resolveValue(token: string, values: Values): unknown {
    if (values === undefined || !Object.hasOwn(values, token)) {
      throw validationError(`undefined attribute value ${token}`);
    }
    this.values.add(token);
    return values[token];
  }

  assertAllUsed(names: Names, values: Values): void {
    for (const token of Object.keys(names ?? {})) {
      if (!this.names.has(token)) throw validationError(`unused attribute name ${token}`);
    }
    for (const token of Object.keys(values ?? {})) {
      if (!this.values.has(token)) throw validationError(`unused attribute value ${token}`);
    }
  }
}

class ConditionParser {
  private position = 0;

  constructor(
    private readonly tokens: readonly string[],
    private readonly names: Names,
    private readonly values: Values,
    private readonly usage: PlaceholderUsage,
  ) {}

  parse(): Condition {
    const condition = this.or();
    if (this.position !== this.tokens.length) {
      throw validationError(`unexpected token "${this.tokens[this.position]}"`);
    }
    return condition;
  }

  private peek(offset = 0): string | undefined {
    return this.tokens[this.position + offset];
  }

  private next(): string {
    const token = this.tokens[this.position];
    if (token === undefined) throw validationError("unexpected end of expression");
    this.position += 1;
    return token;
  }

  private expect(expected: string): void {
    const token = this.next();
    if (token !== expected) throw validationError(`expected "${expected}", got "${token}"`);
  }

  private keyword(word: string): boolean {
    return this.peek()?.toUpperCase() === word;
  }

  private or(): Condition {
    let left = this.and();
    while (this.keyword("OR")) {
      this.next();
      left = { kind: "or", left, right: this.and() };
    }
    return left;
  }

  private and(): Condition {
    let left = this.not();
    while (this.keyword("AND")) {
      this.next();
      left = { kind: "and", left, right: this.not() };
    }
    return left;
  }

  private not(): Condition {
    if (this.keyword("NOT")) {
      this.next();
      return { kind: "not", operand: this.not() };
    }
    return this.primary();
  }

  private primary(): Condition {
    const token = this.peek();
    if (token === "(") {
      this.next();
      const inner = this.or();
      this.expect(")");
      return inner;
    }
    if (token !== undefined && FUNCTIONS.has(token) && this.peek(1) === "(") {
      this.next();
      this.next();
      const args = [this.operand()];
      while (this.peek() === ",") {
        this.next();
        args.push(this.operand());
      }
      this.expect(")");
      return { kind: "function", name: token, args };
    }
    const left = this.operand();
    if (this.keyword("BETWEEN")) {
      this.next();
      const low = this.operand();
      if (!this.keyword("AND")) throw validationError("BETWEEN requires AND");
      this.next();
      return { kind: "between", target: left, low, high: this.operand() };
    }
    const op = this.next();
    if (!COMPARATORS.has(op)) throw validationError(`expected a comparator, got "${op}"`);
    return { kind: "compare", op: op as Comparator, left, right: this.operand() };
  }

  operand(): Operand {
    const token = this.next();
    if (token.startsWith("#")) {
      return { kind: "path", name: this.usage.resolveName(token, this.names) };
    }
    if (token.startsWith(":")) {
      return { kind: "value", value: this.usage.resolveValue(token, this.values) };
    }
    throw validationError(
      `bare attribute name "${token}": use an expression attribute name placeholder`,
    );
  }
}

export const parseCondition = (
  expression: string,
  names: Names,
  values: Values,
  usage: PlaceholderUsage,
): Condition => new ConditionParser(tokenize(expression), names, values, usage).parse();

/** DynamoDB's type descriptor for a document-client value. */
export const typeOf = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return "NULL";
  if (typeof value === "string") return "S";
  if (typeof value === "number") return "N";
  if (typeof value === "boolean") return "BOOL";
  if (value instanceof Uint8Array) return "B";
  if (Array.isArray(value)) return "L";
  return "M";
};

const resolve = (operand: Operand, item: Item | undefined): unknown =>
  operand.kind === "value" ? operand.value : item?.[operand.name];

const compare = (op: Comparator, left: unknown, right: unknown): boolean => {
  if (left === undefined || right === undefined) return false;
  const type = typeOf(left);
  if (type !== typeOf(right)) return op === "<>";
  if (op === "=") return JSON.stringify(left) === JSON.stringify(right);
  if (op === "<>") return JSON.stringify(left) !== JSON.stringify(right);
  // Ordering is defined only for strings and numbers, which is all a key can be.
  if (type !== "S" && type !== "N") return false;
  const a = left as string | number;
  const b = right as string | number;
  switch (op) {
    case "<":
      return a < b;
    case "<=":
      return a <= b;
    case ">":
      return a > b;
    case ">=":
      return a >= b;
  }
};

export const evaluate = (condition: Condition, item: Item | undefined): boolean => {
  switch (condition.kind) {
    case "and":
      return evaluate(condition.left, item) && evaluate(condition.right, item);
    case "or":
      return evaluate(condition.left, item) || evaluate(condition.right, item);
    case "not":
      return !evaluate(condition.operand, item);
    case "compare":
      return compare(condition.op, resolve(condition.left, item), resolve(condition.right, item));
    case "between": {
      const target = resolve(condition.target, item);
      return (
        compare(">=", target, resolve(condition.low, item)) &&
        compare("<=", target, resolve(condition.high, item))
      );
    }
    case "function": {
      const [first, second] = condition.args;
      if (first === undefined) throw validationError(`${condition.name} needs an argument`);
      const value = resolve(first, item);
      switch (condition.name) {
        case "attribute_exists":
          return value !== undefined;
        case "attribute_not_exists":
          return value === undefined;
        case "attribute_type":
          return second !== undefined && typeOf(value) === resolve(second, item);
        case "begins_with": {
          const prefix = second === undefined ? undefined : resolve(second, item);
          // As DynamoDB answers it: a key value may not be the empty string.
          if (prefix === "") {
            throw validationError(
              "One or more parameter values are not valid. The AttributeValue for a key attribute cannot contain an empty string value.",
            );
          }
          return (
            typeof value === "string" && typeof prefix === "string" && value.startsWith(prefix)
          );
        }
        default:
          throw validationError(`unsupported function ${condition.name}`);
      }
    }
  }
};

const KEY_ATTRIBUTES = new Set(["PK", "SK"]);

/** Reads an update expression's tokens, resolving placeholders as it goes. */
class UpdateReader {
  private index = 0;

  constructor(
    private readonly tokens: readonly string[],
    private readonly names: Names,
    private readonly values: Values,
    private readonly usage: PlaceholderUsage,
  ) {}

  done(): boolean {
    return this.index >= this.tokens.length;
  }

  peek(): string {
    return this.tokens[this.index] ?? "";
  }

  take(): string {
    const token = this.tokens[this.index];
    if (token === undefined) throw validationError("unexpected end of update expression");
    this.index += 1;
    return token;
  }

  path(): string {
    const token = this.take();
    if (!token.startsWith("#")) {
      throw validationError(`bare attribute name "${token}": use a placeholder`);
    }
    const name = this.usage.resolveName(token, this.names);
    if (KEY_ATTRIBUTES.has(name)) throw validationError(`cannot update key attribute ${name}`);
    return name;
  }

  value(): unknown {
    const token = this.take();
    if (!token.startsWith(":")) {
      throw validationError(`expected a value placeholder, got "${token}"`);
    }
    return this.usage.resolveValue(token, this.values);
  }
}

type Clause = (reader: UpdateReader, result: Item) => void;

const CLAUSES: Readonly<Record<string, Clause>> = {
  SET: (reader, result) => {
    const name = reader.path();
    if (reader.take() !== "=") throw validationError("SET requires =");
    result[name] = reader.value();
  },
  ADD: (reader, result) => {
    const name = reader.path();
    const increment = reader.value();
    const current = result[name] ?? 0;
    if (typeof increment !== "number" || typeof current !== "number") {
      throw validationError("ADD supports numbers only in this fake");
    }
    result[name] = current + increment;
  },
  REMOVE: (reader, result) => {
    delete result[reader.path()];
  },
};

/** Applies a `SET` / `ADD` / `REMOVE` update expression to a copy of `item`. */
export const applyUpdate = (
  item: Item,
  expression: string,
  names: Names,
  values: Values,
  usage: PlaceholderUsage,
): Item => {
  const reader = new UpdateReader(tokenize(expression), names, values, usage);
  const result: Item = { ...item };
  let clause: Clause | undefined;

  while (!reader.done()) {
    const keyword = CLAUSES[reader.peek().toUpperCase()];
    if (keyword !== undefined || reader.peek() === ",") {
      clause = keyword ?? clause;
      reader.take();
      continue;
    }
    if (clause === undefined) {
      throw validationError("update expression must start with SET, ADD or REMOVE");
    }
    clause(reader, result);
  }
  return result;
};
