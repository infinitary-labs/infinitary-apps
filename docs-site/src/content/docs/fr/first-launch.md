---
source: c16d193883332656
title: Premier lancement
description: Ce qu’Infinitary affiche la première fois que vous l’ouvrez, comment choisir où vit votre second, comment connecter un abonnement et comment ajouter votre premier projet.
---

Avant de commencer, vérifiez [ce dont vous avez besoin](/fr/install/).
Cette page décrit la première ouverture d’Infinitary, et ce qui change ensuite.

## Ce qu’affiche la fenêtre {#what-the-window-shows}

La première fois que vous ouvrez Infinitary, votre second vous accueille au milieu de la fenêtre.
En dessous s’affiche **Bienvenue à bord d’Infinitary, capitaine**, avec quelques mots de votre second :

> Je suis votre second.
> Je vous aide à diriger le reste de l’équipage.

Puis votre second vous demande où il doit vivre :

> Où dois-je vivre ?
> Choisissez un ordinateur qui reste allumé le plus possible.

Suivent trois choix, chacun disant ce qu’il fait :

- **Cet ordinateur** : vous vous connectez ici à un abonnement, et votre second vit et travaille sur cet ordinateur.
- **Un autre ordinateur** : votre second tourne sur un autre ordinateur, et vous le contrôlez depuis celui-ci.
- **Un qui tourne déjà** : vous vous connectez à un second qui tourne déjà sur un autre ordinateur, et vous le pilotez d’ici.

<img class="picture-dark" src="/pictures/first-launch-dark.webp" alt="Le premier lancement : le second au milieu de la fenêtre, les mots de bienvenue, la question de l’endroit où il doit vivre, et les trois choix Cet ordinateur, Un autre ordinateur et Un qui tourne déjà au-dessus de la zone de message grisée." width="1233" height="694" />
<img class="picture-light" src="/pictures/first-launch-light.webp" alt="Le premier lancement : le second au milieu de la fenêtre, les mots de bienvenue, la question de l’endroit où il doit vivre, et les trois choix Cet ordinateur, Un autre ordinateur et Un qui tourne déjà au-dessus de la zone de message grisée." width="1233" height="694" />

Appuyez sur un choix pour l’ouvrir.
Au clavier, Tab atteint chaque choix, les flèches passent de l’un à l’autre, et Entrée ou Espace en ouvre un.
**‹ Où je vis**, au-dessus d’un choix ouvert, vous ramène aux trois.
Sous les choix, votre second indique que vous pourrez le déplacer sur un autre ordinateur plus tard, dans Réglages → Appareils.

La zone de message en bas est grisée et indique « Connectez d’abord un abonnement ».
Rien d’autre ne fonctionne tant qu’aucun abonnement ne peut répondre à votre second.

## Connecter un abonnement {#connect-a-subscription}

Choisissez **Cet ordinateur** pour garder votre second ici.
Un bouton apparaît pour chaque fournisseur que votre second peut utiliser : Codex, Grok, Claude, Kimi Code, Copilot, OpenRouter, Amazon Bedrock et API personnalisée.

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

Si un abonnement est connecté mais ne peut toujours pas répondre, la fenêtre affiche **Configurez votre second sur cet ordinateur**, s’ouvre sur Cet ordinateur et indique ce qui manque encore.

## L’installer sur un autre ordinateur {#set-it-up-on-another-computer}

Choisissez **Un autre ordinateur** pour que votre second vive sur un ordinateur qui reste allumé, comme un ordinateur de bureau ou un serveur, pendant que vous le contrôlez depuis celui-ci.
La fenêtre affiche **Installez-moi sur un autre ordinateur**.

1. Tapez le compte et l’ordinateur comme pour vous y connecter avec SSH, par exemple `you@mini.local`, ainsi que son port s’il n’est pas 22.
   Session à distance doit y être activée ; sous Linux, son serveur SSH.
   Les ordinateurs du même réseau sont listés sous **Sur ce réseau**, pour que vous puissiez en choisir un.
2. Appuyez sur **Continuer**.

Infinitary y installe alors votre second, une étape à la fois, sous « Installation de votre second sur » suivi du nom de cet ordinateur :

1. **Lire sa clé SSH** : il affiche la ligne de clé de l’ordinateur et vous demande de la confirmer avant de vous connecter.
2. **Se connecter avec votre clé SSH** : si l’ordinateur n’accepte pas votre clé, il demande une seule fois le mot de passe de ce compte.
3. **Vérifier son système**.
4. **Envoyer Infinitary**.
5. **Lancer votre second là-bas**, pour qu’il se relance après chaque redémarrage.
6. **Se connecter d'ici**.
7. **Connecter un abonnement pour lui**.

Chaque étape terminée indique ce qu’elle a trouvé.
Si une étape s’arrête, elle indique ce qui l’a arrêtée et ce qu’il faut essayer, avec **Redemander**, **L'installer avec des commandes** et **Retour**.
Si Infinitary tourne déjà là-bas, il propose **S'y connecter à la place**.
Pour un ordinateur Linux qui vous connecte en tant que root, Infinitary propose pour votre second un compte ordinaire nommé `infinitary`, puisqu’Infinitary ne tourne pas en tant que root.
**Annuler** s’arrête à l’étape suivante ; si votre second n’a pas encore démarré là-bas, la copie d’Infinitary envoyée est supprimée.

Une fois la connexion établie, cette fenêtre affiche le second de l’autre ordinateur.
Elle indique **Connectez un abonnement pour commencer** : choisissez un fournisseur et connectez-vous d’ici, comme dans [Connecter un abonnement](#connect-a-subscription).

### Avec des commandes {#with-commands}

**L'installer avec des commandes** présente la même installation sous forme de commandes à exécuter sur l’autre ordinateur :

1. Installez Infinitary là-bas.
2. Démarrez votre second là-bas :

   ```sh
   infinitary start-at-boot
   ```

3. Créez là-bas un lien pour cet ordinateur :

   ```sh
   infinitary link
   ```

4. Collez ici le lien affiché : appuyez sur **Coller son lien**.

Chaque commande a son propre bouton **Copier**.
Sur un Mac, tapez `/Applications/Infinitary.app/Contents/MacOS/Infinitary` à la place de `infinitary`.
Voir [Un ordinateur sans écran](/fr/a-computer-with-no-screen/) pour un serveur que vous ne joignez que par SSH.

## Si votre second vit déjà sur un autre ordinateur {#if-your-first-mate-already-lives-on-another-computer}

Choisissez **Un qui tourne déjà**.
Un groupe indique « Votre second est sur un autre ordinateur » et propose ces façons d’y accéder :

- **Configurer depuis l’ordinateur de votre second**, sur un Mac ou un ordinateur Linux x64, vient en premier.
  Il affiche l’adresse de cet ordinateur, à taper sur l’ordinateur où vit votre second.
  Une fois que cet ordinateur a ajouté celui-ci, cette fenêtre ouvre votre second d’elle-même, tant que rien n’y a encore été configuré, comme une connexion ou un projet.
- **Coller son lien** : collez un lien créé sur l’ordinateur où vit votre second, dans Réglages → Appareils ou en le demandant à votre second, puis appuyez sur **Continuer**.
- **Rejoindre par son adresse** : tapez l’adresse avec laquelle vous vous connectez à cet ordinateur par SSH.
  Si Infinitary n’y est pas ouvert, **L'installer d'ici** y installe plutôt votre second, comme dans [L’installer sur un autre ordinateur](#set-it-up-on-another-computer).

Infinitary demande une fois s’il faut piloter votre second depuis cet ordinateur ; appuyez sur **Le contrôler d’ici**.

Une fenêtre où vous avez déjà configuré quelque chose garde son propre second : utilisez plutôt **Coller son lien** ou **Rejoindre par son adresse** pour piloter ce second d’ici.
Si Infinitary était fermé quand cet ordinateur a ajouté celui-ci, il ouvre votre second au prochain lancement, quoi qu’on y ait configuré.
Une fenêtre à côté d’un Infinitary que vous avez lancé vous-même depuis Terminal garde le second de celui-ci et ne propose aucune de ces deux façons ; arrêtez d’abord cet Infinitary pour les utiliser.
Un PC Windows et un ordinateur Linux Arm n’affichent que **Coller son lien** et **Rejoindre par son adresse**.
Voir [Vos autres ordinateurs](/fr/your-other-computers/).

## L’avis sur les diagnostics {#the-diagnostics-notice}

Un avis sous la zone de message indique ce qu’envoie Diagnostics et précise que cela n’inclut jamais ce que vous tapez.
Il s’affiche qu’un abonnement soit connecté ou non, et reste jusqu’à ce que vous y répondiez.
Choisissez **OK** pour le laisser activé, ou **Désactiver**.
Vous pourrez changer ce choix plus tard dans les [Réglages](/fr/settings/#general).
Voir [Ce qui quitte votre ordinateur](/fr/what-leaves-your-computer/).

## La carte de bienvenue {#the-welcome-card}

Dès que votre second peut répondre, une carte intitulée **Notre façon de travailler** apparaît.

<img class="picture-dark" src="/pictures/first-launch-welcome-dark.webp" alt="La carte Notre façon de travailler : une petite image de la fenêtre avec le second au-dessus de la zone de message, cinq points avec Retour et Suivant en dessous, les trois amorces, et Compris." width="930" height="523" />
<img class="picture-light" src="/pictures/first-launch-welcome-light.webp" alt="La carte Notre façon de travailler : une petite image de la fenêtre avec le second au-dessus de la zone de message, cinq points avec Retour et Suivant en dessous, les trois amorces, et Compris." width="930" height="523" />

C’est une petite image de la fenêtre qui en montre une partie à la fois.
Appuyez sur **Suivant** et **Retour** pour voir la zone de message, une carte, Activité à gauche, où les équipiers font leur rapport, et Tâches à droite, où chaque demande a sa fiche.

Sous l’image s’affiche « Pour commencer, appuyez sur l’une d’elles et terminez la phrase : », avec trois amorces :

- **Cloner un projet** place « Cloner le projet à l’adresse » dans la zone de message.
- **Démarrer un nouveau projet** place « Démarrer un nouveau projet nommé » dans la zone de message.
- **Travailler dans un dossier de mon ordinateur** ouvre le sélecteur de dossier de votre ordinateur.
  Le dossier que vous choisissez devient un projet, et une ligne sous le titre de la carte le nomme.
  Dans un dossier qui n’est pas encore un projet git, git est initialisé avec un premier commit vide.

Terminez la phrase et envoyez-la.
Une amorce n’envoie rien d’elle-même.
Sur un ordinateur qui pilote un second situé sur un autre ordinateur, **Travailler dans un dossier de mon ordinateur** place plutôt « Travailler dans le dossier » dans la zone de message, puisque le sélecteur de dossier montrerait les dossiers de cet ordinateur-ci.

La carte de bienvenue n’a pas de champ de réponse : c’est dans la zone de message en dessous que vous tapez.
Appuyez sur **Compris** pour la ranger quand vous voulez.

## Votre premier équipier {#your-first-crewmate}

La première fois que votre second confie une demande à un équipier, une carte intitulée **Un équipier s'en occupe** apparaît.

<img class="picture-dark" src="/pictures/first-launch-crewmate-dark.webp" alt="La carte Un équipier s'en occupe : le second qui envoie un équipier au travail, un panneau Maintenant indiquant qu’un équipier travaille et qu’il est inutile de le surveiller, un panneau Plus tard indiquant qu’une carte revient ici avec une réponse ou un choix, et Compris." width="1070" height="602" />
<img class="picture-light" src="/pictures/first-launch-crewmate-light.webp" alt="La carte Un équipier s'en occupe : le second qui envoie un équipier au travail, un panneau Maintenant indiquant qu’un équipier travaille et qu’il est inutile de le surveiller, un panneau Plus tard indiquant qu’une carte revient ici avec une réponse ou un choix, et Compris." width="1070" height="602" />

Elle indique que l’équipier travaille en arrière-plan, ce qui peut prendre un moment, et que vous n’avez pas besoin de le surveiller.
Quand l’équipier a une réponse, ou a besoin que vous choisissiez, cela vous revient sous forme de carte.
Seules les cartes ont besoin de vous.

Si la carte Notre façon de travailler est encore ouverte, cette carte prend sa place.
Elle ne s’affiche qu’une fois.
Appuyez sur **Compris** ; le travail continue, et vous pouvez demander autre chose en attendant.
Voir [Votre première tâche](/fr/your-first-task/).

## Ajouter votre premier projet {#add-your-first-project}

Votre second a besoin d’un projet dans lequel travailler.
Le plus simple est une amorce de la carte de bienvenue, ou les mêmes mots dans votre propre message.

**Travailler dans un dossier de mon ordinateur** ajoute tout de suite le dossier que vous choisissez.
Pour les autres amorces, votre second affiche une carte qui nomme le projet et la façon dont il sera configuré.
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
