---
source: 5bc9765e37782345
title: Premier lancement
description: Ce qu’Infinitary affiche la première fois que vous l’ouvrez, comment connecter un abonnement et comment ajouter votre premier projet.
---

Avant de commencer, vérifiez [ce dont vous avez besoin](/fr/install/).
Cette page décrit la première ouverture d’Infinitary, et ce qui change ensuite.

## Ce qu’affiche la fenêtre {#what-the-window-shows}

La première fois que vous ouvrez Infinitary, votre second vous accueille au milieu de la fenêtre.
Au-dessus s’affiche **Bienvenue à bord d’Infinitary, capitaine**, avec quelques mots de votre second :

> Je suis votre second.
> Je vous aide à diriger le reste de l’équipage.
> Configurez-moi sur un ordinateur qui reste allumé le plus possible.
> Vos autres appareils ont besoin que je sois éveillé.

En dessous se trouve un bouton pour chaque fournisseur que votre second peut utiliser : Codex, Grok, Claude, Kimi Code, Copilot, OpenRouter, Amazon Bedrock et API personnalisée.

<img class="picture-dark" src="/pictures/first-launch-dark.webp" alt="Le premier lancement : le second au milieu de la fenêtre, les mots de bienvenue et un bouton pour chaque fournisseur." width="1280" height="652" />
<img class="picture-light" src="/pictures/first-launch-light.webp" alt="Le premier lancement : le second au milieu de la fenêtre, les mots de bienvenue et un bouton pour chaque fournisseur." width="1280" height="652" />

La zone de message en bas est grisée et indique « Connectez d’abord un abonnement ».
Rien d’autre ne fonctionne tant qu’aucun abonnement ne peut répondre à votre second.

## Connecter un abonnement {#connect-a-subscription}

1. Choisissez le bouton de votre fournisseur.
2. Connectez-vous de la façon que demande ce fournisseur.
   Certains ouvrent la page de connexion dans votre navigateur.
   Copilot et Kimi Code affichent un code : appuyez sur **Copier le code**, puis saisissez-le sur le site du fournisseur.
   OpenRouter demande une clé API que vous collez.
   Avec Amazon Bedrock, choisissez une région et utilisez un profil AWS de cet ordinateur, ou collez une clé API Bedrock.
   Un fournisseur qui propose les deux vous demande s’il faut **Se connecter avec votre navigateur** ou coller une **Clé API**.
3. Patientez pendant que la fenêtre indique la connexion en cours.
   Quand l’abonnement peut répondre, l’écran de bienvenue s’efface et la zone de message s’ouvre.

Si vous utilisez Claude, Infinitary utilise le Claude Code que vous avez installé sur cet ordinateur.
Sans lui, le bouton Claude vous invite à installer d’abord Claude Code.

Si un abonnement est connecté mais ne peut toujours pas répondre, la fenêtre affiche **Configurez votre second sur cet ordinateur** et indique ce qui manque encore.

## Si votre second se trouve déjà sur un autre ordinateur {#if-your-first-mate-already-lives-on-another-computer}

Sous les boutons des fournisseurs, un second groupe indique « Votre second est sur un autre ordinateur ».
Sur un Mac ou un ordinateur Linux x64, **Configurer depuis l’ordinateur de votre second** apparaît en premier : il affiche l’adresse de cet ordinateur, à taper sur l’ordinateur où vit votre second.
Une fois que cet ordinateur a ajouté celui-ci, cette fenêtre ouvre votre second d’elle-même, tant que rien n’y a encore été configuré, comme une connexion ou un projet.
Une fenêtre où vous avez déjà configuré quelque chose garde son propre second : utilisez plutôt **Coller son lien** ou **Rejoindre par son adresse** pour piloter ce second d’ici.
Si Infinitary était fermé quand cet ordinateur a ajouté celui-ci, il ouvre votre second au prochain lancement, quoi qu’on y ait configuré.
Une fenêtre à côté d’un Infinitary que vous avez lancé vous-même depuis Terminal garde le second de celui-ci et ne propose aucune de ces deux façons ; arrêtez d’abord cet Infinitary pour les utiliser.
Un PC Windows et un ordinateur Linux Arm n’affichent que les deux autres façons.
Voir [Vos autres ordinateurs](/fr/your-other-computers/).

## L’avis sur les diagnostics {#the-diagnostics-notice}

Un avis sous la zone de message indique ce qu’envoie Diagnostics et précise que cela n’inclut jamais ce que vous tapez.
Choisissez **OK** pour le laisser activé, ou **Désactiver**.
Vous pourrez changer ce choix plus tard dans les [Réglages](/fr/settings/#general).
Voir [Ce qui quitte votre ordinateur](/fr/what-leaves-your-computer/).

## La carte de bienvenue {#the-welcome-card}

Dès que votre second peut répondre, une carte intitulée **Notre façon de travailler** apparaît.
C’est une petite image de la fenêtre qui en montre une partie à la fois.
Appuyez sur **Suivant** et **Retour** pour voir la zone de message, une carte, Activité à gauche et Tâches à droite.

Sous l’image se trouvent trois amorces :

- **Cloner un projet**
- **Démarrer un nouveau projet**
- **Travailler dans un dossier de mon ordinateur**

Appuyer sur l’une d’elles place le début d’une phrase dans la zone de message, comme « Cloner le projet à l’adresse ».
Terminez la phrase et envoyez-la.
L’amorce n’envoie rien d’elle-même.

La carte de bienvenue n’a pas de champ de réponse : c’est dans la zone de message en dessous que vous tapez.
Fermez-la quand vous voulez.

## Ajouter votre premier projet {#add-your-first-project}

Votre second a besoin d’un projet dans lequel travailler.
Le plus simple est une amorce de la carte de bienvenue, ou les mêmes mots dans votre propre message.

Quand vous le demandez, votre second affiche une carte qui nomme le projet et la façon dont il sera configuré.
Vérifiez les choix de la carte, puis appuyez sur **Ajouter un projet**, ou sur **Pas maintenant** pour en rester là.
Rien n’est ajouté tant que vous n’appuyez pas sur **Ajouter un projet**.

Vous pouvez aussi ajouter un projet vous-même dans Réglages → Projets avec **Ajouter un projet**.
Voir [Projets](/fr/projects/) pour les choix proposés.

## Les lancements suivants {#later-launches}

Quand un abonnement peut répondre, Infinitary s’ouvre directement sur la zone de message.
Vos cartes, vos tâches et votre équipage sont là où vous les avez laissés.

Après une mise à jour d’Infinitary, une carte nomme la nouvelle version et ce qui a changé.
Vous pourrez la relire plus tard depuis [Réglages → Général](/fr/settings/#general), sous Version.
Sur un Mac, l’élément **Nouveautés d’Infinitary** du menu Aide l’ouvre aussi.

Si votre dernier abonnement cesse de fonctionner, par exemple parce que vous vous êtes déconnecté, l’écran de bienvenue revient jusqu’à ce qu’un abonnement puisse de nouveau répondre.
Si l’allocation de votre forfait est épuisée, votre second affiche plutôt une carte qui le dit, et garde vos messages jusqu’à ce qu’il puisse répondre.
Voir [Abonnements et allocation](/fr/subscriptions-and-quota/).

Pour ouvrir Infinitary quand vous vous connectez à votre ordinateur, activez **Ouvrir à la connexion** dans Réglages → Général.
