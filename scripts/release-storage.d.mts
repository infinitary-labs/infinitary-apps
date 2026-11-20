export type StoredObject = { bytes: Buffer; etag: string | null };
export type ObjectOptions = { contentType?: string; cacheControl?: string };
export type ReadPatience = { pauseMs: number; patienceMs: number };
export type ReadWaiting = { patience?: ReadPatience; pause?: (ms: number) => Promise<void>; now?: () => number; log?: (line: string) => void };
export const READ_PATIENCE: ReadPatience;
export class ReleaseStorage {
  constructor(options: { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string; request?: typeof fetch; waiting?: ReadWaiting });
  static fromEnvironment(): ReleaseStorage;
  send(method: string, key: string, options?: ObjectOptions & { body?: Buffer | import("node:fs").ReadStream; sha256?: string; condition?: Record<string, string>; contentLength?: number }): Promise<Response>;
  read(key: string): Promise<StoredObject | null>;
  immutable(key: string, bytes: Buffer, options?: ObjectOptions): Promise<void>;
  immutableFile(key: string, file: string): Promise<string>;
  replacePointer(bytes: Buffer, previous: StoredObject | null): Promise<void>;
}
export function publishSnapshot(storage: ReleaseStorage, files: Record<string, string>, previous: StoredObject | null, verify: (key: string, expected: Buffer) => Promise<void>): Promise<{ snapshot: string; files: string[] }>;
export function parsePointer(bytes: Buffer): { schemaVersion: 1; prefix: string; files: string[] };
export function publicDigest(
  url: URL,
  request?: typeof fetch,
  waiting?: ReadWaiting,
): Promise<{ sha256: string; bytes: number; resumedAt: number[] }>;
