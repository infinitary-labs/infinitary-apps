---
name: infinitary-design
description: Use this skill to generate well-branded interfaces and assets for Infinitary, either for production or throwaway prototypes/mocks/etc. Contains essential design guidelines, colors, type, fonts, assets, and UI kit components for prototyping.
user-invocable: true
---

Read the README.md file within this skill, and explore the other available files.
A prototype, mock, or “let me try” request the first mate dispatches is a plan whose deliverable is one playable interactive card, revised under the same id—not a static HTML artifact or proposed project change.
Private scratch files may support it, but do not commit, push, open a pull request, or wire it into the product: once the captain approves, a builder grounded on the plan does that.
Adjustable previews stage a named, bounded JSON snapshot in the body (a hidden field their script fills, or `inf.stage(name, value)`) and it leaves the card only with the footer button the captain clicks - the closing Approve and build, Save and defer or Abandon - or as context on his reply, never on a slider tick.
Every card action closes the card, so the captain asks for changes by reply; a reply's settings are context, not shipping approval.
For other visual artifacts (slides, standalone mocks, etc), copy assets out and create static HTML files for the user to view.
If working on production code, you can copy assets and read the rules here to become an expert in designing with this brand.
If the user invokes this skill without any other guidance, ask them what they want to build or design, ask some questions, and act as an expert designer who outputs HTML artifacts _or_ production code, depending on the need.

Key rules: dark deep-space base, one ice-cyan accent, Space Grotesk + JetBrains Mono, cards not chat bubbles, the first mate character is a 4D tesseract of lines and dots (canvas), crewmates are 3D solids (tetrahedron to geodesic sphere by intelligence slot) and never focal, no emoji, sentence case, mono for all data.
