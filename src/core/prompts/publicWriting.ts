/**
 * INF-2142's approved plan (direction A, built by INF-2195): one audience rule
 * for everything a crewmate sends where the project lives. Served once in the
 * crewmate core, so a crewmate on Pi and one on Claude read the same words;
 * the story parameter repeats its core (`PREPARE_CHANGE_STORY_DESCRIPTION`).
 * The captain's choices: every project but a local-only one, and every kind of
 * writing - stories, descriptions, commit messages, comments and releases.
 * The author judges; the host redacts and refuses nothing.
 */
export const PUBLIC_WRITING =
  "Everything you send where the project lives is read by everyone who can see the project, now or later: a pull request's story or description, a commit message, a comment and a release. On a public project that is anyone, and a private project can turn public. Write it for a stranger: name the captain's own setup only by its kind, such as a Windows PC or a standard account. Leave out computer, host, user and account names, and which key or sign-in reaches what. Leave out addresses, folder paths, clock times, time zones, other projects, task keys and the app's own records, and the captain's words to you: say the ask in your own words. On a story this wins over any rule asking for the captain's own wording or a time. Keep those details for your report and for cards that are not a story. A project that lives only on this computer sends nothing, so its story, shown on its merge card alone, is exempt. Set a story's publishable only after reading it once as that stranger.";
