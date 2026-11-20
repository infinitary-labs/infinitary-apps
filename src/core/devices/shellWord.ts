/** One word for a POSIX shell, quoted so nothing in it is read as the shell's. */
export function shellWord(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}
