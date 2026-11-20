import { copyTree } from "../../src/core/folderMove/copy";
import { compareTrees } from "../../src/core/folderMove/tree";

/**
 * Entry the move test bundles and runs inside Electron: `copy <folder> <staged>`
 * copies with the Node copier every Linux move uses, `compare <folder> <copy>`
 * checks a copy.
 */
const [mode, folder, other] = process.argv.slice(2) as [string, string, string];
const run =
  mode === "copy"
    ? copyTree(folder, other, { platform: "linux" }).then(() => "copied")
    : compareTrees(folder, other).then((work) => `checked ${work}`);
run.then(
  (said) => console.log(said),
  (error: Error) => {
    console.error(error.message);
    process.exit(1);
  },
);
