/** The module a slice job is asked to extend. */

export const sum = (values) => values.reduce((total, value) => total + value, 0);

export const mean = (values) => {
  if (values.length === 0) throw new RangeError("mean of an empty list is undefined");
  return sum(values) / values.length;
};
