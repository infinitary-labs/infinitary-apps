#!/usr/bin/env node
// Hold the same search-list lock as local signing, then run one command.
//
// `security list-keychains -s` replaces the whole user search list. Local
// signing already serializes those edits with search-list.lock. The release
// workflow's throwaway Developer ID keychain edits that same list, so its
// create, prepend and delete go through here. The lock is held only for the
// command, never across codesign, and the kernel drops it if this process dies.
//
//   node scripts/with-search-list-lock.mjs -- <command> [args...]
//   node scripts/with-search-list-lock.mjs prepend <keychain-path>
//
// `prepend` reads the list, puts the path first, and writes it back, all
// under the lock, and refuses an empty read. Arguments are never logged.

import { prependKeychainOnSearchList, runUnderSearchListLock } from "./local-codesign.mjs";

const args = process.argv.slice(2);
if (args[0] === "prepend") {
  if (args.length !== 2) {
    console.error("usage: with-search-list-lock.mjs prepend <keychain-path>");
    process.exit(2);
  }
  try {
    prependKeychainOnSearchList(args[1]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "prepend failed");
    process.exit(1);
  }
  process.exit(0);
}

if (args[0] === "--") {
  args.shift();
}
if (args.length === 0) {
  console.error("usage: with-search-list-lock.mjs -- <command> [args...]");
  console.error("       with-search-list-lock.mjs prepend <keychain-path>");
  process.exit(2);
}

try {
  process.exit(runUnderSearchListLock(args[0], args.slice(1)));
} catch (error) {
  console.error(error instanceof Error ? error.message : "command failed");
  process.exit(1);
}
