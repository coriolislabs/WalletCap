// SPDX-License-Identifier: Apache-2.0
// The JSON shape both CLIs print with --json, and every result's toJSON() gives: snake_case keys,
// amounts and counts as decimal strings, times as ISO-8601 UTC to the millisecond, and null for a
// field with no value. JSON.stringify(result) then never meets a bigint it can't write.

const snake = (key: string): string => key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);

/** Internal: `value` in the wire shape. */
export function toWire(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toWire);
  if (typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [snake(key), toWire(entry)]));
  return value;
}

/** Internal: `result` with a toJSON() that gives its wire shape, kept out of its own keys. */
export function withJSON<T extends object>(result: T): T {
  Object.defineProperty(result, 'toJSON', {
    value(this: T) {
      return toWire(this);
    },
    enumerable: false,
  });
  return result;
}
