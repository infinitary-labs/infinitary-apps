---
source: 37599270c99ffda1
title: Aufgaben und Crewmitglieder
description: Was eine Aufgabe ist, wie sie vom Backlog bis zu „Fertig“ wandert, wo du sie verfolgst und wie du das Crewmitglied lenkst, das sie bearbeitet.
---

Eine Aufgabe ist ein Stück Arbeit, das dein erster Offizier im Blick behält, mit einem Kürzel wie `WEB-12`.
Ein Crewmitglied ist der KI-Helfer, der die Arbeit einer Aufgabe erledigt, in seiner eigenen Arbeitskopie deines Projekts.
Jede Aufgabe führt ein Protokoll darüber, worum du gebeten hast, was sich geändert hat, welche Belege es gibt und was du entschieden hast.

## Wo eine Aufgabe steht {#where-a-task-stands}

Aufgaben, rechts im Fenster, listet deine Aufgaben danach auf, wo sie stehen:

- **Wartet auf dich**: Eine Karte der Aufgabe braucht deine Entscheidung.
- **Arbeitet**: Ein Crewmitglied arbeitet gerade daran.
- **Eingereiht**: Sie startet von selbst, sobald erledigt ist, worauf sie wartet, zum Beispiel eine andere Aufgabe.
- **Backlog**: Sie wartet darauf, dass du sie startest.
  Drück in ihrer Zeile auf **Starten**, wenn sie beginnen soll.
- **Fertig · 7 T.**: in dieser Woche abgeschlossen.

Eine Zeile kann nach ihrem Titel ein Wort ergänzen, etwa „blockiert“, „zurückgehalten“, „Überprüfungen“ oder „nicht gestartet“.
Bei einer Aufgabe, die nicht starten konnte, steht **Erneut versuchen** zur Wahl.

Klick auf eine Zeile, um die Aufgabe zu öffnen.
Wenn eine Karte der Aufgabe auf dich wartet, kommt diese Karte zuerst nach vorn.

### Das Zeichen neben jeder Aufgabe {#the-mark-beside-each-task}

Jede Zeile in Aufgaben beginnt mit einem kleinen Zeichen.
Seine Form sagt, wo die Aufgabe steht, und seine Farbe unterstreicht es.

- <svg class="task-mark" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/></svg> **Backlog**: Sie wartet darauf, dass du **Starten** drückst.
- <svg class="task-mark" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg> **Eingereiht**: Sie startet von selbst, sobald es geht.
- <svg class="task-mark" viewBox="0 0 16 16" aria-hidden="true"><circle class="task-mark-track" cx="8" cy="8" r="5" fill="none" stroke-width="1.5"/><path class="task-mark-ring" d="M8 3a5 5 0 1 1-5 5" fill="none" stroke-width="1.5"/></svg> **Startet**: Infinitary macht ihr Crewmitglied bereit.
- <svg class="task-mark task-mark-hot" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="currentColor" stroke="currentColor" stroke-width="1.2"/></svg> **Arbeitet**: Ein Crewmitglied arbeitet gerade daran.
- <svg class="task-mark task-mark-hot" viewBox="0 0 16 16" aria-hidden="true"><circle class="task-mark-ring" cx="8" cy="8" r="6" fill="none" stroke-width="1.2" stroke-dasharray="2.6 2.1"/><circle cx="8" cy="8" r="3" fill="currentColor"/></svg> **Arbeitet, mit Hintergrundarbeit**: Etwas, das ihr Crewmitglied gestartet hat, etwa ein langer Build oder Testlauf, läuft noch.
- <svg class="task-mark task-mark-calm" viewBox="0 0 16 16" aria-hidden="true"><circle class="task-mark-ring" cx="8" cy="8" r="6" fill="none" stroke-width="1.2" stroke-dasharray="2.6 2.1"/><circle cx="8" cy="8" r="3" fill="currentColor"/></svg> **Arbeitet, wartet auf die Überprüfungen**: Ihr Crewmitglied wartet, bis die Überprüfungen ihrer Änderung durch sind.
  Die Zeile ergänzt „Überprüfungen“.
- <svg class="task-mark task-mark-calm" viewBox="0 0 16 16" aria-hidden="true"><path d="M11.441 3.085 A6 6 0 0 1 11.441 12.915 M4.559 12.915 A6 6 0 0 1 4.559 3.085" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><circle cx="8" cy="8" r="3" fill="currentColor"/></svg> **Arbeitet, wartet auf das Bündel**: Ihre genehmigte Änderung wartet auf die Überprüfungen des Bündels, dem sie beigetreten ist.
  Die Zeile ergänzt „Sammelprüfung“.
- <svg class="task-mark task-mark-ok" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="currentColor" stroke="currentColor" stroke-width="1.2"/></svg> **Frei**: Sie wurde gestartet, aber ihr Crewmitglied arbeitet gerade nicht, und ihre Arbeit bleibt erhalten.
  Wenn sie auf eine andere Aufgabe wartet, ergänzt die Zeile „wartet“.
- <svg class="task-mark task-mark-lava" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="currentColor" stroke="currentColor" stroke-width="1.2"/></svg> **Unterbrochen**: Der Durchgang ihres Crewmitglieds wurde gestoppt, bevor es fertig war.
  Sag ihm, was es als Nächstes tun soll.
- <svg class="task-mark task-mark-calm" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="8" r="3" fill="currentColor"/></svg> **Wartet auf dich**: Eine Karte der Aufgabe braucht deine Entscheidung.
- <svg class="task-mark" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 8 6 12 14 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg> **Fertig**: Sie ist abgeschlossen.
- <svg class="task-mark task-mark-dim" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3 13 13 M13 3 3 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg> **Aufgegeben**: Sie wurde aufgegeben.
  Aufgegebene Arbeit erscheint auf dem Aufgabenboard, nicht in Aufgaben.

Wenn der Computer, auf dem eine Aufgabe läuft, außer Reichweite ist, behält ihr Zeichen seine Form und wird orange, und die Zeile endet mit „außer Reichweite“ ([Deine anderen Computer](/de/your-other-computers/#a-computer-that-runs-work)).
Zum Beispiel zeigt eine Backlog-Aufgabe auf diesem Computer <svg class="task-mark task-mark-hot" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>.

Eine in Teile aufgeteilte Aufgabe listet ihre Teile unter sich auf.
Sobald einer ihrer Teile startet, steht die Aufgabe unter Arbeitet, mit ihren offenen Teilen darunter.
Die Aufgabe behält dort ihr eigenes Zeichen, deshalb kann eine Aufgabe, deren Teile die Arbeit erledigen, unter Arbeitet das Zeichen für Backlog oder Eingereiht zeigen.

Um den Status einer Aufgabe und seinen Grund in Worten zu lesen, halte den Zeiger über ihre Zeile oder geh mit der Tastatur zur Zeile.

## Das Aufgabenboard {#the-task-board}

Für eine ausführlichere Ansicht drück in der Kopfzeile von Aufgaben auf **Aufgabenboard öffnen**.
Das Board zeigt oben „Wartet auf dich“, darunter drei Spalten: Backlog, Eingereiht und Arbeitet.

<img class="picture-dark" src="/pictures/task-board-dark.webp" alt="Das Aufgabenboard: eine Reihe mit den Tags des Projekts, oben eine Aufgabe, die auf dich wartet, darunter die Spalten Backlog, Eingereiht und Arbeitet." width="876" height="493" />
<img class="picture-light" src="/pictures/task-board-light.webp" alt="Das Aufgabenboard: eine Reihe mit den Tags des Projekts, oben eine Aufgabe, die auf dich wartet, darunter die Spalten Backlog, Eingereiht und Arbeitet." width="876" height="493" />

Seine Ansichten listen auch das ganze Backlog, Fertig · 7 T. und die in dieser Woche aufgegebene Arbeit auf.
Gib in **Aufgabe suchen** ein Kürzel oder einen Titel ein, um jede Spalte einzugrenzen, auch ältere fertige Arbeit.
Hat dein Projekt Tags, zeigt das Board sie in einer Reihe, und wenn du auf eines drückst, zeigt das Board nur noch dessen Aufgaben; siehe [Tags](#tags).

Um eine Aufgabe zu verschieben, zieh ihre Kachel in eine andere Spalte oder nutz ihr Menü ⋯:

- Nach **Eingereiht**: Sie startet von selbst, sobald es geht.
- Nach **Arbeitet**: Sie startet sofort.
- Zurück nach **Backlog**: Sie wartet wieder auf dein Wort.
  Eine Aufgabe, die schon gestartet wurde, behält ihre Arbeit.
- In die Ablage **Aufgabe aufgeben**: Sie wird aufgegeben.

Bei einem Verschieben, das Arbeit starten oder aufgeben würde, wird vorher einmal nachgefragt.
Das Board führt nie etwas zusammen: Ein Zusammenführen geschieht nur auf der Karte zum Zusammenführen der Aufgabe.

## Die Karte einer Aufgabe {#a-tasks-card}

Öffne eine Aufgabe, um ihre Karte zu sehen.
Unter ihrem Titel steht eine Reihe von Tabs:

- **Info**: worum du gebeten hast, wo sie steht, ihre Tags und wie sie geliefert wird.
- **Karten**: die Karten, die dir die Aufgabe gezeigt hat, mit ihrer Anzahl.
- **Aktivität**: jede Zeile, die die Aufgabe geschrieben hat, der Reihe nach.
- **Crewmitglied**: die eigene Unterhaltung des Crewmitglieds, Zeile für Zeile, während es arbeitet.
- **Browser**: eine Seite, die das Crewmitglied in seinem eigenen Browser geöffnet hat, wenn es einen hat.
  Siehe [Der Browser der Crew](/de/the-crews-browser/).

Ein Tab erscheint erst, wenn die Aufgabe dort etwas zu zeigen hat.

## Tags {#tags}

Eine Aufgabe kann beliebige Tags ihres Projekts tragen, etwa Fehler oder Funktion.
Die Tags eines Projekts legst du in Einstellungen → Projekte an; siehe [Projekte](/de/projects/#tags).

Um eine Aufgabe zu taggen, öffne ihren Tab **Info** und drück in der Zeile **Tags** auf **Tags bearbeiten**.
Ein Menü listet die Tags des Projekts auf, und jedes Häkchen wird sofort gespeichert.
Die Zeile **Tags** erscheint, sobald das Projekt Tags hat.
Du kannst auch deinen ersten Offizier bitten, eine Aufgabe zu taggen.

An drei Stellen kannst du Aufgaben nach Tag finden:

- **Aufgaben durchsuchen**, in der Kopfzeile von Aufgaben, zeigt eine Reihe mit den Tags des Projekts.
  Drück auf ein Tag, um nur die Aufgaben aufzulisten, die es tragen, auf **Ohne Tag** für die Aufgaben, die keines tragen, oder auf **Alle Tags**, um wieder jede Aufgabe zu sehen.
- **Aufgaben gruppieren**, gleich daneben, listet deine Aufgaben **Nach Tag** statt **Nach Status** auf.
  Jedes Tag ist eine Gruppe, eingeklappt, bis du sie öffnest.
  Eine Aufgabe, die **Wartet auf dich**, steht in der Gruppe jedes ihrer Tags ganz oben und bleibt sichtbar, auch wenn die Gruppe eingeklappt ist.
- Das Aufgabenboard hat eine eigene Reihe von Tags, und seine Ansicht **Nach Tag** zählt die Aufgaben jedes Tags danach, wo sie stehen.

Tags werden immer nur für ein Projekt gezeigt: das Projekt im Fokus oder dein einziges Projekt mit Tags.
Wie du dich auf ein Projekt konzentrierst, steht unter [Projekte](/de/projects/#focus-on-one-project).

## Ein Crewmitglied lenken {#steering-a-crewmate}

Du kannst einem Crewmitglied auf drei Wegen etwas sagen:

1. Schreib unter eine seiner Karten und drück auf **Chat**.
2. Schreib in das Feld am Fuß seines Tabs **Crewmitglied**.
   Ein arbeitendes Crewmitglied nimmt deine Worte während der Arbeit auf; ein freies beginnt von ihnen aus neu.
3. Sag es deinem ersten Offizier, im Nachrichtenfeld.

Um den Durchgang eines Crewmitglieds zu stoppen, drück auf seinem Tab Crewmitglied auf **Stoppen**.
Die Aufgabe bleibt offen, und du kannst ihm sagen, was es als Nächstes tun soll.

## Sorgfalt {#rigor}

Sorgfalt bestimmt, wie gründlich Arbeit überprüft wird, bevor sie dich erreicht.
Es gibt drei Stufen:

- **Schnell**: Die Überprüfungen sind erfolgreich, und wenig mehr.
- **Standard**: Das Crewmitglied zeigt die Änderung in Aktion, mit Bildern, und führt die Tests aus, auf die es ankommt.
- **Sorgfältig**: Standard, dann ein unabhängiges Review und ein Nachweis, dass die Änderung funktioniert, vor der Karte zum Zusammenführen.

Jedes Projekt hat seine eigene Sorgfalt, in Einstellungen → Projekte.
Für eine einzelne Aufgabe sag bei deiner Bitte, wie sorgfältig es sein soll, etwa „sei bei dieser besonders sorgfältig“.
Auf einer Karte zum Zusammenführen hebt **Sorgfältig prüfen** diese Aufgabe auf „Sorgfältig“.

## Vor dem Zusammenführen fragen {#asking-before-merging}

Jedes Projekt fragt entweder vor dem Zusammenführen oder führt selbst zusammen.
Der Schalter **Vor dem Zusammenführen fragen** in Einstellungen → Projekte legt das fest.
Wenn er an ist, wartet fertige Arbeit auf deine Karte zum Zusammenführen.
Wenn er aus ist, darf Arbeit, die die Überprüfungen besteht, ohne Rückfrage zusammengeführt werden, und du bekommst danach eine Karte mit ihrer Geschichte.
Um das für eine einzelne Aufgabe zu ändern, sag es deinem ersten Offizier.

## Eine Aufgabe schließen {#closing-a-task}

Die meisten Aufgaben schließen sich von selbst:

- Das Zusammenführen ihrer Änderung schließt die Aufgabe.
- **Verwerfen** auf ihrer Karte zum Zusammenführen gibt die Arbeit auf.
- **Fertig** auf einer Notiz, die deine Frage beantwortet, schließt sie als beantwortet.

Du kannst eine auch von ihrer Karte aus schließen:

- **Aufgabe aufgeben** beendet sie.
  Ein arbeitendes Crewmitglied stoppt, und seine unfertige Arbeit bleibt erhalten.
- **Als fertig schließen** sagt bei einer Aufgabe, die gestartet wurde, dass die Arbeit erledigt ist.

Eine geschlossene Aufgabe behält ihr Protokoll.
Aufgegebene Arbeit bleibt eine Woche lang auf dem Board, nur lesbar.
