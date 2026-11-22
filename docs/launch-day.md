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
   Read back: the issue is locked and its author association is `MEMBER` or `OWNER`.
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
5. **Crew: require approval for every outside contributor's runs.**
   Set the fork run approval to "Require approval for all external contributors".
   Read back the effective policy.
6. **Crew: a branch rule on `main` requires the "Contributor License Agreement" check.**
   The rule also blocks force pushes and deletion and requires no reviews, since merges go through the app.
   Read back that the rule is active and names the check's exact context.
7. **Crew: read back steps 5 and 6 and the access.**
   Also read back: default workflow permissions are read, no repository or organization secrets reach the project, the four release environments allow only `main`, and forking and run approval match this page.
8. **Captain: allow one test pull request.**
   The crew asks consent on a card, then opens it from a throwaway copy under the captain's own account.
   It expects: GitHub's machines only, the `edits checks` label when it edits a check file, the agreement check failing until its author accepts, and the project's own machines refusing the copy.
   The captain's account is a member, so the test cannot show the run approval a stranger sees; the first real outside pull request does.
   Close the test pull request and delete the copy afterwards.
9. **Captain: open pull requests to everyone, last of all.**
   Move pull request creation from collaborators only to everyone, after step 8 passes.
10. **Crew: the website's studio sentence.**
    Run the website task that changes the "your own studio" description to say the project is open source and links to the project.
