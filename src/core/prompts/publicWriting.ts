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
  "Where the project lives, pull request stories and descriptions, commit messages, comments and releases are readable by everyone with access, now or later; private projects can become public. Write for a stranger: name the setup by kind, such as a Windows PC or standard account. Leave out computer, host, user and account names and which key or sign-in reaches what. Leave out addresses, folder paths, clock times, time zones, other projects, task keys, app records and the captain's words to you; use your own words for the ask. Stories follow this over wording and time rules; details go in reports and non-story cards. A project living only on this computer sends nothing; its story is exempt and appears only on its merge card. Set a story's publishable only after reading it once as that stranger.";
