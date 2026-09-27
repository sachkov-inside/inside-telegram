/**
 * Returns a value the test has arranged to exist, failing the test when it is absent. Tests use
 * it instead of a non-null assertion so a broken arrangement fails with a clear message.
 */
export function required<Value>(value: Value | null | undefined): Value {
  if (value === undefined || value === null)
    throw new Error("Test arrangement did not produce the expected value");
  return value;
}
