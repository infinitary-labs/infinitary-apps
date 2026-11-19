---
name: runbooks
description: Create or customize lasting guidance or a skill for the first mate or every crewmate, as a personal runbook.
---

# Your own runbooks

Work in this personal workspace's `runbooks/<id>/` folder.
A skill for just one project belongs in that project's own skills, not here.
Never edit a built-in or the app's files.
To customize a built-in, ask the first mate to use `app_change runbook-copy` first, with a new id and name; then edit the returned personal path.
A copy starts off and names the built-in in `replaces`; ask the first mate to turn it on when the captain wants the changed guidance to take effect.
Turning it on switches the named built-in off.

## Make a new runbook

Choose an unused lowercase id with words joined by hyphens.
Never overwrite an existing folder or identity.
Create `runbooks/<id>/runbook.json` with a name, description, author and version.
Only declare the sections or folders this request needs.
For example, guidance for the first mate and a skill available to every crewmate:

```json
{
  "id": "plain-release-notes",
  "name": "Plain release notes",
  "description": "Write release notes in plain words.",
  "author": "You",
  "version": "1.0.0",
  "firstmate": "guide.md",
  "skills": "skills"
}
```

Write the lasting instruction in `guide.md` as Markdown.
A crew instruction instead uses `"crew": { "file": "crew.md" }`.
Both sections may exist; omit a section that has nothing to say.
For a skill, create `skills/<skill-name>/SKILL.md` with Agent Skills frontmatter (`name` and `description`) and its instructions.
The description tells a crewmate when to open the skill.
A skills folder is available on demand to every crewmate in the runbook's reach, independently of the crew section's selectors.
Project skills win a shared skill name, then opted-in personal skills, then runbook skills; choose a distinct name when needed.

An optional `crew.when` narrows the crew section using arrays of known facts: `kind`, `place` (`project` or `personal`), `delivery`, `care`, `backend`, or `project` (project ids).
Each provided selector must match; omit selectors for unrestricted reach.
An empty array matches nothing.
An optional top-level `projects` array restricts the whole runbook, including skills, to those project ids.
Never narrow the reach when the captain asked for every crewmate.
A runbook may also name a `parts` folder for HTML parts and pictures.
Use only plain Markdown, text, JSON, HTML, CSS and picture files, with no symbolic links, executable source or paths outside the runbook.
Do not install a panel just because a runbook carries parts.

## Show panels while the runbook is on

A runbook may list panel folders in `panels`, such as `"panels": ["batches"]` for `runbooks/<id>/batches/`.
Each folder is a panel written as the `personal-panel` skill says, with a `manifest.json` and `panel.tsx`, and no `server.ts`: a runbook's panel runs no code of its own in the app.
While the runbook is on, its panels show on the rails as `<id>-<folder>`, or under the built-in's id for a copy that names `replaces`; turning it off takes them away.
Keep panel folders apart from the guidance, skills and parts folders.

## Name commits and pull requests

How commits and pull requests are named comes only from a runbook; the app holds no rule of its own.
To change it, copy the built-in Commit and PR naming runbook and edit the copy's `naming` object and guidance together:

```json
"naming": {
  "pattern": "^\\[[A-Z]+\\] \\S.+$",
  "message": "Start with the area in capitals and brackets, such as \"[DOCS] Explain the export\".",
  "compose": "[APP] {summary}",
  "footer": "^Refs: [^\\r\\n]+"
}
```

`pattern` is the regular expression every commit subject and pull request title must match, and `message` is what an author is told when one does not.
`compose` names each commit the app writes itself, with `{summary}` standing for its plain summary; it must itself match `pattern`.
`footer` is the regular expression for the lines of a pull request's own text that its squash commit message carries.
`compose` and `footer` are optional: without them the app's commits carry their plain summary and no footer is carried.
The first runbook that is on and declares `naming` decides; with none on, no name is checked.

## Check what reaches the crew

Parse the manifest, check its declared files and folders exist inside the runbook, and read the final guidance and skill back.
A new personal runbook is on when the app next reads it, because the captain asked for it; it appears under Yours in Settings → Runbooks.
Only when the captain wants it to start off, as an experiment to try later, add `"startsOff": true` to the manifest; it then stays off until they ask the first mate to turn it on.
No install or extra activation is needed for a new personal folder, and its files are not replaced by app updates.
An invalid folder shows its reason under Yours and supplies no guidance until repaired.
The first mate receives guidance at its next idle boundary, and new crew conversations receive their selected guidance and skills.
Existing crew conversations do not change mid-turn.
Report what you created, its reach, and what you checked; the host commits workspace changes.
