---
source: 72e8eba0a4de8933
title: Le navigateur de l’équipage
description: Un équipier peut ouvrir des sites web dans son propre navigateur pour sa tâche. Regardez-le, prenez le contrôle quand une page a besoin de vous, et décidez lesquelles de vos connexions les tâches suivantes peuvent utiliser.
---

Un équipier peut avoir son propre navigateur pour sa tâche.
Il ouvre des sites web et des pages que sert votre projet, les lit, y clique et y tape, et en prend des images pour la fiche de la tâche.
Vous pouvez le regarder travailler, prendre le contrôle quand une page a besoin d’une personne, et le lui rendre.
Un achat, une réservation ou toute autre chose qui vous engage reste toujours à faire par vous.

<img class="picture-dark" src="/pictures/browser-dark.webp" alt="La carte d’une tâche sur son onglet Navigateur pendant que vous avez le contrôle : la rangée au-dessus d’une page inventée de club de jardinage indique que vous avez la main et que l’équipier ne voit pas la page, avec Rendre le contrôle, et la carte de décision de l’équipier à côté vous demande de vous connecter à la page du club." width="1272" height="636" />
<img class="picture-light" src="/pictures/browser-light.webp" alt="La carte d’une tâche sur son onglet Navigateur pendant que vous avez le contrôle : la rangée au-dessus d’une page inventée de club de jardinage indique que vous avez la main et que l’équipier ne voit pas la page, avec Rendre le contrôle, et la carte de décision de l’équipier à côté vous demande de vous connecter à la page du club." width="1272" height="636" />

## Le navigateur propre à une tâche {#a-tasks-own-browser}

Le navigateur s’exécute sur l’ordinateur où s’exécute la tâche, et appartient à cette seule tâche.
Il démarre vide et déconnecté de tout, séparé de votre propre navigateur, si bien qu’il n’utilise jamais les connexions, l’historique ni les mots de passe enregistrés de votre navigateur.
Quand Google Chrome ou Microsoft Edge est installé sur cet ordinateur, le navigateur de la tâche s’exécute dedans, séparé de la même façon ; sinon, il utilise celui d’Infinitary.
Rien de ce que demande une page ne s’ouvre dans votre propre navigateur ni dans une autre app.

Le navigateur d’un équipier peut ouvrir :

- les sites web publics, en https ;
- les pages du même ordinateur, comme un projet que l’équipier y fait tourner ;
- un site du réseau de votre bureau, de votre domicile ou de votre VPN, une fois que vous l’avez listé sous [Sites privés](#private-sites).

Pendant que l’équipier pilote, le navigateur refuse une page qui demande votre caméra, votre micro, votre presse-papiers ou vos notifications.
Un site qui demande une clé d’accès apprend qu’il n’y en a pas, et propose donc un autre moyen, comme un mot de passe ou un code.
Quand une page a besoin d’une connexion, d’un code ou d’un paiement, l’équipier vous le demande ([voir plus bas](#when-a-page-needs-you)).

Le navigateur s’arrête quand l’équipier le ferme, quand vous appuyez sur **Arrêter le navigateur**, quand sa tâche se ferme, après 30 minutes sans usage pendant que personne ne regarde, ou quand Infinitary quitte.
Un ordinateur fait tourner au plus quatre navigateurs de tâche à la fois.

## Le regarder travailler {#watch-it-work}

Ouvrez la carte de la tâche et choisissez son onglet **Navigateur**, qui indique **Navigateur** et le titre de la page.
Depuis une carte sur la tâche, **Afficher Navigateur** dans la recherche de commandes l’ouvre aussi.
La carte d’un équipier peut aussi porter un bouton, comme « Essayer » ou « Voir la réservation », qui ouvre le navigateur à côté de cette carte.

La rangée au-dessus de la page propose **Précédent**, **Suivant** et **Actualiser**, qui pilote, **Prendre le contrôle** et **Plus**.
Pendant que vous regardez, la page est une image de ce que voit l’équipier, et vos clics ne l’atteignent pas.
**Plus** contient **Ajuster** ou **Taille réelle**, **Arrêter le navigateur**, **Copier l’adresse de la page** et **Signaler un problème**, qui commence un message à votre second que vous terminez.

Sous la page, une ligne Équipier repliée affiche les derniers mots de l’équipier.
Dépliez-la pour lire la conversation de l’équipier à côté de la page et lui écrire.
Masquer ou Échap range la vue, et le navigateur continue de tourner.

Un navigateur arrêté dit pourquoi il s’est arrêté.
**Rouvrir** démarre un navigateur neuf sur la page où il était, connecté seulement aux sites que cette tâche peut encore utiliser ; ce n’est plus proposé une fois la tâche fermée.

## Prendre le contrôle {#take-control}

1. Appuyez sur **Prendre le contrôle** dans la rangée au-dessus de la page.
   L’équipier termine d’abord son action en cours, et la rangée indique « fin de l’action en cours de l’équipier… ».
2. La rangée indique « vous avez la main · l’équipier ne voit pas cette page ».
   Vos clics, défilements, saisies et collages atteignent désormais la page.
3. Appuyez sur **Rendre le contrôle** pour le lui rendre.
   Avant que vous n’appuyiez, la vue vous le rappelle : « Rendre le contrôle permet à l’équipier de lire et d’utiliser ce navigateur, y compris les pages connectées. »

Rien d’autre ne fait changer le contrôle de main : ni un clic sur la page, ni une connexion, ni une redirection, ni Masquer, ni la fermeture d’une carte, ni un minuteur.
**Prendre ou rendre le contrôle du navigateur** dans la recherche de commandes fait de même pour le navigateur à l’écran.

Pendant que vous avez le contrôle :

- rien de ce que vous faites sur la page n’est enregistré, et l’équipier n’apprend jamais ce que la page a dit pendant votre temps ;
- une page qui demande votre caméra, votre micro, votre presse-papiers ou vos notifications vous le demande sur une ligne au-dessus de la page, avec **Autoriser une fois** et **Pas maintenant**, et Rendre le contrôle reprend ce que vous avez autorisé ;
- une page qui demande un fichier ouvre pour vous le sélecteur de fichiers d’Infinitary.

Une fois le contrôle rendu, l’équipier jette un œil neuf sur la page.
Il ne lit pas ce que vous avez tapé dans les champs de la page : ils apparaissent remplis, avec leurs mots masqués.
Il ne prend une image de la page qu’avec une raison qu’il donne, qui va dans l’Activité de la tâche, et jamais d’une page qui contient ce que vous avez tapé.

## Quand une page a besoin de vous {#when-a-page-needs-you}

Un équipier qui a besoin d’une personne sur la page, pour une connexion, un code ou un paiement, vous le demande sur une carte de décision.
La carte nomme le site et la raison, avec un bouton pour votre part, comme « Ouvrir le navigateur et se connecter », à côté d’un bouton comme « Laisser en attente ».
Pendant ce temps, le navigateur vous attend, et la ligne Navigateur de la tâche indique « en pause, il attend votre aide ».

Appuyez sur le bouton de la carte, et la page s’ouvre sous votre contrôle avec la carte à côté.
La carte garde ses instructions et les valeurs à copier en vue, et son champ vous permet d’écrire à l’équipier pendant que vous travaillez.
Quand vous avez fini, appuyez sur **Rendre le contrôle**.
La carte disparaît, l’équipier poursuit, et les mots laissés dans le champ de la carte partent avec votre retour.

## Sites connectés {#signed-in-sites}

Quand un équipier vous demande de vous connecter ou de créer un compte, ce à quoi vous vous connectez reste dans le profil de navigateur propre à cet ordinateur.
La connexion couvre tout le site : une connexion faite sur la page de connexion distincte d’example.com sert aussi à ses autres pages, comme developer.example.com.
Quand vous appuyez sur **Rendre le contrôle**, une question au-dessus de la page demande ce que les tâches suivantes peuvent faire, comme « Votre connexion à example.com reste sur cet ordinateur. Les tâches suivantes : » :

- **L’utiliser sans demander** vient en premier et est choisi pour un nouveau site.
  Une tâche suivante ouvre le site connecté, sans carte, et son Activité le signale à chaque fois.
  Cela ne couvre jamais un paiement ni un envoi final.
- Avec **Me demander à chaque fois**, une tâche suivante qui a besoin du site le demande sur sa carte, qui ajoute **Utiliser ma connexion à example.com** à côté de **Me connecter moi-même**.
  Un clic permet au navigateur de cette tâche d’utiliser le site, connecté, sans que vous ne tapiez rien.

Une règle s’applique aux tâches de tous les projets sur cet ordinateur.
Un navigateur qui utilise un site connecté n’ouvre que ce site et les pages de connexion par lesquelles il est passé ; tout autre site s’ouvre déconnecté.
Une tâche garde les sites connectés qu’elle peut utiliser quand son navigateur s’arrête de lui-même ou que l’app redémarre, jusqu’à ce que vous appuyiez sur **Arrêter le navigateur** ou que la tâche se ferme.
Quand vous vous connectez pour une autre raison, par exemple après avoir appuyé vous-même sur **Prendre le contrôle**, la connexion ne dure en général que jusqu’à l’arrêt de ce navigateur.
La ligne sous la page indique laquelle, comme « temporaire · garde ce à quoi vous vous êtes connecté jusqu’à son arrêt ».

Chaque ordinateur garde ses propres connexions, et aucune n’est copiée vers un autre ordinateur ni dans un fichier.
Elles restent dans le profil de navigateur de cet ordinateur, pas dans le stockage protégé, et sont donc aussi sûres que la session et le disque de cet ordinateur.

Sur l’ordinateur où vit votre second, la liste se trouve dans Réglages → **Secrets**, sous **Sites connectés**, avec les sites de chaque ordinateur sous son nom.
Sur un ordinateur qui contrôle votre second depuis ailleurs, elle se trouve dans Réglages → **Général**, sous **Connexions aux sites web**.
Chaque site indique quand vous vous êtes connecté, sa règle **Tâches suivantes** et **Retirer**, qui le déconnecte aussitôt sur cet ordinateur.
**Tout retirer** déconnecte cet ordinateur de chaque site, y compris des connexions jamais ajoutées à la liste.

Les sites mettent fin à leurs propres connexions de temps à autre, et l’équipier vous redemande alors.
Si une connexion gardée n’a pas connecté la page, la carte suivante propose d’abord **Me connecter moi-même** et garde **Utiliser ma connexion (n’a pas marché la dernière fois)** comme second choix.

## Sites privés {#private-sites}

Un site du réseau de votre bureau, de votre domicile ou de votre VPN n’est joint qu’une fois que vous l’avez listé.
Quand un équipier en a besoin d’un, votre second vous le demande sur une carte, comme « Laisser les navigateurs des tâches joindre wiki.corp.example ? ».
Appuyez sur **Autoriser** pour l’ajouter, ou sur **Pas maintenant** ; votre second n’en ajoute jamais un lui-même.

La liste se trouve sous **Sites privés** dans Réglages → **Intégrations**, et s’applique sur tous vos ordinateurs.

- Appuyez sur **Site**, tapez un nom comme `wiki.corp.example`, et appuyez sur **Ajouter**.
- Un suffixe comme `.corp.example.com` couvre tous les noms en dessous.
- Une entrée est un nom, jamais une adresse numérique.
- **Retirer** enlève un site de la liste, et les navigateurs des tâches cessent aussitôt de le joindre.

Un site listé s’ouvre en https ou en http, depuis n’importe quelle page, comme dans un navigateur ordinaire.
Il n’atteint jamais un programme qui n’écoute qu’à l’intérieur de l’ordinateur lui-même.

## Les achats et les réservations vous reviennent {#purchases-and-bookings-are-yours}

Un achat, une réservation ou tout autre envoi qui vous engage vous revient, sur la page même du site, sous votre contrôle.
L’équipier remplit tout jusqu’au dernier bouton et s’arrête là.

Il demande ensuite sur une carte de vérification qui nomme ce à quoi vous vous engagez, lu sur la page telle qu’elle est maintenant.
Pour un voyage, ce sont l’itinéraire, les dates et heures, les passagers, le vendeur, le total et la devise, ainsi que les règles de bagages et de tarif.
La carte nomme aussi ce qui reste incertain, et ce qui a changé depuis votre dernier choix.
Son bouton nomme votre part, comme « Ouvrir le navigateur et payer », à côté d’un bouton comme « M’arrêter ici ».

- Si le prix ou les conditions changent après la vérification, l’équipier s’arrête et redemande.
- Après que vous avez payé et rendu le contrôle, l’équipier lit ce que la page dit qu’il s’est passé et ne garde que le résultat, comme une référence de réservation.
  Les données de carte que vous avez tapées lui restent masquées.
- Si la page ne le confirme pas, l’équipier dit clairement qu’il ne sait pas si l’opération est passée.
  Il ne la renvoie jamais, et vérifie là où le site la liste, comme vos réservations, avant de vous demander.
- Le navigateur n’envoie jamais un formulaire deux fois : actualiser une page qui a répondu à un formulaire ne le renvoie pas.

## Fichiers et téléchargements {#files-and-downloads}

Un fichier qu’une page télécharge, y compris un fichier que vous téléchargez pendant que vous avez le contrôle, est enregistré avec les éléments de la tâche, et l’Activité de la tâche note chacun.
Quand une page demande un fichier, l’équipier ne peut lui donner qu’un fichier de la copie de travail de la tâche.
Un fichier qu’il n’a pas est à vous de le donner : il vous le demande sur une carte qui vous confie le navigateur.

## Sur vos autres ordinateurs {#on-your-other-computers}

Une tâche qui s’exécute sur un autre de vos ordinateurs y a son navigateur.
Vous le regardez et en prenez le contrôle depuis n’importe quelle fenêtre, comme pour un navigateur de cet ordinateur.
Cet ordinateur garde ses propres sites connectés, et la liste des [sites privés](#private-sites) s’y applique aussi.
Une page là-bas qui demande un fichier pendant que vous avez le contrôle attend l’équipier, car le sélecteur de fichiers d’Infinitary ne peut pas joindre cet ordinateur.
Voir [Vos autres ordinateurs](/fr/your-other-computers/).
