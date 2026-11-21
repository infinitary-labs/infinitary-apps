---
source: e53def040de764b3
title: Leitfäden
description: Die geschriebene Anleitung, der dein erster Offizier und deine Crew bei bestimmten Arten von Arbeit folgen – und wie du sie ein- oder ausschaltest, liest und eigene erstellst oder hinzufügst.
---

Ein Leitfaden ist eine geschriebene Anleitung, der dein erster Offizier und deine Crew bei einer bestimmten Art von Arbeit folgen, etwa eine Änderung zu planen, eine Lektion zu halten oder Commits zu benennen.
Er besteht aus Worten, Beispielen und Bildern und führt auf deinem Computer nichts aus.
Infinitary bringt eigene Leitfäden mit, und du kannst weitere erstellen oder hinzufügen.

<img class="picture-dark" src="/pictures/runbooks-dark.webp" alt="Einstellungen, Bereich „Leitfäden“: die Liste „Mitgeliefert“ mit Gängige Abläufe, Lieferurteil, Testregeln, Sorgfaltsstufen, Commit- und PR-Namen, Programme und Kleine Projekte, jeweils mit einer kurzen Beschreibung, einer Schaltfläche „Ansehen“ und einem eingeschalteten Schalter." width="1168" height="618" />
<img class="picture-light" src="/pictures/runbooks-light.webp" alt="Einstellungen, Bereich „Leitfäden“: die Liste „Mitgeliefert“ mit Gängige Abläufe, Lieferurteil, Testregeln, Sorgfaltsstufen, Commit- und PR-Namen, Programme und Kleine Projekte, jeweils mit einer kurzen Beschreibung, einer Schaltfläche „Ansehen“ und einem eingeschalteten Schalter." width="1168" height="618" />

## Wo die Leitfäden liegen {#where-runbooks-live}

Öffne **Einstellungen** und dann **Leitfäden**.
Du kannst in der Befehlssuche auch nach **Leitfäden öffnen** suchen.

Der Bereich hat drei Gruppen:

- **Mitgeliefert** listet die Leitfäden, die mit Infinitary kommen.
- **Deine** listet die Leitfäden, die du hinzugefügt oder mit deinem ersten Offizier erstellt hast.
- **Eigenen erstellen** enthält **Dein Leitfäden-Ordner** und Beispiele dafür, worum du bitten kannst.

Jede Zeile zeigt den Namen eines Leitfadens, wofür er da ist, und seinen Schalter.

## Einen Leitfaden ein- oder ausschalten {#turn-a-runbook-on-or-off}

Nutze den Schalter eines Leitfadens, um ihn ein- oder auszuschalten.
Du kannst auch deinen ersten Offizier bitten, etwa „Schalte Lektionen aus“.

Dein erster Offizier folgt der Änderung, sobald er fertig ist mit dem, was er gerade tut, und ebenso jedes Crewmitglied, das danach startet.
Ein Crewmitglied, das schon arbeitet, behält die Anleitung, mit der es gestartet ist.

Ein ausgeschalteter Leitfaden leitet niemanden an, bleibt aber in der Liste, damit du ihn wieder einschalten kannst.

## Die mitgelieferten Leitfäden {#the-built-in-runbooks}

Die meisten mitgelieferten Leitfäden sind anfangs eingeschaltet.
Drei sind anfangs aus, bis du sie einschaltest: **Gebündelte Pull Requests**, **Pull-Request-Kommentare** und **Erweiterte Architektur**.

- **Gängige Abläufe**: wie dein erster Offizier an Planung, Bau, Fehlerbehebung und Recherche herangeht.
- **Lieferurteil**: wie Crewmitglieder Überprüfungen und Reparaturen beurteilen und wann eine Änderung bereit zum Zusammenführen ist, bei Arbeit, die über einen Pull Request läuft.
- **Testregeln**: was getestet wird, wenn ein Crewmitglied ein Projekt plant oder ändert.
- **Sorgfaltsstufen**: was jede Stufe von einer Änderung verlangt: **Schnell**, **Standard** und **Sorgfältig**.
  Siehe [Sorgfalt](/de/tasks-and-crewmates/#rigor).
- **Commit- und PR-Namen**: wie Commits, Pull Requests und Arbeits-Branches benannt werden.
  Ist er aus und gibt es keinen Leitfaden von dir, der sie benennt, prüft Infinitary keine Namen.
- **Programme**: Bei Arbeit, die sich per Skript aufteilen lässt, schreibt ein Crewmitglied ein kurzes Skript, das jeden Teil als eigene Aufgabe anlegt.
- **Kleine Projekte**: wie dein erster Offizier kleine Projekte zum Spaß oder für den privaten Gebrauch einrichtet.
  Siehe [Worum du bitten kannst](/de/what-you-can-ask-for/#a-small-project-for-fun).
- **Lektionen**: Anleitung und Kartenteile, um ein Thema über mehrere Tage zu lernen.
  Siehe [Worum du bitten kannst](/de/what-you-can-ask-for/#a-subject-learned-across-days).
- **Gebündelte Pull Requests**: fasst deine genehmigten Änderungen in einem gebündelten Pull Request zusammen und führt sie gemeinsam zusammen, damit ihre Überprüfungen nur einmal laufen.
  Schalte ihn ein, um in Einstellungen → **Projekte** gebündelte Pull Requests für ein Projekt zu wählen.
  Siehe [Projekte](/de/projects/#how-changes-reach-your-project).
- **Pull-Request-Kommentare**: Ein Crewmitglied beantwortet Kommentare zu seinem Pull Request, bis er zusammengeführt ist.
  Eindeutige Korrekturen macht es selbst, unklare bringt es dir als Entscheidung.
- **Computer aufräumen**: ein Blick, der nur liest, nachdem du zugestimmt hast, und eine Karte, auf der du wählst, welche Überbleibsel gestoppt werden.
  Siehe [Worum du bitten kannst](/de/what-you-can-ask-for/#a-look-at-a-computer-under-strain).
- **Geheimnisse übernehmen**: wie ein Crewmitglied Geheimnisse aus einem anderen Werkzeug in **Geheimnisse** übernimmt, ohne dass ein Agent einen Wert sieht.
  Ein Crewmitglied liest ihn nur bei einer solchen Übernahme.
  Siehe [Geheimnisse](/de/secrets/).
- **Erweiterte Architektur**: zeichnet die Teile eines Projekts und ihre Verbindungen und zeigt, was eine Änderung auf dieser Karte verschiebt.
  Sie ist ein Experiment.

Infinitary lässt dich **Gebündelte Pull Requests** nicht ausschalten, solange ein Projekt gebündelte Pull Requests nutzt, und nennt dieses Projekt.

## Einen Leitfaden lesen {#read-a-runbook}

Drück neben einem mitgelieferten Leitfaden auf **Ansehen**.
Es öffnet eine schreibgeschützte Kopie des Ordners des Leitfadens auf deinem Computer.
Um zu ändern, wie ein mitgelieferter Leitfaden arbeitet, bitte deinen ersten Offizier, ihn zu deinem eigenen zu machen, wie unten beschrieben.

## Eigene erstellen {#make-your-own}

Bitte deinen ersten Offizier in deinen eigenen Worten darum.
**Eigenen erstellen** in den Einstellungen zeigt Beispiele, etwa:

- „Gib jedem Crewmitglied einen Skill, um Release-Notes in einfachen Worten zu schreiben.“
- „Erstelle einen Leitfaden, der dem ersten Offizier sagt, dass ich kurze Antworten bevorzuge.“

Ein Crewmitglied schreibt den neuen Leitfaden in **Dein Leitfäden-Ordner**.
Er steht unter **Deine** und ist sofort eingeschaltet, es sei denn, du hast darum gebeten, dass er ausgeschaltet startet.

**Ordner öffnen** öffnet **Dein Leitfäden-Ordner** auf deinem Computer.
Eine Änderung an einem Leitfaden dort erreicht deinen ersten Offizier und deine Crew auf dieselbe Weise wie ein Schalter.

## Einen mitgelieferten Leitfaden zu deinem eigenen machen {#make-a-built-in-runbook-yours}

Bitte deinen ersten Offizier, einen mitgelieferten Leitfaden zu kopieren, etwa „Kopiere Gängige Abläufe und sorg dafür, dass immer erst geplant wird, bevor gebaut wird.“

1. Dein erster Offizier kopiert den ganzen Leitfaden unter einem neuen Namen in **Dein Leitfäden-Ordner**.
2. Die Kopie steht unter **Deine** und startet ausgeschaltet, also ändert sich noch nichts.
3. Ändere die Kopie selbst oder bitte deinen ersten Offizier, sie zu ändern.
4. Schalte die Kopie ein.
   Der mitgelieferte Leitfaden schaltet sich zur selben Zeit aus.

Der mitgelieferte Leitfaden bleibt, wie er war.
Um zurückzugehen, schalte deine Kopie aus und den mitgelieferten wieder ein.

## Einen Leitfaden hinzufügen, den jemand geteilt hat {#add-a-runbook-someone-shared}

Bitte deinen ersten Offizier, einen Leitfaden von einer Webadresse oder aus einem Ordner hinzuzufügen, etwa „Füge den Leitfaden unter einer Webadresse oder in einem Ordner hinzu, den jemand geteilt hat.“

Nichts wird hinzugefügt, bevor du die Karte beantwortest, die den Namen des Leitfadens im Titel trägt, etwa „Release-Notes hinzufügen?“.
Die Karte nennt, woher der Leitfaden kommt, wer ihn erstellt hat, worauf er zugreift und welchen mitgelieferten Leitfaden er ausschaltet.

- **Hinzufügen** fügt den Leitfaden hinzu und schaltet ihn ein.
- **Nicht hinzufügen** lehnt ihn ab und löscht, was geholt wurde.

Eine Karte, die du beiseitelegst, hält das Angebot bereit.
Ein Update eines hinzugefügten Leitfadens fragt dich auf derselben Art Karte erneut.

Um einen hinzugefügten Leitfaden zu entfernen, bitte deinen ersten Offizier, ihn mit seinem Namen zu entfernen.
Ein mitgelieferter Leitfaden, den er ausgeschaltet hat, bleibt aus, bis du ihn wieder einschaltest.

Ein Leitfaden unter **Deine**, den Infinitary nicht lesen kann, zeigt den Grund, hat keinen Schalter und leitet niemanden an, bis er repariert ist.

## Von einem anderen Computer {#from-another-computer}

Auf einem Computer, der deinen ersten Offizier von anderswo steuert, ändern die Schalter die Leitfäden dort, wo dein erster Offizier lebt.
**Ansehen** und **Ordner öffnen** funktionieren nur auf diesem Computer, und die Ordnerzeile nennt ihn.
Siehe [Deine anderen Computer](/de/your-other-computers/).

## Die Tastatur nutzen {#use-the-keyboard}

Mit der Tabulatortaste erreichst du jede Schaltfläche **Ansehen** und jeden Schalter.
Die Befehlssuche hat **Leitfäden öffnen** und **Deinen Leitfäden-Ordner öffnen**, und du kannst jedem von beiden in Einstellungen → **Tastatur** eine Taste geben.
Siehe [Tastatur](/de/keyboard/).
