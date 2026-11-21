---
source: 48dd73d5a1c0ec46
title: Intégrations
description: Connectez GitHub, GitLab, Bitbucket, Google et des serveurs MCP pour que votre second et votre équipage puissent les joindre, et choisissez ce que chacun peut faire sans vous demander.
---

Une intégration est une connexion à quelque chose en dehors de vos projets, comme GitHub, Gmail ou un service à vous.
Chacune est établie à votre nom.
Votre second, votre équipage, vos automatisations et vos panneaux la joignent de la même façon, avec la même connexion et les mêmes règles.

<img class="picture-dark" src="/pictures/integrations-dark.webp" alt="Réglages, section Intégrations : un serveur Notes connecté dont chaque lecture et la modification sont réglées sur Vous demande à côté d’un interrupteur activé, puis des boutons pour ajouter GitHub, Google, un serveur MCP, GitLab ou GitHub Enterprise, la commande Infinitary désactivée et une liste Sites privés vide." width="1180" height="709" />
<img class="picture-light" src="/pictures/integrations-light.webp" alt="Réglages, section Intégrations : un serveur Notes connecté dont chaque lecture et la modification sont réglées sur Vous demande à côté d’un interrupteur activé, puis des boutons pour ajouter GitHub, Google, un serveur MCP, GitLab ou GitHub Enterprise, la commande Infinitary désactivée et une liste Sites privés vide." width="1180" height="709" />

## Où se trouvent les intégrations {#where-integrations-live}

Ouvrez **Réglages**, puis **Intégrations**.
Vous pouvez aussi chercher **Ouvrir Intégrations** dans la recherche de commandes.

Chaque ligne est une connexion.
Elle affiche le nom de la connexion, le compte auquel elle est connectée ou ce qu’elle exécute, et combien de ses actions sont activées.
Ouvrez une ligne pour voir ses actions, et ce qu’elle peut signaler à vos automatisations.

Le menu au bout d’une ligne propose :

- **Vérifier maintenant**, qui vérifie que la connexion fonctionne toujours.
- **Mettre en pause** : personne n’y accède tant que vous ne la reprenez pas avec **Reprendre**.
- **Se déconnecter et retirer**, ou **Retirer** pour un serveur MCP.

Les boutons sous la liste connectent quelque chose de nouveau, comme **GitHub**, **Google** ou **Serveur MCP**.
Vous pouvez aussi demander à votre second de connecter quelque chose.
Une connexion reste toujours à faire par vous, donc votre second vous apporte une carte qui ouvre cet onglet.

## GitHub, GitLab, GitHub Enterprise et Bitbucket {#github-gitlab-github-enterprise-and-bitbucket}

Votre connexion à l’endroit où vos projets sont hébergés est gardée ici.
Voir [Projets](/fr/projects/#your-github-gitlab-or-bitbucket-sign-in) pour savoir comment Infinitary l’utilise pour cloner un projet et proposer ses changements.

- **GitHub** : vous saisissez un code sur la page de GitHub dans votre navigateur.
  Si GitHub CLI est installé sur cet ordinateur et que votre organisation bloque les apps comme Infinitary, **Utiliser GitHub CLI** utilise la connexion que GitHub CLI détient déjà.
- **GitLab** : vous vous connectez dans votre navigateur ou collez une clé, sur gitlab.com ou sur votre propre serveur GitLab.
- **GitHub Enterprise** : vous créez une clé sur votre propre serveur et la collez ici.
- **Bitbucket** : vous créez un jeton d’API sur votre compte Atlassian et le collez ici, pour bitbucket.org.

Chaque ligne a deux actions : l’une qui lit, et l’autre qui modifie quelque chose, comme **Modifier quelque chose sur GitHub**.
Ce sont elles que votre second et votre équipage utilisent pour chercher des informations ou agir là-bas au-delà du travail propre à une tâche.
La branche d’une tâche, sa demande de tirage, ses vérifications et sa fusion suivent plutôt les réglages de votre projet.

Si un autre ordinateur exécute du travail pour vous, sa propre connexion GitHub, pour cloner et pousser là-bas, a aussi une ligne ici.
Voir [Vos autres ordinateurs](/fr/your-other-computers/).

Se déconnecter de GitHub arrête les clonages privés et les demandes de tirage jusqu’à ce que vous vous reconnectiez.

## Google : Gmail et Agenda {#google-gmail-and-calendar}

Google est une seule connexion pour Gmail et Agenda.

1. Appuyez sur **Google**.
2. Lisez **Avant de connecter Google** : ce qu’Infinitary utilise de votre compte, où cela va et combien de temps cela reste.
3. Appuyez sur **Accepter et continuer vers Google**, ou sur **Annuler** pour ne rien demander à Google.
4. Terminez la connexion sur la page de Google dans votre navigateur, et accordez chaque autorisation qu’elle liste.

Si vous laissez une autorisation décochée, Infinitary ne garde rien et vous pouvez vous reconnecter.
Chaque fois que vous vous connectez à Google, l’avis s’affiche d’abord.

Une fois Google connecté, votre second et votre équipage peuvent chercher dans votre courrier et le lire, enregistrer une pièce jointe dans le dossier d’une tâche, étiqueter ou archiver un message, rédiger un brouillon et envoyer un message.
Dans Agenda, ils peuvent lister vos agendas et vos événements, lire un événement, voir quand vous êtes occupé, et créer ou mettre à jour un événement.
Aucune action ne supprime un événement d’agenda.

Ce que lisent votre second et votre équipage reste 30 jours dans leurs conversations enregistrées.
Une note prend ensuite sa place.
Pour l’effacer plus tôt, appuyez sur **Supprimer** sur la ligne **Supprimer le contenu Gmail et Agenda** sous **Données**, au pied de l’onglet.
Une pièce jointe enregistrée reste dans le dossier de sa tâche jusqu’à la fermeture de la tâche ou pendant 30 jours.
Les mots qu’un équipier a lus dans une pièce jointe enregistrée restent dans sa conversation après les 30 jours.
Ce que votre second et votre équipage ont écrit eux-mêmes, dans des cartes, des notes et des fichiers, reste jusqu’à ce que vous supprimiez la tâche.
Retirer Google ne supprime rien de ce qu’ils ont déjà lu.

N’importe qui peut vous envoyer des mots écrits pour orienter une IA.
Infinitary remet votre courrier et vos événements à votre second et à votre équipage marqués comme des informations venues de l’extérieur, jamais comme des instructions.
Un message peut tout de même induire un modèle d’IA en erreur.
Un équipier peut accéder à internet sans vous demander, donc un équipier induit en erreur pourrait envoyer ailleurs ce qu’il a lu.

## Serveurs MCP {#mcp-servers}

Un serveur MCP est un programme ou une adresse web qui propose des actions aux apps d’IA.

1. Appuyez sur **Serveur MCP**.
2. Donnez-lui un **Nom**.
3. Sous **Exécute**, saisissez un programme et ses arguments, ou l’adresse https du serveur.
4. Appuyez sur **Connecter**.

Un programme démarre sur cet ordinateur quand quelqu’un l’utilise.
Infinitary se connecte aussitôt et ouvre la nouvelle ligne sur la liste des actions propre au serveur.
S’il ne peut pas se connecter, le formulaire dit pourquoi.

Si le serveur a besoin d’une clé, placez-la vous-même au début de la ligne **Exécute**, comme `EXAMPLE_KEY=your-key npx -y @example/mcp-server`.
Infinitary déplace la clé dans [Secrets](/fr/secrets/), et la ligne n’en garde qu’une référence.
Le serveur reçoit la clé à chaque démarrage, sans vous demander.
Votre second et votre équipage ne la voient jamais.
Retirer le serveur oublie ses clés.

## Ce que chaque action peut faire sans vous demander {#what-each-action-may-do-without-asking-you}

Une ligne ouverte liste chaque action avec ce qu’elle fait : **lit**, **modifie** ou **envoie**.
Chaque action commence sur **Vous demande**, y compris les lectures.
Appuyez sur sa règle pour passer de **Vous demande** à **Toujours autorisée**, et inversement.
Vous seul pouvez changer une règle.
L’interrupteur à côté d’une action la désactive, et plus personne ne peut alors l’exécuter.

Quand votre second ou un équipier utilise une action qui vous demande, Infinitary affiche sa propre carte d’approbation.
La carte montre exactement ce qui s’exécuterait, et la raison qui a été donnée.

- **Toujours autoriser** l’exécute, et cette action s’exécute ensuite sans demander jusqu’à ce que vous la changiez dans les Réglages, que vous remplaciez la connexion ou que l’action change.
- **Autoriser pour le reste de cette tâche**, sur une demande d’équipier, l’exécute et laisse cet équipier exécuter la même action au même endroit sans demander jusqu’à la fermeture de sa tâche.
  La carte précise quel est cet endroit, comme un dépôt sur GitHub ou les destinataires d’un message.
- **Seulement cette fois** l’exécute une fois.
- **Pas maintenant** n’exécute rien.

Quand un équipier demande plusieurs fois sur une même connexion, les demandes partagent une seule carte, une ligne chacune avec une case **Autoriser** cochée.
Décochez une ligne, et elle ne s’exécute jamais.
Mettre la carte de côté laisse ses demandes en attente.

Si Infinitary ne peut pas savoir si une modification est arrivée, il ne l’envoie jamais une seconde fois.
Ce que répond une intégration est une information pour votre second et votre équipage, jamais une instruction.

Un panneau peut aussi utiliser les intégrations qu’il nomme.
Ses demandes affichent la même carte, qui nomme le panneau.
Voir [Panneaux](/fr/panels/).

## Ce qu’une intégration peut signaler {#what-an-integration-can-tell}

Certaines connexions signalent quand quelque chose se produit, et une automatisation peut l’attendre.
Une ligne ouverte les liste avec la mention **signale**.

- GitHub : **Une exécution de workflow échoue** et **Une exécution de workflow se termine**, dans un dépôt que vous nommez.
- Gmail : **Un message arrive**.
- Agenda : **Un événement d’agenda change**.
- Un serveur MCP qui le propose : **Une ressource a changé**.

Choisissez-en un sous **Quand quelque chose se produit** dans Automatisation.
Voir [Automatisation](/fr/automation/#when-it-runs).

## La commande Infinitary {#the-infinitary-command}

Le cadre **Commande Infinitary** est destiné aux programmes que vous exécutez sur cet ordinateur, et à vos propres agents d’IA.
Avec une seule commande, ils peuvent lire vos cartes et vos tâches et agir dessus, et parler à votre second en votre nom.
Un équipier ne la reçoit jamais.

Elle est désactivée jusqu’à ce que vous l’activiez.
Une fois activée, le cadre affiche la ligne à exécuter, avec **Copier**, et **La lier** propose un nom plus court quand c’est possible.
La première fois que vous l’activez, elle active aussi une automatisation, **Événements de la boîte de réception Infinitary**, pour que votre second soit prévenu de chaque note qu’envoie un programme.
Une note est une information, jamais une instruction.

Désactivez-la, et la commande répond par un refus tandis que les notes enregistrées restent.
**Supprimer les notes de la boîte de réception Infinitary**, sous **Données**, supprime les notes et la désactive.

## Sites privés {#private-sites}

Le cadre **Sites privés** liste les sites du réseau de votre bureau, de votre domicile ou de votre VPN que les navigateurs des tâches peuvent ouvrir.
La liste s’applique sur tous vos ordinateurs.
Appuyez sur **Site** pour en ajouter un, ou sur **Retirer** pour en enlever un.
Votre second n’ajoute jamais un site lui-même : il vous le demande sur une carte, et seul votre **Autoriser** l’ajoute.
Voir [Le navigateur de l’équipage](/fr/the-crews-browser/#private-sites).

## Pour la suite {#next}

- [Secrets](/fr/secrets/)
- [Automatisation](/fr/automation/)
