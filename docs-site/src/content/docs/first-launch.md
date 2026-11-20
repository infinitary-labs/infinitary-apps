---
title: First launch
description: What Infinitary shows the first time you open it, how to connect a subscription, and how to add your first project.
---

Before you start, check [what you need](/install/).
This page walks through the first time you open Infinitary, and what changes after that.

## What the window shows

The first time you open Infinitary, your first mate greets you in the middle of the window.
Above it reads **Welcome aboard Infinitary, Captain**, with a line from your first mate:

> I'm your first mate.
> I'll help you manage the rest of the crew.
> Set me up on a computer that stays on as much as possible.
> Your other devices need me awake.

Below that is a button for each provider your first mate can use: Codex, Grok, Claude, Kimi Code, Copilot, OpenRouter, Amazon Bedrock and Custom API.

<img class="picture-dark" src="/pictures/first-launch-dark.webp" alt="The first launch: the first mate in the middle of the window, the welcome words, and a button for each provider." width="1280" height="652" />
<img class="picture-light" src="/pictures/first-launch-light.webp" alt="The first launch: the first mate in the middle of the window, the welcome words, and a button for each provider." width="1280" height="652" />

The message box at the bottom is dimmed and reads "connect a subscription first".
Nothing else works until a subscription can answer your first mate.

## Connect a subscription

1. Pick your provider's button.
2. Sign in the way that provider asks.
   Some open the sign-in page in your browser.
   Copilot and Kimi Code show a code: press **Copy code**, then enter it on the provider's site.
   OpenRouter takes an API key you paste.
   With Amazon Bedrock, choose a region and use an AWS profile on this computer or paste a Bedrock API key.
   A provider that offers both asks whether to **Sign in with your browser** or paste an **API key**.
3. Wait while the window says it is connecting.
   When the subscription can answer, the welcome screen fades and the message box opens.

If you use Claude, Infinitary uses the Claude Code you installed on this computer.
Without it, the Claude button says to install Claude Code first.

If a subscription is connected but still cannot answer, the window reads **Set up your first mate on this computer** and says what is still missing.

## If your first mate already lives on another computer

Under the provider buttons, a second group reads "Your first mate is on another computer".
On a Mac or an x64 Linux computer, **Set up from your first mate's computer** comes first: it shows this computer's address to type on the computer where your first mate lives.
Once that computer adds this one, this window opens your first mate by itself, as long as nothing was set up in it yet, such as a sign-in or a project.
A window where you already set something up keeps its own first mate: use **Paste its link** or **Join by its address** to control that first mate from here instead.
A window beside an Infinitary you started yourself from Terminal keeps that one's first mate and offers neither way; stop that Infinitary first to use them.
A Windows PC and an Arm Linux computer show the other two ways alone.
See [Your other computers](/your-other-computers/).

## The Diagnostics notice

A notice under the message box says what Diagnostics sends and that it never includes what you type.
Choose **OK** to keep it on, or **Turn off**.
You can change it later in [Settings](/settings/#general).
See [What leaves your computer](/what-leaves-your-computer/).

## The welcome card

Once your first mate can answer, a card titled **How we work** appears.
It is a small picture of the window that shows one part at a time.
Press **Next** and **Back** to see the message box, a card, Activity on the left, and Tasks on the right.

Under the picture are three starters:

- **Clone a project**
- **Start a new project**
- **Work in a folder on my computer**

Pressing one puts the start of a sentence in the message box, such as "Clone the project at ".
Finish the sentence and send it.
The starter sends nothing by itself.

The welcome card has no reply field: the message box under it is where you type.
Close it whenever you like.

## Add your first project

Your first mate needs a project to work in.
The easiest way is a starter on the welcome card, or the same words in your own message.

When you ask, your first mate shows a card that names the project and how it will be set up.
Check the choices on the card, then press **Add project**, or **Not now** to leave it.
Nothing is added until you press **Add project**.

You can also add a project yourself in Settings → Projects with **Add project**.
See [Projects](/projects/) for the choices there.

## Later launches

When a subscription can answer, Infinitary opens straight to the message box.
Your cards, tasks and crew are where you left them.

After Infinitary updates, a card names the new version and what changed.
You can read it again later from [Settings → General](/settings/#general), under Version.
On a Mac, the Help menu's **What’s New in Infinitary** opens it too.

If your last subscription stops working, for example because you signed out, the welcome screen comes back until one can answer again.
If your plan's allowance runs out, your first mate shows a card that says so instead, and keeps your messages until it can answer.
See [Subscriptions and allowance](/subscriptions-and-quota/).

To open Infinitary when you sign in to your computer, turn on **Start at login** in Settings → General.
