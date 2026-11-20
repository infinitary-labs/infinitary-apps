/** A read value's arrays can retain items already delivered to this subscription.
 * Nonnegative indices name the previous array; negative indices name new items
 * in the compact value (-1 is its first). null names an array at the root.
 * This is transport only: no row, ordering or read-catalog fact is derived here.
 */
export type ReadArrayReuse = { key: string | null; indices: number[] };
export type ReadTransfer = { value: unknown; reuse?: ReadArrayReuse[] };

/** INF-2221: retain immutable read rows instead of cloning the entire board
 * into every panel on every push. A new subscription always starts whole.
 * Only root arrays and an object's array fields are compacted; their members
 * are reused by identity, never by inspecting the row's words or identifiers.
 */
export function transferReadValue(previous: unknown, next: unknown): ReadTransfer {
  const reuse: ReadArrayReuse[] = [];
  const compact = (before: unknown, after: unknown[], key: string | null) => {
    if (!Array.isArray(before)) return after;
    const positions = new Map<object, number>();
    before.forEach((item, index) => {
      if (item !== null && typeof item === "object") positions.set(item, index);
    });
    const added: unknown[] = [];
    const indices = after.map((item) => {
      const index = item !== null && typeof item === "object" ? positions.get(item) : undefined;
      if (index !== undefined) return index;
      return -added.push(item);
    });
    if (added.length === after.length) return after;
    reuse.push({ key, indices });
    return added;
  };
  let value = next;
  if (Array.isArray(next)) {
    value = compact(previous, next, null);
  } else if (next && typeof next === "object" && previous && typeof previous === "object") {
    const fields = { ...next } as Record<string, unknown>;
    for (const [key, field] of Object.entries(fields)) {
      if (Array.isArray(field)) {
        fields[key] = compact((previous as Record<string, unknown>)[key], field, key);
      }
    }
    if (reuse.length) value = fields;
  }
  return reuse.length ? { value, reuse } : { value };
}

/** Executed verbatim in the hash-pinned frame bridge, also exercised by the
 * transport's unit test. Keep the decoder here beside its encoder; it needs
 * no browser API and introduces no second owner of a read's meaning.
 */
export const READ_VALUE_DECODER = `function (previous, message) {
  var value = message.value;
  (message.reuse || []).forEach(function (array) {
    var before = array.key === null ? previous : previous[array.key];
    var added = array.key === null ? value : value[array.key];
    var items = array.indices.map(function (index) {
      return index >= 0 ? before[index] : added[-index - 1];
    });
    if (array.key === null) value = items;
    else Object.defineProperty(value, array.key, { value: items, enumerable: true, writable: true, configurable: true });
  });
  return value;
}`;
