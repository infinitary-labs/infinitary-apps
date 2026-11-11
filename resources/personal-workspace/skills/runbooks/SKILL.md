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

## Check what reaches the crew

Parse the manifest, check its declared files and folders exist inside the runbook, and read the final guidance and skill back.
A new personal runbook is on when the app next reads it, because the captain asked for it; it appears under Yours in Settings → Runbooks.
Only when the captain wants it to start off, as an experiment to try later, add `"startsOff": true` to the manifest; it then stays off until they ask the first mate to turn it on.
No install or extra activation is needed for a new personal folder, and its files are not replaced by app updates.
An invalid folder shows its reason under Yours and supplies no guidance until repaired.
The first mate receives guidance at its next idle boundary, and new crew conversations receive their selected guidance and skills.
Existing crew conversations do not change mid-turn.
Report what you created, its reach, and what you checked; the host commits workspace changes.
