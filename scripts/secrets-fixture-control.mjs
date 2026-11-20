// The fixture accepts one closed command, never source, paths, values or passwords.
import { createConnection } from "node:net";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { decodeFixtureReply, FIXTURE_COMMANDS, UNREADABLE_FIXTURE_REPLY } from "../tests/fixtures/native-secrets/control.ts";
const [root, command, ...extra] = process.argv.slice(2);
if (!root || !isAbsolute(root) || !FIXTURE_COMMANDS.includes(command) || extra.length)
  throw new Error("Name the owned fixture folder and one supported control.");
const marker = join(root, "fixture.json");
if (realpathSync(root) !== root || !lstatSync(marker).isFile() || lstatSync(marker).isSymbolicLink() || JSON.parse(readFileSync(marker, "utf8")).purpose !== "infinitary-native-secrets-fixture")
  throw new Error("Not an owned native fixture.");
process.chdir(root);
const socket = createConnection("control.sock");
socket.setEncoding("utf8");
socket.once("connect", () => socket.end(command));
let reply = "";
socket.on("data", chunk => { reply += chunk; });
socket.once("end", () => {
  try {
    const result = decodeFixtureReply(reply);
    process.stdout.write(`${JSON.stringify(result.value)}\n`);
    if (result.refused) process.exitCode = 1;
  } catch {
    console.error(UNREADABLE_FIXTURE_REPLY);
    process.exitCode = 1;
  }
});
socket.once("error", () => {
  console.error("The fixture did not answer. Check its state before repeating any action.");
  process.exitCode = 1;
});
