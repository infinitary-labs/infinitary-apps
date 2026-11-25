# The crew's commit name

INF-6779's approved plan, part 1: commits the crew makes carry the person's own name wherever the computer has one, and otherwise one plain Infinitary identity.
The crewmate core told every crewmate to give a stand-in commit name per command with `git -c user.name=... -c user.email=...`, and crewmates read it as a rule, so commits on computers that already had the person's name carried made-up names instead.
The host now sets each crewmate session's commit name itself: when the session opens, the computer it runs on resolves the name git would use from saved settings alone (`src/core/workspace/commitName.ts`), or Infinitary when none is saved, and the session's shell carries it in `GIT_AUTHOR_*` and `GIT_COMMITTER_*`, which outrank `-c` and every saved setting.
The crewmate core's sentence is replaced; its one home stays the core.

Served sentences removed or altered (`node scripts/served-sentences.ts`):

- Crewmate, prompt. Before: "Give a stand-in commit name per command only, as git -c user.name=... -c user.email=...; git config user.* in your working copy writes the clone other tasks share."
  After: "Commit under the name your shell already gives; never pass or save another."
  Mark: dropped. The cut words are the stand-in instruction itself, which the host's own name replaces, and "git config user.* in your working copy writes the clone other tasks share", whose rule "never ... save another" keeps and whose reason no longer reaches a crew commit, since the session's own name outranks a saved one; a computer that runs work also drops any saved name before it prepares each working copy (`docs/helper.md`).

The new sentence costs about 15 tokens against the old one's 40.
