/**
 * Whether the app was started to run work for another computer's Firstmate
 * (docs/helper.md): `<app> work <command> ...`, and the words after `work`
 * when it was. `defaultApp` is Electron's `process.defaultApp`: an
 * unpackaged run is `electron <entry> work ...`, a packaged one
 * `<executable> work ...`. Chromium's own switches may stand before
 * `work`: an AppImage's runtime adds `--no-sandbox` where it cannot make the
 * sandbox, and Linux starts the work mode on Chromium's windowless platform
 * (`--ozone-platform=headless`). Any other start is the app itself.
 */
export function workCommand(argv: readonly string[], defaultApp: boolean): string[] | null {
  const words = commandWords(argv, defaultApp);
  return words?.[0] === "work" ? words.slice(1) : null;
}

/**
 * The words the app was started with, past the executable, the entry of an
 * unpackaged run and Chromium's own switches before them; null with none.
 * The work mode reads `work ...` from them, and the command that starts the
 * app with no window `run ...` (./runCommand.ts).
 */
export function commandWords(argv: readonly string[], defaultApp: boolean): string[] | null {
  let index = 1;
  const switches = () => {
    while (argv[index]?.startsWith("--")) index += 1;
  };
  switches();
  if (defaultApp) {
    index += 1;
    switches();
  }
  return index < argv.length ? argv.slice(index) : null;
}
