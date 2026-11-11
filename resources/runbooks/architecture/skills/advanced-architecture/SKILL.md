---
name: advanced-architecture
description: Map a project as flat diagrams and show what a change moves on them - the .architecture.json map files, how to find parts, links and state machines, the comparison between two versions, and the map part that draws both on a card. Read before writing or updating map files, or before showing a map or what changed.
---

# Advanced architecture

A map is a project's design as its people talk about it: its parts, the links between them, and the state machines inside them.
The map part draws it flat, one level at a time; a part whose folder has its own map file opens into that map.
A map file holds names, groups, links with their why, and machines, never files, lines or counts: those come from git each time it is drawn, so a map file goes stale only when the design changes.

## Map files

One `.architecture.json` per mapped folder, starting at the project's top; `parts/map.schema.json` beside this guide is the format.
Check every map file you write against it before your pull request.
A worked example, the top of a small online shop:

```json
{
  "name": "Print shop",
  "about": "Sells art prints online and ships them.",
  "groups": [
    { "name": "Storefront", "why": "Runs in the shopper's browser" },
    { "name": "Back office", "why": "Runs on the server" }
  ],
  "parts": [
    { "name": "pages", "path": "web/pages", "about": "What shoppers see", "group": "Storefront" },
    { "name": "cart", "path": "web/cart", "about": "The basket and checkout form", "group": "Storefront" },
    { "name": "api", "path": "server/api", "about": "Answers the browser", "group": "Back office" },
    { "name": "orders", "path": "server/orders", "about": "Takes an order from paid to shipped", "group": "Back office" },
    { "name": "catalog", "path": "server/catalog", "about": "Prints, sizes and prices", "group": "Back office" }
  ],
  "outside": [
    { "name": "card payments", "about": "The payment provider's service" },
    { "name": "database", "about": "Orders and the catalog" }
  ],
  "links": [
    { "from": "pages", "to": "api", "why": "reads the catalog" },
    { "from": "cart", "to": "api", "why": "places an order" },
    { "from": "api", "to": "orders", "why": "starts and looks up orders" },
    { "from": "api", "to": "catalog", "why": "lists prints" },
    { "from": "orders", "to": "card payments", "why": "charges and refunds" },
    { "from": "orders", "to": "database", "why": "keeps orders" },
    { "from": "catalog", "to": "database", "why": "keeps prints" }
  ],
  "machines": [
    {
      "name": "an order",
      "in": "orders",
      "about": "One shopper's purchase",
      "states": ["placed", "paid", "shipped", "refunded"],
      "moves": [
        { "from": "placed", "to": "paid", "why": "the charge clears", "by": "card payments" },
        { "from": "paid", "to": "shipped", "why": "a label is printed", "by": "orders" },
        { "from": "paid", "to": "refunded", "why": "the shopper cancels", "by": "api" }
      ]
    }
  ]
}
```

`server/orders/.architecture.json` would map that folder's own parts the same way, with paths under `server/orders`.

## How to map

1. Read the project's README, its docs and its folder tree, and use the names its people use.
2. A part is a folder whose code has one job and changes together. Its path is that folder from the project's top, never a file.
3. Group parts by what they share, such as where they run or who uses them, and say why. A part is in at most one group.
4. A link goes from the part that uses to the part it uses, with what the use is for in a few words. Read every kind of use, in every language the project has: imports, calls, messages and channels, web addresses, files one writes and another reads. One link per pair; fold many uses into one why.
5. An outside box is what the project reaches and does not own: a service, a database, the system, another program. Give it a path only when it is a folder of this project outside the mapped folder.
6. Keep a level to what one look holds, about twelve boxes. A part too big for that gets its own map file in its folder.
7. Leave `place` out unless the drawn layout reads badly; then give a box's column and row from 0.

## State machines

A state machine is a value that moves through named states by rules: a status field, a phase, a lifecycle, a reducer's modes.
Find them in types and status fields, then read every place that changes the value.
Write a machine into the map file of the folder whose part holds it, with `in` naming that part.
Name its states in the project's words, first state first, and each move with its why and, in `by`, the part or outside box on that map whose code makes it.
When one machine's state starts another, name that machine under `opens`.
Map the machines a person would talk about; skip a flag with two states.

## A comparison

A comparison draws what changed between two versions: a pull request and its base, or now and a date, a release or a commit.
Work it out from git and the code, then give it to the map part as one entry of `compare`:

- Find the older version: a pull request's merge base with its base branch, a release's tag, or for a date `git rev-list -1 --before=<date> <default branch>`.
- `files`: every changed file from `git diff --numstat -M` and `--name-status` between the two, as `[path, "+", added, removed]` for an added file, `"-"` for a removed one and `"~"` for a changed one. A renamed file is one removed and one added; a binary file counts 0 lines.
- `was`: for each folder whose map file differs, that file as it was at the older version (`git show <old>:<folder>/.architecture.json`), or `null` when it had none. Leave out a folder whose map file did not change.
- `names`: for a machine whose states were renamed, each new state's old name, `{ "<machine>": { "<state now>": "<state it was>" } }`. Pairing them is your judgment from the diff.
- `untraced`: the machines you did not trace this time. They show no tags, never "unchanged", and one the newer map file no longer holds is left off instead of shown removed.

A change that moves nothing on the map, such as a docs edit, gets no change view: say so in a sentence instead.

## Drawing it on a card

Copy `parts/map.html` into a card body whole and fill in only its JSON block, as the comment at its top describes:

- `maps`: every map file to draw, keyed by its folder (`""` for the top).
- `counts`: for each part's folder, `{ "files": n, "lines": n }` from `git ls-files` and a line count of those files; boxes are sized from them.
- `compare`: the comparisons, one button each.
- `open`: where the card opens, a part's folder or a machine's name, including one that comparison removed, and which comparison is on.

A card body holds at most 65,536 characters, and the part takes about 40,000 of them.
When the data does not fit, pack it: deflate it raw, encode it in base64, put that in the block and add `data-packed` to it, for example with `node -e "process.stdout.write(require('zlib').deflateRawSync(require('fs').readFileSync(0)).toString('base64'))" < map-data.json`.
If the map part lists problems under the drawing, fix the map files and draw it again before the card goes up.
The reader clicks a box for its links or a pill for its state machine, goes in with a double-click or Enter, goes back with Esc, chooses with the arrows, and moves with drag, scroll, +, − and 0.
For a picture of it, such as in a pull request, open the filled part as a page in your task's browser, photograph it and look at the picture before using it.
