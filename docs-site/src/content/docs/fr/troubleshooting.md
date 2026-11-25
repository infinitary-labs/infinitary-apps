---
source: b49e11a26445efba
title: Dépannage
description: Les problèmes courants dans Infinitary, les mots que l’app affiche pour chacun et ce qu’il faut faire.
---

Chaque problème ci-dessous commence par les mots qu’Infinitary vous affiche.

## Un abonnement vous demande de vous reconnecter {#a-subscription-needs-you-to-sign-in-again}

Vous pouvez voir une carte intitulée « Votre second a besoin que vous vous reconnectiez », ou un abonnement dans Réglages → **Intelligence** qui indique « se reconnecter ».
Le travail sur cet abonnement attend : « Le travail est en pause jusqu’à ce que vous vous reconnectiez. »

1. Appuyez sur **Se connecter** sur la carte, ou ouvrez Réglages → **Intelligence**.
2. Connectez-vous à cet abonnement de la façon que demande votre fournisseur.
3. Le travail en attente reprend de lui-même.

Une tâche qui s’exécute sur un autre ordinateur utilise la connexion propre à cet ordinateur ; reconnectez-vous donc pour cet ordinateur, sous son nom.

## L’allocation de votre forfait est épuisée {#your-plans-allowance-ran-out}

Votre second affiche une carte intitulée « Votre second a épuisé son allocation ».
Une réponse à un équipier sur cet abonnement indique « Enregistrée, pas encore envoyée », avec le moment où l’allocation se renouvelle.
Le travail reprend de lui-même une fois l’allocation renouvelée.

Pour reprendre plus tôt :

- Appuyez sur **Revérifier l’allocation** si vous avez changé quelque chose du côté de votre fournisseur.
- Si la revérification ne trouve aucun changement, la carte propose aussi de réessayer votre fournisseur, par exemple **Try Claude again** : vos mots partent une fois, et si l’allocation est toujours épuisée, le second se met de nouveau en pause.
- Appuyez sur **Passer à** un autre fournisseur, quand la carte en propose un.
- Demandez à votre second de passer le travail sur un autre modèle.

Réglages → **Intelligence** indique ce qu’il reste de l’allocation de chaque forfait, et quand elle se renouvelle.
Pour Claude et Codex, **Continuer avec les crédits** permet à un compte de poursuivre avec des crédits configurés chez votre fournisseur.

## Votre second ne répond pas {#your-first-mate-is-not-answering}

Si un message n’a rien donné, une carte indique « Votre second n’a pas répondu à votre message ».
Appuyez sur **Redemander** pour l’envoyer une nouvelle fois, ou sur **Laisser**.

Si c’est le fournisseur lui-même qui ne répond pas, une carte indique qu’il « ne répond pas à votre second pour le moment ».
Appuyez sur **Réessayer Claude**, ou sur le même bouton avec le nom de votre fournisseur, ou sur **Ouvrir les Réglages** pour choisir un autre abonnement.
Quand un fournisseur a un bref problème, Activité le signale, et l’app réessaie d’elle-même.

## Un équipier attend {#a-crewmate-is-waiting}

Une tâche qui indique **En attente de vous** a une carte pour vous.
Ouvrez la tâche et appuyez sur **Afficher la carte**, puis tranchez.

D’autres mots sur une tâche disent ce qui la retient :

- « En attente des vérifications » : son équipier attend les vérifications de sa demande de tirage.
- « Nouvel essai chez son fournisseur » : le fournisseur a échoué, et l’app réessaie d’elle-même.
- « Bloquée chez son fournisseur » : le fournisseur a refusé trois fois la même demande, et votre second choisit quoi faire.
- « Bloquée par une autre tâche » : elle démarre une fois cette tâche terminée.

## Les vérifications ont échoué sur une demande de tirage {#the-checks-failed-on-a-pull-request}

Quand les vérifications échouent, l’équipier qui a fait la demande de tirage les corrige et apporte une nouvelle version.
Une carte de fusion propose alors **Fusionner après correction des erreurs**.
Si vous appuyez dessus, votre fusion est gardée : « Votre fusion attend une correction : ses vérifications ont échoué. »
Elle a lieu une fois les vérifications de la correction réussies, ou l’équipier vous redemande sur une nouvelle carte si la correction a changé le travail.

## Un autre ordinateur est hors de portée {#another-computer-is-out-of-reach}

Une fenêtre sur un autre ordinateur indique « Les modifications sont désactivées jusqu’au retour » de l’autre ordinateur, « Il est peut-être en veille, ou sur un autre réseau. »
Ou encore : « Infinitary est fermé sur » cet ordinateur.

1. Réveillez l’ordinateur où vit votre second, et ouvrez-y Infinitary.
2. Placez les deux ordinateurs sur le même réseau, ou sur le même réseau privé.
3. Dans Réglages → **Appareils**, appuyez sur **Réessayer** sur sa ligne.

Si un ordinateur que vous avez ajouté par son adresse a une nouvelle adresse, ouvrez son menu, les trois points sur sa ligne, et choisissez **Changer l’adresse**.
Sur un Mac, macOS peut tenir Infinitary à l’écart du réseau local jusqu’à ce que quelqu’un devant ce Mac l’autorise.
Sa ligne propose alors plutôt **L’ajouter par son adresse**.
Voir [Vos autres ordinateurs](/fr/your-other-computers/).

## Un ordinateur apparaît deux fois {#a-computer-is-listed-twice}

Réglages → **Appareils** affiche le même nom deux fois : une ligne à portée, et une hors de portée qui porte encore des tâches.
Cela arrive quand un ordinateur qui exécute le travail rejoint de nouveau après la suppression de son travail enregistré, ou après une nouvelle installation d’Infinitary sur cet ordinateur.
La ligne à portée indique « Une entrée plus ancienne avec ce nom et cet utilisateur est hors de portée ».

1. Sur la ligne à portée, appuyez sur **Poursuivre ses tâches ici**.
2. Lisez ce qui continue et ce qui reste en arrière, puis appuyez sur **Les poursuivre**.
3. Chaque tâche reprend à partir du dernier commit que l’ordinateur où vit votre second a rapporté.
   L’ancienne ligne disparaît de votre liste une fois que toutes les tâches ont été déplacées.

Les commits postérieurs, les modifications non validées et les fichiers des anciens dossiers de tâches restent avec l’ancienne entrée.
Pour une ligne hors de portée sans correspondance, appuyez sur **Déplacer ses tâches vers…** et choisissez un ordinateur.
Voir [Ce qui supprime votre travail enregistré](/fr/update-and-remove/#what-deletes-your-saved-work).

## La fenêtre ne répond plus {#the-window-stops-answering}

Attendez d’abord un instant.
Si elle reste bloquée, quittez Infinitary et rouvrez-le.
Les messages que votre second ou un équipier n’avait pas fini de traiter sont repris à l’ouverture.

## Infinitary n’a pas pu démarrer {#infinitary-could-not-start}

Après deux démarrages qui se sont arrêtés avant qu’Infinitary ait fini de démarrer, il affiche un écran intitulé « Infinitary n’a pas pu démarrer ».
L’écran indique : « Il s’est arrêté deux fois avant d’avoir fini de démarrer. Votre travail enregistré n’a pas été modifié. »

- **Réessayer** démarre Infinitary une fois de plus.
- **Réinitialiser Infinitary** repart comme s’il venait d’être installé.
  Il demande d’abord, avec **Tout garder** pour revenir en arrière, puis votre ordinateur confirme que c’est bien vous.
  Il supprime tout ce qu’Infinitary garde sur cet ordinateur, tandis que les projets dans vos propres dossiers gardent tous leurs fichiers et commits.
- **Quitter** ferme l’écran, qui s’affiche de nouveau au prochain démarrage d’Infinitary.

Les écrans qu’Infinitary affiche quand il ne peut pas ouvrir votre travail enregistré proposent aussi **Réinitialiser Infinitary**.
Voir [Réinitialiser Infinitary](/fr/update-and-remove/#reset-infinitary) pour ce qu’une réinitialisation supprime.

### Réinitialiser depuis un terminal {#reset-from-a-terminal}

Quand aucune fenêtre ne s’ouvre, quittez Infinitary et exécutez ceci dans un terminal :

```sh
infinitary reset
```

Sur un Mac, tapez `/Applications/Infinitary.app/Contents/MacOS/Infinitary` à la place de `infinitary`, et pour une AppImage, tapez le chemin du fichier.
Votre ordinateur confirme que c’est bien vous, et la commande répond : « Infinitary est réinitialisé. Il s’ouvrira sur l’écran d’accueil la prochaine fois. »
Tant qu’Infinitary est ouvert sur cet ordinateur, ou quand vous ne confirmez pas, la commande indique que rien n’a été réinitialisé.

## macOS pose une question sur les données d’autres apps {#macos-asks-about-other-apps-data}

macOS peut demander « Infinitary souhaite accéder aux données d’autres apps. »
Cela arrive quand la recherche d’un équipier atteint des fichiers qu’une autre app garde.
Le travail d’Infinitary en a rarement besoin, si bien que **Ne pas autoriser** convient en général.
La fiche de la tâche indique « En attente de macOS » jusqu’à votre réponse, puis la recherche continue.

## Claude Code est absent {#claude-code-is-missing}

Pour utiliser un abonnement Claude, installez d’abord Claude Code sur cet ordinateur.
Sans lui, Infinitary indique « Claude Code n’est pas installé sur cet ordinateur. Installez-le pour utiliser Claude ici. »
Si le vôtre est trop ancien, il nomme la version nécessaire et vous dit d’exécuter `claude update`.
Sur un autre ordinateur, Claude Code s’y connecte lui-même : connectez-vous-y une fois sur place, et Infinitary utilise cette connexion.

## Toujours bloqué {#still-stuck}

Voir [Obtenir de l’aide](/fr/get-help/).
Dites ce que vous avez fait, ce que vous attendiez et ce qui s’est passé à la place.
