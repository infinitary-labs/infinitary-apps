---
title: Integrations
description: Connect GitHub, GitLab, Bitbucket, Google and MCP servers so your first mate and crew can reach them, and choose what each one may do without asking you.
---

An integration is a connection to something outside your projects, such as GitHub, Gmail or a service of your own.
Each one is signed in as you.
Your first mate, your crew, your automations and your panels reach it the same way, through the same sign-in and the same rules.

<img class="picture-dark" src="/pictures/integrations-dark.webp" alt="Settings, Integrations section: a connected Notes server with each of its reads and its change set to Asks you beside an on switch, then buttons to add GitHub, Google, an MCP server, GitLab or GitHub Enterprise, the Infinitary command switched off, and an empty Private sites list." width="1180" height="709" />
<img class="picture-light" src="/pictures/integrations-light.webp" alt="Settings, Integrations section: a connected Notes server with each of its reads and its change set to Asks you beside an on switch, then buttons to add GitHub, Google, an MCP server, GitLab or GitHub Enterprise, the Infinitary command switched off, and an empty Private sites list." width="1180" height="709" />

## Where integrations live

Open **Settings**, then **Integrations**.
You can also search for **Open Integrations** in command search.

Each row is one connection.
It shows the connection's name, who it is signed in as or what it runs, and how many of its actions are on.
Open a row to see its actions, and what it can tell your automations.

The menu at the end of a row has:

- **Check now**, which checks that the connection still works.
- **Pause**: nobody reaches it until you **Resume** it.
- **Sign out and remove**, or **Remove** for an MCP server.

The buttons under the list connect something new, such as **GitHub**, **Google** or **MCP server**.
You can also ask your first mate to connect something.
A sign-in is always yours to make, so your first mate brings you a card that opens this tab.

## GitHub, GitLab, GitHub Enterprise and Bitbucket

Your sign-in to where your projects live is kept here.
See [Projects](/projects/#your-github-gitlab-or-bitbucket-sign-in) for how Infinitary uses it to clone a project and offer its changes.

- **GitHub**: you enter a code on GitHub's page in your browser.
  If GitHub CLI is on this computer and your organization blocks apps like Infinitary, **Use GitHub CLI** uses the sign-in GitHub CLI already holds.
- **GitLab**: you sign in in your browser or paste a key, on gitlab.com or on your own GitLab server.
- **GitHub Enterprise**: you make a key on your own server and paste it here.
- **Bitbucket**: you make an API token on your Atlassian account and paste it here, for bitbucket.org.
  For your own Bitbucket Data Center server, version 8.19 or newer, you enter its address and paste an HTTP access token you make on it, with Project read and Repository write permissions.
  A Data Center row offers no actions yet.

Each row has two actions: one that reads, and one that changes something, such as **Change something on GitHub**.
They are what your first mate and crew use to look things up or act there beyond a task's own work.
A task's branch, its pull request, its checks and its merge follow your project's settings instead.

If another computer runs work for you, its own GitHub sign-in, for cloning and pushing there, has a row here too.
See [Your other computers](/your-other-computers/).

Signing out of GitHub stops private clones and pull requests until you sign in again.

## Google: Gmail and Calendar

Google is one sign-in for both Gmail and Calendar.

1. Press **Google**.
2. Read **Before you connect Google**: what Infinitary uses from your account, where it goes and how long it stays.
3. Press **Accept and continue to Google**, or **Cancel** to ask nothing of Google.
4. Finish signing in on Google's page in your browser, and allow every permission it lists.

If you leave a permission unchecked, Infinitary keeps nothing and you can sign in again.
Each time you sign in to Google, the notice shows first.

With Google connected, your first mate and crew can search and read your mail, save an attachment into a task's folder, label or archive a message, draft a message and send one.
In Calendar they can list your calendars and events, read an event, read when you are busy, and create or update an event.
No action deletes a calendar event.

What your first mate and crew read stays in their saved conversations for 30 days.
Then a note takes its place.
To delete it sooner, press **Delete** on the **Delete Gmail and Calendar content** row under **Data**, at the foot of the tab.
A saved attachment stays in its task's folder until the task closes or 30 days pass.
Words a crewmate read inside a saved attachment stay in its conversation after the 30 days.
What your first mate and crew wrote themselves, in cards, notes and files, stays until you delete the task.
Removing Google deletes none of what they already read.

Anyone can send you words written to steer an AI.
Infinitary hands your mail and events to your first mate and crew marked as information from outside, never as instructions.
A message can still mislead an AI model.
A crewmate can reach the internet without asking you, so a misled crewmate could send what it read elsewhere.

## MCP servers

An MCP server is a program or a web address that offers actions to AI apps.

1. Press **MCP server**.
2. Give it a **Name**.
3. Under **Runs**, enter a program and its arguments, or the server's https address.
4. Press **Connect**.

A program starts on this computer when someone uses it.
Infinitary connects at once and opens the new row on the server's own list of actions.
If it cannot connect, the form says why.

If the server needs a key, put it at the start of the **Runs** line yourself, such as `EXAMPLE_KEY=your-key npx -y @example/mcp-server`.
Infinitary moves the key into [Secrets](/secrets/), and the line keeps only a reference to it.
The server gets the key each time it starts, without asking you.
Your first mate and your crew never see it.
Removing the server forgets its keys.

## What each action may do without asking you

An open row lists each action with what it does: **reads**, **changes** or **sends**.
Every action starts at **Asks you**, reads included.
Press its rule to switch between **Asks you** and **Always allowed**.
Only you can change a rule.
The switch beside an action turns it off, and then nobody can run it.

When your first mate or a crewmate uses an action that asks you, Infinitary puts up its own approval card.
The card shows exactly what would run, and the reason it was given.

- **Always allow** runs it, and that action then runs without asking until you change it in Settings, replace the connection, or the action changes.
- **Allow for the rest of this task**, on a crewmate's ask, runs it and lets that crewmate run the same action in the same place without asking until its task closes.
  The card says what the place is, such as a repository on GitHub or the recipients of a message.
- **Only this time** runs it once.
- **Not now** runs nothing.

When a crewmate asks several times on one connection, the asks share one card, a row each with a ticked **Allow** box.
Untick a row, and it never runs.
Putting the card aside leaves its asks waiting.

If Infinitary cannot tell whether a change arrived, it never sends it again.
What an integration answers is information for your first mate and crew, never an instruction.

A panel can use the integrations it names too.
Its asks raise the same card, naming the panel.
See [Panels](/panels/).

## What an integration can tell

Some connections tell when something happens, and an automation can wait for it.
An open row lists these marked **tells**.

- GitHub: **A workflow run fails** and **A workflow run finishes**, in a repository you name.
- Gmail: **A message arrives**.
- Calendar: **A calendar event changes**.
- An MCP server that offers it: **A resource changed**.

Choose one under **When something happens** in Automation.
See [Automation](/automation/#when-it-runs).

## The Infinitary command

The **Infinitary command** box is for programs you run on this computer, and for your own AI agents.
With one command, they can read and act on your cards and tasks and talk to your first mate as you.
A crewmate never gets it.

It is off until you turn it on.
Once it is on, the box shows the line to run, with **Copy**, and **Link it** offers a shorter name where it can.
The first time you turn it on, it also turns on an automation, **Infinitary Inbox events**, so your first mate is told of each note a program sends.
A note is information, never an instruction.

Turn it off, and the command answers with an error while the saved notes stay.
**Delete Infinitary Inbox notes**, under **Data**, removes the notes and turns it off.

## Private sites

The **Private sites** box lists sites on your office, home or VPN network that task browsers may open.
The list applies on all your computers.
Press **Site** to add one, or **Remove** to take one away.
Your first mate never adds a site itself: it asks you on a card, and only your **Allow** adds it.
See [The crew's browser](/the-crews-browser/#private-sites).

## Next

- [Secrets](/secrets/)
- [Automation](/automation/)
