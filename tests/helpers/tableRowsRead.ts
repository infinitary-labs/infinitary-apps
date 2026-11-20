import Database from "better-sqlite3";

type Rows = Record<string, unknown>[];

/**
 * Collects every row the statements naming `table` return until `stop`,
 * on any connection: better-sqlite3's statements share one prototype.
 */
function watchRows(table: string): { rows: Rows; stop: () => void } {
  const probe = new Database(":memory:");
  const statement = Object.getPrototypeOf(probe.prepare("SELECT 1")) as Database.Statement;
  probe.close();
  const { get, all } = statement;
  const names = new RegExp(`\\b${table}\\b`);
  const rows: Rows = [];
  const target = statement as unknown as Record<string, unknown>;
  target.get = function (this: Database.Statement, ...args: unknown[]) {
    const row = get.apply(this, args as never) as Record<string, unknown> | undefined;
    if (row !== undefined && names.test(this.source)) rows.push(row);
    return row;
  };
  target.all = function (this: Database.Statement, ...args: unknown[]) {
    const found = all.apply(this, args as never) as Rows;
    if (names.test(this.source)) rows.push(...found);
    return found;
  };
  return { rows, stop: () => Object.assign(target, { get, all }) };
}

/**
 * What `read` answers, and every row its statements returned from one table,
 * in the order they came back: how a test sees how much of the saved record a
 * read decoded, by work and never by time (docs/testing.md, the captain's B1
 * timing rule). A statement counts when its text names the table.
 */
export function tableRowsRead<T>(table: string, read: () => T): { answer: T; rows: Rows } {
  const watch = watchRows(table);
  try {
    return { answer: read(), rows: watch.rows };
  } finally {
    watch.stop();
  }
}

/** `tableRowsRead` for a read that settles later: every row returned until it settles. */
export async function tableRowsReadSettled<T>(
  table: string,
  read: () => Promise<T>,
): Promise<{ answer: T; rows: Rows }> {
  const watch = watchRows(table);
  try {
    return { answer: await read(), rows: watch.rows };
  } finally {
    watch.stop();
  }
}
