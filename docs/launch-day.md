# Launch day: opening the project to outside pull requests

`infinitary-apps` is private, with forking off and pull request creation limited to collaborators.
This page is the ordered checklist for making it public and opening it to outside pull requests.
Until step 9, only collaborators can open pull requests, so nothing from outside arrives while the guards go up.
Four steps need the captain: 3, 4, 8 and 9.
The crew does the rest.
What each guard is and why it exists is in `docs/public-ci.md`; this page only orders the work and says how to read each step back.

## Before launch day

1. **Crew: the agreement's record issue.**
   Create the issue titled "Contributor License Agreement record" as a maintainer and lock it.
   The agreement check fails every outside pull request without it, and counts only a locked issue a maintainer opened (`scripts/contributor-agreement.mjs`).
   Read back: the issue is locked, its author association is `MEMBER` or `OWNER`, and a GitHub search for its exact title returns it as the oldest such issue, which is the lookup the check makes (GitHub's search can lag a few minutes behind a new issue).
2. **Crew: the guards are on `main`.**
   `check-file-flag.yml`, the contributor agreement check, and the outside-contributor routing and guide in `docs/public-ci.md` and `docs/testing.md`, "An outside contributor's pull request".
   An approved outside change merges as its own pull request after GitHub's machines run the batch's tests on it (`docs/forge.md`, "Batches of your own").
3. **Captain: the organization's runner groups and secrets.**
   The crew's sign-in cannot read them.
   Confirm no runner group is open to public projects and no organization secret reaches the project; the project's own machines serve named projects only and refuse a job from another copy of the project.

## Launch day, in this order

4. **Captain: make the project public.**
   One click on a card; the crew sends it.
   The project's settings below cannot be set while it is private, which is why they follow.
5. **Crew: require approval for every outside contributor's runs, and turn on secret scanning and push protection.**
   Set the fork run approval to "Require approval for all external contributors".
   GitHub refuses secret scanning and push protection while the project is private, so turn both on now.
   Read back the effective policy and both controls.
6. **Crew: a branch rule on `main` requires the "Contributor License Agreement" check.**
   The rule also blocks force pushes and deletion and requires no reviews, since merges go through the app.
   Read back that the rule is active and names the check's exact context.
7. **Crew: read back steps 5 and 6 and the access.**
   Also read back: default workflow permissions are read, no repository or organization secrets reach the project, the four release environments allow only `main`, Dependency graph and Dependabot alerts, secret scanning and push protection are on, and run approval matches this page.
   Forking is open once the project is public, which is expected; GitHub applies the forking setting only to private projects.
   The captain reviews any secret-scanning findings privately, and rotates an exposed credential through its owner (`docs/public-ci.md`, "Repository security controls").
8. **Captain: allow one test pull request.**
   The crew asks consent on a card, then opens it from a throwaway copy under the captain's own account.
   The test pull request edits a check file so that one harmless job asks for the project's own machines; every job of an outside pull request otherwise goes to GitHub's machines and never reaches the fork guard.
   It expects: the `edits checks` label, the agreement check failing until its author accepts, every other job on GitHub's machines, and that one job never starting on the project's own machines, with the runner service logging a refusal.
   The captain's account is a member, so the test cannot show the run approval a stranger sees; the first real outside pull request does.
   Close the test pull request and delete the copy afterwards.
9. **Captain: open pull requests to everyone, last of all.**
   Move pull request creation from collaborators only to everyone, after step 8 passes.
10. **Crew: the website's studio sentence.**
    Run the website task that changes the "your own studio" description to say the project is open source and links to the project.

Once step 10 is done, the crew moves anything still true into `docs/public-ci.md`, then deletes this page and its `docs/README.md` entry.
