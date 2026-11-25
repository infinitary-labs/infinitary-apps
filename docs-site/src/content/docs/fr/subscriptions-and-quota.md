---
source: b09b575fa5a6a2c1
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

<img class="picture-dark" src="/pictures/subscriptions-dark.webp" alt="Réglages, section Intelligence : deux comptes dans Abonnements d’IA, Codex et Claude, chacun avec une jauge de session et une jauge hebdomadaire, et une réinitialisation enregistrée sur le compte Codex, puis les boutons Ajouter un compte, la ligne Fichier de connexions et Modèle du second." width="1048" height="524" />
<img class="picture-light" src="/pictures/subscriptions-light.webp" alt="Réglages, section Intelligence : deux comptes dans Abonnements d’IA, Codex et Claude, chacun avec une jauge de session et une jauge hebdomadaire, et une réinitialisation enregistrée sur le compte Codex, puis les boutons Ajouter un compte, la ligne Fichier de connexions et Modèle du second." width="1048" height="524" />

Chaque compte affiche une petite jauge pour chaque allocation de son fournisseur, comme une session et une semaine.
Le nombre indique ce qui reste.
Laissez le pointeur sur une jauge pour voir quand elle se réinitialise.

- La barre devient orange quand vous êtes en avance sur l’horloge : vous dépensez plus vite qu’un rythme régulier qui durerait jusqu’à la réinitialisation.
- Le nombre devient orange sous la moitié, et rouge sous un cinquième.
- À côté des jauges, un mot résume le compte : **dans le rythme**, **épuisée dans** suivi d’une durée, ou **épuisée**.
- **il y a 3 h** signifie que la dernière lecture est ancienne, donc ses nombres sont estompés.
- Un tiret signifie que cette allocation n’a pas été lue.
- Un compte Codex qui détient des [réinitialisations enregistrées](#saved-codex-resets) en indique le nombre sous ses jauges.

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

### Réinitialisations enregistrées de Codex {#saved-codex-resets}

ChatGPT peut donner à un compte Codex des réinitialisations enregistrées.
Chacune renouvelle une allocation avant qu’elle ne se réinitialise d’elle-même.
La ligne du compte indique combien il en détient et où en utiliser une, comme « 1 réinitialisation enregistrée · à utiliser sur chatgpt.com ».

Tant que l’une d’elles peut être utilisée maintenant, le menu du compte propose **Utiliser une réinitialisation enregistrée**.
La carte qui indique qu’une allocation est épuisée le dit aussi, avec le même bouton et un lien vers la page d’utilisation sur chatgpt.com.
Infinitary fait alors utiliser par Codex, sur votre ordinateur, la réinitialisation qui expire en premier.
Il faut pour cela Codex 0.143 ou plus récent, et la première fois, Codex vous demande de vous connecter à ce compte ChatGPT.
Une réinitialisation utilisée ne peut pas être rendue.
Activité indique ce qui s’est passé, et combien il en reste.

Infinitary peut aussi les utiliser sans que vous cliquiez.
Activez **Utiliser les réinitialisations enregistrées d’office** dans le menu du compte, ou sur cette carte ; ce réglage est désactivé jusqu’à ce que vous l’activiez.
Infinitary en utilise alors une seulement quand du travail attend et qu’aucun compte n’a d’allocation, et seulement si attendre le renouvellement de l’allocation prendrait longtemps.
Les comptes qui ont encore de l’allocation passent toujours en premier.
Activité le signale chaque fois qu’il en utilise une.

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

### Connexions depuis un fichier {#connections-from-a-file}

Si vous gardez déjà vos connexions dans un fichier au format `models.json` de Pi, Infinitary peut les lire depuis ce fichier.
Sur la ligne **Fichier de connexions** sous **Abonnements d’IA**, appuyez sur **Choisir un fichier** et sélectionnez le fichier.
Infinitary ne fait que lire le fichier : il ne le modifie jamais, et il n’utilise jamais une clé qui y est écrite.

Chaque connexion que définit le fichier apparaît avec les mentions **Depuis votre fichier** et **Pas encore approuvée**.
Appuyez sur **Approuver**, saisissez la clé propre à cet ordinateur et toute taille de modèle que le fichier omet, puis appuyez sur **Enregistrer**, qui vérifie chaque modèle.

Infinitary suit ensuite le fichier.
Un nouveau nom ou un nouveau prix s’applique aussitôt, et un changement de limite fait revérifier ce modèle.
Un changement d’adresse, de protocole ou d’en-tête met la connexion en pause jusqu’à ce que vous appuyiez sur **Approuver à nouveau**.
Une connexion qui disparaît du fichier est mise en pause, jamais supprimée.
**Arrêter la lecture** cesse de suivre le fichier, et les connexions que vous avez approuvées restent.

### Sur vos autres ordinateurs {#on-your-other-computers}

Quand un autre ordinateur exécute du travail pour vous, la ligne d’une connexion personnalisée propose **Utiliser**, qui nomme cet ordinateur.
Vous saisissez la clé propre à cet autre ordinateur, et il vérifie chaque modèle et garde lui-même la clé ; cet ordinateur-ci n’en garde aucune copie.
Les changements apportés ensuite à la connexion la suivent là-bas.
Voir [Vos autres ordinateurs](/fr/your-other-computers/).

## Utilisation {#usage}

Réglages → **Utilisation** montre ce qu’ont utilisé votre second et votre équipage, dans tous les projets.
Elle s’ouvre en **$ estimés** ; sous **Afficher l’utilisation en**, vous pouvez passer à **Jetons**.
Choisissez une **Période** et le type de **Travail** à compter.
Les dollars estimés donnent une idée de la valeur, ce n’est pas une facture.

**Coût par tâche** montre sur un graphique ce que coûte une tâche terminée, revues comprises.
Chaque point est la médiane des tâches terminées dans les sept jours qui le précèdent, et la bande contient leur moitié centrale.
Une ligne qui monte signifie que les tâches demandent plus de travail qu’avant.
**Projets** et **Types** le restreignent au travail que vous voulez comparer.

**Tâches récentes** liste ce qu’a utilisé chaque tâche.

Sous **Intelligence**, **Demander avant qu’une tâche dépense plus de** fixe un montant.
Une tâche qui le dépasse s’arrête à un point sûr et vous demande sur une carte avant de dépenser davantage.
