// A panel's own stylesheet is text: the panel compiler admits
// `import styles from "./board.css"` as a module whose default export is the
// file's contents (docs/ui-plugins.md, "The panel library grows"), as a
// panel's workspace types it (infinitary-env.d.ts).
declare module "*.css" {
  const text: string;
  export default text;
}
