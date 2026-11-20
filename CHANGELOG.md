# Changelog

## [0.1.30](https://github.com/kunchenguid/firstmate-3000/compare/v0.1.29...v0.1.30) (2026-10-06)


### Features

* **cards:** let the captain answer any card question in their own words ([914468c](https://github.com/kunchenguid/firstmate-3000/commit/914468cffea085e89ed00cc83d16a7e2b7b68165))
* **crew:** confirm delivery tools and evidence readers before the first edit ([baa25f9](https://github.com/kunchenguid/firstmate-3000/commit/baa25f90e8c2265413aa349d4f4aee133636561f))
* **custom-api:** add extra request headers to a custom connection ([8a27a2a](https://github.com/kunchenguid/firstmate-3000/commit/8a27a2a4040ff3f0ab6e43fc405a6b141bcca2a8))
* **devices:** route a task on another Mac among that Mac's own subscriptions ([29fd0ef](https://github.com/kunchenguid/firstmate-3000/commit/29fd0eff291f8fc6d83dc8f34a40faaf4a0507c7))
* **devices:** try a locked SSH key again quietly on wake and every few minutes ([201a502](https://github.com/kunchenguid/firstmate-3000/commit/201a502b57d12dde31be35d69bcd46db73d39d21))
* **firstmate:** say times of day in the captain's local time ([3ba722b](https://github.com/kunchenguid/firstmate-3000/commit/3ba722b06501c45d3335c2c483ed1e0e83b2478c))
* **settings:** group Usage by project and list each recent task's usage ([2f4f047](https://github.com/kunchenguid/firstmate-3000/commit/2f4f047401562bf673222c16c4c19bff13c3ced0))
* **tasks:** move tasks on the task board by drag and by menu ([71ecee5](https://github.com/kunchenguid/firstmate-3000/commit/71ecee58c6eea2f56a1df083f595965802634688))


### Bug Fixes

* **cards:** keep a card's reading room and controls in short zoomed windows ([033706d](https://github.com/kunchenguid/firstmate-3000/commit/033706d64238dfa11a2ab463b0201cdd2f25ffec))
* **cards:** keep where a task runs in view on a card with a long title ([55e405a](https://github.com/kunchenguid/firstmate-3000/commit/55e405a25a469f831d09ed88e91d1ddc2e54a88e))
* **cards:** require playable figures to show more than a still drawing ([91bffc5](https://github.com/kunchenguid/firstmate-3000/commit/91bffc5e1e0bc7ba4f5cd65e1d6de97ca9dd8a52))
* **claude:** say what to try when a Claude sign-in ends with no reason ([d343443](https://github.com/kunchenguid/firstmate-3000/commit/d34344363bc522346d0bfb5f8b887c2b7ef9b86f))
* **composer:** undo what was typed by the run, not one character at a time ([6ce2309](https://github.com/kunchenguid/firstmate-3000/commit/6ce2309a1fa057bf4c0d879317837e9e54ae2cea))
* **crew:** name a note that is up in the idle nudge and stall wake ([e97c257](https://github.com/kunchenguid/firstmate-3000/commit/e97c257bde3c9d2af58aaa85bef41335f2041ad1))
* **crew:** record the model that answers when Claude Code swaps it ([11aae93](https://github.com/kunchenguid/firstmate-3000/commit/11aae93f75203370fd374643d44b9cdce6bcdef8))
* **crew:** say which model took new work the captain named a model for ([70ba451](https://github.com/kunchenguid/firstmate-3000/commit/70ba451b6a20f66ffd3fe9e34fc9c958baa268d1))
* **custom-api:** compact a long custom session instead of failing at its context check ([60258d8](https://github.com/kunchenguid/firstmate-3000/commit/60258d8aea030d6fde1c8278492d2b853bc59dc5))
* **custom-api:** size a request by its model's documented context ([9016ea5](https://github.com/kunchenguid/firstmate-3000/commit/9016ea58646aa823ef540dd2b0030e47a29f739e))
* **decisions:** answer with the chosen decision model, and never name one that is not answering ([07cb756](https://github.com/kunchenguid/firstmate-3000/commit/07cb756f04265e5843a9d298a12e266517997936))
* **design:** load the quota card's components from their sources ([497174f](https://github.com/kunchenguid/firstmate-3000/commit/497174f2739809559be9a916b4fbea70dde24ab3))
* **devices:** ask for the address a computer's Codex sign-in ends on ([3ee2c52](https://github.com/kunchenguid/firstmate-3000/commit/3ee2c526fc7800b9fe442271854478d2a38157c4))
* **devices:** ask once, then leave a gone Firstmate when adding a Mac by its address ([5f26050](https://github.com/kunchenguid/firstmate-3000/commit/5f26050346ca1643281dccbfb8aecff2c8bb9faf))
* **devices:** bring a command Mac back by its address and keep it on this Mac's SSH ([b0a71e3](https://github.com/kunchenguid/firstmate-3000/commit/b0a71e3dabbd22e78fe5edf2ee69e9b7b02d2632))
* **devices:** follow this Mac's network so Devices and the connection move with its address ([72d18b9](https://github.com/kunchenguid/firstmate-3000/commit/72d18b9ca2f4b604f589ac85f32aaba14095f48b))
* **devices:** keep a work Mac's cut-off and usage on its own sign-in ([ae6e9d3](https://github.com/kunchenguid/firstmate-3000/commit/ae6e9d36f060707cfe7a596c99ec1f53dc1124ef))
* **devices:** say the app holding the SSH key did not approve, not that it is locked ([6166751](https://github.com/kunchenguid/firstmate-3000/commit/61667511649cb0400ea6696dea8a2cd0ff9f982b))
* **devices:** say the app holding the SSH key is not open, not that it is locked ([a58a0b7](https://github.com/kunchenguid/firstmate-3000/commit/a58a0b724501b64fd182ba118b7f9320a22e60b0))
* **devices:** say why a Mac added by a command never reached this Mac on the local network ([a2a5489](https://github.com/kunchenguid/firstmate-3000/commit/a2a54896ddb168ab4a436f79820961de1f46b7ae))
* **evals:** keep the evaluator's own stop reason after it cuts a turn ([772ded2](https://github.com/kunchenguid/firstmate-3000/commit/772ded2f4f3cbd74baa77ceff2836414239968a4))
* **firstmate:** label thread activity by the card's current answer hold ([df38f87](https://github.com/kunchenguid/firstmate-3000/commit/df38f877612167c64c3145f0048133b65e2d0340))
* **frames:** answer each frame request only to the document that asked ([25154b9](https://github.com/kunchenguid/firstmate-3000/commit/25154b966a58df16e55c8127e60fce62d5368f50))
* **main:** remove release developer controls and recover crashed pages ([c743ac4](https://github.com/kunchenguid/firstmate-3000/commit/c743ac42d76b7b1e19be55c4641b045ef3d0d019))
* **main:** stop Chromium's bounce-tracking store from holding a quit on a loaded Mac ([d1631aa](https://github.com/kunchenguid/firstmate-3000/commit/d1631aaa9db95298e56315ded993433ec9798d40))
* **release:** isolate publication test release channels ([5b95d99](https://github.com/kunchenguid/firstmate-3000/commit/5b95d99c26ff9a535318ee168f4ebca260d6ca85))
* **release:** keep a stable's tap release off the tap's Latest badge ([5657e37](https://github.com/kunchenguid/firstmate-3000/commit/5657e379afb382d3f0f68b7a00d445b935d10440))
* **scripts:** keep installs off the local signing keychain ([7145006](https://github.com/kunchenguid/firstmate-3000/commit/7145006bbce29ab43bf3e2dfd95d775f9228701b))
* **settings:** explain refused look, panels, model, sharing and account saves ([83da896](https://github.com/kunchenguid/firstmate-3000/commit/83da896c081091eed5da22d041e9752452b1dc5c))
* **tasks:** close a finished step as answered into the task waiting on it ([e343ab1](https://github.com/kunchenguid/firstmate-3000/commit/e343ab139637f1d14e0289d61f5de3dc43225ea6))
* **tasks:** find curly apostrophes and quotes from the plain ones typed ([f0caaa0](https://github.com/kunchenguid/firstmate-3000/commit/f0caaa0dccaf7564831ba5924f6b7c62a344c39b))
* **tasks:** keep the Tasks search box's focus glow whole on every side ([8b4bde8](https://github.com/kunchenguid/firstmate-3000/commit/8b4bde8afdb81371c64a79703a8d0f5a146b64f8))


### Performance Improvements

* **crew:** keep a brief receipt's reports by reference and hand a follow-up its origin once ([264d345](https://github.com/kunchenguid/firstmate-3000/commit/264d345fb1ef4ec3caa064ecbe29bc35a3ddc698))

## [0.1.29](https://github.com/kunchenguid/firstmate-3000/compare/v0.1.28...v0.1.29) (2026-10-05)


### Features

* **cards:** ask about discarding picked answers right under the card's close ([c842428](https://github.com/kunchenguid/firstmate-3000/commit/c8424281cfbdf752efd706a2c4807c17f3fd5ec8))
* **cards:** fold the prototype into the plan, with a playable preview on its card ([a0e34b2](https://github.com/kunchenguid/firstmate-3000/commit/a0e34b2e410e4f41e44806d9a7e3fec2f4d14ee7))
* **cards:** let a figure move only when it shows change over time or a value to vary ([12c5c6d](https://github.com/kunchenguid/firstmate-3000/commit/12c5c6de1f199c263944a489710ba46ed46840f3))
* **cards:** link task keys in card bodies to their task ([0c7d609](https://github.com/kunchenguid/firstmate-3000/commit/0c7d6094e28d0fa54c693e04c0032f8ca19bf828))
* **cards:** livelier motion for cards, popovers, summaries and labels ([7b4d60f](https://github.com/kunchenguid/firstmate-3000/commit/7b4d60fc9db9cb0384c1a792e259d2772a1f118c))
* **cards:** offer Save and defer beside Approve and build on plans and prototypes ([95f6a73](https://github.com/kunchenguid/firstmate-3000/commit/95f6a73fe3586dd231823ce535edb6ef06532511))
* **cards:** open each report from its line in a task's Activity ([d65fa78](https://github.com/kunchenguid/firstmate-3000/commit/d65fa78de3a7c6933cdddabdffd9f6fbf6296d84))
* **cards:** place the model readout above the task actions ([05c55fe](https://github.com/kunchenguid/firstmate-3000/commit/05c55fe9820b4f71b4387d963c7116ab34661cd7))
* **composer:** take shell editing keys in the message box ([b110e3f](https://github.com/kunchenguid/firstmate-3000/commit/b110e3f27b56850314ab00c0f9ad2cd29643b91d))
* **crew:** draw a crewmate's reported plan on the summary and the task record ([35fd223](https://github.com/kunchenguid/firstmate-3000/commit/35fd223fa8479bba7dbfa7619090f2d3fc2d67c8))
* **crew:** fade a crewmate's model name in when it shows ([6839d1b](https://github.com/kunchenguid/firstmate-3000/commit/6839d1b77e83af23f70d242b902fd6be67352b50))
* **crew:** file only defects and safety risks, and close what a merge covered ([871c0f9](https://github.com/kunchenguid/firstmate-3000/commit/871c0f9d39869a0819eb26049e10364090f2baf1))
* **crew:** give each task on this Mac its own browser for the project's local pages ([386099d](https://github.com/kunchenguid/firstmate-3000/commit/386099dcb0bd13f65d3e81146f5b8970ed76e50d))
* **crew:** keep a site's own page storage in a saved website sign-in ([c0899f5](https://github.com/kunchenguid/firstmate-3000/commit/c0899f5c774ea39c462e47d93fa4ad3a05b570cd))
* **crew:** let a crewmate's card open its task's browser ([03a4e79](https://github.com/kunchenguid/firstmate-3000/commit/03a4e798272dcbb069219d6ed9908bd2db1af769))
* **crew:** let a task's browser reach public websites, with a second page ([627cc7a](https://github.com/kunchenguid/firstmate-3000/commit/627cc7a6726d9fd10acf5e59a513b31957737feb))
* **crew:** let the captain make a booking's final payment in a task's browser, never sent twice ([96d0105](https://github.com/kunchenguid/firstmate-3000/commit/96d01051691079226abb44992a5c1a3da343b73a))
* **crew:** let the captain take control of a task's browser and hand it back ([dcef58f](https://github.com/kunchenguid/firstmate-3000/commit/dcef58fd217f30ad2edd89e4282dcb0429b3b23f))
* **crew:** let the captain watch a task's browser from its record ([9fb709b](https://github.com/kunchenguid/firstmate-3000/commit/9fb709bea7d34e62a6e0dad59c35f49854e851ec))
* **crew:** load each project's AGENTS.md and skills into every crewmate's session ([91d9825](https://github.com/kunchenguid/firstmate-3000/commit/91d9825baa0206fc86b910cba4c560181b8c6217))
* **crew:** remember a website's sign-in on this Mac for a later task's browser ([8d4c7a0](https://github.com/kunchenguid/firstmate-3000/commit/8d4c7a08918e24907cd00cdfd17127c97bd81217))
* **devices:** add a Mac by its address over Remote Login, and update or remove it there ([7790dbe](https://github.com/kunchenguid/firstmate-3000/commit/7790dbe479c9d95f4a6965854354710a5c17bc65))
* **devices:** add the Devices tab and the connect card at home ([db462b7](https://github.com/kunchenguid/firstmate-3000/commit/db462b7fec8a29c6cbf28b9199a7a6d96a25fda4))
* **devices:** bring a computer's leftover working copies home and remove them there ([5ab9a0f](https://github.com/kunchenguid/firstmate-3000/commit/5ab9a0fb6367446c7c660d3930314170fb083b42))
* **devices:** control Firstmate from a second Mac joined at its first launch ([9b29332](https://github.com/kunchenguid/firstmate-3000/commit/9b29332203c6dfb26adca1eb1fc4e1df0d2d4fe3))
* **devices:** hold a crewmate's conversation on a computer that runs work ([d490aff](https://github.com/kunchenguid/firstmate-3000/commit/d490aff763dc048816536b29340f704a0ea55057))
* **devices:** join a computer by one command, and remove one with its work brought home ([504d411](https://github.com/kunchenguid/firstmate-3000/commit/504d4111e9a84bbbcd3a8f1ace48720ab7546843))
* **devices:** keep a task's working copy on the computer that runs it and bring its work home ([671fd83](https://github.com/kunchenguid/firstmate-3000/commit/671fd833a33058d4dec98c05251a6b28e0b14d4e))
* **devices:** notify on a Mac that controls another when Firstmate needs you ([ea26492](https://github.com/kunchenguid/firstmate-3000/commit/ea264921deb4b8940ca8cdfe3d29a597485be1a1))
* **devices:** open and drive a crewmate's conversation on a computer that runs work ([6bfa7d8](https://github.com/kunchenguid/firstmate-3000/commit/6bfa7d8098f5ad701cd35b8fe1c62d7f65829159))
* **devices:** run a project's tasks on the computer its Runs on names ([303ab63](https://github.com/kunchenguid/firstmate-3000/commit/303ab63deaa5884ad1fe88b29806eb6f7756f60a))
* **devices:** run work for another Mac from the app itself, with no window ([f3e5fff](https://github.com/kunchenguid/firstmate-3000/commit/f3e5fffe5a49bb32fe4d7b7095a618fcf8be9890))
* **devices:** say when a computer runs another version, and update any computer from Devices ([d79cc55](https://github.com/kunchenguid/firstmate-3000/commit/d79cc55004ea41532cd0367a058957f2f8ae5ed2))
* **devices:** show a computer's Claude allowance, or say why it is not read there ([2981330](https://github.com/kunchenguid/firstmate-3000/commit/29813305c12bccac5ff8e173020e4f3a66fa4abe))
* **devices:** show a Mac controlling another its own update notice ([e4254d9](https://github.com/kunchenguid/firstmate-3000/commit/e4254d98d22af3812a158719efdfb7ced81cdea4))
* **devices:** sign a computer that runs work in to GitHub and Claude from home ([800b0eb](https://github.com/kunchenguid/firstmate-3000/commit/800b0ebad49a104b8501a277c1eda335a06acc08))
* **devices:** sign a computer that runs work in to its own subscriptions from home ([9e8ddac](https://github.com/kunchenguid/firstmate-3000/commit/9e8ddac7d3e6c7dd838f2eaf4765368996a808df))
* **firstmate:** make every Firstmate emote say what happened ([cab1a52](https://github.com/kunchenguid/firstmate-3000/commit/cab1a52734d88d38af82fd71265e58a3b4dc5ec6))
* **keyboard:** change the app's keys in a Keyboard tab in Settings ([cfab3a4](https://github.com/kunchenguid/firstmate-3000/commit/cfab3a49d87f8a98cd56d4d70860ceb0c44b2139))
* **keyboard:** hear window keys inside cards and panels, and go back to the main message with Cmd+L ([b6d1ccb](https://github.com/kunchenguid/firstmate-3000/commit/b6d1ccbe10f2b5a840ba69b0342ffced18d09f23))
* **keyboard:** move between the window's parts with F6 and through lists with the arrows ([6f235cd](https://github.com/kunchenguid/firstmate-3000/commit/6f235cd1f2d11eaa48c26ff45473adb103473273))
* **keyboard:** read, answer and choose on a card from the keyboard ([3a28662](https://github.com/kunchenguid/firstmate-3000/commit/3a286623584697a3e78e53abd9a019085e8b5671))
* **keyboard:** search commands with Cmd+K, and keys for the reply, cards, tasks and Settings ([e28d119](https://github.com/kunchenguid/firstmate-3000/commit/e28d11974ae74542043ce92635dff34ce6ce9119))
* **release-notes:** read a release note again from the Help menu, command search, Settings and Firstmate ([9de78b8](https://github.com/kunchenguid/firstmate-3000/commit/9de78b8ab5a65f18f2dde30c48842af1cc846fff))
* **release:** keep a hero picture beside every visible change and group the note by area ([dafa2d0](https://github.com/kunchenguid/firstmate-3000/commit/dafa2d0a02508247d4662a4089912c42571ae682))
* **release:** keep release notes to changes a person notices and products the app supports ([e73e7cd](https://github.com/kunchenguid/firstmate-3000/commit/e73e7cdde8f489be97ce0e7e3a6ed14aaed9b1d8))
* **settings:** add the Usage tab with tokens per model and estimated dollars ([7851927](https://github.com/kunchenguid/firstmate-3000/commit/78519274b1d09ff4d3d055cb68065b739442a2ba))
* **settings:** choose which account Firstmate answers on ([dbad464](https://github.com/kunchenguid/firstmate-3000/commit/dbad46402a1df91ebdf9b0b04d928544cbde9e81))
* **settings:** say in Devices when a Mac controlling Firstmate was last seen ([750834e](https://github.com/kunchenguid/firstmate-3000/commit/750834ed062d00bf17c940ff057196fbbdb5f606))


### Bug Fixes

* **cards:** clear reply drafts immediately on send ([b2ed013](https://github.com/kunchenguid/firstmate-3000/commit/b2ed013b5dbbd6aecb8de670092428f320d0a2e1))
* **cards:** close departed cards without waiting for the next body ([dfe6f5d](https://github.com/kunchenguid/firstmate-3000/commit/dfe6f5dcfc9c82abd9104dc083984a6b5f51a0ab))
* **cards:** end a change task whose prototype is saved for later or abandoned ([83ecf81](https://github.com/kunchenguid/firstmate-3000/commit/83ecf813465ec93c50470acf624f853e2fb06242))
* **cards:** hand a card body's own choice its refusal again ([9d6b315](https://github.com/kunchenguid/firstmate-3000/commit/9d6b3159938a5bc5c6bbb5e5874058ecd7aeff0d))
* **cards:** keep focus in the main message when a card's or panel's script calls focus() ([287a778](https://github.com/kunchenguid/firstmate-3000/commit/287a778986db0de8b638f8118cafa45dc9841d4d))
* **cards:** keep the reply box's height when the first character is typed ([7a71fb5](https://github.com/kunchenguid/firstmate-3000/commit/7a71fb5c9c874dc565160cddb58cdcae66317be7))
* **cards:** keep the reply field focused through a send ([f0b0e6a](https://github.com/kunchenguid/firstmate-3000/commit/f0b0e6af6f0c7b7362e025a1365a5c1489af1400))
* **cards:** let the task card grow to show its whole record, and give Drop task the left edge ([a07f7ed](https://github.com/kunchenguid/firstmate-3000/commit/a07f7ede72d1dbde9cceca012fe8e2796c074b19))
* **cards:** open a card body's link only from the captain's own click or Enter ([fee2d9d](https://github.com/kunchenguid/firstmate-3000/commit/fee2d9d7f110160b5bc4be06d9641884d5beffff))
* **cards:** refuse a choice on a closed task at emit, where the click would refuse it ([a7117cc](https://github.com/kunchenguid/firstmate-3000/commit/a7117cc53344b1697a9f7e1b8c8e71a85d344a80))
* **cards:** refuse a decision that does not give 2 or 3 actions ([705aa51](https://github.com/kunchenguid/firstmate-3000/commit/705aa51d8560e2e69aaf48e6eef1b96ba676b162))
* **cards:** refuse a New mark on a picture itself, where no tag can be drawn ([8920ff9](https://github.com/kunchenguid/firstmate-3000/commit/8920ff9726d7979be255fe117d1fcd35cf4d7efe))
* **cards:** separate revision bars from author New tags ([e611aad](https://github.com/kunchenguid/firstmate-3000/commit/e611aad7ef912ea9fd00f0e01e1496ffb20b32c4))
* **cards:** share the Hide successor policy with preparation ([501c8eb](https://github.com/kunchenguid/firstmate-3000/commit/501c8ebc6f9176c335ea19e353d2969dc4727b83))
* **cards:** show a reply's settings apart from the captain's words ([ee04eaa](https://github.com/kunchenguid/firstmate-3000/commit/ee04eaa9e65052dc83164ea8a04628c1130aa11c))
* **character:** redraw the still Firstmate sharp after a size change ([963e71f](https://github.com/kunchenguid/firstmate-3000/commit/963e71ff53b852f573beb67377c1fd75cf943f9e))
* **checks:** refresh pull request results across live task surfaces ([9bf8f58](https://github.com/kunchenguid/firstmate-3000/commit/9bf8f58252292444b01e9776ad8e9393be1357b8))
* **claude:** keep the person's Claude auto-memory out of every session ([0da35f4](https://github.com/kunchenguid/firstmate-3000/commit/0da35f4f98a5102fb7d70a73fcc367a52e7d6b47))
* **composer:** remove duplicate inner focus outline ([195c06a](https://github.com/kunchenguid/firstmate-3000/commit/195c06a92f5cc0923b6ca81cfc7f93701debce10))
* **composer:** shorten the empty message box hint when it would not fit ([2768f99](https://github.com/kunchenguid/firstmate-3000/commit/2768f990cd517203ce6e2b7d5f525ad98379cd2b))
* **crew:** bring back a Mac added by its address after this Mac's address changes ([4b5c0e4](https://github.com/kunchenguid/firstmate-3000/commit/4b5c0e4ab8a7be642e033b6223b8e189fbb3c219))
* **crew:** check only the branch's own commits against the fetched main ([ccc4fc1](https://github.com/kunchenguid/firstmate-3000/commit/ccc4fc1c6c29dd961296a2c688b3564173358641))
* **crew:** close a task whose pull request was merged outside the app ([7a09144](https://github.com/kunchenguid/firstmate-3000/commit/7a09144ab7f585b9e8a1cdca0359ddaf302fadbe))
* **crew:** close personal reports using the captain-turn witness ([aa46d55](https://github.com/kunchenguid/firstmate-3000/commit/aa46d556afcbfe8823e0986d61849208913a5db5))
* **crew:** finish a work computer's removal when it fails part-way ([ee788af](https://github.com/kunchenguid/firstmate-3000/commit/ee788af70b99a2f24e36d00de60330e8034a20ce))
* **crew:** keep an unconfirmed payment unknown in a crewmate's words ([0539c97](https://github.com/kunchenguid/firstmate-3000/commit/0539c97847fcef55958be5890a8520792e09d6ec))
* **crew:** keep what the captain typed off a handed-back browser page ([e060e29](https://github.com/kunchenguid/firstmate-3000/commit/e060e291db08b42e191196d82f32e0a3c0d84c90))
* **crew:** let a completion decision declare its merge without a label ([bf4760f](https://github.com/kunchenguid/firstmate-3000/commit/bf4760fc67a0ed0bfde05c33f374712fdecf34ff))
* **crew:** let a work computer find its home again after the home's address changes ([a6afe87](https://github.com/kunchenguid/firstmate-3000/commit/a6afe874c434a16da402b8cebe2b2da343b8095c))
* **crew:** let a work computer leave a home that is gone, on its own yes ([203b75e](https://github.com/kunchenguid/firstmate-3000/commit/203b75e26b05c78ba7a54d3ff5fa4d5f1e2a57dd))
* **crew:** redraw the still crew ring sharp on another display ([c0a5aca](https://github.com/kunchenguid/firstmate-3000/commit/c0a5acae9fc388f83b21e96e86ea07738fdd63db))
* **crew:** run the app's own git on a computer that runs work ([e2bedf7](https://github.com/kunchenguid/firstmate-3000/commit/e2bedf767b0366b9b8e646f6595027208721a1eb))
* **crew:** tell the crewmate when a request card's browser is gone ([6c9dbab](https://github.com/kunchenguid/firstmate-3000/commit/6c9dbab3c52ea715da7116656f4a7c7b47834660))
* **crew:** wake Firstmate for cardless internal-step reports ([5983d7f](https://github.com/kunchenguid/firstmate-3000/commit/5983d7f708ade198e2b060ed0239ae925817b485))
* **design:** name every ResponseCard prop in the adherence rule ([24864ac](https://github.com/kunchenguid/firstmate-3000/commit/24864acb09d74f3c30e368633de3d11740c1a469))
* **devices:** ask Claude Code before a computer signs in over its login ([d01f0ec](https://github.com/kunchenguid/firstmate-3000/commit/d01f0ec0125cb83c9bb795f85d22882d0afc997c))
* **devices:** keep another user on this Mac in reach when its address changes ([2279e9e](https://github.com/kunchenguid/firstmate-3000/commit/2279e9eb8a68dd0a8844ed5693fee5fdb6018615))
* **devices:** keep multi-machine support behind the captain-held dev gate ([1652367](https://github.com/kunchenguid/firstmate-3000/commit/1652367a4cf1c86bc8c3824f115a11fc488c55bd))
* **devices:** reach the home through macOS's own nc on a shared network ([72e08d6](https://github.com/kunchenguid/firstmate-3000/commit/72e08d6b87caf17842c8d05d1874f64535a0306b))
* **devices:** refuse files a Mac that controls another cannot send ([07ca068](https://github.com/kunchenguid/firstmate-3000/commit/07ca06876dd1fa5a7e85e737f3195c71d3b89677))
* **devices:** say a card's Settings button is done on the Mac being controlled ([ffc1570](https://github.com/kunchenguid/firstmate-3000/commit/ffc157056089f984d7ae02da5496e3cfeb86e8a1))
* **devices:** say that work run as another user can read your home folder ([fe8c930](https://github.com/kunchenguid/firstmate-3000/commit/fe8c930f98e21af801bd1e4751ce316183b0511e))
* **devices:** sign Claude out on a computer when Firstmate made that login ([aca9ae5](https://github.com/kunchenguid/firstmate-3000/commit/aca9ae59aa4a595e9f828229da8dde2c46d517a8))
* **devices:** tell a refused background start from an absent login session ([e5846bb](https://github.com/kunchenguid/firstmate-3000/commit/e5846bb21d1c90d11bb69371e22dadf868f93156))
* **focus:** return unavailable controls to the main input ([58713ce](https://github.com/kunchenguid/firstmate-3000/commit/58713ce90ca8d15aaa8c29f91dcdd420fc5b7f2c))
* **orchestrator:** prevent concurrent inbox drains from starting duplicate turns ([3a98a24](https://github.com/kunchenguid/firstmate-3000/commit/3a98a24aa4ca25180102143e9defd31625de5158))
* **release:** give the notes merged beside the hero-picture rule an area and a reason ([8ce419a](https://github.com/kunchenguid/firstmate-3000/commit/8ce419a10db68535300a65a6b2549aef9aea76dd))
* **scripts:** rebuild a local signing keychain that refuses its stored secret ([792c4b6](https://github.com/kunchenguid/firstmate-3000/commit/792c4b6126c753c072160efafbc8e6c6ed4f8485))
* **settings:** place Your panels under Dictation ([bd8c971](https://github.com/kunchenguid/firstmate-3000/commit/bd8c9717bd5ae78ad4fb62f31281061a5cb65256))
* **settings:** point an empty Not in use lane at models reachable by name ([bcbcca7](https://github.com/kunchenguid/firstmate-3000/commit/bcbcca7a934281a87db40fe926b74f1c716c3af2))
* **settings:** say an empty premium level's work waits ([69c8d49](https://github.com/kunchenguid/firstmate-3000/commit/69c8d49f352a23197719fecc1954d24caa341b80))
* **stage:** raise Firstmate's words clear of the crew, in larger text ([9f8466d](https://github.com/kunchenguid/firstmate-3000/commit/9f8466db1bbe1d718d1644cdd03b1521ec6a47fa))
* **tasks:** point a blocked start at the edge, never at dropping the blocker ([617cbee](https://github.com/kunchenguid/firstmate-3000/commit/617cbeea2a4a1f50435e7d722d5bfce75a03b0e9))
* **tasks:** separate the pull request line from the model ([77954b6](https://github.com/kunchenguid/firstmate-3000/commit/77954b680606715bacc9969a84054661caf2adce))
* **work:** preserve unreadable copies when removing a computer ([3fd37b7](https://github.com/kunchenguid/firstmate-3000/commit/3fd37b7777bbad7df8a839fd0271d288f3ea6523))


### Performance Improvements

* **cards:** prepare a scripted next card ahead, holding its scripts until shown ([cf333a6](https://github.com/kunchenguid/firstmate-3000/commit/cf333a644f56bf45ca8ad234c8c426c092399048))
* **install:** clone the app's git and the ONNX runtime files into each working copy ([96aedae](https://github.com/kunchenguid/firstmate-3000/commit/96aedae69c6cc9a4eaf9a8ea9b3b2a594fb8bdb0))
* **main:** load only the work mode's code and run it as one process ([b2de4f0](https://github.com/kunchenguid/firstmate-3000/commit/b2de4f002650b01141baf9f59320ed146cd36ec0))
* **tasks:** read posture for live work only and stop board re-reads on card changes ([ae0a231](https://github.com/kunchenguid/firstmate-3000/commit/ae0a231e8727dc9f7c2d9388b5cfdc4478a9a8d9))

## [0.1.28](https://github.com/kunchenguid/firstmate-3000/compare/v0.1.27...v0.1.28) (2026-10-03)


### Features

* **cards:** ask for before and after pictures of each changed view on merge cards ([7264f32](https://github.com/kunchenguid/firstmate-3000/commit/7264f3266c75c0aa6017fb587f090ebfcc905c1b))
* **cards:** bring a closed card forward through one shared show-card action ([4bb8b5d](https://github.com/kunchenguid/firstmate-3000/commit/4bb8b5d04b591d6b352a386a71117a7add4cdde1))
* **cards:** check that each captain message got an action, retry once, then say so ([2c0a2a9](https://github.com/kunchenguid/firstmate-3000/commit/2c0a2a988560af7224e3729afb115c9edc7fec4f))
* **cards:** keep the next owner visible after an answer authorizes a build ([1a99310](https://github.com/kunchenguid/firstmate-3000/commit/1a993106a23f7527f9f2e644becec1ee577008f0))
* **cards:** nudge crewmates to edit in place and report the app's own revision counts ([8a3419f](https://github.com/kunchenguid/firstmate-3000/commit/8a3419f8a22808cdaafe11f7904c7f580c27683a))
* **cards:** read a closed card again as a read-only past card on the stage ([be1b316](https://github.com/kunchenguid/firstmate-3000/commit/be1b31687cb9d6214746126780bcb7a1b6aa6521))
* **cards:** retire the keep-open action; changes come by reply ([345c041](https://github.com/kunchenguid/firstmate-3000/commit/345c041d1e92e0b71316b56d9406b6d69df6dcdb))
* **cards:** say in a card's thread what a waiting reply is held by ([8606835](https://github.com/kunchenguid/firstmate-3000/commit/8606835e667c2e136a04af9348f63d0fca5ba2d9))
* **cards:** show the next card ready, and the first unread one ([94a43e0](https://github.com/kunchenguid/firstmate-3000/commit/94a43e021078c2865a26f8d8cb34ac9e6e108dd9))
* **character:** let Firstmate's emote carry a few words above the character ([92c695f](https://github.com/kunchenguid/firstmate-3000/commit/92c695f0b6a8a531b5412c5d05272f9ae2fa8ec9))
* **composer:** drop or choose files in the main input and card replies ([92e023f](https://github.com/kunchenguid/firstmate-3000/commit/92e023f451e3c4c759cfc5334948e4da5cdbc071))
* **connection:** publish the client contract with its version rule ([084bf9d](https://github.com/kunchenguid/firstmate-3000/commit/084bf9d8c7551b9e1600a4800bdd82a81e2c311a))
* **connection:** serve the core to paired devices over a numbered connection ([783edd2](https://github.com/kunchenguid/firstmate-3000/commit/783edd2d02d6ca5537dfab1b0f8092a6740768aa))
* **crew:** hand a grounded builder its basis card as a file ([1a5af01](https://github.com/kunchenguid/firstmate-3000/commit/1a5af016e1acf2debf8fbc12cc76cd9697123076))
* **devices:** pair a device with a one-use link over pinned TLS ([343c1c4](https://github.com/kunchenguid/firstmate-3000/commit/343c1c44eac0abe807fb223d7ca8e10233411e0d))
* **forge:** add github_read and github_write, and count Claude's background work on the idle clock ([1ed081f](https://github.com/kunchenguid/firstmate-3000/commit/1ed081f4732fe32bcdac2489895ad702bda47967))
* **release:** add the reviewed release-notes ledger, release check and version tracking ([db63d5c](https://github.com/kunchenguid/firstmate-3000/commit/db63d5c6c90f72e1862e59b04368c37e0c057ac1))
* **release:** show what is new after an upgrade, on top of the card stack ([0deb57b](https://github.com/kunchenguid/firstmate-3000/commit/0deb57b614776032d5c54b2da60ceac7b0d5014c))
* **settings:** rebuild the model catalog as levels with a model panel and drag and drop ([281685a](https://github.com/kunchenguid/firstmate-3000/commit/281685a94747e532f063cfdcb27031c3901ea59b))
* **settings:** show a Reduced motion badge beside the settings button ([9079ef9](https://github.com/kunchenguid/firstmate-3000/commit/9079ef9e5a81c134c77acfe5ab95ada1761a0aa6))
* **settle:** keep the captain's merge approval through repair, bound to the card he saw ([e61cdfe](https://github.com/kunchenguid/firstmate-3000/commit/e61cdfe0c35df20649820372ba86560fafc35b3e))
* **settle:** keep the captain's merge click through a conflict refusal ([d7fca9b](https://github.com/kunchenguid/firstmate-3000/commit/d7fca9b1ac9a1880b9779d64b8a2f75692072d58))
* **tasks:** give every open task record one fixed action bar ([ae5fddc](https://github.com/kunchenguid/firstmate-3000/commit/ae5fddc3fe3fa11e4d99a8d95389043c0627031b))
* **tasks:** let the Tasks filter find earlier closed and dropped work ([620ad67](https://github.com/kunchenguid/firstmate-3000/commit/620ad67eb5d0b55a8b0e01cbc91790e83cd0f9c7))
* **tasks:** list every card a task showed in a Cards row on its record ([65c2d48](https://github.com/kunchenguid/firstmate-3000/commit/65c2d4858b2c8f50008bd69951ad42691cbcd6bf))
* **tasks:** open the crew summary from a resting Tasks row ([1a4479b](https://github.com/kunchenguid/firstmate-3000/commit/1a4479b144f1e001eb60fb80b1d1182c97d69258))
* **tasks:** replace the Tasks filter word with a search icon ([1d2f044](https://github.com/kunchenguid/firstmate-3000/commit/1d2f0444c9e067c81af5ced1b671fcfedcfab5a3))
* **tasks:** share one set of task facts across the record and crew summary ([76674fe](https://github.com/kunchenguid/firstmate-3000/commit/76674fefe452e3163acce6a5900358497dc76883))


### Bug Fixes

* **cards:** answer replies under a done task's kept note in that note's thread ([62d15ad](https://github.com/kunchenguid/firstmate-3000/commit/62d15ad1bcd06215049be547d99eafb8b4e8ac7d))
* **cards:** drop the thread head's repeat of the card's author, model and close ([2a8f8a1](https://github.com/kunchenguid/firstmate-3000/commit/2a8f8a16a6b98f5a21703e58ac256a3e1c92abda))
* **cards:** keep a merge card's facts beside its buttons ([3142c8d](https://github.com/kunchenguid/firstmate-3000/commit/3142c8d12fdf12e9edd17e7118ba30a82548038e))
* **cards:** open http links to localhost subdomains through the safe predicate ([5bd2cd2](https://github.com/kunchenguid/firstmate-3000/commit/5bd2cd21b13634b1bbe67a11a5689bc782da6360))
* **cards:** push a replied-under card's wait at once so its answer counts as new ([16ec35b](https://github.com/kunchenguid/firstmate-3000/commit/16ec35b5a7caf414e324189f5fa620581f0c8f90))
* **character:** repaint the still Firstmate when the theme changes ([10b1214](https://github.com/kunchenguid/firstmate-3000/commit/10b121459093180ea3765da921187fd01b380860))
* **claude:** clear a spent-allowance hold and a declined read when the login changes ([71ab306](https://github.com/kunchenguid/firstmate-3000/commit/71ab306082aa9c40bc6ef93efcb5e01eb1950f8d))
* **claude:** retry a declined usage read once when the saved login changes ([0d31d4e](https://github.com/kunchenguid/firstmate-3000/commit/0d31d4e729701bd15568b0e3e3b6427edbc45a09))
* **composer:** center the empty message box hint on the whole box ([9c561f0](https://github.com/kunchenguid/firstmate-3000/commit/9c561f048dfa21cf4f94c71e9974c4e58b14aa5a))
* **crew:** close pull requests when attempts are abandoned ([d0968f6](https://github.com/kunchenguid/firstmate-3000/commit/d0968f64d102aea9f5f02c9fd1e13709ab1669cf))
* **crew:** drop the plate behind a crew model name ([ead38f9](https://github.com/kunchenguid/firstmate-3000/commit/ead38f90f2e973ea31fd3e07302aeda134a83622))
* **crew:** hand a builder its basis's own answered card, not a later Firstmate note ([480f39b](https://github.com/kunchenguid/firstmate-3000/commit/480f39b59023973c880f4be1d3eda77c7ac2fe9c))
* **crew:** hand a prototype's design to the builder in words and files, and stop discounting implement builds ([f9eea2e](https://github.com/kunchenguid/firstmate-3000/commit/f9eea2e0349bb262798210dd546b872a29dde5e6))
* **crew:** keep a wait on underway work waiting and resume it when that work closes ([f5bc49b](https://github.com/kunchenguid/firstmate-3000/commit/f5bc49b7c57caf76afca7237faed51ee7e6f12df))
* **crew:** tell Firstmate about the captain's task card clicks on its next turn ([91727a7](https://github.com/kunchenguid/firstmate-3000/commit/91727a7b21848f718bbb115350f986f45c31274b))
* **crew:** wake Firstmate when a crewmate relays a decision only it can act on ([0b60abc](https://github.com/kunchenguid/firstmate-3000/commit/0b60abcb503e9fd3198d64752c69fc19b33b293f))
* **crew:** wake Firstmate when a task waits on work nobody has started ([200e50e](https://github.com/kunchenguid/firstmate-3000/commit/200e50ed16bdd09edfba1aab12aaea0a8fe06d19))
* **custom-api:** let turns finish long streamed replies ([256a13f](https://github.com/kunchenguid/firstmate-3000/commit/256a13f2060a5c6ed82d0666533e7503f07ba8eb))
* **decisions:** stop Jev's request on the caller's cancel and refuse replies past 64 KB ([616b642](https://github.com/kunchenguid/firstmate-3000/commit/616b64254acc3aeb7736aa896f206b925f1b6552))
* **design:** center the disclosure caret in its row ([1a043d3](https://github.com/kunchenguid/firstmate-3000/commit/1a043d3c740165a9192466b3d7b056b3d5adb6d8))
* **e2e:** keep full suite execution in CI ([cdb1741](https://github.com/kunchenguid/firstmate-3000/commit/cdb174143e27c2cd9419a3a3957ffdf8c493c10f))
* **forge:** let a later run decide a cancelled duplicate check ([fb10ad5](https://github.com/kunchenguid/firstmate-3000/commit/fb10ad57fe928d84436aee21e5fc0cf51e702c43))
* **models:** upgrade Pi to 1.0 ([db2b186](https://github.com/kunchenguid/firstmate-3000/commit/db2b1864400cb86d6a98d044e1055b2deb5aaa0d))
* **projects:** restore clone sign-in way through shared actions ([72db381](https://github.com/kunchenguid/firstmate-3000/commit/72db381ec64bb5c1867d6bfa32cd2aad3340b948))
* **quota:** name a Codex window by its own length, not its slot ([a1271a4](https://github.com/kunchenguid/firstmate-3000/commit/a1271a438e671e611efe738c2b0ed56113aedf09))
* **quota:** read Claude utilization of 1 as 1% used, not a fraction ([0af5a79](https://github.com/kunchenguid/firstmate-3000/commit/0af5a79255eb05a313b10f08b91120f31b2fae49))
* **quota:** read Codex used_percent of 1 as 1% used, not a fraction ([52a9587](https://github.com/kunchenguid/firstmate-3000/commit/52a95872195af943acdd7480b376acc22d8584ae))
* **release-notes:** show every recorded change after an upgrade from an untracked version ([a616e94](https://github.com/kunchenguid/firstmate-3000/commit/a616e9444a414c7714cdbb882a1ea5ce2aa25821))
* **settings:** enforce action coverage for each shared setting ([bba7aea](https://github.com/kunchenguid/firstmate-3000/commit/bba7aeaa1b5dd99448d95f46cf5b41c7c41c8d55))
* **tasks:** share lifecycle status across task views ([00989e2](https://github.com/kunchenguid/firstmate-3000/commit/00989e267802144ccb14e2ebf0e33ae2dd070681))


### Performance Improvements

* **firstmate:** trim the fixed instructions and tool list ([9352cb6](https://github.com/kunchenguid/firstmate-3000/commit/9352cb6a0367d9a8c4e04b9b8af2d9e5643af9a2))

## [0.1.27](https://github.com/kunchenguid/firstmate-3000/compare/v0.1.26...v0.1.27) (2026-10-02)


### Features

* **actions:** add Intelligence to the shared action catalog ([d6d232c](https://github.com/kunchenguid/firstmate-3000/commit/d6d232c270c5ceacfc08f2342709a70a357ae0ec))
* **actions:** add the shared actor-gated app action catalog ([18df3bc](https://github.com/kunchenguid/firstmate-3000/commit/18df3bc0471dd5cfff3693538459ce14abf3bb31))
* **actions:** complete the app action catalog and enforce strict parity ([ba391ed](https://github.com/kunchenguid/firstmate-3000/commit/ba391ed31835acc82176cf560097baf149906606))
* **appearance:** add persisted whole-window size choices ([46f16bf](https://github.com/kunchenguid/firstmate-3000/commit/46f16bf25622be7017b1d8f69d98f1d5aae8473e))
* **cards:** accept editable body files for crewmate cards ([03984ba](https://github.com/kunchenguid/firstmate-3000/commit/03984baf5450456994adeac77f3f0cdf718f4262))
* **cards:** default to wide except short plain notes ([d4a8b0b](https://github.com/kunchenguid/firstmate-3000/commit/d4a8b0b4d5e9365a463603e1fa3a01c354485693))
* **cards:** give card authors five sentence habits and score them on recorded cards ([3020a69](https://github.com/kunchenguid/firstmate-3000/commit/3020a69f63b9dd1c359a131628b3a7957ba94cc2))
* **cards:** mark what changed since the captain last saw a card ([d1733aa](https://github.com/kunchenguid/firstmate-3000/commit/d1733aa31bb93536e39197c295d0e808f1f0d286))
* **cards:** reveal the first card after a dismissal ([38198fc](https://github.com/kunchenguid/firstmate-3000/commit/38198fcd234b8dea8e4881bc545a624ba1179e95))
* **composer:** send long pastes as local file snippets ([23a6978](https://github.com/kunchenguid/firstmate-3000/commit/23a6978c02bfcc2eb540b8ff13c95607fa64f7ca))
* **crew:** race the crew round their orbits during the black hole ([92d4e09](https://github.com/kunchenguid/firstmate-3000/commit/92d4e0986245d576540e3480495d9071c47b5603))
* **crew:** send the captain's close of a card to its crewmate ([8781820](https://github.com/kunchenguid/firstmate-3000/commit/878182006bc393f840eb4b7e07fc0b765d8819dc))
* **crew:** show a crewmate's model, intelligence and reasoning as a labeled readout ([99637f0](https://github.com/kunchenguid/firstmate-3000/commit/99637f09ff67e3621d747f287b35285bc62a5686))
* **decisions:** offer OpenRouter classifiers through signed-in accounts ([1e8f188](https://github.com/kunchenguid/firstmate-3000/commit/1e8f188ab8282490a3666f5066ada73d5898fa3b))
* **dictation:** add an off switch and configurable talk key ([6962ead](https://github.com/kunchenguid/firstmate-3000/commit/6962eadde54a6b73da78718e4909ba37f9fd9bf7))
* **projects:** add projects directly from Settings ([4c68fc2](https://github.com/kunchenguid/firstmate-3000/commit/4c68fc2c8868ca7e13f260bee5585d7dae16af3e))
* **projects:** remove a project from its open row in Settings ([7e0d540](https://github.com/kunchenguid/firstmate-3000/commit/7e0d540638f2554735cda7fb5e62ae5d05e98bfd))
* **settings:** group visual settings in Appearance ([0e9ec69](https://github.com/kunchenguid/firstmate-3000/commit/0e9ec69a3f7261c6958c21d0c7d51a4e26c6cf02))


### Bug Fixes

* **accounts:** support approved HTTP AI gateways ([44fa44b](https://github.com/kunchenguid/firstmate-3000/commit/44fa44be6de21f94bfbbce18af219b07970db32c))
* **appearance:** migrate saved 20% wash to zero once ([c4a4a97](https://github.com/kunchenguid/firstmate-3000/commit/c4a4a97a85f21a00a5bc15b55f6f701acab85827))
* **cards:** ask decision choices unpicked and refuse preanswered ones ([ca9783d](https://github.com/kunchenguid/firstmate-3000/commit/ca9783d4c40afdd951e1b3812b412e163717230f))
* **cards:** close untouched prefilled answers without asking ([8d5aa27](https://github.com/kunchenguid/firstmate-3000/commit/8d5aa27e80ca13e58945afc532455af8a24798e7))
* **cards:** rename Stop it to Stop task ([edd1eb5](https://github.com/kunchenguid/firstmate-3000/commit/edd1eb5cd7a85a0170ecf1570caa8921ecbfc9a2))
* **cards:** separate recommended options from explicit picks ([1c7ac06](https://github.com/kunchenguid/firstmate-3000/commit/1c7ac06dc66152d705acc138b17e5a01e79b1ada))
* **first-launch:** keep the welcome when setup leaves Settings records ([f3a6c72](https://github.com/kunchenguid/firstmate-3000/commit/f3a6c72ffbfb0d05807273f9adbafca6ff9823e1))
* **forge:** accept completed skipped checks in PR verdicts ([44ae4cf](https://github.com/kunchenguid/firstmate-3000/commit/44ae4cfa86314598bd6ac04d996e1277cc7549fa))
* **ollama:** require a 64K local context so Firstmate's fixed prompt leaves room ([59f0164](https://github.com/kunchenguid/firstmate-3000/commit/59f01648345f52f5854c6cac1b9acadadc08ae4c))
* **release:** require full Mac checks for alpha releases ([faa563b](https://github.com/kunchenguid/firstmate-3000/commit/faa563b660b50c8fe60e6e32144c4a0ee9ded20e))
* **shell:** default an unset window wash to 0% ([0da8d64](https://github.com/kunchenguid/firstmate-3000/commit/0da8d648ba38545c8ef695d23c8b03fc33445a1e))
* **update:** name the installed version in the update panel ([e4568a2](https://github.com/kunchenguid/firstmate-3000/commit/e4568a2b1e7d40fd1fffcdf32cdc171e05a1c0a7))

## [0.1.26](https://github.com/kunchenguid/firstmate-3000/compare/v0.1.25...v0.1.26) (2026-10-01)


### Features

* **cards:** a reply sends its card to the back of the stack instead of off it ([7d4505d](https://github.com/kunchenguid/firstmate-3000/commit/7d4505de3e32635af5681119ef29f5940e3f7a2f))
* **crew:** give the crewmate summary side labels, more room and the reason for its model ([5f93d50](https://github.com/kunchenguid/firstmate-3000/commit/5f93d508e24c1f4d2acdf5ec621aa3ef414ef8c9))
* **crew:** slow the stage near the pointer, pause on a crewmate and summarize it ([7d70034](https://github.com/kunchenguid/firstmate-3000/commit/7d700347257739c700faad2c588c9d608e86459e))
* **custom-api:** read model names and limits from the server's model list ([2d30f03](https://github.com/kunchenguid/firstmate-3000/commit/2d30f0392d7171df8e8d833433978c329bca3d7a))
* **projects:** choose the folder new projects go in ([47290eb](https://github.com/kunchenguid/firstmate-3000/commit/47290ebaeaf8fc25343278fb76deeabd2be09558))
* **release:** promote a published alpha to stable on a release branch ([358dd0e](https://github.com/kunchenguid/firstmate-3000/commit/358dd0ea40ac833c504eb0d1c93468969852a4df))


### Bug Fixes

* **cards:** keep a crewmate's note on the stack when its task closes done ([63cc4d0](https://github.com/kunchenguid/firstmate-3000/commit/63cc4d08092df83f946bbf81ae860b3883b1194c))
* **cards:** keep a new body frame's first document until it loads ([6872c13](https://github.com/kunchenguid/firstmate-3000/commit/6872c136213ef75e86bb4bfd4ea3550cf81f1125))
* **crew:** hand accepted plans to grounded implementation ([317bdb8](https://github.com/kunchenguid/firstmate-3000/commit/317bdb8de32e021b6e6e06909faba19a1044a772))
* **crew:** keep crewmate evidence out of commits and remove committed artifacts ([907d5ed](https://github.com/kunchenguid/firstmate-3000/commit/907d5edb9a3c5fcac71d69ab666812fa2243dc54))
* **crew:** leave a crewmate's model label empty until a model is assigned ([b790096](https://github.com/kunchenguid/firstmate-3000/commit/b790096e83016efae103a05345d1aec069e80cc5))
* **crew:** re-space every orbit evenly when crew join or leave ([eb140c0](https://github.com/kunchenguid/firstmate-3000/commit/eb140c034548b1ccfa1432e788281fca859dada5))
* **crew:** tell Firstmate when a crewmate's completion card was refused ([bee6f23](https://github.com/kunchenguid/firstmate-3000/commit/bee6f23b91f699fa2f9aec3cfe6d613adac3a615))
* **crew:** turn a merge card back while a wait would refuse the click ([da1def4](https://github.com/kunchenguid/firstmate-3000/commit/da1def46abee6d3725732fa9a29b4a741ad9dbf7))
* **evals:** fix each live check's call allowance on the run sheet ([9113115](https://github.com/kunchenguid/firstmate-3000/commit/91131155587984dc4a0e287f62baf6a2c9fc9815))
* **evals:** judge a basis edit by the task the record names ([44865e9](https://github.com/kunchenguid/firstmate-3000/commit/44865e92f4676d2ac07454996513bc54b2c71dac))
* **evals:** keep ordinary words readable in live-check evidence ([080ca9f](https://github.com/kunchenguid/firstmate-3000/commit/080ca9fee414563aaebe3b9ea6dd6f19bea3a13b))
* **forge:** read checks that have not started as pending, not green ([d7d6bf4](https://github.com/kunchenguid/firstmate-3000/commit/d7d6bf4291f3d7f8fdbd82d10a53258d70610b1b))
* **notifications:** show a card body's visible text, not its HTML markup ([80a2758](https://github.com/kunchenguid/firstmate-3000/commit/80a2758ecc4623ad55cb9d6517fd926ef1593a0c))


### Performance Improvements

* **tests:** reuse database fixtures and replay results ([ed5a852](https://github.com/kunchenguid/firstmate-3000/commit/ed5a8524fcf6bc9555abd958a2a7e2d8a25b0312))
* **tests:** share guarded unit code and size Mac integration workers ([36d1ada](https://github.com/kunchenguid/firstmate-3000/commit/36d1ada161109423990b1ddc337a78f2eb977199))

## [0.1.25](https://github.com/kunchenguid/firstmate-3000/compare/v0.1.24...v0.1.25) (2026-10-01)


### Features

* **cards:** animate stage replacements after first draw ([ade556e](https://github.com/kunchenguid/firstmate-3000/commit/ade556eb740303a56f838b35d40b16f5b574f17e))
* **cards:** move task records onto the solid stack ([5cb4460](https://github.com/kunchenguid/firstmate-3000/commit/5cb44607177b620f7a8a4e34ecb657f62ca802e7))
* **character:** add five sky fidgets to the Firstmate's pool ([47bcb21](https://github.com/kunchenguid/firstmate-3000/commit/47bcb2129418aee0b0270cd6e210692ccedc8497))
* **crew:** show model names with a persisted visibility switch ([606276f](https://github.com/kunchenguid/firstmate-3000/commit/606276fac804632f946ad889ac34813b5ac68cc3))
* **custom-api:** add checked isolated gateway connections ([0af10de](https://github.com/kunchenguid/firstmate-3000/commit/0af10de8ca5e54aae22f406f4187084baa79ee57))
* **forge:** expose workflow logs and artifact downloads ([cd11f3e](https://github.com/kunchenguid/firstmate-3000/commit/cd11f3eae990ffec29ba5b5ecca156f6894db030))
* **motion:** reveal disclosures settings and fresh activity in place ([a3579b1](https://github.com/kunchenguid/firstmate-3000/commit/a3579b198d592fa6e2282d0b6e5775254151700e))
* **projects:** add GitHub sign-in code copying ([044642a](https://github.com/kunchenguid/firstmate-3000/commit/044642a7643ea680fc135aef3d9b08e510483eb4))
* **providers:** add guarded custom API transport ([e66e8b1](https://github.com/kunchenguid/firstmate-3000/commit/e66e8b18bbfd9dc911bd3a6d1f2c08818f818a92))
* **release:** publish alpha and stable through one signed channel workflow ([0193834](https://github.com/kunchenguid/firstmate-3000/commit/0193834de512944438ebaba2bf8b30af30850d21))
* **release:** typed stable and alpha casks with a forward-only targets writer ([f468d3f](https://github.com/kunchenguid/firstmate-3000/commit/f468d3f6fcde818950f616b9edad3a765d4b3c9f))
* **stage:** show a Thinking label above the Firstmate on the captain's first turn ([8e5cc2f](https://github.com/kunchenguid/firstmate-3000/commit/8e5cc2f78d033ea80f66e991a68a17fea3a9fef0))
* **storage:** refuse incompatible saved data before startup ([f80a153](https://github.com/kunchenguid/firstmate-3000/commit/f80a153680d32113a6794993e05755c7c97c33d0))
* **update:** offer each installation its own channel's updates ([159bfd2](https://github.com/kunchenguid/firstmate-3000/commit/159bfd249ac08f314eca5aa998caefcbbcaeec07))


### Bug Fixes

* **cards:** derive task waiting from reachable ready choices ([dc5b94e](https://github.com/kunchenguid/firstmate-3000/commit/dc5b94e2039d3960279ec8f89b82db2310b6865e))
* **cards:** prefer captain intent in completion-card Why ([bbd6073](https://github.com/kunchenguid/firstmate-3000/commit/bbd6073ecef6551c8e9bc258c597f1b314a2961e))
* **cards:** refuse undeclared choices before resolution ([0443c17](https://github.com/kunchenguid/firstmate-3000/commit/0443c17197a58b1320a18d8f15dcde246977c023))
* **cards:** remove transport wrappers from refused requests ([2ca0f1f](https://github.com/kunchenguid/firstmate-3000/commit/2ca0f1f8812af2d3f1ae9c8d97a5b6338da8b061))
* **cards:** retire choices when crew tasks close ([ffab571](https://github.com/kunchenguid/firstmate-3000/commit/ffab5711bcdd4152e65b579bbd315f7dda0c3015))
* **cards:** stop viewport-height padding feedback ([e889c3c](https://github.com/kunchenguid/firstmate-3000/commit/e889c3c45998d7f20359f8e2af1720c9e1bc6979))
* **cards:** submit current settings with prototype build approval ([d6a27ef](https://github.com/kunchenguid/firstmate-3000/commit/d6a27efbc6f9b92693c3b60efff8b277786170d6))
* **cards:** use current answer holds for handoff witnesses ([518bc24](https://github.com/kunchenguid/firstmate-3000/commit/518bc240a78ffed455b82963e6b0ec416b99b74b))
* **classifier:** avoid unused Pi startup ([5dd17ba](https://github.com/kunchenguid/firstmate-3000/commit/5dd17ba2d6bea38aa23e1e984ffcde3e8b02ffab))
* **crew:** apply approved orbit capacities and motion ([3e19d57](https://github.com/kunchenguid/firstmate-3000/commit/3e19d5792380a9a90458d305d38aacb2ee5e7577))
* **crew:** keep indicators active during evidenced background work ([7b54b3d](https://github.com/kunchenguid/firstmate-3000/commit/7b54b3df49313de13f81f4af0941530381eebea0))
* **feed:** show task keys and updates without titles ([ab785d8](https://github.com/kunchenguid/firstmate-3000/commit/ab785d80e865ccabe8f70572b17c178c995bf8e0))
* **first-launch:** commit the welcome before fresh readiness ([a584814](https://github.com/kunchenguid/firstmate-3000/commit/a58481495cf61587a4640144289783fc0034ad4e))
* **motion:** share reduced-motion durations across shell and frames ([bb1c8de](https://github.com/kunchenguid/firstmate-3000/commit/bb1c8de4b8a9db1534342adcf5319db4bf74b66a))
* **panels:** prevent fractional-height document scrollbars ([c972e70](https://github.com/kunchenguid/firstmate-3000/commit/c972e707db2c9f8f6efc685f26d6cf13bcbc1e68))
* **panels:** stabilize content-frame scrollbar widths ([f4476ea](https://github.com/kunchenguid/firstmate-3000/commit/f4476ea7ed2fbc315f38a35b06b94204c2e2397a))
* **projects:** align approval badge accent with switch ([cd1f137](https://github.com/kunchenguid/firstmate-3000/commit/cd1f1372c0683501cffe5c9658d5ccc0537889e3))
* **scripts:** disable WebSockets for offline core loading ([fd272ce](https://github.com/kunchenguid/firstmate-3000/commit/fd272cece2c4b215f850c2196cae0270d7ad3d31))
* **settings:** explain refused saves and recover saved values ([0694258](https://github.com/kunchenguid/firstmate-3000/commit/0694258503aaac2bf8259ea7ec62bb7a89e98d17))
* **settings:** keep side padding within minimum window ([e52be5e](https://github.com/kunchenguid/firstmate-3000/commit/e52be5ec8aafdd741775bf2ee2e38d70d8a7dfb6))
* **settings:** keep transport details out of failure messages ([90db7a4](https://github.com/kunchenguid/firstmate-3000/commit/90db7a4c49f0fecef8b899a5781671b3ec989458))
* **tasks:** preserve specification delivery and history ([97c93aa](https://github.com/kunchenguid/firstmate-3000/commit/97c93aa48d46b4477f957533f80dd4abaead8251))
* **workspace:** preserve staged files when seeding project history ([139d9ad](https://github.com/kunchenguid/firstmate-3000/commit/139d9ad5d02607bf5e8857e13574b8db5a221fb7))

## [0.1.24](https://github.com/kunchenguid/firstmate-3000/compare/v0.1.23...v0.1.24) (2026-09-30)


### Features

* **cards:** add a consistent code completion outline ([d3aec2e](https://github.com/kunchenguid/firstmate-3000/commit/d3aec2edea05d4996a34b1825265d80fab272144))
* **tasks:** drop never-started charted work from the record ([a54c078](https://github.com/kunchenguid/firstmate-3000/commit/a54c07854a4a4c4e61210629db6107c5d2f934c2))


### Bug Fixes

* **cards:** stabilize scrollbar width to stop resize feedback ([ffba431](https://github.com/kunchenguid/firstmate-3000/commit/ffba431c241dbe0d93200cb1ff08b0433d49e069))
* **checks:** diagnose failures and count unsuccessful own repairs ([d46d381](https://github.com/kunchenguid/firstmate-3000/commit/d46d381c7a66f21f545108dd51b32536c02404e8))
* **ci:** run Linux checks on release proposals ([1a0a1d5](https://github.com/kunchenguid/firstmate-3000/commit/1a0a1d5babb62afc3097230775e257b86816f660))
* **composer:** raise the key hint to the secondary type size ([b83f1f8](https://github.com/kunchenguid/firstmate-3000/commit/b83f1f86148686bff77ccc4ff78acf654b004360))
* **settings:** expand Models by default in Intelligence ([c2e0d45](https://github.com/kunchenguid/firstmate-3000/commit/c2e0d456a175a75f32e56584f9bbb95ee3e9b02c))
* **tasks:** hide closed blockers in task records ([13e534b](https://github.com/kunchenguid/firstmate-3000/commit/13e534b7cea0aa2a9060beaf00dac045f9cd6caa))
* **vocabulary:** restore the outside words the captain adopted ([25a6e8d](https://github.com/kunchenguid/firstmate-3000/commit/25a6e8d027afb6c04a1409a035e2dc6688ccee98))

## [0.1.23](https://github.com/kunchenguid/firstmate-3000/compare/v0.1.22...v0.1.23) (2026-09-29)


### Features

* **cards:** keep a local record of card decisions and export it as episodes ([#465](https://github.com/kunchenguid/firstmate-3000/issues/465)) ([7718a67](https://github.com/kunchenguid/firstmate-3000/commit/7718a675bbc3c0cb01ba63371e6479ae58ecb28c))
* **crew:** declare objective plan skips across installs ([634e53a](https://github.com/kunchenguid/firstmate-3000/commit/634e53a270b88ae0b5f598aa1ac7ac28143bc782))
* **crew:** declare objective plan skips across installs ([73d4a0c](https://github.com/kunchenguid/firstmate-3000/commit/73d4a0cfe987dc9d697faaa8b333d9613af10c49))


### Bug Fixes

* **crew:** enforce conventional change and save-point names ([b4fda8c](https://github.com/kunchenguid/firstmate-3000/commit/b4fda8caa359f3f60c9f8e684dd81d2b383fc9dc))
* **crew:** enforce conventional change and save-point names ([5cca54e](https://github.com/kunchenguid/firstmate-3000/commit/5cca54e85db9d250fb8d895c29e4cff9a49eedc9))
* **crew:** guide mid-task continuations through landing ([33cc783](https://github.com/kunchenguid/firstmate-3000/commit/33cc7836522ba8c1cd1f586d093397176b37f836))
* **crew:** guide mid-task continuations through landing ([f950129](https://github.com/kunchenguid/firstmate-3000/commit/f950129991eed374b2a15c30d9db24cf4c8f9c50))
* **models:** upgrade Pi and start Codex on GPT-6.1 Sol ([69900df](https://github.com/kunchenguid/firstmate-3000/commit/69900df8160e83bcaab587d5f58d509691c69c21))
* **models:** upgrade Pi and start Codex on GPT-6.1 Sol ([d1fe95c](https://github.com/kunchenguid/firstmate-3000/commit/d1fe95c348fcac90cfa8f29ff97cc74104a70d1f))
* **release:** document how to request a release after plain-titled merges ([#453](https://github.com/kunchenguid/firstmate-3000/issues/453)) ([68c93c5](https://github.com/kunchenguid/firstmate-3000/commit/68c93c56f3c545da424f65fede9ab4822227ed24))
* **release:** keep macOS release jobs awake ([1f6e2bb](https://github.com/kunchenguid/firstmate-3000/commit/1f6e2bb620d9eb55626c30702c5ed5e12d38c3c4))
* **release:** keep macOS verify runner awake ([5f0bbd6](https://github.com/kunchenguid/firstmate-3000/commit/5f0bbd6c49ea690757486937a183f4091fea4bda))
* **release:** keep the macOS signing job awake ([13f2f0e](https://github.com/kunchenguid/firstmate-3000/commit/13f2f0e614dbdffecfe2e8d4aaeda95cef3ce681))

## [0.1.22](https://github.com/kunchenguid/firstmate-3000/compare/v0.1.21...v0.1.22) (2026-09-29)


### Features

* **cards:** the card reply row takes more than one line ([#441](https://github.com/kunchenguid/firstmate-3000/issues/441)) ([bae6de2](https://github.com/kunchenguid/firstmate-3000/commit/bae6de2775fefcf05a3baa76eceb00915fcae8ab))
* **composer:** the multi-line composer ([#440](https://github.com/kunchenguid/firstmate-3000/issues/440)) ([0b085e5](https://github.com/kunchenguid/firstmate-3000/commit/0b085e5057f2845381d5fc3da710186342baffc2))
* **tasks:** close verified external releases without task-owned changes ([b9bf821](https://github.com/kunchenguid/firstmate-3000/commit/b9bf821dfa0ed084a84b96b864a774e9ee925166))


### Bug Fixes

* **composer:** never lose a draft ([#434](https://github.com/kunchenguid/firstmate-3000/issues/434)) ([2a48432](https://github.com/kunchenguid/firstmate-3000/commit/2a4843244c9a28f0c2c3d12f70baeab898aff1ac))
* **crew:** drop the review electron orbital lines ([eae7c14](https://github.com/kunchenguid/firstmate-3000/commit/eae7c14bba7a506bc85292281cecb7ca4855866c))

## [0.1.21](https://github.com/kunchenguid/firstmate-3000/compare/v0.1.20...v0.1.21) (2026-09-28)


### Features

* **cards:** ask a decision's questions inline, sent with the footer (contract 4.22) ([#424](https://github.com/kunchenguid/firstmate-3000/issues/424)) ([62f5700](https://github.com/kunchenguid/firstmate-3000/commit/62f5700d2e3e87dac07fb8bc06ab71b62d325218))
* **cards:** size a card to its content, then the hint, then the captain's drag ([#423](https://github.com/kunchenguid/firstmate-3000/issues/423)) ([e9eecc9](https://github.com/kunchenguid/firstmate-3000/commit/e9eecc9067b5ba1592c823da95db2102450c584c))
* **record:** lifecycle footer and the model chip app-wide (task popup, host side) ([#427](https://github.com/kunchenguid/firstmate-3000/issues/427)) ([7834769](https://github.com/kunchenguid/firstmate-3000/commit/7834769e781fc80e94fa6874e78ef402292bac30))
* **record:** the task record body as peer rows, in plain words (contract 4.24) ([#426](https://github.com/kunchenguid/firstmate-3000/issues/426)) ([6b257a4](https://github.com/kunchenguid/firstmate-3000/commit/6b257a407d8ecede75f8fa4cbf8c4bcc00af9825))


### Bug Fixes

* **cards:** hold a lone card under the stage's edge through a resize ([#429](https://github.com/kunchenguid/firstmate-3000/issues/429)) ([6497aa8](https://github.com/kunchenguid/firstmate-3000/commit/6497aa8ae0100773765e917557c96d7b211fabc2))

## [0.1.20](https://github.com/kunchenguid/firstmate-3000/compare/v0.1.19...v0.1.20) (2026-09-28)


### Bug Fixes

* advance Claude Sonnet starter to 5.5 ([92e5290](https://github.com/kunchenguid/firstmate-3000/commit/92e5290b15a277fb2f9ec0433ad1727bc32cd557))
* **bench:** quote dry-run fixture check path ([e773755](https://github.com/kunchenguid/firstmate-3000/commit/e7737550ce81a0768c0727023706ab76ccac7b23))
* **telemetry:** raise the send timeout to 10 s ([#421](https://github.com/kunchenguid/firstmate-3000/issues/421)) ([8e54926](https://github.com/kunchenguid/firstmate-3000/commit/8e549266aa89f1cd48b44e51c8e098e4ecf32551))


### Tests

* budget the recorded Claude replay for hosted Linux ([#417](https://github.com/kunchenguid/firstmate-3000/issues/417)) ([20f1a1d](https://github.com/kunchenguid/firstmate-3000/commit/20f1a1d30d2a8ca0b7f17ddf74ffd2c543c2af50))

## [0.1.19](https://github.com/kunchenguid/firstmate-3000/compare/v0.1.18...v0.1.19) (2026-09-28)


### Features

* **tasks:** show crew filings on the quiet ledger (contract 4.21) ([a44977c](https://github.com/kunchenguid/firstmate-3000/commit/a44977c66f3a41680e8e373a5bbe60cca10ef2d7))


### Bug Fixes

* **cards:** draw figure type at true size in the usual card (contract 4.20) ([dc42ea1](https://github.com/kunchenguid/firstmate-3000/commit/dc42ea1e7b6f0cedb67f8fd009387f7c72d9a904))
* **firstmate:** a parent only for an ask of more than one step (contract 4.19) ([#413](https://github.com/kunchenguid/firstmate-3000/issues/413)) ([9125c5c](https://github.com/kunchenguid/firstmate-3000/commit/9125c5cc2b367162f557cf6e85a9508588d0e88e))
* **tasks:** take keep and drop off the record ([e0f86f8](https://github.com/kunchenguid/firstmate-3000/commit/e0f86f85612197edca5eb44b5e11c3d1ef9682b2))

## [0.1.18](https://github.com/kunchenguid/firstmate-3000/compare/v0.1.17...v0.1.18) (2026-09-28)


### Bug Fixes

* **usage:** keep a Claude crewmate's cut-turn usage when a close, escalation, purge or quit stops it ([#411](https://github.com/kunchenguid/firstmate-3000/issues/411)) ([1d9b4ac](https://github.com/kunchenguid/firstmate-3000/commit/1d9b4ace35d58de6a00a7b2b65f04eac00074cce))

## [0.1.17](https://github.com/kunchenguid/firstmate-3000/compare/v0.1.16...v0.1.17) (2026-09-28)


### Features

* **crew:** mark active adversarial reviews with ember orbits ([2863ab5](https://github.com/kunchenguid/firstmate-3000/commit/2863ab5ff01cb99c6952fc52528eb9da80a37fda))
* **rigor:** port recommended no-mistakes care rules ([6693088](https://github.com/kunchenguid/firstmate-3000/commit/66930887ea77b7825ec086ed012cfe2108da1b54))


### Bug Fixes

* **shell:** keep the macOS 26 window transparent so wash can show the desktop ([e25d080](https://github.com/kunchenguid/firstmate-3000/commit/e25d0800877d9817655619d35c04fc246a43b17d))
* **tasks:** center the section expand chevron in its row ([0612bed](https://github.com/kunchenguid/firstmate-3000/commit/0612bed49b7f06247a67c9be5271412cab7a5a46))
* **voice:** return focus to prompt after transcription and send ([6cba967](https://github.com/kunchenguid/firstmate-3000/commit/6cba9671e964df92f5ac0057e8e324f2902ff7b2))

## [0.1.16](https://github.com/kunchenguid/firstmate-3000/compare/v0.1.15...v0.1.16) (2026-09-28)


### Features

* **bench:** headless attempt driver with a mock dry run ([#399](https://github.com/kunchenguid/firstmate-3000/issues/399)) ([a6e233d](https://github.com/kunchenguid/firstmate-3000/commit/a6e233d75212731922f615822c52f5c818bf500f))
* **bench:** S0 task runtime on Apple container, with the 113-task empty-patch sweep ([#401](https://github.com/kunchenguid/firstmate-3000/issues/401)) ([c085c71](https://github.com/kunchenguid/firstmate-3000/commit/c085c7122e34d1c4ba9cbe95b671e80e2dd80c8b))


### Bug Fixes

* **tasks:** use the panel expand chevron on section headers ([2ca7dfa](https://github.com/kunchenguid/firstmate-3000/commit/2ca7dfa8d9df992d6fecedc9555c1ae910b39608))
* toggle voice on quick right Option press while retaining hold to talk ([dda8c25](https://github.com/kunchenguid/firstmate-3000/commit/dda8c25cc2f1207ad35dd41f11f367b7cb8d0401))

## [0.1.15](https://github.com/kunchenguid/firstmate-3000/compare/v0.1.14...v0.1.15) (2026-09-28)


### Features

* **cards:** show the model name beside the task key ([035fc99](https://github.com/kunchenguid/firstmate-3000/commit/035fc993479134cefe37652afc9def4ff09ab162))
* **crew:** step Quick reasoning down from the served model level ([7af2303](https://github.com/kunchenguid/firstmate-3000/commit/7af23036d0c1b1c854b2d06b2eeb94096aab130e))
* **crew:** the host watches a change's checks and wakes the crewmate once ([#390](https://github.com/kunchenguid/firstmate-3000/issues/390)) ([1cc53c1](https://github.com/kunchenguid/firstmate-3000/commit/1cc53c1dc4866eac77f318d40a48bf1bccd6434c))
* safely refresh managed checkouts after merge ([0b22000](https://github.com/kunchenguid/firstmate-3000/commit/0b22000188fc650b66f5ba7f546141db5b12363a))
* **shell:** the main window is translucent on macOS ([9fbc13d](https://github.com/kunchenguid/firstmate-3000/commit/9fbc13d90d380c7573d8ad50ae3a11167e6d4f80))
* **shell:** the main window is translucent on macOS ([37af413](https://github.com/kunchenguid/firstmate-3000/commit/37af413157061f9f7fbced4eee097ac617851bb8))


### Bug Fixes

* **cards:** refuse figure type below 11px at emit boundary ([dc8c37f](https://github.com/kunchenguid/firstmate-3000/commit/dc8c37f66b0eba032702bec2e277361ce654d26a))
* **claude:** keep the client's per-turn reminders off the seat and pin what it adds ([#389](https://github.com/kunchenguid/firstmate-3000/issues/389)) ([76b59dc](https://github.com/kunchenguid/firstmate-3000/commit/76b59dc442f6a8413bfbd4bdf0e7cf6f90fd4cda))
* **claude:** start a new seat session when its instructions change ([#392](https://github.com/kunchenguid/firstmate-3000/issues/392)) ([a56e604](https://github.com/kunchenguid/firstmate-3000/commit/a56e604d1f5d0b024f0dcf79f41ddaf449e579c8))
* **crew:** keep crewmates off the person's keychains and signing material ([#386](https://github.com/kunchenguid/firstmate-3000/issues/386)) ([c04cdb4](https://github.com/kunchenguid/firstmate-3000/commit/c04cdb4a448926329ce97167fbdd170732c84989))
* **firstmate:** record and announce a seat move picked in Settings ([#388](https://github.com/kunchenguid/firstmate-3000/issues/388)) ([ebf83ce](https://github.com/kunchenguid/firstmate-3000/commit/ebf83cef00716d9b0f10a3ac6a3183dc8e10b9ab))
* **settle:** say a GitHub merge conflict as work to bring up to date ([#387](https://github.com/kunchenguid/firstmate-3000/issues/387)) ([b159282](https://github.com/kunchenguid/firstmate-3000/commit/b1592821139f829db0f892cce7ba8d06c61627a0))
* tolerate legacy settlement test doubles ([a59ca12](https://github.com/kunchenguid/firstmate-3000/commit/a59ca127374388e40f89ea5df02fb07f2143c8ba))

## [0.1.14](https://github.com/kunchenguid/firstmate-3000/compare/v0.1.13...v0.1.14) (2026-09-27)


### Features

* **cards:** a card comes back at its author's close-out ([#383](https://github.com/kunchenguid/firstmate-3000/issues/383)) ([ed64789](https://github.com/kunchenguid/firstmate-3000/commit/ed64789a40d961fd3124f8039d3bb8fa020e0579))


### Bug Fixes

* **claude:** never start a vendor sign-in over a login FM3000 cannot read ([#380](https://github.com/kunchenguid/firstmate-3000/issues/380)) ([9ee5ac3](https://github.com/kunchenguid/firstmate-3000/commit/9ee5ac31ff47792ae04230d4d6e93c58f8ec9ba5))
* **routing:** walk uncatalogued models cheapest first ([#379](https://github.com/kunchenguid/firstmate-3000/issues/379)) ([a6d0afa](https://github.com/kunchenguid/firstmate-3000/commit/a6d0afa36ceb914ee2d38fd41f66cb90c06b699f))
* **test:** give the npm-pack plugin case a measured budget and keep npm off the registry ([#382](https://github.com/kunchenguid/firstmate-3000/issues/382)) ([091ac44](https://github.com/kunchenguid/firstmate-3000/commit/091ac44a3e6e23342886a77a510f8c1c97a4fe47))

## [0.1.13](https://github.com/kunchenguid/firstmate-3000/compare/v0.1.12...v0.1.13) (2026-09-27)


### Bug Fixes

* **test:** pause the black hole clock ahead of its install; tolerate an unread stub stdin ([#377](https://github.com/kunchenguid/firstmate-3000/issues/377)) ([340c325](https://github.com/kunchenguid/firstmate-3000/commit/340c325edc02373e55db55e4de45847ccb497e01))

## [0.1.12](https://github.com/kunchenguid/firstmate-3000/compare/v0.1.11...v0.1.12) (2026-09-27)


### Features

* **session:** Claude crewmates steer and settle like the seat (step 5) ([#373](https://github.com/kunchenguid/firstmate-3000/issues/373)) ([4793b5e](https://github.com/kunchenguid/firstmate-3000/commit/4793b5ebc294980fcf43fbe2ef86e9d815d0f7cc))
* **session:** the Claude crewmate's record (step 6) ([#374](https://github.com/kunchenguid/firstmate-3000/issues/374)) ([ea712de](https://github.com/kunchenguid/firstmate-3000/commit/ea712de9588cd3acc0a45a0182252a22424bedd4))
* **session:** time bounds on one clock (step 7) ([#375](https://github.com/kunchenguid/firstmate-3000/issues/375)) ([4b1c5a8](https://github.com/kunchenguid/firstmate-3000/commit/4b1c5a8f4c935197b26fc7025588a232f336a2a4))


### Bug Fixes

* **test:** keep git's detached maintenance out of the pool fixture copy ([#369](https://github.com/kunchenguid/firstmate-3000/issues/369)) ([69961a7](https://github.com/kunchenguid/firstmate-3000/commit/69961a73206cb1e6630f412076c50ae92b1ba6f7))

## [0.1.11](https://github.com/kunchenguid/firstmate-3000/compare/v0.1.10...v0.1.11) (2026-09-27)


### Features

* **accounts:** a typed cut-off is a fact on the account (W1 S7) ([#362](https://github.com/kunchenguid/firstmate-3000/issues/362)) ([9abc231](https://github.com/kunchenguid/firstmate-3000/commit/9abc231e288e3bb446fa78773fbcc1c39e91d151))
* **classifier:** the kind classifier can run on the Claude login (W1 S10) ([#363](https://github.com/kunchenguid/firstmate-3000/issues/363)) ([bb15027](https://github.com/kunchenguid/firstmate-3000/commit/bb15027a5224d141d0b94d534f50b860e6d14420))
* **claude:** the Firstmate seat on Claude, dark (W1 S6) ([#360](https://github.com/kunchenguid/firstmate-3000/issues/360)) ([1862c84](https://github.com/kunchenguid/firstmate-3000/commit/1862c84fb75435f8c26a6e50e5d2f6a8a0b80d7b))
* **claude:** typed Claude signals, shared by crew and seat (W1 S3) ([#359](https://github.com/kunchenguid/firstmate-3000/issues/359)) ([0c70b25](https://github.com/kunchenguid/firstmate-3000/commit/0c70b25c948f26965e8953787322f77a3e27d6e8))
* **crew:** a cut-off Claude login holds its crew lanes, told once (W1 S8) ([#364](https://github.com/kunchenguid/firstmate-3000/issues/364)) ([929ec8d](https://github.com/kunchenguid/firstmate-3000/commit/929ec8dc3d303227b419ed3116dafa4d0fabcc2c))
* **crew:** honest retry, durable idle ladder, and a bound on background jobs ([#343](https://github.com/kunchenguid/firstmate-3000/issues/343)) ([f855714](https://github.com/kunchenguid/firstmate-3000/commit/f85571413fe4a41b62a2d50d5cf2f6b5c9db87c2))
* **crew:** the gate becomes a witness, and every card with actions places it ([#345](https://github.com/kunchenguid/firstmate-3000/issues/345)) ([a6a19d7](https://github.com/kunchenguid/firstmate-3000/commit/a6a19d7631e074e27358f6788f7dbd49ef861f91))
* **inbox:** a typed wake envelope, and the idle ladder's wakes ride it ([#347](https://github.com/kunchenguid/firstmate-3000/issues/347)) ([87661de](https://github.com/kunchenguid/firstmate-3000/commit/87661dee76119819b37cc94cd47ec27f6a4d9e70))
* **inbox:** every remaining wake rides the typed envelope, through one drain ([#350](https://github.com/kunchenguid/firstmate-3000/issues/350)) ([4945889](https://github.com/kunchenguid/firstmate-3000/commit/4945889eca5e99a726cfea8a7af63c007dd800f3))
* **inbox:** the outage wakes and the job bound ride the typed envelope, once per fact durably ([#349](https://github.com/kunchenguid/firstmate-3000/issues/349)) ([618c5d7](https://github.com/kunchenguid/firstmate-3000/commit/618c5d7a62bdd63c91b9a845a66538c3cb8ae471))
* **inbox:** the round caps' wakes ride the typed envelope ([#348](https://github.com/kunchenguid/firstmate-3000/issues/348)) ([75587ab](https://github.com/kunchenguid/firstmate-3000/commit/75587abaa1db857573eba8ac1525ad36ecca26c0))
* **orchestrator:** one ticker - one interval, one injectable clock ([#351](https://github.com/kunchenguid/firstmate-3000/issues/351)) ([a79d312](https://github.com/kunchenguid/firstmate-3000/commit/a79d31253ce368652bf8116eabe8d1d1092c6cca))
* **replay:** Claude-served Firstmate sessions replay through one reader (W1 S11) ([#361](https://github.com/kunchenguid/firstmate-3000/issues/361)) ([e35635f](https://github.com/kunchenguid/firstmate-3000/commit/e35635fdeb729645fbe3e9d268f9dfbd0c0677e7))
* **seat:** a cut-off pauses the seat through the ladder, and every move asks (W1 S9) ([#365](https://github.com/kunchenguid/firstmate-3000/issues/365)) ([531d11c](https://github.com/kunchenguid/firstmate-3000/commit/531d11cf5acd0a36ade59b014b102030ce192362))
* **seat:** the flip - Claude seats the Firstmate, every cut-off rehearsed (W1 S12) ([#366](https://github.com/kunchenguid/firstmate-3000/issues/366)) ([9e74408](https://github.com/kunchenguid/firstmate-3000/commit/9e7440862aba52fe30444aeb8f0480875b810817))
* set reasoning effort defaults ([c894303](https://github.com/kunchenguid/firstmate-3000/commit/c894303d7485d60a93a14baa2f4e4f5cce2b6871))
* **tasks:** derive the basis verdict and read the review join off the parent edge ([#344](https://github.com/kunchenguid/firstmate-3000/issues/344)) ([5a1dbba](https://github.com/kunchenguid/firstmate-3000/commit/5a1dbba391bec8d26e69f1009030e3f716c4af59))
* **tools:** every Firstmate tool rule reaches a Claude seat (W1 S2, contract 4.13) ([#357](https://github.com/kunchenguid/firstmate-3000/issues/357)) ([a14756b](https://github.com/kunchenguid/firstmate-3000/commit/a14756bbd4196684c6f0e8b39cc4d4026d49a884))
* **tools:** one crewmate tool spec for both runtimes, grouped spawn parameters (P7) ([#354](https://github.com/kunchenguid/firstmate-3000/issues/354)) ([d0fa487](https://github.com/kunchenguid/firstmate-3000/commit/d0fa48740c48241e8a4a5d23c2ec6b9241113dcf))


### Bug Fixes

* **crew:** the stall card on a capped task says it needs the captain's call ([#346](https://github.com/kunchenguid/firstmate-3000/issues/346)) ([0dbce68](https://github.com/kunchenguid/firstmate-3000/commit/0dbce687b9776d902788ef67a0fb2cceaeda6439))
* **forge:** date every GitHub sign-in health change in a durable log ([#336](https://github.com/kunchenguid/firstmate-3000/issues/336)) ([9ab2b61](https://github.com/kunchenguid/firstmate-3000/commit/9ab2b61fac0052c87efd5a7152e8f028be97a3d1))
* **forge:** keep and use the refresh token of a short-lived GitHub sign-in ([#342](https://github.com/kunchenguid/firstmate-3000/issues/342)) ([1ef4bcc](https://github.com/kunchenguid/firstmate-3000/commit/1ef4bccfd39f716c418885679da0d8b4bc3d67af))

## [0.1.10](https://github.com/kunchenguid/firstmate-3000/compare/v0.1.9...v0.1.10) (2026-09-25)


### Features

* offer GitHub sign-in for task dispatch ([5645ac9](https://github.com/kunchenguid/firstmate-3000/commit/5645ac9ff76b50776412b93b5fc6ff0088e28292))
* **plugins:** one plugin vehicle - add a panel by talking, behind one consent card ([#326](https://github.com/kunchenguid/firstmate-3000/issues/326)) ([74b6d81](https://github.com/kunchenguid/firstmate-3000/commit/74b6d8103cf2a8419bf4636d0b75b0f7733ae192))
* **plugins:** the frame realm - draw added panels contained, Tasks and Activity in the plugin shape ([#332](https://github.com/kunchenguid/firstmate-3000/issues/332)) ([a220f8e](https://github.com/kunchenguid/firstmate-3000/commit/a220f8eaccd59be0e3df85a03dbd985aeb45ff37))
* **sequences:** seed the sharpened sequences and let create_task relay a step's line verbatim ([#325](https://github.com/kunchenguid/firstmate-3000/issues/325)) ([af921c5](https://github.com/kunchenguid/firstmate-3000/commit/af921c59c201ffd846cb0d6b0b144b4152a9cb4f))

## [0.1.9](https://github.com/kunchenguid/firstmate-3000/compare/v0.1.8...v0.1.9) (2026-09-25)


### Features

* **cards:** name pictures in the body, group them, and serve them by reference ([#318](https://github.com/kunchenguid/firstmate-3000/issues/318)) ([bf18f80](https://github.com/kunchenguid/firstmate-3000/commit/bf18f802fba3a9033fba270209e248b924564538))
* **cards:** open any card picture large in a viewer over the window ([#322](https://github.com/kunchenguid/firstmate-3000/issues/322)) ([cf893c3](https://github.com/kunchenguid/firstmate-3000/commit/cf893c3b5b42356bdc65ba24f64cfc6e0ab2fd6b))
* **cards:** show active work in card threads ([b1c99fd](https://github.com/kunchenguid/firstmate-3000/commit/b1c99fd130d0cdc5adbb40ab35d4a2e28aaaa776))
* **forge:** put every question about where a project lives behind one seam ([#314](https://github.com/kunchenguid/firstmate-3000/issues/314)) ([9324ee3](https://github.com/kunchenguid/firstmate-3000/commit/9324ee38b2cff78f9bcf45235f5dc67ba9cfde50))
* **forge:** sign in to GitHub in the app, and git that never prompts ([#319](https://github.com/kunchenguid/firstmate-3000/issues/319)) ([37064df](https://github.com/kunchenguid/firstmate-3000/commit/37064df44ac0628f35c3615b1ecba2d81b76c5d5))
* **forge:** tell the Firstmate where each project lives and name the host in every change string ([#321](https://github.com/kunchenguid/firstmate-3000/issues/321)) ([04d3037](https://github.com/kunchenguid/firstmate-3000/commit/04d30376fa8886c00a106e918044db9152121917))
* **git:** bring the app's own git, for every host git and a crewmate's shell ([#324](https://github.com/kunchenguid/firstmate-3000/issues/324)) ([ab275a4](https://github.com/kunchenguid/firstmate-3000/commit/ab275a447475f67058f4839411621034ca4b665b))
* **plugins:** read the app's record through versioned SQL views ([#320](https://github.com/kunchenguid/firstmate-3000/issues/320)) ([7fdb1fc](https://github.com/kunchenguid/firstmate-3000/commit/7fdb1fc53722dc92e2d7b2d5d65ecba7e67c1e92))
* **providers:** drop Cursor; only Pi subscriptions, Claude the exception ([#312](https://github.com/kunchenguid/firstmate-3000/issues/312)) ([9d6558e](https://github.com/kunchenguid/firstmate-3000/commit/9d6558ee41456918f8f55eb430d892616ad52413))
* **tasks:** prefix rows with task keys ([ba0678f](https://github.com/kunchenguid/firstmate-3000/commit/ba0678f6adb2d647744795046ead221eb300709c))


### Bug Fixes

* bring answered cards back and update stale e2e after [#304](https://github.com/kunchenguid/firstmate-3000/issues/304)/[#305](https://github.com/kunchenguid/firstmate-3000/issues/305) ([#309](https://github.com/kunchenguid/firstmate-3000/issues/309)) ([a4dd4df](https://github.com/kunchenguid/firstmate-3000/commit/a4dd4df76feb69badfd3f21ec21b240cfde0283e))
* **cards:** keep pictures inside the card and letterbox tall ones ([#313](https://github.com/kunchenguid/firstmate-3000/issues/313)) ([1fcff36](https://github.com/kunchenguid/firstmate-3000/commit/1fcff36d420d1ce3e84615d1bf287aa2d003a996))
* e2e timing asserted as order or work, budgets graded on demand; lost captain steer ([#316](https://github.com/kunchenguid/firstmate-3000/issues/316)) ([fcbe57b](https://github.com/kunchenguid/firstmate-3000/commit/fcbe57b3dd530d550375ba5ae6bd7dd1ce50e883))
* every child the core starts sees the person's search path ([#307](https://github.com/kunchenguid/firstmate-3000/issues/307)) ([68b1101](https://github.com/kunchenguid/firstmate-3000/commit/68b110121f8f76faa74da56121fd0e86ebd752c6))
* let local signers share the search list instead of queueing on one lock ([#315](https://github.com/kunchenguid/firstmate-3000/issues/315)) ([f88a47e](https://github.com/kunchenguid/firstmate-3000/commit/f88a47e2fe7b1ce8ddcb8a9ce283d717de4edc59))
* **now:** keep active task trees together ([66d68e3](https://github.com/kunchenguid/firstmate-3000/commit/66d68e3a3155ae47cc84032dcee486852b0540f5))
* **now:** keep active task trees together ([4e2ec39](https://github.com/kunchenguid/firstmate-3000/commit/4e2ec39969535327370b58997d6cebe7f1750bb9))
* put the local signing keychain on the search list while signing ([#311](https://github.com/kunchenguid/firstmate-3000/issues/311)) ([714d8f0](https://github.com/kunchenguid/firstmate-3000/commit/714d8f0be8f7ea1260573507ed2b3e9f832b5ec4))
* read the checks honestly, discard quietly, and say settle failures plainly ([#308](https://github.com/kunchenguid/firstmate-3000/issues/308)) ([e357a09](https://github.com/kunchenguid/firstmate-3000/commit/e357a09eba165035de8e6a4e48f8865e3f36ab07))
* **rigor:** ask for the end-to-end tests a change touches, and start follow-ups at the repo's rigor ([#310](https://github.com/kunchenguid/firstmate-3000/issues/310)) ([4eb5c5a](https://github.com/kunchenguid/firstmate-3000/commit/4eb5c5a42b1d8ebfef4143ee4b5183d281c824ae))
* **tests:** give every test run a private temp root and fail the run on a leak ([#317](https://github.com/kunchenguid/firstmate-3000/issues/317)) ([de025b7](https://github.com/kunchenguid/firstmate-3000/commit/de025b7c66558833d78fbe49c863bd9b03ef8f6f))

## [0.1.8](https://github.com/kunchenguid/firstmate-3000/compare/v0.1.7...v0.1.8) (2026-09-24)


### Bug Fixes

* **checks:** find the GitHub tool when the app is opened from the Dock ([a869499](https://github.com/kunchenguid/firstmate-3000/commit/a869499c8cee54901cbe8867886001e2a7034473))

## [0.1.7](https://github.com/kunchenguid/firstmate-3000/compare/v0.1.6...v0.1.7) (2026-09-24)


### Features

* **firstmate:** work new asks through captain-owned sequences ([#293](https://github.com/kunchenguid/firstmate-3000/issues/293)) ([4989017](https://github.com/kunchenguid/firstmate-3000/commit/4989017826bf245c2886ccf4267c5e5b1be2b6f8))
* **tasks:** planned steps carry a basis, containers complete with their children ([#292](https://github.com/kunchenguid/firstmate-3000/issues/292)) ([9e470ea](https://github.com/kunchenguid/firstmate-3000/commit/9e470eab3c4b03311acf0f621370ea1c455e06d1))

## [0.1.6](https://github.com/kunchenguid/firstmate-3000/compare/v0.1.5...v0.1.6) (2026-09-24)


### Features

* **character:** draw each crewmate as the solid of its intelligence slot ([#290](https://github.com/kunchenguid/firstmate-3000/issues/290)) ([fb6a856](https://github.com/kunchenguid/firstmate-3000/commit/fb6a85647407f0b43589f5f35472c875143a33f0))
* **models:** Grok 4.7 medium, Composer low, Decisions alignment ([#288](https://github.com/kunchenguid/firstmate-3000/issues/288)) ([a6d3224](https://github.com/kunchenguid/firstmate-3000/commit/a6d3224b01deb5a402b3c43d0dc27c2de11bc016))
* **models:** keep model lists lean, read each account's catalog at runtime ([#285](https://github.com/kunchenguid/firstmate-3000/issues/285)) ([b3ed1a2](https://github.com/kunchenguid/firstmate-3000/commit/b3ed1a2c6abfa529c9be95dc081faf51b883cda7))


### Bug Fixes

* **e2e:** isolate Electron profiles and skip Whisper when the weights are absent ([#291](https://github.com/kunchenguid/firstmate-3000/issues/291)) ([be4123a](https://github.com/kunchenguid/firstmate-3000/commit/be4123ab3fb88739147a38bc04f6daff911447bf))
* **panels:** photograph panel themes off the live window ([#289](https://github.com/kunchenguid/firstmate-3000/issues/289)) ([8eac157](https://github.com/kunchenguid/firstmate-3000/commit/8eac157fbfb9fd4ff6ef838bced5194e41c2e367))
* **quota:** show reading… for sensed accounts until first allowance read ([#287](https://github.com/kunchenguid/firstmate-3000/issues/287)) ([d4a10cf](https://github.com/kunchenguid/firstmate-3000/commit/d4a10cfe79b6a651c0c1cb0438f6bc31fc8c9188))

## [0.1.5](https://github.com/kunchenguid/firstmate-3000/compare/v0.1.4...v0.1.5) (2026-09-23)


### Bug Fixes

* **claude:** name the earlier generations the client now serves ([#283](https://github.com/kunchenguid/firstmate-3000/issues/283)) ([54fd515](https://github.com/kunchenguid/firstmate-3000/commit/54fd5153725aa307c787071f5d18dfccf34cadf3))

## [0.1.4](https://github.com/kunchenguid/firstmate-3000/compare/v0.1.3...v0.1.4) (2026-09-23)


### Features

* **character:** flicker the character that spent a finished request ([#279](https://github.com/kunchenguid/firstmate-3000/issues/279)) ([da0db21](https://github.com/kunchenguid/firstmate-3000/commit/da0db21a1d506caae3f1cb703230011738006b3b))
* **models:** default Cursor's Grok slot to 4.7 ([#282](https://github.com/kunchenguid/firstmate-3000/issues/282)) ([d0691cd](https://github.com/kunchenguid/firstmate-3000/commit/d0691cd58a5fbab2e4adf608c9aaa0669a5dcf1c))
* **models:** default GPT-6 Sol to high and medium, Grok to 4.7 ([#280](https://github.com/kunchenguid/firstmate-3000/issues/280)) ([4bfeac1](https://github.com/kunchenguid/firstmate-3000/commit/4bfeac128f4603d2763b9c22990be9c411af97eb))

## [0.1.3](https://github.com/kunchenguid/firstmate-3000/compare/v0.1.2...v0.1.3) (2026-09-23)


### Features

* **providers:** drop Kimi and Copilot and label API-key sign-in ([#276](https://github.com/kunchenguid/firstmate-3000/issues/276)) ([bc56d29](https://github.com/kunchenguid/firstmate-3000/commit/bc56d29e8e57583ebec3345466a2daf83c8e45ed))


### Bug Fixes

* **models:** bump Pi SDK to 0.87.1 so Codex lists GPT-6 ([#278](https://github.com/kunchenguid/firstmate-3000/issues/278)) ([90ce05f](https://github.com/kunchenguid/firstmate-3000/commit/90ce05f40f8c23e4361cbfc5497d9cca70afc5c2))

## [0.1.2](https://github.com/kunchenguid/firstmate-3000/compare/v0.1.1...v0.1.2) (2026-09-23)


### Features

* **workspace:** warm worktree pool, fetched default branch at dispatch ([#275](https://github.com/kunchenguid/firstmate-3000/issues/275)) ([88240e2](https://github.com/kunchenguid/firstmate-3000/commit/88240e2f6f5d98f89f74de6fb844e56f945e4381))


### Bug Fixes

* **main:** dev runs keep their state in firstmate-3000-dev, apart from the release ([#274](https://github.com/kunchenguid/firstmate-3000/issues/274)) ([49c7071](https://github.com/kunchenguid/firstmate-3000/commit/49c707174b93b1ea1f680416f2d8abafede1f602))
* **now-panel:** re-clamp a growing record pane before it paints; settle two layout e2e reads ([#272](https://github.com/kunchenguid/firstmate-3000/issues/272)) ([f1d0d8e](https://github.com/kunchenguid/firstmate-3000/commit/f1d0d8e2ceff0d68cef7a45d28a784b65bc7e0a1))

## [0.1.1](https://github.com/kunchenguid/firstmate-3000/compare/v0.1.0...v0.1.1) (2026-09-23)


### Bug Fixes

* **release:** verify-app reads x64ArchFiles; add a no-publish release dry run ([#269](https://github.com/kunchenguid/firstmate-3000/issues/269)) ([c6630d0](https://github.com/kunchenguid/firstmate-3000/commit/c6630d02777c54367feb57cea7d514219d8a0317))
* **workspace:** a closed task's worktree always goes, unlanded work saved first ([#270](https://github.com/kunchenguid/firstmate-3000/issues/270)) ([7daabe5](https://github.com/kunchenguid/firstmate-3000/commit/7daabe5cd6b5cdece097902a9f33a019950e918e))

## 0.1.0 (2026-09-23)


### Features

* a Firstmate that answers and proposes - interaction P1 (WI-8 to WI-14) ([#105](https://github.com/kunchenguid/firstmate-3000/issues/105)) ([5115365](https://github.com/kunchenguid/firstmate-3000/commit/51153655291c982d6f73b6e781c336ab67a3d754))
* a new card is never gone unseen (WI-18) ([#102](https://github.com/kunchenguid/firstmate-3000/issues/102)) ([c40892a](https://github.com/kunchenguid/firstmate-3000/commit/c40892a17ea29e5a172172ed874b5d8eefc53d2a))
* **accounts:** add a provider-agnostic credential-health framework ([#83](https://github.com/kunchenguid/firstmate-3000/issues/83)) ([72eb5bc](https://github.com/kunchenguid/firstmate-3000/commit/72eb5bca278b86efbc8ad586628c96b94ce9a6d6))
* **activity:** use semantic kind trail ([85e1aa7](https://github.com/kunchenguid/firstmate-3000/commit/85e1aa722d42c80ce3a924b046a76dbdddccadf7))
* **activity:** use semantic kind trail ([658406d](https://github.com/kunchenguid/firstmate-3000/commit/658406dde2f5333876695e5a1f466a0c13d2c5f6))
* add close_card so agents can dismiss obsolete cards ([#29](https://github.com/kunchenguid/firstmate-3000/issues/29)) ([5ead038](https://github.com/kunchenguid/firstmate-3000/commit/5ead038a56893cb8a0fee39bb694d707020c9f24))
* add Firstmate emote tool ([5a6d4fe](https://github.com/kunchenguid/firstmate-3000/commit/5a6d4feecc98d923cd6f5085b23b2afebc71eb16))
* add Firstmate emote tool ([eb36acd](https://github.com/kunchenguid/firstmate-3000/commit/eb36acd83ea168e9977e48718f8f0bed8927b295))
* add the AccountSelectionPolicy and selector binding (broker phase 3) ([b4612ce](https://github.com/kunchenguid/firstmate-3000/commit/b4612ce2d902c56eb36a182032bfa441a63af94e))
* add the AccountVault - the account-keyed store matrix (broker phase 1) ([ee24269](https://github.com/kunchenguid/firstmate-3000/commit/ee24269dc12291be0de761846b99444619ec94e7))
* agent-driven fleet management - the user asks, Firstmate registers ([#5](https://github.com/kunchenguid/firstmate-3000/issues/5)) ([c4f720d](https://github.com/kunchenguid/firstmate-3000/commit/c4f720d3340c3cbd7b94bb54d5d5375e7f33986e))
* agent-first task loop without per-task cards ([#15](https://github.com/kunchenguid/firstmate-3000/issues/15)) ([0973883](https://github.com/kunchenguid/firstmate-3000/commit/0973883076d62a2d5fc3e44f0f969c4bf6f4cfd2))
* **agents:** the wake diet - coalesce operational wakes into one turn (P3) ([#135](https://github.com/kunchenguid/firstmate-3000/issues/135)) ([7367b06](https://github.com/kunchenguid/firstmate-3000/commit/7367b06414211108c1b933924913840517af8474))
* **autonomy:** a per-task autonomy ask and the host's own merge hold (contract v3.9) ([#225](https://github.com/kunchenguid/firstmate-3000/issues/225)) ([0850e15](https://github.com/kunchenguid/firstmate-3000/commit/0850e15ceb02f1731e6fd60e67a684d9c7bfdce5))
* card allowlist v2 - inline SVG, headings, disclosure ([#97](https://github.com/kunchenguid/firstmate-3000/issues/97)) ([66711d3](https://github.com/kunchenguid/firstmate-3000/commit/66711d3730cf3d6dd090645533157490c5544774))
* card rule in prompts and spawn_crewmate; AGENTS.md update ([#10](https://github.com/kunchenguid/firstmate-3000/issues/10)) ([56aa990](https://github.com/kunchenguid/firstmate-3000/commit/56aa990028c5612ef15b2e3abb71631b0e965f33))
* **cards:** cards as threads, phase 1 - a reply under a card reaches its author (contract v4.2) ([#236](https://github.com/kunchenguid/firstmate-3000/issues/236)) ([47add51](https://github.com/kunchenguid/firstmate-3000/commit/47add515a67893bfa8a8063327e832cfab197263))
* **cards:** complete cards-as-threads with Firstmate replies, images, and Observe ([#237](https://github.com/kunchenguid/firstmate-3000/issues/237)) ([8e47d58](https://github.com/kunchenguid/firstmate-3000/commit/8e47d586ea6914edcc3c3caac5c91dea5c5fd65b))
* **cards:** dismiss any open card a captain message directly addresses ([2715783](https://github.com/kunchenguid/firstmate-3000/commit/27157832cf2cf76b3ace84382cbfd6b78b63aba8))
* **cards:** dismiss any open card a captain message directly addresses ([3eba97c](https://github.com/kunchenguid/firstmate-3000/commit/3eba97ca1e31335f26f55dd51203178dd651fb22))
* **cards:** explain-more is no longer a prescribed default action (contract v1.8) ([a98b41d](https://github.com/kunchenguid/firstmate-3000/commit/a98b41d6379e1157392cf1d8a2ef39d402db69c1))
* **cards:** one card shape whose actions carry effects; the host dispatches on the effect, never on an action id (P1) ([#133](https://github.com/kunchenguid/firstmate-3000/issues/133)) ([5b45748](https://github.com/kunchenguid/firstmate-3000/commit/5b457489bbfae6c2e2b9b5e1a2fbf7c58dc7be01))
* **cards:** re-home the card contract by kind, state the visual intent as a fact, trim the prescribed cards (contract v3.6) ([#219](https://github.com/kunchenguid/firstmate-3000/issues/219)) ([8b68ea3](https://github.com/kunchenguid/firstmate-3000/commit/8b68ea3e7044d29ad867636dd6a6347e873956ee))
* **cards:** remove the automatic Later, the park row, the task-result card and the host decision cards (P0) ([#132](https://github.com/kunchenguid/firstmate-3000/issues/132)) ([898b0ab](https://github.com/kunchenguid/firstmate-3000/commit/898b0ab7a6011bddcceea5a702a26e67dfd58cf6))
* **cards:** render card bodies verbatim in contained frames ([#158](https://github.com/kunchenguid/firstmate-3000/issues/158)) ([d72f6b8](https://github.com/kunchenguid/firstmate-3000/commit/d72f6b89c3ba7af0508405b5fc7d45f72b287210))
* **cards:** the settle facts as a labeled fact strip, with the crewmate's model (contract v2.7) ([e775b82](https://github.com/kunchenguid/firstmate-3000/commit/e775b82ad4b216dd268401132b8744884c6280d5))
* **cards:** the settle facts as a labeled fact strip, with the crewmate's model (contract v2.7) ([4c84ab9](https://github.com/kunchenguid/firstmate-3000/commit/4c84ab939243caaec2d7d10edb25793d8a84f026))
* **character:** crewmates orbit the Firstmate on the home view ([#125](https://github.com/kunchenguid/firstmate-3000/issues/125)) ([0e784e3](https://github.com/kunchenguid/firstmate-3000/commit/0e784e321c461c0ea1e48b844dda4b94409a89a2))
* **character:** the Firstmate folds into the Crystal while it consults ([#127](https://github.com/kunchenguid/firstmate-3000/issues/127)) ([40e52cf](https://github.com/kunchenguid/firstmate-3000/commit/40e52cfbc8379d46555e430ea6815e42019579cc))
* **character:** the Firstmate's eyes follow the pointer ([#60](https://github.com/kunchenguid/firstmate-3000/issues/60)) ([90ea030](https://github.com/kunchenguid/firstmate-3000/commit/90ea030b9aa5bccacb9bde3f0ec4817d05016822))
* **character:** the pretend black hole becomes a lensed accretion disk ([#63](https://github.com/kunchenguid/firstmate-3000/issues/63)) ([71340c4](https://github.com/kunchenguid/firstmate-3000/commit/71340c48db7946541c36e8ddae819eb5cbfa3199))
* **claude:** a live model-catalog probe, and the Fable drift it found ([6faa086](https://github.com/kunchenguid/firstmate-3000/commit/6faa0861f15d79e1a2395786fb899ec7cc49b717))
* **claude:** run the Claude Code the person installed, ship none (roadmap 1.6, F14) ([#226](https://github.com/kunchenguid/firstmate-3000/issues/226)) ([886b942](https://github.com/kunchenguid/firstmate-3000/commit/886b94246eff9f8c4cb7b477cfa78032f56e509f))
* **claude:** use the Mac's default login as the only Claude credential ([#79](https://github.com/kunchenguid/firstmate-3000/issues/79)) ([ad79208](https://github.com/kunchenguid/firstmate-3000/commit/ad792084210bb8d5faec424ab04199044f3fb4ba))
* close cards from chrome without a Done action ([#34](https://github.com/kunchenguid/firstmate-3000/issues/34)) ([61a9fc8](https://github.com/kunchenguid/firstmate-3000/commit/61a9fc81724b888d9db639f2ca57896bb7aaa745))
* **contract:** one card contract, host settle facts, lint by shape (2.0) ([#157](https://github.com/kunchenguid/firstmate-3000/issues/157)) ([cc9a00b](https://github.com/kunchenguid/firstmate-3000/commit/cc9a00b6599ac27036ff9ed29b44996a58d93222))
* **copy:** the plain-language pass - one vocabulary, the app's words on every surface, scored in the replay gate (roadmap 1.5, contract v4.0) ([#229](https://github.com/kunchenguid/firstmate-3000/issues/229)) ([fdb777e](https://github.com/kunchenguid/firstmate-3000/commit/fdb777e0095d78b6967ee0bfb1059a15ca5ff131))
* **core:** capture prospective decision provenance ([#170](https://github.com/kunchenguid/firstmate-3000/issues/170)) ([3062028](https://github.com/kunchenguid/firstmate-3000/commit/30620281f6c75bd9006a3b4dbd56734b1af2867a))
* **delivery:** let a captain ask override posture for one task ([663851b](https://github.com/kunchenguid/firstmate-3000/commit/663851bb2e55bca86f3016c2aabcf2015504decd))
* **delivery:** let a captain ask override posture for one task ([a82eb4e](https://github.com/kunchenguid/firstmate-3000/commit/a82eb4ea357a473641fc13bed4be8a5597790d4a))
* design system components and four-state app shell ([f7c8f72](https://github.com/kunchenguid/firstmate-3000/commit/f7c8f7224e94fe9caf9d92eae44f2b3405b3c1bc))
* **dev:** the dev-only local-model orchestrator seat, from Settings or the environment, refused by a packaged build (roadmap 1.7) ([#230](https://github.com/kunchenguid/firstmate-3000/issues/230)) ([c4e0bb7](https://github.com/kunchenguid/firstmate-3000/commit/c4e0bb7433b61a698666b6515a071a4bc51d1c15))
* distinguish PR merge from local landing ([7a0dc9e](https://github.com/kunchenguid/firstmate-3000/commit/7a0dc9ec14f3a130514ee1b35faa87345936826a))
* distinguish PR merge from local landing ([2d1423e](https://github.com/kunchenguid/firstmate-3000/commit/2d1423e33c12bfc8689ebcb61ae1377f4d77cfca))
* dock tasks panel at bottom ([38c1cb6](https://github.com/kunchenguid/firstmate-3000/commit/38c1cb649083a2fb7e70201fa55bbee05b1f6edd))
* drop Anthropic from the offered provider catalog ([918296e](https://github.com/kunchenguid/firstmate-3000/commit/918296e81c1c0eba9e10f1bb6c3e3075db0b1bde))
* durable captain-scope notes that survive compaction ([#37](https://github.com/kunchenguid/firstmate-3000/issues/37)) ([52f2fc5](https://github.com/kunchenguid/firstmate-3000/commit/52f2fc53497f82a786407866c127ef47f8540b39))
* durable inbox steering and a supervision session for routine fleet triage ([#36](https://github.com/kunchenguid/firstmate-3000/issues/36)) ([31b0282](https://github.com/kunchenguid/firstmate-3000/commit/31b02821e09f8dcbfe1f643f48ee6a3d848dfd19))
* echo accepted home input into the activity feed ([#22](https://github.com/kunchenguid/firstmate-3000/issues/22)) ([e1af18b](https://github.com/kunchenguid/firstmate-3000/commit/e1af18be0798e3c0bfbd7840e677d170d121573c))
* encode direct-pr CI babysit rule ([#8](https://github.com/kunchenguid/firstmate-3000/issues/8)) ([2662fdf](https://github.com/kunchenguid/firstmate-3000/commit/2662fdfb55ddb1042172b281476ef6e86046f064))
* enforce the backend-neutral placement seam (broker phase 0) ([80f8ec4](https://github.com/kunchenguid/firstmate-3000/commit/80f8ec4d5e43b5cd7387cfe16e21564a787a565d))
* fetch quota with FM3000-managed keys and drop quota-axi ([d2691bc](https://github.com/kunchenguid/firstmate-3000/commit/d2691bc017f0cec5373623bae83cf478e7eaa9b3))
* figure recipes and the fm.viz card helper (WI-17) ([#104](https://github.com/kunchenguid/firstmate-3000/issues/104)) ([d1c5c1b](https://github.com/kunchenguid/firstmate-3000/commit/d1c5c1b829d70b50fae3893e427066ef466cc309))
* **first-launch:** the gate on the stage, the Firstmate's welcome note, and the first-run hint ([#214](https://github.com/kunchenguid/firstmate-3000/issues/214)) ([03b0144](https://github.com/kunchenguid/firstmate-3000/commit/03b01440060478624d22e36f804c4f1a59141526))
* firstmate orchestrator agent replaces prompt-equals-crewmate ([e25ce22](https://github.com/kunchenguid/firstmate-3000/commit/e25ce22cb9150f07e0ea56ea0ee79724cd3e0fc0))
* forge-agnostic land action on finished task cards ([e2151a8](https://github.com/kunchenguid/firstmate-3000/commit/e2151a8927651c9820148e7a390a1b55689f5cf7))
* four card kinds with sandboxed live-prototype bodies ([7a09fd5](https://github.com/kunchenguid/firstmate-3000/commit/7a09fd5f0aca74bc4d571ba20241f1aac0e60dab))
* give the home activity feed a third of the window ([#18](https://github.com/kunchenguid/firstmate-3000/issues/18)) ([b69d221](https://github.com/kunchenguid/firstmate-3000/commit/b69d2213b7f2b9aa534b18ceabfa4648bb139529))
* host-own keep/land/discard on crewmate settle cards ([#31](https://github.com/kunchenguid/firstmate-3000/issues/31)) ([6161fca](https://github.com/kunchenguid/firstmate-3000/commit/6161fca71c39d99a1a5ec83ac661c83226fbe09d))
* **host:** read the Claude Keychain through a host capability (CD-5=B) ([#82](https://github.com/kunchenguid/firstmate-3000/issues/82)) ([11e76c5](https://github.com/kunchenguid/firstmate-3000/commit/11e76c5b6d6a553c94b4820193b3a98027139b20))
* inject the selected account at spawn and resume (broker phase 4) ([8a9a089](https://github.com/kunchenguid/firstmate-3000/commit/8a9a089264cd8cb4fcc41b817b5195a4bff867b9))
* linkify http(s) URLs in plain-text card bodies ([#19](https://github.com/kunchenguid/firstmate-3000/issues/19)) ([b5e9bc5](https://github.com/kunchenguid/firstmate-3000/commit/b5e9bc5113426a293b4f25585e8572394c33f703))
* live pi.dev model catalog, connected-only models, tier hygiene ([2c2a91c](https://github.com/kunchenguid/firstmate-3000/commit/2c2a91ce0eb1453edd561361d11facf21d5df679))
* local voice input on webgpu whisper ([ac808ad](https://github.com/kunchenguid/firstmate-3000/commit/ac808adb4b12818a4a828523960afa71da6671cd))
* local-dev Observe surface over existing session JSONL and usage ([0ca0e05](https://github.com/kunchenguid/firstmate-3000/commit/0ca0e054649b08651d359e0646d4482db060bced))
* machine-driven character with eyes, busy ember, and emotes ([#38](https://github.com/kunchenguid/firstmate-3000/issues/38)) ([b45f662](https://github.com/kunchenguid/firstmate-3000/commit/b45f66275d7b7a1adc9326a0dc9f4d074aa24de1))
* mention the on-screen card as a maybe in turn context ([#23](https://github.com/kunchenguid/firstmate-3000/issues/23)) ([19b6825](https://github.com/kunchenguid/firstmate-3000/commit/19b6825c4226aec951e6bce2457d11609ed0bf53))
* model-routing redesign - capability checks, a premium tier, and a user-activated shortlist (HOLD, do not merge) ([#41](https://github.com/kunchenguid/firstmate-3000/issues/41)) ([f595433](https://github.com/kunchenguid/firstmate-3000/commit/f595433c654ffc707ca84f9d6762a0ff36ac5c45))
* **models:** allow one offering in more than one intelligence slot ([21eef64](https://github.com/kunchenguid/firstmate-3000/commit/21eef64e91d9d32c955c9db266f8e43a9f9677a5))
* **models:** allow one offering in more than one intelligence slot ([f4bbbb9](https://github.com/kunchenguid/firstmate-3000/commit/f4bbbb90cdf15caa2fbdbce17371c205fe116ff9))
* multi-account Subscriptions tab (broker phase 5) ([6498548](https://github.com/kunchenguid/firstmate-3000/commit/64985483d95fe332e39455f26b543b237f621a1c))
* name the account in the Firstmate quota context line ([5999ac3](https://github.com/kunchenguid/firstmate-3000/commit/5999ac3ff10ee538c7b6f792ee42e0f186729d37))
* **now:** fold the to-land group into underway ([4e91da2](https://github.com/kunchenguid/firstmate-3000/commit/4e91da2ce16e4cabc66e40fd36b209aee8ea11a4))
* **now:** show project name on task rows instead of the key ([a5a6359](https://github.com/kunchenguid/firstmate-3000/commit/a5a6359e4487e7189c3753b8097cb4f56b72bd3c))
* **now:** the task record opens as a pane beside the panel, tied to its row ([39ab0e2](https://github.com/kunchenguid/firstmate-3000/commit/39ab0e260a6bd0b9028f33a1add902cfe3ce48a9))
* **now:** the task record opens as a pane beside the panel, tied to its row ([79ed8ee](https://github.com/kunchenguid/firstmate-3000/commit/79ed8ee3def7ad659ae125aa9cb2e7006d638c3a))
* **orchestrator:** drop stale closed-task noise, gate model-bucket section on change ([aed68c4](https://github.com/kunchenguid/firstmate-3000/commit/aed68c4668b3ee5f86adae889222debe1b45126d))
* paste-to-attach images on home chat input ([#7](https://github.com/kunchenguid/firstmate-3000/issues/7)) ([1d39749](https://github.com/kunchenguid/firstmate-3000/commit/1d3974980b10b5a203f2af3c1860ed3efd5fa042))
* **personal-panels:** the @firstmate/ui library, the authoring skills and the adherence lint ([#191](https://github.com/kunchenguid/firstmate-3000/issues/191)) ([a39fd3d](https://github.com/kunchenguid/firstmate-3000/commit/a39fd3d63762e3d3b7d1f26defb1adede1bb6b72))
* **personal-panels:** the build loop - live posture, personal-ui spawns, panel checks, declared reads (Step 4) ([#194](https://github.com/kunchenguid/firstmate-3000/issues/194)) ([8ac2cec](https://github.com/kunchenguid/firstmate-3000/commit/8ac2cecfe3889b5fd8ac089847dd869e547451da))
* pin Observe transcripts to the bottom while streaming ([#17](https://github.com/kunchenguid/firstmate-3000/issues/17)) ([b78faac](https://github.com/kunchenguid/firstmate-3000/commit/b78faacb910b64b0ad2848d0c116c62b86a9b3b3))
* **plugins:** preferredPlacement replaces preferredSide ([96c5aad](https://github.com/kunchenguid/firstmate-3000/commit/96c5aad3ffc12b5d72e37161dcaf727e3bceb14c))
* **plugins:** preferredPlacement replaces preferredSide ([a8e64d7](https://github.com/kunchenguid/firstmate-3000/commit/a8e64d73a326850008b20ecf8b591270eb94117d))
* **poc2:** derive weak under-escalation candidates from routine outcomes (C2) ([#49](https://github.com/kunchenguid/firstmate-3000/issues/49)) ([e82ed19](https://github.com/kunchenguid/firstmate-3000/commit/e82ed19f055199723b35b817da4cdf5a2c350bae))
* **poc2:** flag_missed_escalation, the 20th Firstmate tool (C3) ([#47](https://github.com/kunchenguid/firstmate-3000/issues/47)) ([a4fd065](https://github.com/kunchenguid/firstmate-3000/commit/a4fd0658960704d23bb3e3e98ceefe5bb56907a4))
* **poc2:** the dev-gated corpus export (C4) ([#48](https://github.com/kunchenguid/firstmate-3000/issues/48)) ([2ee6774](https://github.com/kunchenguid/firstmate-3000/commit/2ee67746adb81b5b2ea724576ca4386a588bd5df))
* **poc2:** the dispatch extractor over the Pi JSONL already on disk (C5) ([#46](https://github.com/kunchenguid/firstmate-3000/issues/46)) ([7a06f1c](https://github.com/kunchenguid/firstmate-3000/commit/7a06f1c7fa0b57983224663d4b77b741c90be6b3))
* **prompt:** delegate UI prototypes to crewmates ([674f00f](https://github.com/kunchenguid/firstmate-3000/commit/674f00f60ae80f3f643ad1786241af9af070f80f))
* **prompts:** the standard delivery tier, instruction only (delivery rigor phase 1) ([#202](https://github.com/kunchenguid/firstmate-3000/issues/202)) ([5ab2952](https://github.com/kunchenguid/firstmate-3000/commit/5ab29524ba0a67a564c76e0ffad5a09558501771))
* put the activity-feed thumb on the left rail ([#27](https://github.com/kunchenguid/firstmate-3000/issues/27)) ([bf11cf6](https://github.com/kunchenguid/firstmate-3000/commit/bf11cf6f249a33e5b27c951d0dc0ea9e3c4e3673))
* quota sensing, burn tracking, and quota-aware routing ([9288307](https://github.com/kunchenguid/firstmate-3000/commit/928830736b1aeed81688ba0c089196952963bec2))
* **quota:** quota-axi parity - sensed Claude usage, disclosed uncertainty, spend-priority routing ([#42](https://github.com/kunchenguid/firstmate-3000/issues/42)) ([705bfd7](https://github.com/kunchenguid/firstmate-3000/commit/705bfd73d5effec83f4acfd95b1c12832cd30340))
* **quota:** raise a needs_reauth card only from proof, with one-step restore ([#80](https://github.com/kunchenguid/firstmate-3000/issues/80)) ([e842850](https://github.com/kunchenguid/firstmate-3000/commit/e8428502f42f901ab57412f75ed743c9ab7be55d))
* **quota:** sense Cursor usage from the DashboardService RPC (CD-4=B2) ([#81](https://github.com/kunchenguid/firstmate-3000/issues/81)) ([1ee2b75](https://github.com/kunchenguid/firstmate-3000/commit/1ee2b75c3232158eb00354dc5e60fbe6c3711b2b))
* re-key the quota sensor and usage ledger to accounts (broker phase 2) ([d645cc6](https://github.com/kunchenguid/firstmate-3000/commit/d645cc67bb264c669ec4a183272289da67d47f4a))
* real pi crewmates end to end behind the placement seam ([05ca0cc](https://github.com/kunchenguid/firstmate-3000/commit/05ca0cc6d5eef517bea53cd640e01ae8edf28088))
* **release:** the private alpha as a cask from the public tap while the repository stays private (roadmap 1.2) ([#231](https://github.com/kunchenguid/firstmate-3000/issues/231)) ([8bbb19c](https://github.com/kunchenguid/firstmate-3000/commit/8bbb19c024172b22f137da640d97ac0476b6c99e))
* rename the status card kind to note ([d99297f](https://github.com/kunchenguid/firstmate-3000/commit/d99297fcc14a3f0bd581a9a0fd0d184815fa6fe6))
* render note and decision card bodies as markdown ([#26](https://github.com/kunchenguid/firstmate-3000/issues/26)) ([2e302f2](https://github.com/kunchenguid/firstmate-3000/commit/2e302f2880eb0fa1b649111bf24e6f9f646dbd7b))
* replay captain sessions as an eval gate (interaction P3, WI-19/20/21) ([#106](https://github.com/kunchenguid/firstmate-3000/issues/106)) ([578a76b](https://github.com/kunchenguid/firstmate-3000/commit/578a76b287b758f4d71d625faa6daaaaeef71ef4))
* **repos:** the personal workspace is a workspace kind, not a delivery posture (contract v3.7) ([#221](https://github.com/kunchenguid/firstmate-3000/issues/221)) ([d24861d](https://github.com/kunchenguid/firstmate-3000/commit/d24861d7e56a08c3bcd17dcd386bb669f34636ed))
* require self-contained card copy in Firstmate prompts ([#24](https://github.com/kunchenguid/firstmate-3000/issues/24)) ([0faeff9](https://github.com/kunchenguid/firstmate-3000/commit/0faeff9307fd11223985f0193fd0565005727d2c))
* retention, telemetry split, and the orchestrator-loop architecture doc ([237fb18](https://github.com/kunchenguid/firstmate-3000/commit/237fb180f010ad5fb6c5fba7a9739609dd6914fa))
* revise open emit_card cards in place by stable id ([#28](https://github.com/kunchenguid/firstmate-3000/issues/28)) ([63d01fd](https://github.com/kunchenguid/firstmate-3000/commit/63d01fd8250558aa6d57a427cfddda2c05533594))
* **rigor:** agent-driven rigor pipeline aligned to no-mistakes; per-head review rounds; standard default ([5d023fd](https://github.com/kunchenguid/firstmate-3000/commit/5d023fd5b5541d83af8a9cadd851e6b756a2fc4e))
* **rigor:** agent-driven rigor pipeline aligned to no-mistakes; standard default; per-head review rounds ([0a29bf4](https://github.com/kunchenguid/firstmate-3000/commit/0a29bf4da10c8527e353602383bceb54ad6ecbd6))
* **rigor:** review tasks are delivery children of their builders - parent join, close cascade, review_of fold ([14b956a](https://github.com/kunchenguid/firstmate-3000/commit/14b956added9ffb8135bc6e92c4179622617e78c))
* **rigor:** the numbers, in the one home the routing numbers have (delivery rigor phase 4) ([#205](https://github.com/kunchenguid/firstmate-3000/issues/205)) ([f0fbc19](https://github.com/kunchenguid/firstmate-3000/commit/f0fbc1929ed7d7f4b9e3fb9ca5c74bc6c1fb926c))
* **rigor:** the review is the builder's delivery child - parent join, close cascade, review_of fold ([963c771](https://github.com/kunchenguid/firstmate-3000/commit/963c771da59844406c2cb0fc1e9c780911082818))
* **rigor:** the reviewed tier - host-derived rigor and a read-only reviewer that holds the merge (delivery rigor phase 2) ([#203](https://github.com/kunchenguid/firstmate-3000/issues/203)) ([db5a4cd](https://github.com/kunchenguid/firstmate-3000/commit/db5a4cd39605b98eb0fdc7b20ead3b57f858a424))
* **rigor:** the tier as a record, with host holds (delivery rigor phase 3) ([#204](https://github.com/kunchenguid/firstmate-3000/issues/204)) ([6dd1080](https://github.com/kunchenguid/firstmate-3000/commit/6dd1080af5d5f9dbb37a3e642a25cec80571f4c6))
* **routing:** escalation on the regular spawn (S4) ([#199](https://github.com/kunchenguid/firstmate-3000/issues/199)) ([4445f12](https://github.com/kunchenguid/firstmate-3000/commit/4445f124470dfe7c8327e91a85a247e1c3fa8a3a))
* **routing:** let spawn_crewmate pin an exact model id ([cde0830](https://github.com/kunchenguid/firstmate-3000/commit/cde0830fc0dd0a91b2d0b2a755bf14c5202b749e))
* **routing:** let the user assign models to intelligence slots ([#84](https://github.com/kunchenguid/firstmate-3000/issues/84)) ([2775923](https://github.com/kunchenguid/firstmate-3000/commit/27759239ad501ccb51d12946cec790dddb2e7c14))
* **routing:** observability and eval for the tier policy (S5) ([#200](https://github.com/kunchenguid/firstmate-3000/issues/200)) ([f8f95f9](https://github.com/kunchenguid/firstmate-3000/commit/f8f95f95667e07f1aa3c9e8320a6e31e3bc1cf59))
* **routing:** the kind classifier on the low slot (S3) ([#198](https://github.com/kunchenguid/firstmate-3000/issues/198)) ([c1c4593](https://github.com/kunchenguid/firstmate-3000/commit/c1c4593101996a14d8b7b6edc68c2ab669457c01))
* **routing:** the reasoning class is Firstmate's judgment, not a keyword heuristic ([a3aca13](https://github.com/kunchenguid/firstmate-3000/commit/a3aca13382f085fddca895f185a32f76f52738a4))
* **routing:** the reasoning class is Firstmate's judgment, not a keyword heuristic ([ccb216e](https://github.com/kunchenguid/firstmate-3000/commit/ccb216ec3c52c38b28ba9feacda51fca81a5375b))
* **routing:** the work shape on the spawn, the tier from the policy (S2) ([#195](https://github.com/kunchenguid/firstmate-3000/issues/195)) ([19a6de1](https://github.com/kunchenguid/firstmate-3000/commit/19a6de19f3198ff9b7765c9826905b9687536b42))
* scaffold secure electron shell with design tokens and typed ipc ([94eadd2](https://github.com/kunchenguid/firstmate-3000/commit/94eadd2319e62ca16184e06955a3f7413a957aa4))
* scripts in every card body (WI-16) ([#100](https://github.com/kunchenguid/firstmate-3000/issues/100)) ([1b4e606](https://github.com/kunchenguid/firstmate-3000/commit/1b4e60699a63888cbf8c74684f973c8f01c47745))
* **scripts:** extract supervision turns and R2 evidence ([#173](https://github.com/kunchenguid/firstmate-3000/issues/173)) ([0b781de](https://github.com/kunchenguid/firstmate-3000/commit/0b781def12b8db13c2620a561b24463fa821a8f4))
* **settings:** accordion project policy UI on Settings → Projects ([0977a8d](https://github.com/kunchenguid/firstmate-3000/commit/0977a8d88405ae0a206a0d833fbff85c09cdca4f))
* **settings:** split Repositories into its own Projects tab ([5668d41](https://github.com/kunchenguid/firstmate-3000/commit/5668d41b23cff005b5681007f42600b078dc37fb))
* **sharing:** the two switches, off by default, with the payload shown before the first send (roadmap 1.4) ([#228](https://github.com/kunchenguid/firstmate-3000/issues/228)) ([3b51283](https://github.com/kunchenguid/firstmate-3000/commit/3b5128313fa4512a8dae75f63b4f8b0adb8eaebb))
* **shell:** the whisper - the newest feed line above the input ([4c56623](https://github.com/kunchenguid/firstmate-3000/commit/4c56623323f995ee40375cbc92eed73bc3f4feab))
* **shell:** the whisper - the newest feed line above the input ([c56f68d](https://github.com/kunchenguid/firstmate-3000/commit/c56f68d747c0d7811b0b51eac643f7a3448480e2))
* ship the tracked source as a read-only Firstmate jail root ([#2](https://github.com/kunchenguid/firstmate-3000/issues/2)) ([2a699d0](https://github.com/kunchenguid/firstmate-3000/commit/2a699d0530815501b02d912c586368c1f18b445c))
* signed release pipeline files and the release contract gate ([0be36dc](https://github.com/kunchenguid/firstmate-3000/commit/0be36dce5a707b6102ebdfa67649ffc64582f675))
* sqlite-backed work substrate with repo registry and task deletion ([b7e5ad6](https://github.com/kunchenguid/firstmate-3000/commit/b7e5ad64474c5923b20b1e850ac9b9a7ef5d3093))
* stamp supervision outcomes with provenance (migration 15) ([#45](https://github.com/kunchenguid/firstmate-3000/issues/45)) ([6a6ed93](https://github.com/kunchenguid/firstmate-3000/commit/6a6ed9395f40f8ed0ea5e2ad0d4958904b1902b1))
* **supervision:** sort a crewmate's report by the whose-turn rule, not a model (S7c) ([#220](https://github.com/kunchenguid/firstmate-3000/issues/220)) ([6790ff4](https://github.com/kunchenguid/firstmate-3000/commit/6790ff4607989cd0ef3fe91a7f08bc8689641b60))
* **tasks:** retire the finish mode and delivered status; structured settle refusals (P2) ([#134](https://github.com/kunchenguid/firstmate-3000/issues/134)) ([da69c01](https://github.com/kunchenguid/firstmate-3000/commit/da69c01eee3f3e4bfd80ea0964deaced1011ffa1))
* **tasks:** task-system P0 - the task record, TaskService as the one writer, settle closes instead of deleting ([#70](https://github.com/kunchenguid/firstmate-3000/issues/70)) ([7349269](https://github.com/kunchenguid/firstmate-3000/commit/73492698b228f084e35812b450d0dcfdcfcac0de))
* **tasks:** task-system P1 - capture: every captain ask lands in a task ([#71](https://github.com/kunchenguid/firstmate-3000/issues/71)) ([8a31c10](https://github.com/kunchenguid/firstmate-3000/commit/8a31c1039902e8681f033cd8aaabc48f253a35df))
* **tasks:** task-system P2 - the graph: parents, links, the ready query, and crewmate follow-ups ([#72](https://github.com/kunchenguid/firstmate-3000/issues/72)) ([81ab89f](https://github.com/kunchenguid/firstmate-3000/commit/81ab89f438397757e8f074ef9a6f27cd6c7ba886))
* **tasks:** task-system P3 - the protocol: shared task surface, fm:tasks push, three reads, two events, the feed as a view over task_events, contract 1.2.0 ([#73](https://github.com/kunchenguid/firstmate-3000/issues/73)) ([edcd567](https://github.com/kunchenguid/firstmate-3000/commit/edcd5670d34b8ada0363b7caacefbbf1ca8db127))
* **tasks:** task-system P5 - scale, polish, retention (delta push, compaction, JSONL export, session footprint, Observe over kept sessions, emotes on task_changed) ([#76](https://github.com/kunchenguid/firstmate-3000/issues/76)) ([908d11a](https://github.com/kunchenguid/firstmate-3000/commit/908d11a6826066446b6c5822ba1d6510d7ae7edb))
* **tasks:** the deliverable axis - an answer task is a first-class fact (contract v3.8) ([#224](https://github.com/kunchenguid/firstmate-3000/issues/224)) ([338338c](https://github.com/kunchenguid/firstmate-3000/commit/338338c5105a03f0a15fe0a0b3d26105d3a7c220))
* telemetry, retention purge, update indicator, presence defaults ([276168f](https://github.com/kunchenguid/firstmate-3000/commit/276168f4c794db966c17224bf7cef2492c0e00da))
* the Claude Max crewmate backend (broker phase 7) ([5af6edf](https://github.com/kunchenguid/firstmate-3000/commit/5af6edf5a550aeb18167c7ec88eb6001d523d42e))
* the Cursor crewmate backend (broker phase 8) ([ffafdc7](https://github.com/kunchenguid/firstmate-3000/commit/ffafdc7a8ae80a7b6a78c000872d9dad0621dcaf))
* the Pi-only flagship with attachment-point rebind (broker phase 6) ([437fc46](https://github.com/kunchenguid/firstmate-3000/commit/437fc4615f9af20578f9b22be506d9a3243b6dc9))
* the scoped capability build - protection, notifications, honesty, and owning time ([#4](https://github.com/kunchenguid/firstmate-3000/issues/4)) ([23795f6](https://github.com/kunchenguid/firstmate-3000/commit/23795f6b7234d1f662efcb4f759a09fd3eda03c8))
* **ui:** plugin system phase 0 - registries, manifest with capabilities, two side rails ([#65](https://github.com/kunchenguid/firstmate-3000/issues/65)) ([30b4fe3](https://github.com/kunchenguid/firstmate-3000/commit/30b4fe3d92dae7b8c4fd76fe098716bbf602e56b))
* **ui:** plugin system phase 1 - frame vehicle v2, bridge v2, read catalog v0, fonts in frames, Observe as the first Tier-2 frame ([#68](https://github.com/kunchenguid/firstmate-3000/issues/68)) ([71500d0](https://github.com/kunchenguid/firstmate-3000/commit/71500d00b548c4f5715c28bf9163021870e65ac2))
* **ui:** plugin system phase 2 - the left rail carries the feed and crew strip as Tier-2 frames; the streaming probe passes ([#69](https://github.com/kunchenguid/firstmate-3000/issues/69)) ([12e209d](https://github.com/kunchenguid/firstmate-3000/commit/12e209dce8e0130b7eed7977bbf227ff400e49ff))
* **ui:** Subscriptions tab as Instruments - one list, micro-meters, a kebab per row ([#67](https://github.com/kunchenguid/firstmate-3000/issues/67)) ([5e84217](https://github.com/kunchenguid/firstmate-3000/commit/5e8421779d29833863d131c111493c896e7280c5))
* **ui:** task-system P4 - the now panel on the right rail and the read-only task-record card ([#75](https://github.com/kunchenguid/firstmate-3000/issues/75)) ([5701f9a](https://github.com/kunchenguid/firstmate-3000/commit/5701f9a86f9fd0bc1395e0720e4db5732680197a))
* v1 orchestrator contract - orchestration-only Firstmate (dogfood, do not merge) ([#39](https://github.com/kunchenguid/firstmate-3000/issues/39)) ([da6f640](https://github.com/kunchenguid/firstmate-3000/commit/da6f64075fc4a265296935f46be6896801cf8a1b))
* workspace inference e2e with the ambiguity decision flow ([cf3858a](https://github.com/kunchenguid/firstmate-3000/commit/cf3858ae6da4710e075ddc48f604c5b7a7b3d53e))


### Bug Fixes

* a host-run settle answers the Firstmate, not only the feed ([1756aba](https://github.com/kunchenguid/firstmate-3000/commit/1756aba76a1a646daad6d544cfd53a98715482c7))
* abort a Firstmate runaway at the request, not the whole turn ([dd6faf3](https://github.com/kunchenguid/firstmate-3000/commit/dd6faf333033661ddfae24509d7be0c29242920c))
* acknowledge actions instantly and report background failures ([#85](https://github.com/kunchenguid/firstmate-3000/issues/85)) ([4b55cab](https://github.com/kunchenguid/firstmate-3000/commit/4b55cabf94497e00fb587f25082aefdf86bd1e8f))
* **activity:** keep bottom dock visible by default ([79a59c2](https://github.com/kunchenguid/firstmate-3000/commit/79a59c2550a0f1b93e1010631194ca8642534fb0))
* **activity:** replace blue overflow wash with alpha fade ([3c88eb2](https://github.com/kunchenguid/firstmate-3000/commit/3c88eb2defd2d4b4534f086f94beea634d995d95))
* admit custom providers to the Firstmate picker and stop the load-flash verdict ([486c2d1](https://github.com/kunchenguid/firstmate-3000/commit/486c2d1074a2423f890b0a153a3aca3ee89c5a69))
* bound grok-4.6 Firstmate reasoning so a provider hiccup cannot hang the orchestrator ([7b05af1](https://github.com/kunchenguid/firstmate-3000/commit/7b05af1345b6e79eea70209621a06b43e98ee38a))
* cancel an idle crewmate as dropped, not delivered ([6be04bd](https://github.com/kunchenguid/firstmate-3000/commit/6be04bdfebdf210464aed0194d3d5a51c372c85e))
* cancel an idle crewmate as dropped, not delivered ([d00bb21](https://github.com/kunchenguid/firstmate-3000/commit/d00bb21b18a4847fe2845efd4f2669dfd6b79437))
* **cards:** gate a crewmate's merge decision on green CI ([ec4b18b](https://github.com/kunchenguid/firstmate-3000/commit/ec4b18b6b4555b29b664c2b508b372a3bfceba2c))
* **cards:** gate a crewmate's merge decision on green CI ([64593e7](https://github.com/kunchenguid/firstmate-3000/commit/64593e70baddde31120c13c273779892a0d3e18a))
* **cards:** keep each card's height independent ([818491d](https://github.com/kunchenguid/firstmate-3000/commit/818491d6dcee02255a8eed7f6e29c296dfddbf15))
* **cards:** keep long footer actions in bounds ([8044066](https://github.com/kunchenguid/firstmate-3000/commit/8044066f2e9379114c1506488a8828aebfb6d788))
* **cards:** key the shown card by its own id so height stays independent ([45eb0db](https://github.com/kunchenguid/firstmate-3000/commit/45eb0db10d5de129a5dd45e6c73bad312ad66b10))
* **cards:** let note/decision card bodies grow past 280px ([09e82b0](https://github.com/kunchenguid/firstmate-3000/commit/09e82b02540bd893d84aa9148ac4a158a54838b7))
* **cards:** let note/decision card bodies grow past 280px ([fdd92ed](https://github.com/kunchenguid/firstmate-3000/commit/fdd92ed247cd98f6787e2e137784d491fc870f3f))
* **cards:** overlay body scrollbar ([229d6e2](https://github.com/kunchenguid/firstmate-3000/commit/229d6e237f292059a449d0606b88f88a8ef17ad1))
* **cards:** retire live-prototype; a decision carries the working preview ([83905a5](https://github.com/kunchenguid/firstmate-3000/commit/83905a5993442e4eda0dd657c3248fe5cac83a9a))
* **cards:** retire live-prototype; a decision carries the working preview ([879bf61](https://github.com/kunchenguid/firstmate-3000/commit/879bf614d07f7f1484bd97be60b36279001fc664))
* **cards:** scope accent focal points per figure ([#168](https://github.com/kunchenguid/firstmate-3000/issues/168)) ([48026da](https://github.com/kunchenguid/firstmate-3000/commit/48026daa1d274c91b6c355fe6f2949dfd86ddd59))
* **cards:** show task key and title on crewmate card chrome ([55d9d90](https://github.com/kunchenguid/firstmate-3000/commit/55d9d90d48408690d014785280f4a81927ff6970))
* **cards:** show task key and title on crewmate card chrome ([1e3a868](https://github.com/kunchenguid/firstmate-3000/commit/1e3a868aa9e6ad92776010a87179fb5ebf1f84ad))
* **cards:** space actions above footer border ([175e0d7](https://github.com/kunchenguid/firstmate-3000/commit/175e0d72a692e6104731a6fb580d4ad5ff904b71))
* **cards:** the crewmate fact is the dispatched model, and a fact cell never wraps (review F1-F3) ([7c7658d](https://github.com/kunchenguid/firstmate-3000/commit/7c7658d73a1580b2acb5ed3705ab2b73d4b8b55b))
* claim queued dispatch and reuse leftover task worktrees ([b6031c4](https://github.com/kunchenguid/firstmate-3000/commit/b6031c40d82975bb4a8e9e389097551c88d4b21a))
* claim queued dispatch and reuse leftover task worktrees ([ee2805b](https://github.com/kunchenguid/firstmate-3000/commit/ee2805b643425e1e39b9f22277881f989b2aca21))
* **claude:** a signed-in account whose client probe breaks is not signed out ([#44](https://github.com/kunchenguid/firstmate-3000/issues/44)) ([39e7685](https://github.com/kunchenguid/firstmate-3000/commit/39e768524cb24f2a322e2c2371bf048508871188))
* **claude:** detect external credential account swaps ([#172](https://github.com/kunchenguid/firstmate-3000/issues/172)) ([6617fae](https://github.com/kunchenguid/firstmate-3000/commit/6617fae9a08577269c6eff806bbd22d3f992272f))
* **claude:** one macOS grant carries a session, not one tick ([9e306df](https://github.com/kunchenguid/firstmate-3000/commit/9e306df977a91138972e1871904ebdb2ff5e4313))
* **claude:** one macOS grant carries a session, not one tick ([7b41573](https://github.com/kunchenguid/firstmate-3000/commit/7b41573087fb6d517f18432790a446dea5dbbdee))
* **claude:** own autonomous turn completions ([7d0a5b9](https://github.com/kunchenguid/firstmate-3000/commit/7d0a5b995622732ebd56028f283eb5327cfd3a65))
* clear bottom dock panels from window edge ([fdbd4f1](https://github.com/kunchenguid/firstmate-3000/commit/fdbd4f19918b7e92998d6ddd431f1a10f54d89be))
* close the task-deletion observation race behind the phase3 e2e flake ([#12](https://github.com/kunchenguid/firstmate-3000/issues/12)) ([733c18a](https://github.com/kunchenguid/firstmate-3000/commit/733c18a4471bafe6cad06d7424e7e9bef30dad96))
* code-review fixes for the recently merged batch (PRs 4-10) ([#14](https://github.com/kunchenguid/firstmate-3000/issues/14)) ([0a7eb93](https://github.com/kunchenguid/firstmate-3000/commit/0a7eb93b046da148aadf169f9d2c693bb3a78cac))
* **copy:** plain-language residuals in feed lines, meter details, and task titles ([#268](https://github.com/kunchenguid/firstmate-3000/issues/268)) ([153ef86](https://github.com/kunchenguid/firstmate-3000/commit/153ef86e337626a0bddd385bf64951993ad93995))
* **core:** classify served inputs by structured origin ([#171](https://github.com/kunchenguid/firstmate-3000/issues/171)) ([91e2884](https://github.com/kunchenguid/firstmate-3000/commit/91e2884025b5435b31e0b0cdd3a02ceaccb4aae4))
* correct offline evidence exports and redaction ([#169](https://github.com/kunchenguid/firstmate-3000/issues/169)) ([5298185](https://github.com/kunchenguid/firstmate-3000/commit/5298185efe3e4e4d8cf26b4855f0fea384f1ff03))
* count only live idle runtimes as idle crewmates ([#30](https://github.com/kunchenguid/firstmate-3000/issues/30)) ([d779f16](https://github.com/kunchenguid/firstmate-3000/commit/d779f163c0680fe193a30141839348ab5d5dff47))
* cover Claude SDK darwin binaries in universal x64ArchFiles ([#1](https://github.com/kunchenguid/firstmate-3000/issues/1)) ([711b7f1](https://github.com/kunchenguid/firstmate-3000/commit/711b7f17018c63cb2f73e37ee245a0009549fb3a))
* **crew:** a working crewmate glyph is ember, an idle one is cyan ([b8f2a04](https://github.com/kunchenguid/firstmate-3000/commit/b8f2a049077fa0803016dff64da984cb2aaaad05))
* **crew:** a working crewmate glyph is ember, an idle one is cyan ([453a54d](https://github.com/kunchenguid/firstmate-3000/commit/453a54d49642f03be5446737e6a113cd10b2dd5f))
* **cursor:** stop treating a status probe failure as a sign-out ([#78](https://github.com/kunchenguid/firstmate-3000/issues/78)) ([814b8e4](https://github.com/kunchenguid/firstmate-3000/commit/814b8e4d5715ccfcdc4eb430e96e531662614338))
* dedupe inbox wakes by content (WI-3) ([#101](https://github.com/kunchenguid/firstmate-3000/issues/101)) ([115d455](https://github.com/kunchenguid/firstmate-3000/commit/115d4559d9d0a7056ee676f8862f1f77b3e358db))
* **delivery:** inherit note-only asks, soften origin guard, blame the task ([4945382](https://github.com/kunchenguid/firstmate-3000/commit/49453820a48a8b30dde49b4a2e3e9e6cd0ba8b0d))
* **delivery:** use the task posture for CI, escalate, and supervision ([47ae1eb](https://github.com/kunchenguid/firstmate-3000/commit/47ae1eb91667d3ecfe4ce306181ae10e49aa0918))
* **design:** portal RowMenu so it escapes ancestor overflow clipping ([166b445](https://github.com/kunchenguid/firstmate-3000/commit/166b4451aa6f1741dfadbcb1f5e9da804bc86a43))
* **design:** RowMenu escapes ancestor overflow clipping ([22e9f02](https://github.com/kunchenguid/firstmate-3000/commit/22e9f02afc20b0c92d9b2a53c78a447de0ed9788))
* **discard:** close the crewmate's open PR on GitHub when discarding a task ([f571380](https://github.com/kunchenguid/firstmate-3000/commit/f5713803542fdcd0fa5a4126625bd81bbe59f5b6))
* **discard:** close the crewmate's open PR when a task is discarded ([21b8a61](https://github.com/kunchenguid/firstmate-3000/commit/21b8a61cf261ac1eaeba50c9ee48bb3a8f1ae9b8))
* **e2e:** bring the four standing-red specs back to the product's current flows ([#196](https://github.com/kunchenguid/firstmate-3000/issues/196)) ([732b3d1](https://github.com/kunchenguid/firstmate-3000/commit/732b3d18a0a1d6993037e21a4034fb1390d7cd79))
* **e2e:** guard unbuilt Electron launches ([52995eb](https://github.com/kunchenguid/firstmate-3000/commit/52995eb443dba9399b2b83505428647ce23a7de6))
* **e2e:** the self-source consult reads a path that carries spaces ([05ff293](https://github.com/kunchenguid/firstmate-3000/commit/05ff2938ff30bb3e5b347b7ce5e5b9af1ef533f0))
* **e2e:** the self-source consult reads a path that carries spaces ([5bc9695](https://github.com/kunchenguid/firstmate-3000/commit/5bc9695c5a6b55843c8691f4e94bf674e1fadff8))
* fable review fixes - replay window and real baselines, collapsed-card revisions, dismissals as context (items 1-9) ([#108](https://github.com/kunchenguid/firstmate-3000/issues/108)) ([aec217e](https://github.com/kunchenguid/firstmate-3000/commit/aec217e0b19d9318a007ad958e004036d0dfac03))
* finish interaction P0 - chatter as feed lines, supervision fed new information, fleet hygiene invariants (WI-5, WI-6, WI-7) ([#103](https://github.com/kunchenguid/firstmate-3000/issues/103)) ([d135733](https://github.com/kunchenguid/firstmate-3000/commit/d1357332c45197061f19ffc4644aaf90c2f2b7e7))
* first-morph glow warmup and a UI papercut polish pass ([#3](https://github.com/kunchenguid/firstmate-3000/issues/3)) ([7676ae0](https://github.com/kunchenguid/firstmate-3000/commit/7676ae04bb197068ebdfeb327e032651d94bf1a0))
* format two capWithOverflow calls per biome's line-width rule ([883bcfb](https://github.com/kunchenguid/firstmate-3000/commit/883bcfb29d9a7ef64e1149db43cbd5f38cb02086))
* home input caret blinks left, not centered, when empty ([82ac5fe](https://github.com/kunchenguid/firstmate-3000/commit/82ac5fefb862fa022349d8a3313755847cb520ab))
* **home:** de-emphasize home side panels (no border, no background) ([04caebb](https://github.com/kunchenguid/firstmate-3000/commit/04caebb3be26078235545939785b2c8d0a1a0f07))
* **home:** drop border and solid background on home side panels ([ca3a8e7](https://github.com/kunchenguid/firstmate-3000/commit/ca3a8e79fcb8221182bc69898af576e1ee3857a2))
* honor settings width and keep a stranded Firstmate pin honest ([dc126f0](https://github.com/kunchenguid/firstmate-3000/commit/dc126f053ab794fb8b7b17193d737e1d3db2e832))
* improve card dismissal instruction ([c141482](https://github.com/kunchenguid/firstmate-3000/commit/c14148258acfe49b462e0afb3877195467085779))
* keep Intelligence free of provider machinery ids ([d837149](https://github.com/kunchenguid/firstmate-3000/commit/d837149c0918f6017fc4a9ab583e7b4992b16d19))
* keep personal-panel reload and off-switch snapshots reliable under load ([0b85502](https://github.com/kunchenguid/firstmate-3000/commit/0b855027248ffe8b0da56a737aeb35c3e3b0be13))
* keep the Firstmate and input centered on the window ([709ceb8](https://github.com/kunchenguid/firstmate-3000/commit/709ceb8657d96e71ac8662155f5f37cf087f1090))
* keep the home input caret on the left when empty ([9746640](https://github.com/kunchenguid/firstmate-3000/commit/9746640414e2bb53990b1535b13aea539c01c415))
* **keychain:** let Retry unlock a locked login keychain from a fresh helper process ([#259](https://github.com/kunchenguid/firstmate-3000/issues/259)) ([2787b75](https://github.com/kunchenguid/firstmate-3000/commit/2787b757551f086b9b8430b6f7cafda766168f24))
* let taps reach the mate and keep the prompt inside the stage ([d6c32db](https://github.com/kunchenguid/firstmate-3000/commit/d6c32db2ce630e17fe529c5261f6e88618b51787))
* make card figure guidance shape-neutral ([#167](https://github.com/kunchenguid/firstmate-3000/issues/167)) ([7704aef](https://github.com/kunchenguid/firstmate-3000/commit/7704aefab7e0a3ea81319faf19b5d466b1a677a6))
* make Merge PR card buttons actually merge ([8147baf](https://github.com/kunchenguid/firstmate-3000/commit/8147baf259aaf61bc96867172aae5f27bd838cc8))
* make pasted image turns actually reach the model (PR 7 review fixes) ([#13](https://github.com/kunchenguid/firstmate-3000/issues/13)) ([c941f2e](https://github.com/kunchenguid/firstmate-3000/commit/c941f2e79e6a7964d919484efb31c20d4ab615ea))
* **models:** let any bucket take a placed model, and unstrand Copilot's Fable ([a982bbe](https://github.com/kunchenguid/firstmate-3000/commit/a982bbe749604c7f8d738309bbe4e12cd79caa2d))
* **models:** let any bucket take a placed model, and unstrand Copilot's Fable ([2b1f004](https://github.com/kunchenguid/firstmate-3000/commit/2b1f00495adf3ea44d8f2cda16c36db685909181))
* **models:** satisfy CI's biome check (format, import order) ([4f7d56c](https://github.com/kunchenguid/firstmate-3000/commit/4f7d56cb799a50d094e7dae8618c1500a1751dc3))
* **now:** cap the trailing track at 40% of the row ([8eec9e2](https://github.com/kunchenguid/firstmate-3000/commit/8eec9e2594489d07500bc1cb1e3072317964f698))
* **now:** ellipsize project name chrome and sync the design skill ([3894882](https://github.com/kunchenguid/firstmate-3000/commit/38948829a807ecb8d41ebcb94c2c3508306e70fd))
* **now:** size the project-name track with fit-content(40%) ([6f10c59](https://github.com/kunchenguid/firstmate-3000/commit/6f10c5906ddfbf261b0275e7296851bfa6bca7be))
* **now:** the row dot says the crewmate's state, in the character's colors ([18b6db4](https://github.com/kunchenguid/firstmate-3000/commit/18b6db4b56d386da6a8c7b18c8aad3ee8d4e4eb9))
* **now:** the row dot says the crewmate's state, in the character's colors ([4caf38e](https://github.com/kunchenguid/firstmate-3000/commit/4caf38e7d8c47363adf1bc12c3d603a08db846bb))
* **observe:** satisfy biome lint in the new frame test ([027d990](https://github.com/kunchenguid/firstmate-3000/commit/027d990a9f915fc7bf4fdebf0a5af9ae85d35089))
* **observe:** separate context from op rows ([04784cf](https://github.com/kunchenguid/firstmate-3000/commit/04784cf7516db1bd913885f8cf7406081ffd25fa))
* **observe:** separate context from op rows ([a7bfee7](https://github.com/kunchenguid/firstmate-3000/commit/a7bfee7ce286fc414587e2547d7e7107588b2c62))
* **observe:** stop the transcript scroller from snapping to the top ([cf080d2](https://github.com/kunchenguid/firstmate-3000/commit/cf080d2a5d9858ad57ba0b507b4863d494be40ae))
* **observe:** stop the transcript scroller from snapping to the top ([e3523bd](https://github.com/kunchenguid/firstmate-3000/commit/e3523bd42ff2b382016455a9a747fcc528eecd2e))
* **observe:** tell main and supervision apart, and never render a crewmate blank ([#64](https://github.com/kunchenguid/firstmate-3000/issues/64)) ([3e7e4b7](https://github.com/kunchenguid/firstmate-3000/commit/3e7e4b78e6229085d272b35a394527e08ad62524))
* one answer owner per question, carried onto the crew report turn ([d24b31d](https://github.com/kunchenguid/firstmate-3000/commit/d24b31d75149c0d071a365a26d6e70034e4c1741))
* one answer owner per question, carried onto the crew report turn ([b2f7deb](https://github.com/kunchenguid/firstmate-3000/commit/b2f7deb7eb7e7f8bfb2b3de6f32413554030b358))
* only an idle crewmate decommissions on the task card's Done ([4bb85d2](https://github.com/kunchenguid/firstmate-3000/commit/4bb85d2b6b176ee004970036ef3b6d7274912db4))
* **orchestrator:** hand off closed answer choices ([83fac3d](https://github.com/kunchenguid/firstmate-3000/commit/83fac3d7d4fa33719ef8c37909bc3648c08b4567))
* **pi:** make the crewmate drive direct-pr CI to green itself ([d44fc6d](https://github.com/kunchenguid/firstmate-3000/commit/d44fc6dcd7faeae566785cb67108c3d27fb873ba))
* prefix activity-feed user turns with captain: ([#33](https://github.com/kunchenguid/firstmate-3000/issues/33)) ([74e8b00](https://github.com/kunchenguid/firstmate-3000/commit/74e8b00f1b0ae58cae18b4916da74799624192be))
* preserve active card when stack updates ([3c3f292](https://github.com/kunchenguid/firstmate-3000/commit/3c3f2928b473aafcc641a1f40cf477b59e994aa3))
* preserve active card when stack updates ([edba68c](https://github.com/kunchenguid/firstmate-3000/commit/edba68c6d61cd3a2e6429e888a4425aa02d31306))
* prevent duplicate delegated answer cards ([407ad68](https://github.com/kunchenguid/firstmate-3000/commit/407ad68f14ec80747630e4918df21a1f46321895))
* prevent duplicate delegated answer cards ([75e919b](https://github.com/kunchenguid/firstmate-3000/commit/75e919b90f4029a97eea874e18e6b8b389669b88))
* prevent launch cleanup SQLite re-entry ([#222](https://github.com/kunchenguid/firstmate-3000/issues/222)) ([7ae144a](https://github.com/kunchenguid/firstmate-3000/commit/7ae144aca0bc8404480337349bf43c8f08ef523e))
* **prompt:** trim card dismissal rule under the core budget ([#156](https://github.com/kunchenguid/firstmate-3000/issues/156)) ([93ef05e](https://github.com/kunchenguid/firstmate-3000/commit/93ef05e9b2c7c5a480ea65d36df6aff1195224fe))
* queue the Firstmate's steer behind a supervision claim instead of refusing (WI-4) ([#99](https://github.com/kunchenguid/firstmate-3000/issues/99)) ([906019c](https://github.com/kunchenguid/firstmate-3000/commit/906019cdca7bfff325b9deb63fcf3de340aad70c))
* **quota:** ask Claude Keychain at sign-in and make a decline retryable ([#74](https://github.com/kunchenguid/firstmate-3000/issues/74)) ([360f8ac](https://github.com/kunchenguid/firstmate-3000/commit/360f8ac46d46e1f1444fe958175b6c746e404486))
* **quota:** classify unreadable Claude Keychain reads instead of treating them as absent ([#77](https://github.com/kunchenguid/firstmate-3000/issues/77)) ([c59570b](https://github.com/kunchenguid/firstmate-3000/commit/c59570ba0811f0c5ea34d1e2af1019fc36260186))
* **quota:** make quota reliable - the vendor's verdict drives renewal ([#57](https://github.com/kunchenguid/firstmate-3000/issues/57)) ([afe2e59](https://github.com/kunchenguid/firstmate-3000/commit/afe2e59e63ed0dcc10f52332c035a3e4ed231efa))
* **quota:** preserve Claude one-percent session headroom ([a3c1c7c](https://github.com/kunchenguid/firstmate-3000/commit/a3c1c7cb07b1a89c4510ca427478c39068e3796c))
* **quota:** read Grok's consumer meter so an xAI sign-in shows a real meter ([#66](https://github.com/kunchenguid/firstmate-3000/issues/66)) ([01eb64d](https://github.com/kunchenguid/firstmate-3000/commit/01eb64d8ab3aee68d3311f2b2e597f2ae0bc39fa))
* raise a retryable card on a refused merge/land, retry transient gh errors, repair legacy settle cards ([c4aa2c7](https://github.com/kunchenguid/firstmate-3000/commit/c4aa2c7ba4828e1f73a6f67cf9aaad089a60394e))
* raise the Firstmate per-request abort from 90s to 300s ([c77b9d0](https://github.com/kunchenguid/firstmate-3000/commit/c77b9d03d66c5ef7978457c4e5350479e3cfe8de))
* recognize remotely landed task commits ([7d835cb](https://github.com/kunchenguid/firstmate-3000/commit/7d835cbbaab5079afa79532361d1fca975ac871c))
* recognize remotely landed task commits ([650f299](https://github.com/kunchenguid/firstmate-3000/commit/650f299fcd270589b5cae0ccb6aaa7220f3be081))
* Refine card contract descriptions for clarity ([a793a25](https://github.com/kunchenguid/firstmate-3000/commit/a793a25906cffce79a460844ae6ea50b24b29513))
* replace the Firstmate exact-done close with a brief non-empty response ([4be9c87](https://github.com/kunchenguid/firstmate-3000/commit/4be9c87f419773690075f7aa62dc0f1a51da5f4d))
* report only real crew reports and purge a closed task's wakes ([#98](https://github.com/kunchenguid/firstmate-3000/issues/98)) ([f1f4443](https://github.com/kunchenguid/firstmate-3000/commit/f1f44434cf6e1ec777d5b635b8e350e75e2f3037))
* retryable card on refused merge/land, transient-gh retry, legacy card cleanup ([c9dff23](https://github.com/kunchenguid/firstmate-3000/commit/c9dff239a8baab60a50df80fea6bf7570d91fe5e))
* run electron's own installer from postinstall ([b635caa](https://github.com/kunchenguid/firstmate-3000/commit/b635caaac2db27423332b6ea9b6db0e903279c13))
* scroll overflowing card bodies ([01b9faa](https://github.com/kunchenguid/firstmate-3000/commit/01b9faabac175595b219ab2cbcaf9ebb78ece89b))
* scroll overflowing card bodies ([0db984e](https://github.com/kunchenguid/firstmate-3000/commit/0db984eaa03397430093b21383ed60aaabd7be65))
* **settings:** align Intelligence bucket taglines with routing ([c243038](https://github.com/kunchenguid/firstmate-3000/commit/c2430388ab6a5efcb0ad6d428912f1ed0b70f2be))
* **settings:** align Intelligence bucket taglines with routing ([d34743b](https://github.com/kunchenguid/firstmate-3000/commit/d34743bb21be788e39e63214d93d68c1190e6740))
* **settings:** captain-attributed policy writes and live autonomy lock ([ad0f90b](https://github.com/kunchenguid/firstmate-3000/commit/ad0f90b4b53dfd8a4aec4107f52eaed3f2541e33))
* **settings:** captain-facing Intelligence bucket taglines ([080d0be](https://github.com/kunchenguid/firstmate-3000/commit/080d0bee3486ee320689073a4f0cedab5bb731ce))
* **settings:** debounce policy writes through drainPendingPolicy ([2b696d2](https://github.com/kunchenguid/firstmate-3000/commit/2b696d279e0a1f8fb61d3360b0b25710a2ee77e5))
* **settings:** flush pending policy on unmount; one repo_configured builder ([944fee6](https://github.com/kunchenguid/firstmate-3000/commit/944fee6f11f3fb540f72e2407481a581d38cba86))
* **settings:** give Intelligence slot hints their own row ([8401332](https://github.com/kunchenguid/firstmate-3000/commit/840133253a343fc5a8c91111224b16eea08c69ed))
* **settings:** review follow-ups for project policy accordion ([ce9c000](https://github.com/kunchenguid/firstmate-3000/commit/ce9c000e449cc8936699bca0f81218d84251f810))
* **settings:** swallow configure rejection on unmount flush ([9f0be12](https://github.com/kunchenguid/firstmate-3000/commit/9f0be12e6e514ecac61ace11f82df023006b91d4))
* **settings:** tighten empty-slot caption stack ([b6cea0e](https://github.com/kunchenguid/firstmate-3000/commit/b6cea0e5c7e8a98db5bbb6e6142e0b66f3ba2632))
* **settle:** queue merge intent through active turns ([3d62153](https://github.com/kunchenguid/firstmate-3000/commit/3d621539540b5d6173cba27f0f6d48a17a846be3))
* **sharing:** show no terms while unpublished; alpha feedback to Discord ([#267](https://github.com/kunchenguid/firstmate-3000/issues/267)) ([d762a2a](https://github.com/kunchenguid/firstmate-3000/commit/d762a2aeeebb518f4025cc7ae2cb14ccdc05fb53))
* **shell:** align main activity line ([ae5053c](https://github.com/kunchenguid/firstmate-3000/commit/ae5053cd1913775b005ca55d6d21536b5c551596))
* **shell:** review round one on the whisper - first-line fade, inert exit frame, reveal on click ([f8b9dab](https://github.com/kunchenguid/firstmate-3000/commit/f8b9dab052337a546b5df5d5cef99c0c5dc76450))
* **shell:** the whisper's accessible name is the affordance, not the line ([c2a6fbd](https://github.com/kunchenguid/firstmate-3000/commit/c2a6fbd8b79aa06a056ba65fcd47f4a2e60ef578))
* stop Codex Connect hanging on Connecting... ([#20](https://github.com/kunchenguid/firstmate-3000/issues/20)) ([28508b4](https://github.com/kunchenguid/firstmate-3000/commit/28508b4ae3d7f1c57e1d212a1bc396d3a646184d))
* stop duplicate PR settlement cards ([#90](https://github.com/kunchenguid/firstmate-3000/issues/90)) ([4cac1b6](https://github.com/kunchenguid/firstmate-3000/commit/4cac1b61e05328483a708c3fa1fc7b2060ee889a))
* stop labelling successful idle teardown as cancelled ([#21](https://github.com/kunchenguid/firstmate-3000/issues/21)) ([074df4c](https://github.com/kunchenguid/firstmate-3000/commit/074df4ce48a515fa7f72f51625baba65c8a07a77))
* stop scraping Firstmate final text into the activity feed ([#25](https://github.com/kunchenguid/firstmate-3000/issues/25)) ([01b37ca](https://github.com/kunchenguid/firstmate-3000/commit/01b37ca7573f17430d564c9603bc649c437fdcc6))
* stop truncating crewmate reports and other fm-op excerpts ([24405ef](https://github.com/kunchenguid/firstmate-3000/commit/24405efb9d918234bb1abd802548262540d74b4c))
* surface failed turns and classify auth from real signal ([#35](https://github.com/kunchenguid/firstmate-3000/issues/35)) ([5501880](https://github.com/kunchenguid/firstmate-3000/commit/55018805405083fa53ac086c9104b75b59446855))
* **tasks:** follow-ups are not child tasks, so requested work can land ([02c91d1](https://github.com/kunchenguid/firstmate-3000/commit/02c91d17c1f2e1684301dcad3a4fd01c825c7374))
* **tasks:** follow-ups are not child tasks, so requested work can land ([2588eba](https://github.com/kunchenguid/firstmate-3000/commit/2588ebada3495ae1d8ecdf67c4dde35d2bd45540))
* **tasks:** shrink dock after group collapse ([ccd625f](https://github.com/kunchenguid/firstmate-3000/commit/ccd625f908fe132c10703b34d17ae50b3c05c3ba))
* **tests:** locate fixtures with fileURLToPath, not URL.pathname ([ebf78a3](https://github.com/kunchenguid/firstmate-3000/commit/ebf78a31ebe58cc8807e235fd110d9551fd0d982))
* **tests:** locate replay and export fixtures with fileURLToPath ([d8fef98](https://github.com/kunchenguid/firstmate-3000/commit/d8fef984e915d45fd9f7c15ccf85cc9e22c4374c))
* **ui:** remove the Firstmate 3000 wordmark from the window title bar ([5219977](https://github.com/kunchenguid/firstmate-3000/commit/5219977a74d4d7d2aef5d04baee319a0e48499e6))
* **ui:** stabilize image attachment tray ([9dc74e7](https://github.com/kunchenguid/firstmate-3000/commit/9dc74e7e02097df5083d480e08c1406195f8548a))
* **ui:** stabilize image attachment tray ([b683ee2](https://github.com/kunchenguid/firstmate-3000/commit/b683ee22a5b7d62151063ae5131c563241c998fc))
* unify Settings tab width and Intelligence model controls ([a37ce6d](https://github.com/kunchenguid/firstmate-3000/commit/a37ce6d213bdb36e3baa10db06db46f292dfb4c4))
* widen side rails on large windows ([a675e83](https://github.com/kunchenguid/firstmate-3000/commit/a675e8334b8d3c5e59654d49419df62299ddf809))
* widen subscriptions settings ([63473e0](https://github.com/kunchenguid/firstmate-3000/commit/63473e060207b15f71fb04e6273614b34fa720e8))
* widen subscriptions settings ([0344fef](https://github.com/kunchenguid/firstmate-3000/commit/0344fefec85b40ac6b7e9542109aa2b2af6fc0fa))
* wrap overflowing card action buttons ([#32](https://github.com/kunchenguid/firstmate-3000/issues/32)) ([4a37808](https://github.com/kunchenguid/firstmate-3000/commit/4a3780899628db838aab88184e6b914f6ffbbb3e))


### Performance Improvements

* composite the Firstmate's glow into one blur pass, and scale it with dpr ([fa24aa8](https://github.com/kunchenguid/firstmate-3000/commit/fa24aa8722f7b69cae715a5356ae07df3e46b928))
* keep the character smooth through crewmate spawn and dispose ([#266](https://github.com/kunchenguid/firstmate-3000/issues/266)) ([ee98164](https://github.com/kunchenguid/firstmate-3000/commit/ee98164067c3aaeee13302eebd82984e9ff97f26))
