/** The module a remote program is asked to extend. */
import { z } from "zod";

const Numbers = z.array(z.number());

/** @param {readonly number[]} values */
export const sum = (values) => Numbers.parse(values).reduce((total, value) => total + value, 0);

/** @param {readonly number[]} values */
export const mean = (values) => {
  if (values.length === 0) throw new RangeError("mean of an empty list is undefined");
  return sum(values) / values.length;
};
