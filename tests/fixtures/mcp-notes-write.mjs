// INF-1573: observe the same public notes file the journey polls while the
// real stdio stand-in is between truncation, its first write and completion.
// Preloaded only by the regression; no delays or changes to the server protocol.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const notes = process.argv[4];
const writeFileSync = fs.writeFileSync;
fs.writeFileSync = (file, data, options) => {
  const bytes = Buffer.from(data);
  const split = Math.floor(bytes.length / 2);
  const observations = [];
  const observe = () => observations.push(fs.readFileSync(notes, "utf8"));
  // Exercise real file operations at the two boundaries a polling reader can hit.
  writeFileSync(file, "", options);
  observe();
  writeFileSync(file, bytes.subarray(0, split), { flag: "a" });
  observe();
  writeFileSync(file, bytes.subarray(split), { flag: "a" });
  observe();
  writeFileSync(`${notes}.observations.json`, JSON.stringify(observations));
};
syncBuiltinESMExports();
