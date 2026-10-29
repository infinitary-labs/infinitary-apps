# Contract changes

Every change to the published contract (`docs/contract.md`) adds one Markdown file to this folder, in the same pull request.
The contract is every core request and push of `src/shared/ipc.ts`, the orders of `src/shared/work.ts` and the connection's envelope (`src/shared/connection.ts`).
This README is not a change.

## The version moves only on a break

`PROTOCOL_VERSION` (`src/shared/ipc.ts`) is a typed line that only a major change edits.
A minor change adds its file and edits no version line, so two changes open at once each add a file of their own and merge cleanly.
The minor stays at 1 on major 10, the last minor typed before changes had names, and a major sets it to 0.
The patch is always 0.

Exactly one file is the major's, `major-<N>.md`, and `PROTOCOL_VERSION`'s major is its number.
Every other file is a minor change, and its name without `.md` is what this build lists in its hello and its welcome (`changes`, `docs/connection.md`).
`src/core/connection/contractChanges.test.ts` refuses a folder with no major file or two, and a version whose major is not the major file's.

## Adding a minor change

A minor change only adds: a new request, a new push, a new optional field, a new order.

1. Add one file named for the change in lowercase words joined by hyphens, such as `story-around.md`, never with a version number.
2. Write what the change adds and what an older side does without it, one sentence per line.
3. Leave `PROTOCOL_VERSION` as it is, and run `pnpm generate:contract` when a published shape changed.

A file's name is the change's name for good: never rename a minor file, and delete one only in a major.

## A feature that needs the other side to have the change

A home and a computer that runs work, on the same major, may still be built from different changes.
A feature that would break against a side without the change waits for the change's name, never for a number:

```ts
import { contractChange, listsChange } from "@core/connection/contractChanges";

/** Longer plan labels (`plan-label-limits.md`). */
const PLAN_LABEL_LIMITS = contractChange("plan-label-limits");

if (listsChange(link.state().homeChanges, PLAN_LABEL_LIMITS)) {
  // the home has the change
}
```

- `contractChange` refuses a name no file has when its module loads, so every test that loads the feature fails until the file exists.
- On the home, a computer's list is `WorkDeviceVersion.changes` (`WorkDevices.version`); on a computer, its home's is `HomeLinkState.homeChanges`.
- A side that listed nothing, such as one built before changes had names, has no change, so it gets no such feature.

A feature asked across majors, such as the update and download orders or where a computer gets Infinitary, keeps a typed number (`WORK_DOWNLOAD_SINCE`, `src/shared/ipc.ts`), because a major removes every name.
The numbers typed before changes had names (`*_SINCE`) stay as they are.

## Adding a major change

A major change is anything a side written against the older contract could not survive: a request, push or field removed or renamed, a field made required, a new member of a closed set, a meaning changed.

1. Add `major-<N+1>.md` and remove `major-<N>.md` and every minor file, since every side that takes work on the new major has them all.
   On a line of its own the file says whether it broke what views send or read: `Views: keep.` or `Views: break.`
   A new member of an open list (`VIEW_OPEN_LISTS`, `src/shared/openLists.ts`) keeps views; a removed or renamed request, push or field a view uses, or a new member of any other closed set a view reads, breaks them.
   A major that breaks views sets `VIEW_FLOOR` (`src/shared/ipc.ts`) to its own number, and one that keeps them leaves it; `src/core/connection/contractChanges.test.ts` refuses a floor that disagrees.
2. Set `PROTOCOL_VERSION` to `<N+1>.0.0` and run `pnpm generate:contract`.
3. Remove each wait for a removed name: a computer takes work only on its home's major (`takesWork`), so the feature no longer waits.
   A view feature may still meet an older home within its floor, so it waits for the name or the new major, as the phone's scene readings wait for `sceneObservationsSince`.

Two majors open at once both add the same file, so they conflict on purpose: the one that merges second takes the next number.

## An open pull request written before names

A pull request that typed a new minor converts once, when it is brought up to date with main:

1. Put back main's `PROTOCOL_VERSION` line, and regenerate the published contract and the phone's generated file with `pnpm generate:contract`.
2. Move the paragraph it added atop `docs/contract.md` into a new file here, named for the change.
3. Replace the `*_SINCE` number it added for its own feature with `contractChange("<its file name>")`, checked with `listsChange` against the other side's list.

A pull request that typed a new major takes the next major's file name, and follows the steps for a major.
