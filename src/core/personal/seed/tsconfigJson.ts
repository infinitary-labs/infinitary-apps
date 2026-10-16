/**
 * The personal workspace's `tsconfig.json`: the editor-facing mirror of
 * what the host compiler does (automatic JSX runtime, ES modules, the
 * generated contracts). The host never reads it; it exists so an editor
 * or a crewmate's `tsc --noEmit` sees the same world the compiler does.
 */
export const PERSONAL_TSCONFIG_JSON = `${JSON.stringify(
  {
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      jsx: "react-jsx",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
    },
    include: ["**/*.ts", "**/*.tsx", "infinitary-env.d.ts"],
  },
  null,
  2,
)}\n`;
