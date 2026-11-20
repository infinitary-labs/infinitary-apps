/**
 * The words of a systemd unit's `ExecStart=`, unquoted as systemd reads the
 * double-quoted words the app's own units write (`unitWord`,
 * src/core/helper/background.ts): the command line the started process gets.
 */
export function execStart(unit: string): string[] {
  const line = /^ExecStart=(.*)$/m.exec(unit)?.[1] ?? "";
  return [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) =>
    (match[1] ?? "").replace(/\$\$/g, "$").replace(/\\(.)/g, "$1").replace(/%%/g, "%"),
  );
}
