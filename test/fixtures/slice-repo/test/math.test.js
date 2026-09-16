import assert from "node:assert/strict";
import { test } from "node:test";
import { mean, sum } from "../src/math.js";

test("sum adds every value", () => {
  assert.equal(sum([1, 2, 3]), 6);
  assert.equal(sum([]), 0);
});

test("mean divides by the count", () => {
  assert.equal(mean([2, 4]), 3);
});

test("mean refuses an empty list", () => {
  assert.throws(() => mean([]), RangeError);
});
