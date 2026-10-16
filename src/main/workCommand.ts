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
  let index = 1;
  const switches = () => {
    while (argv[index]?.startsWith("--")) index += 1;
  };
  switches();
  if (defaultApp) {
    index += 1;
    switches();
  }
  return argv[index] === "work" ? argv.slice(index + 1) : null;
}
