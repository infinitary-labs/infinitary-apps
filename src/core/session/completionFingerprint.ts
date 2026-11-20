import { createHash, type Hash } from "node:crypto";

/** Typed canonical identity: object key order is irrelevant; arrays and scalar types are not. */
export function completionDigest(value: unknown, bytes?: (count: number) => void): string {
  const hash = createHash("sha256");
  visit(hash, value, bytes);
  return hash.digest("hex");
}

function visit(hash: Hash, value: unknown, bytes?: (count: number) => void): void {
  if (value === null) {
    hash.update("null;");
  } else if (typeof value === "string") {
    hash.update(`s${value.length}:`);
    // No JSON serialization or decoded copy of a picture. Hash the existing
    // string in bounded pieces, preserving even unpaired UTF-16 code units.
    for (let offset = 0; offset < value.length; offset += 8192) {
      const part = value.slice(offset, offset + 8192);
      hash.update(part, "utf16le");
      bytes?.(part.length * 2);
    }
  } else if (typeof value === "number" || typeof value === "boolean") {
    hash.update(`${typeof value}:${Object.is(value, -0) ? "-0" : String(value)};`);
  } else if (Array.isArray(value)) {
    hash.update(`a${value.length}[`);
    for (const item of value) visit(hash, item, bytes);
    hash.update("]");
  } else if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    hash.update(`o${keys.length}{`);
    for (const key of keys) {
      visit(hash, key, bytes);
      visit(hash, record[key], bytes);
    }
    hash.update("}");
  } else if (value === undefined) {
    hash.update("undefined;");
  } else {
    throw new Error("A completed operation must contain only typed data");
  }
}
