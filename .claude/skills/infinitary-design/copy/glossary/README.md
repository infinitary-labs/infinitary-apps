# Glossaries

Each language the app speaks has one glossary here, named by its catalog tag (`zh-Hans.md`, `ar.md`), beside the messages it governs in the app's `src/shared/i18n/messages/<tag>.json`.
A glossary opens with its register: who the reader is, how the app addresses them and the language's typography.
Its Terms table gives one word for each term of the Vocabulary (`../Vocabulary.prompt.md`), so a thing keeps one name in every message of that language.

## Using a glossary

Whoever changes an English message translates it into every language in the same change, following each language's glossary (the app's `docs/i18n.md`, "Translating").
A term the table lacks is added to it in that change, with the word chosen and why.
A word the table names changes in every message of that language at once, never in one message alone.

## Adding a language

A new language adds its glossary here, its messages to the catalog and its folder to the macOS language list (the app's `docs/i18n.md`, "Adding a language").
