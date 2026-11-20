# An app follows the home's version

An app open on another computer that runs an older version than its home gets the home's version by itself and tells the home each step with the new request `inf:devices:app-follow`: getting it, waiting for nobody to use it, restarting, cannot, or failed (`appFollowReportSchema`, `src/shared/appFollow.ts`).
Each device in `inf:devices:list` and the `inf:devices` push adds `follow` to its `appVersion`, while its app is connected and has said a step for the home's current version.
The new request `inf:devices:update-app` is the Devices row's Update for that app: the home sends that computer's app the live frame `inf:devices:update-app-now`, and the app catches up at once and starts again as soon as no words are left unsent there.
An app sends `inf:devices:app-follow` only to a home that lists this change; a home from before never hears it, and its row says the app's version as before.
A view from before has no field of that name and shows no step or Update, and an app from before ignores the live frame.
