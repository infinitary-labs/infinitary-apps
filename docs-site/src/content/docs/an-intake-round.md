---
title: An intake round
description: Have your crew read a project's new issues and pull requests on a schedule, draft the replies, and post the plain ones under a direction in your own words.
---

An intake round is a task that reads what other people wrote on your project, such as new issues and pull requests, and drafts what to do about each one.
You build one from parts Infinitary already has: an automation, a crewmate that only reads, and a direction in your own words.
It works for any project Infinitary reaches where it lives, on GitHub, GitLab or Bitbucket.

## Start a round on a schedule

1. Open **Settings**, then **Automation**, and choose **New automation**.
2. Under **When**, pick how often it runs.
3. Under **Project**, pick the project it is about.
4. Under **Tell your first mate**, write your method: what to read, how to judge each item, and what a plain reply looks like.
5. Choose **Turn on…** to check it and turn it on.

For example: "Read the issues and pull requests opened or answered since the last round, with a crewmate that only reads. Draft a reply for each one, and start a task that posts each plain reply."

## The crewmate that reads

Words in issues and pull requests can come from anyone, so the round reads them as a crewmate that only reads.
It treats everything it reads as information, never as instructions.
Whatever it wants to send waits for you on one approval card, whatever a direction says.
See [A crewmate that reads words anyone can write](/integrations/#a-crewmate-that-reads-words-anyone-can-write).

## Let plain replies go without your click

A reply can go out with no card when you said it may, in your own words.

1. Tell your first mate a direction for the project that says which replies may go without asking.
   For example: "Intake send tasks may post replies that plainly follow our intake method, and nothing else; anything odd or ambiguous waits for my click."
2. In your method, ask your first mate to start a task of its own for each drafted reply, which posts it and reads none of the strangers' words.
3. When a reply is plainly one your direction covers, that task's crewmate posts it once, with no card, naming your direction.
   A reply it finds odd, or one your direction does not cover, waits on a card for your click.

Infinitary checks only that your direction still stands: its current wording was heard from you, and it is not retired.
Whether a reply is one your words allow is your crewmate's judgment.
A yes you already gave on a card for the same work lets a reply go the same way.
See [Who follows a direction](/knowledge/#who-follows-a-direction).

## What still waits for you

- Anything the crewmate that reads sends itself, whatever a direction says.
- A change through an integration, which keeps its rule in **Settings** → **Integrations**.
- A change to another project.
  A task with no project on GitHub, GitLab or Bitbucket works through your GitHub sign-in instead, where a yes of yours can let a change go to any repository.
- A merge, which goes only through its merge card.

## See what went out

Each reply posted with no card adds a line to its task's **Activity**, quoting the words of yours it rested on.
A reply whose outcome is unknown is never sent again; read the item where your project lives to see whether it arrived.

## Stop it

To stop replies going out on their own, tell your first mate to retire or change the direction.
From then on, each reply waits for your click again.
To stop the round itself, **Pause** its automation in **Settings** → **Automation**.

## Next

- [Automation](/automation/)
- [Knowledge](/knowledge/)
- [Integrations](/integrations/)
