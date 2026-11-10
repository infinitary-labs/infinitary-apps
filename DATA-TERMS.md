# Data terms

**Status: draft 4. Not in force, not published.** These terms name Infinitary Labs, Inc. as the party. Until these terms are published with the public beta, nothing is collected under them, and the contribution switch is absent from every build. Counsel reviews this document before publication. The version in force is the one in the repository beside the code that sends the payload.

## 1. Who we are and what this covers

"We" and "us" mean Infinitary Labs, Inc., a Delaware corporation ("the company"). Contact us at help@getinfinitary.com. "Infinitary" or "the app" means the desktop application published from this repository. "You" means the person running it.

These terms cover two things and nothing else: what the app sends us when you turn a switch on, and what we may do with it. Your sign-ins to the AI providers you already pay for go from your machine to those providers directly, under their terms, and are not covered here because they never pass through us.

## 2. Your work is yours

Your conversations, tasks, code, knowledge and the record of every task stay on your computer. They go to the model providers you sign in to, on your own accounts and under their terms. They go to the place a project lives, such as GitHub, when you ask for that. They never come to us. We never see your model use, never charge you for it and never resell it. Using the app needs no account with us, and nothing in it depends on a service of ours. No feature is gated on a switch below: everything the app can do, it does with both switches off.

## 3. Two switches

**Diagnostics, on by default.** Anonymous usage events from a fixed list in the app's code: the app opening, a first mate turn finishing or failing, and how far first-time setup has come; and, from an iPhone or iPad paired to your computer, the phone app opening, being set up, a message sent and a card answered, which your computer sends for the phone only while its own Diagnostics switch is on. Each carries the app version and a random install ID tied to nothing about you, a separate one for each phone. Never a transcript, a prompt, code, a card, a name or a path. The app tells you on its first launch, before anything is sent, and one switch turns it off. Turning it back on starts a new, unrelated install ID.

**Contribution.** Redacted records of the first mate's own decisions: what it was asked, what it chose to do, and what came of it, in the same shapes the app's own corpus export packages, with secrets scrubbed. Before the first record is sent, the app shows you the full payload. Every record after that is inspectable in the app before and after it is sent.

Each switch is one setting. Turning one on is your consent for that switch alone, under the version of these terms the app shows you at that moment.

## 4. What we may do with contributions

We may use contributions to improve the product and to train our models, whether we release those models open or keep them closed, and to run the product's own evaluations and analytics. Diagnostics are used only to find and fix problems in the app.

These uses transfer with the company. Any successor owner of the company, or of the records, is bound by these terms and inherits exactly these uses and no more.

## 5. What we will never do

We will never sell contributions. We will never hand them to a third party as data, other than to a successor owner bound by these terms. We will never use them for anything not listed in section 4. A change that widens section 4 is a new version of these terms and applies only as section 8 says.

## 6. The ask, and what contributors get

The app asks you about contribution once, at the moment you enable the local model, because that model was trained on contributions like yours. "No" is a full answer: the local model works the same either way, and the app does not ask again on its own.

If you contribute, you get each new version of the weights we release before anyone else, and a credit in the model card if you want one.

## 7. Stopping

You can turn either switch off at any time. Records we have not yet used are deleted when you ask. Records already inside a model we have trained stay in it, because training cannot be undone; we say so here plainly rather than pretend otherwise.

## 8. Versions

These terms are versioned in this repository beside the code that sends the payload, so the terms you read are the terms that build ships. A change that narrows what we may do takes effect for every record. A change that widens what we may do applies only to records contributed after the change, and only after you have read the new version and said yes again.
