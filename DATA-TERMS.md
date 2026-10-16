# Data terms

**Status: draft. Not in force, not published.** These terms name the company as the party, and the company does not exist yet. Until Eona Labs, Inc. is formed and these terms are published with the public beta, nothing is collected under them: Firstmate 3000 runs in privacy mode, the contribution switch is absent from every build, and no diagnostic leaves your machine. Counsel reviews this document before publication. The version that is in force is the one in the repository beside the code that sends the payload.

## 1. Who we are and what this covers

"We" and "us" mean Eona Labs, Inc. ("the company") [placeholder: the company is not formed yet; the name is confirmed, or corrected, before these terms are published]. "Firstmate 3000" or "the app" means the desktop application published from this repository. "You" means the person running it.

These terms cover two things and nothing else: what the app sends us when you turn a switch on, and what we may do with it. Your sign-ins to the AI providers you already pay for go from your machine to those providers directly, under their terms, and are not covered here because they never pass through us.

## 2. Privacy mode is the default

Out of the box, the app sends us nothing. Not a transcript, not a prompt, not a line of code, not a card, not a decision record, not a count, not an error. We do not run a service the app depends on, and there is no account with us.

Privacy mode is not a promise that nothing leaves your machine. Your work goes to the AI providers you signed in to, because that is what the app does. Privacy mode is the promise that nothing goes to us.

No feature of the app is gated on turning a switch on. Everything the app can do, it does in privacy mode.

## 3. Two switches, both off by default

**Diagnostics.** Counts, errors, versions and timings: how often something ran, what failed, which build. Never a transcript, a prompt, code, or a card body.

**Contribution.** Redacted records of the Firstmate's own decisions: what it was asked, what it chose to do, and what came of it, in the same shapes the app's own corpus export packages, with secrets scrubbed. Before the first record is sent, the app shows you the full payload. Every record after that is inspectable in the app before and after it is sent.

Each switch is one setting. Turning one on is your consent for that switch alone, under the version of these terms the app shows you at that moment.

## 4. What we may do with contributions

We may use contributions to improve the product and to train our models, whether we release those models open or keep them closed, and to run the product's own evaluations and analytics. Diagnostics are used only to find and fix problems in the app.

These uses transfer with the company. Any successor owner of the company, or of the records, is bound by these terms and inherits exactly these uses and no more.

## 5. What we will never do

We will never sell contributions. We will never hand them to a third party as data, other than to a successor owner bound by these terms. We will never use them for anything not listed in section 4. A change that widens section 4 is a new version of these terms and applies only as section 8 says.

## 6. The ask, and what contributors get

The app asks you about contribution once, at the moment you enable the local model, because that model was trained on contributions like yours. "No" is a full answer: the local model works the same either way, and the app does not ask again on its own.

If you contribute, you get each new version of the weights we release before anyone else, and a credit in the model card if you want one.

If we ever offer to run the model for you on our machines (hosted convenience), that service requires contribution, because we pay to serve it. The app itself never does.

## 7. Stopping

You can turn either switch off at any time. Records we have not yet used are deleted when you ask. Records already inside a model we have trained stay in it, because training cannot be undone; we say so here plainly rather than pretend otherwise.

## 8. Versions

These terms are versioned in this repository beside the code that sends the payload, so the terms you read are the terms that build ships. A change that narrows what we may do takes effect for every record. A change that widens what we may do applies only to records contributed after the change, and only after you have read the new version and said yes again.
