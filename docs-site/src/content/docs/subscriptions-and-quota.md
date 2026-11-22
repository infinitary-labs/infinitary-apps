---
title: Subscriptions and allowance
description: How to add your AI subscriptions, read how much of your plan's allowance is left, and what your crew does when it runs out.
---

Your first mate and your crew work through the AI subscriptions you already have.
You manage them in Settings, under **Intelligence**, in the **AI subscriptions** list.

## Add a subscription

1. Open Settings and choose **Intelligence**.
2. At the foot of **AI subscriptions**, under **Add account**, choose your provider: Codex, Grok, Claude, Kimi Code, Copilot, OpenRouter or Amazon Bedrock.
3. Sign in the way the provider asks.
   Some open your browser, some show a code to enter on their site, and some take a key you paste.
4. When the sign-in finishes, the new account appears in the list.

You can add more than one account of the same provider.
Its button then reads **Add another Codex account**, for example.

## Name your accounts

Each account has a label, so you can tell a personal account from a work one.
When the sign-in does not name the account, a name box opens so you can type one.
To change it later, open the account's menu and choose **Rename**.

A Claude account is different.
It follows the Claude Code sign-in on your computer, so its row shows whoever is signed in there now.
It has no **Rename**, and if you switch the Claude Code sign-in, the row follows.

## Read your plan's allowance

<img class="picture-dark" src="/pictures/subscriptions-dark.webp" alt="Two accounts in AI subscriptions, Codex and Claude, each with a session meter and a weekly meter, and the Add account buttons below them." width="1064" height="532" />
<img class="picture-light" src="/pictures/subscriptions-light.webp" alt="Two accounts in AI subscriptions, Codex and Claude, each with a session meter and a weekly meter, and the Add account buttons below them." width="1064" height="532" />

Each account shows a small meter for every allowance its provider has, such as a session and a week.
The number is how much is left.
Rest the pointer on a meter to see when it resets.

- The bar turns amber when you are ahead of the clock: spending faster than an even pace would last until the reset.
- The number turns amber below half, and red below a fifth.
- Beside the meters, one word sums up the account: **on pace**, **empty in** a time, or **empty now**.
- **as of 3h ago** means the last reading is old, so its numbers are dimmed.
- A dash means that allowance was not read.

**Refresh**, at the top of the list, reads every allowance again.
Infinitary does not read an allowance for OpenRouter or a custom API, and the row says so.
Amazon Bedrock is billed by use on your AWS account; its row shows this month’s estimate from work Infinitary recorded.

## Choose which account does what

Open an account's menu, the three dots on its row, for these choices.

- **Prefer for crew work** makes your crew use this account first.
  A ✱ marks it.
- **Pause** stops all work on this account until you choose **Resume**.
- **Disconnect** removes the account from Infinitary.

When you have two or more accounts of the provider your first mate uses, Settings lets you pick which one your first mate answers on.
A **firstmate** tag marks that account.

## When an allowance runs out

Your crew moves on by itself.
New work goes to a model with allowance left.
If none is left at that level, crew work drops to a weaker model or waits until the allowance resets.

When your first mate's own account runs out, it first moves to another account of the same provider that still has some.
If there is none, a card says **Your first mate has used up its allowance**.
Your words wait, and nothing is lost.
On the card you can choose **Recheck allowance**, move your first mate to another provider, or **Open settings**.
If a recheck finds nothing changed, the card also offers to try your provider again, such as **Try Claude again**, for when your first mate reaches it on another sign-in; if the allowance is still used up, it pauses again.

Some providers can keep answering on credits you set up with them.
For a Claude or Codex account, the menu holds **Keep going on credits**.
Your crew then spends credits only after every included allowance.
Infinitary never buys credits or sets their limit; the provider's own site does.

## Sign in again

A sign-in can lapse.
When it does, the account's row says **sign in again** and shows a **Sign in** button.
Choose it and sign in the way you did the first time.
This renews the same account, with its label and choices kept.

## Custom API

If your organization runs its own AI server, choose **Custom API** under **Add account**.
Give it a name, the server's address, a key if it needs one, and the models to use.
**Save** checks each model before your crew can use it.
You then choose on the **Models** board whether your crew uses these models.

## Usage

Settings → **Usage** shows how much your first mate and your crew have used, across every project.
Show it in **Tokens** or **Estimated $**, for a **Period** and for the kind of **Work**.
Estimated dollars are a guide to value, not a bill.
**Recent tasks** lists what each task used.

Under **Intelligence**, **Ask before a task spends more than** sets an amount.
A task that passes it stops at a safe point and asks you on a card before it spends more.
