/**
 * The personal workspace's `AGENTS.md`. Force-copied and self-healed at every
 * boot (../workspace.ts). Common workspace rules stay here. Panel mechanics
 * have one copy, in the personal-panel skill. Types stay in the generated
 * `infinitary-env.d.ts`; a panel looks up the ones it uses and does not read
 * the file from top to bottom.
 */
export const PERSONAL_AGENTS_MD = `# Personal workspace

This folder holds personal panels and lesson records, not standalone games or apps.
A lesson comes back as cards. Open the lessons skill, read \`lessons/learner.md\`, and keep that subject's progress under \`lessons/<subject>/\`. Do not open the panel skill, \`infinitary-env.d.ts\`, or the design overview for a lesson.
A game or a standalone app belongs in its own project. That project keeps the setup, planning and delivery the captain submitted. It does not use this folder's rule of no branch and no pull request.

## Stay inside this workspace

Work only in this directory. Never search parent directories or the app's own source: the
host source is not on disk in an installed app, and macOS may prompt for permissions when a
process walks outside.

## What to open

Open the one skill your brief names. Do not read every skill under \`.claude/skills/\`.
A panel task opens \`.claude/skills/personal-panel/SKILL.md\` before it writes or changes a panel. That skill is the one copy of a panel's shape, imports, store, actions, cards and checks. Look up a type you use in \`infinitary-env.d.ts\` next to this file (the \`@infinitary/contracts\` module). Do not read that file from top to bottom.
The captain's panel instructions arrive as standing directions with each turn; follow them too.

## What the host still does

Do not commit. The host commits at the end of each turn, and your completion is a report, never a merge card. There is nothing to merge, land, or discard.
`;
