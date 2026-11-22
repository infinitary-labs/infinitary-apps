---
source: e1f49458875e9674
title: Abonnements et allocation
description: Comment ajouter vos abonnements d’IA, voir ce qui reste de l’allocation de votre forfait, et ce que fait votre équipage quand elle est épuisée.
---

Votre second et votre équipage travaillent avec les abonnements d’IA que vous avez déjà.
Vous les gérez dans les Réglages, sous **Intelligence**, dans la liste **Abonnements d’IA**.

## Ajouter un abonnement {#add-a-subscription}

1. Ouvrez les Réglages et choisissez **Intelligence**.
2. Au bas de **Abonnements d’IA**, sous **Ajouter un compte**, choisissez votre fournisseur : Codex, Grok, Claude, Kimi Code, Copilot, OpenRouter ou Amazon Bedrock.
3. Connectez-vous de la façon que demande le fournisseur.
   Certains ouvrent votre navigateur, d’autres affichent un code à saisir sur leur site, et d’autres demandent une clé que vous collez.
4. Une fois la connexion terminée, le nouveau compte apparaît dans la liste.

Vous pouvez ajouter plusieurs comptes du même fournisseur.
Son bouton indique alors par exemple **Ajouter un autre compte Codex**.

## Nommer vos comptes {#name-your-accounts}

Chaque compte a un libellé, pour distinguer un compte personnel d’un compte professionnel.
Quand la connexion ne nomme pas le compte, un champ s’ouvre pour que vous en tapiez un.
Pour le changer plus tard, ouvrez le menu du compte et choisissez **Renommer**.

Un compte Claude est différent.
Il suit la connexion de Claude Code sur votre ordinateur, donc sa ligne affiche la personne qui y est connectée en ce moment.
Il n’a pas de **Renommer**, et si vous changez la connexion de Claude Code, la ligne suit.

## Lire l’allocation de votre forfait {#read-your-plans-allowance}

<img class="picture-dark" src="/pictures/subscriptions-dark.webp" alt="Deux comptes dans Abonnements d’IA, Codex et Claude, chacun avec une jauge de session et une jauge hebdomadaire, et les boutons Ajouter un compte en dessous." width="1064" height="532" />
<img class="picture-light" src="/pictures/subscriptions-light.webp" alt="Deux comptes dans Abonnements d’IA, Codex et Claude, chacun avec une jauge de session et une jauge hebdomadaire, et les boutons Ajouter un compte en dessous." width="1064" height="532" />

Chaque compte affiche une petite jauge pour chaque allocation de son fournisseur, comme une session et une semaine.
Le nombre indique ce qui reste.
Laissez le pointeur sur une jauge pour voir quand elle se réinitialise.

- La barre devient orange quand vous êtes en avance sur l’horloge : vous dépensez plus vite qu’un rythme régulier qui durerait jusqu’à la réinitialisation.
- Le nombre devient orange sous la moitié, et rouge sous un cinquième.
- À côté des jauges, un mot résume le compte : **dans le rythme**, **épuisée dans** suivi d’une durée, ou **épuisée**.
- **il y a 3 h** signifie que la dernière lecture est ancienne, donc ses nombres sont estompés.
- Un tiret signifie que cette allocation n’a pas été lue.

**Actualiser**, en haut de la liste, relit chaque allocation.
Infinitary ne lit pas d’allocation pour OpenRouter ni pour une API personnalisée, et la ligne le dit.
Amazon Bedrock est facturé à l’usage sur votre compte AWS ; sa ligne affiche l’estimation de ce mois-ci d’après le travail qu’Infinitary a enregistré.

## Choisir quel compte fait quoi {#choose-which-account-does-what}

Ouvrez le menu d’un compte, les trois points sur sa ligne, pour ces choix.
Ses réglages viennent en premier, chacun avec un interrupteur qui montre s’il est activé ; en choisir un l’active ou le désactive, et le menu reste ouvert.

- **Privilégier pour le travail de l’équipage** fait utiliser ce compte en premier par votre équipage.
  Un ✱ le signale.
- **En pause** arrête tout travail sur ce compte tant que son interrupteur est activé.
- **Déconnecter** retire le compte d’Infinitary.

Quand vous avez au moins deux comptes du fournisseur qu’utilise votre second, les Réglages vous laissent choisir celui sur lequel votre second répond.
Une étiquette **second** signale ce compte.

## Quand une allocation est épuisée {#when-an-allowance-runs-out}

Votre équipage continue de lui-même.
Le nouveau travail va à un modèle qui a encore de l’allocation.
S’il n’en reste plus à ce niveau, le travail de l’équipage passe à un modèle moins puissant ou attend que l’allocation se réinitialise.

Quand le compte de votre second est lui-même épuisé, il passe d’abord à un autre compte du même fournisseur qui en a encore.
S’il n’y en a aucun, une carte indique **Votre second a épuisé son allocation**.
Vos mots attendent, et rien n’est perdu.
Sur la carte, vous pouvez choisir **Revérifier l’allocation**, faire passer votre second à un autre fournisseur, ou **Ouvrir les Réglages**.
Si la revérification ne trouve aucun changement, la carte propose aussi de réessayer votre fournisseur, par exemple **Try Claude again**, pour le cas où votre second l’atteint avec une autre connexion ; si l’allocation est toujours épuisée, il se met de nouveau en pause.

Certains fournisseurs peuvent continuer à répondre avec des crédits que vous avez configurés chez eux.
Pour un compte Claude ou Codex, le menu propose **Continuer avec les crédits**.
Votre équipage ne dépense alors des crédits qu’après toutes les allocations incluses.
Infinitary n’achète jamais de crédits et ne fixe pas leur limite ; c’est le site du fournisseur qui le fait.

## Se reconnecter {#sign-in-again}

Une connexion peut expirer.
Dans ce cas, la ligne du compte indique **à reconnecter** et affiche un bouton **Se connecter**.
Choisissez-le et connectez-vous comme la première fois.
Cela renouvelle le même compte, en gardant son libellé et ses choix.

## API personnalisée {#custom-api}

Si votre organisation fait tourner son propre serveur d’IA, choisissez **API personnalisée** sous **Ajouter un compte**.
Donnez-lui un nom, l’adresse du serveur, une clé si elle en demande une, et les modèles à utiliser.
**Enregistrer** vérifie chaque modèle avant que votre équipage puisse l’utiliser.
Vous choisissez ensuite sur le tableau **Modèles** si votre équipage utilise ces modèles.

## Utilisation {#usage}

Réglages → **Utilisation** montre ce qu’ont utilisé votre second et votre équipage, dans tous les projets.
Affichez-la en **Jetons** ou en **$ estimés**, pour une **Période** et pour le type de **Travail**.
Les dollars estimés donnent une idée de la valeur, ce n’est pas une facture.
**Tâches récentes** liste ce qu’a utilisé chaque tâche.

Sous **Intelligence**, **Demander avant qu’une tâche dépense plus de** fixe un montant.
Une tâche qui le dépasse s’arrête à un point sûr et vous demande sur une carte avant de dépenser davantage.
