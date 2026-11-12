/**
 * INF-2142's approved plan (direction A, built by INF-2195): one audience rule
 * for everything a crewmate sends where the project lives. Served once in the
 * crewmate core, so a crewmate on Pi and one on Claude read the same words;
 * the story parameter points here rather than repeating them.
 * The captain's choices: every project but a local-only one, and every kind of
 * writing - stories, descriptions, commit messages, comments and releases.
 * The author judges; the host redacts and refuses nothing.
 */
export const PUBLIC_WRITING =
  "Where the project lives, a pull request's story or description, a commit message, a comment and a release are readable by everyone with access, now or later. Public projects are open; private ones can become public. Write it for a stranger: name the captain's setup by kind, such as a Windows PC or standard account. Leave out computer, host, user and account names and which key or sign-in reaches what. Leave out addresses, folder paths, clock times, time zones, other projects, task keys, app records and the captain's words to you; say the ask in your own words. For stories this overrides rules asking for wording or time. Keep details in reports and non-story cards. A project that lives only on this computer sends nothing; its story is exempt and shown only on its merge card. Set a story's publishable only after reading it once as that stranger.";
