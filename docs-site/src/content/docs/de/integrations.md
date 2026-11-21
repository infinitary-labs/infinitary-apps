---
source: 48dd73d5a1c0ec46
title: Integrationen
description: Verbinde GitHub, GitLab, Bitbucket, Google und MCP-Server, damit dein erster Offizier und deine Crew sie erreichen, und lege fest, was jede Integration ohne Rückfrage tun darf.
---

Eine Integration ist eine Verbindung zu etwas außerhalb deiner Projekte, etwa GitHub, Gmail oder einem eigenen Dienst.
Jede ist als du angemeldet.
Dein erster Offizier, deine Crew, deine Automatisierungen und deine Panels erreichen sie auf dieselbe Weise, über dieselbe Anmeldung und mit denselben Regeln.

<img class="picture-dark" src="/pictures/integrations-dark.webp" alt="Einstellungen, Bereich Integrationen: ein verbundener Notes-Server, bei dem jede Leseaktion und die Änderungsaktion auf „Fragt dich“ stehen, jeweils neben einem eingeschalteten Schalter, darunter Schaltflächen zum Hinzufügen von GitHub, Google, einem MCP-Server, GitLab oder GitHub Enterprise, der ausgeschaltete Infinitary-Befehl und eine leere Liste privater Seiten." width="1180" height="709" />
<img class="picture-light" src="/pictures/integrations-light.webp" alt="Einstellungen, Bereich Integrationen: ein verbundener Notes-Server, bei dem jede Leseaktion und die Änderungsaktion auf „Fragt dich“ stehen, jeweils neben einem eingeschalteten Schalter, darunter Schaltflächen zum Hinzufügen von GitHub, Google, einem MCP-Server, GitLab oder GitHub Enterprise, der ausgeschaltete Infinitary-Befehl und eine leere Liste privater Seiten." width="1180" height="709" />

## Wo Integrationen liegen {#where-integrations-live}

Öffne die **Einstellungen**, dann **Integrationen**.
Du kannst in der Befehlssuche auch nach **Integrationen öffnen** suchen.

Jede Zeile ist eine Verbindung.
Sie zeigt den Namen der Verbindung, als wer sie angemeldet ist oder was sie ausführt und wie viele ihrer Aktionen eingeschaltet sind.
Öffne eine Zeile, um ihre Aktionen zu sehen und was sie deinen Automatisierungen mitteilen kann.

Das Menü am Ende einer Zeile enthält:

- **Jetzt prüfen**: Es prüft, ob die Verbindung noch funktioniert.
- **Pausieren**: Niemand erreicht sie, bis du sie **Fortsetzen** lässt.
- **Abmelden und entfernen**, bei einem MCP-Server **Entfernen**.

Die Schaltflächen unter der Liste verbinden etwas Neues, zum Beispiel **GitHub**, **Google** oder **MCP-Server**.
Du kannst auch deinen ersten Offizier bitten, etwas zu verbinden.
Eine Anmeldung machst immer du selbst, deshalb bringt dir dein erster Offizier eine Karte, die diesen Tab öffnet.

## GitHub, GitLab, GitHub Enterprise und Bitbucket {#github-gitlab-github-enterprise-and-bitbucket}

Deine Anmeldung dort, wo deine Projekte liegen, wird hier aufbewahrt.
Unter [Projekte](/de/projects/#your-github-gitlab-or-bitbucket-sign-in) steht, wie Infinitary sie nutzt, um ein Projekt zu klonen und seine Änderungen anzubieten.

- **GitHub**: Du gibst auf der Seite von GitHub in deinem Browser einen Code ein.
  Wenn GitHub CLI auf diesem Computer ist und deine Organisation Apps wie Infinitary blockiert, nutzt **GitHub CLI verwenden** die Anmeldung, die GitHub CLI schon hat.
- **GitLab**: Du meldest dich in deinem Browser an oder fügst einen Schlüssel ein, auf gitlab.com oder auf deinem eigenen GitLab-Server.
- **GitHub Enterprise**: Du erstellst auf deinem eigenen Server einen Schlüssel und fügst ihn hier ein.
- **Bitbucket**: Du erstellst in deinem Atlassian-Konto ein API-Token und fügst es hier ein, für bitbucket.org.

Jede Zeile hat zwei Aktionen: eine, die liest, und eine, die etwas ändert, etwa **Etwas auf GitHub ändern**.
Damit schlagen dein erster Offizier und deine Crew etwas nach oder handeln dort über die eigene Arbeit einer Aufgabe hinaus.
Der Branch einer Aufgabe, ihr Pull Request, ihre Überprüfungen und ihr Zusammenführen folgen stattdessen den Einstellungen deines Projekts.

Wenn ein anderer Computer Arbeit für dich ausführt, hat auch seine eigene GitHub-Anmeldung, zum Klonen und Pushen dort, hier eine Zeile.
Siehe [Deine anderen Computer](/de/your-other-computers/).

Wenn du dich bei GitHub abmeldest, funktionieren private Klone und Pull Requests erst wieder, wenn du dich erneut anmeldest.

## Google: Gmail und Kalender {#google-gmail-and-calendar}

Google ist eine Anmeldung für Gmail und Kalender zusammen.

1. Drück **Google**.
2. Lies **Bevor du Google verbindest**: was Infinitary aus deinem Konto verwendet, wohin es geht und wie lange es bleibt.
3. Drück **Akzeptieren und weiter zu Google**, oder **Abbrechen**, wenn Google nichts erfahren soll.
4. Schließ die Anmeldung auf der Seite von Google in deinem Browser ab und erlaube jede Berechtigung, die dort aufgeführt ist.

Wenn du eine Berechtigung nicht ankreuzt, behält Infinitary nichts, und du kannst dich erneut anmelden.
Bei jeder Anmeldung bei Google erscheint zuerst der Hinweis.

Mit verbundenem Google können dein erster Offizier und deine Crew deine Mails durchsuchen und lesen, einen Anhang im Ordner einer Aufgabe speichern, eine Nachricht beschriften oder archivieren, eine Nachricht entwerfen und eine senden.
Im Kalender können sie deine Kalender und Termine auflisten, einen Termin lesen, lesen, wann du beschäftigt bist, und einen Termin anlegen oder ändern.
Keine Aktion löscht einen Kalendertermin.

Was dein erster Offizier und deine Crew lesen, bleibt 30 Tage in ihren gespeicherten Unterhaltungen.
Danach tritt ein Vermerk an die Stelle.
Um es früher zu löschen, drück **Löschen** in der Zeile **Gmail- und Kalenderinhalte löschen** unter **Daten** am Ende des Tabs.
Ein gespeicherter Anhang bleibt im Ordner seiner Aufgabe, bis die Aufgabe geschlossen wird oder 30 Tage vergehen.
Worte, die ein Crewmitglied in einem gespeicherten Anhang gelesen hat, bleiben auch nach den 30 Tagen in seiner Unterhaltung.
Was dein erster Offizier und deine Crew selbst geschrieben haben, in Karten, Notizen und Dateien, bleibt, bis du die Aufgabe löschst.
Wenn du Google entfernst, wird nichts von dem gelöscht, was sie schon gelesen haben.

Jeder kann dir Worte schicken, die geschrieben sind, um eine KI zu lenken.
Infinitary übergibt deine Mails und Termine an deinen ersten Offizier und deine Crew als Informationen von außen gekennzeichnet, nie als Anweisungen.
Eine Nachricht kann ein KI-Modell trotzdem in die Irre führen.
Ein Crewmitglied kann ohne Rückfrage ins Internet, deshalb könnte ein in die Irre geführtes Crewmitglied weitergeben, was es gelesen hat.

## MCP-Server {#mcp-servers}

Ein MCP-Server ist ein Programm oder eine Webadresse, die KI-Apps Aktionen anbietet.

1. Drück **MCP-Server**.
2. Gib ihm einen **Namen**.
3. Gib unter **Führt aus** ein Programm mit seinen Argumenten ein oder die https-Adresse des Servers.
4. Drück **Verbinden**.

Ein Programm startet auf diesem Computer, wenn jemand es benutzt.
Infinitary verbindet sich sofort und öffnet die neue Zeile mit der eigenen Aktionsliste des Servers.
Wenn die Verbindung nicht klappt, sagt das Formular, warum.

Wenn der Server einen Schlüssel braucht, setz ihn selbst an den Anfang der Zeile **Führt aus**, zum Beispiel `EXAMPLE_KEY=your-key npx -y @example/mcp-server`.
Infinitary verschiebt den Schlüssel in die [Geheimnisse](/de/secrets/), und die Zeile behält nur einen Verweis darauf.
Der Server bekommt den Schlüssel bei jedem Start, ohne dich zu fragen.
Dein erster Offizier und deine Crew sehen ihn nie.
Wenn du den Server entfernst, vergisst Infinitary seine Schlüssel.

## Was jede Aktion ohne Rückfrage tun darf {#what-each-action-may-do-without-asking-you}

Eine geöffnete Zeile listet jede Aktion mit dem, was sie tut: **liest**, **ändert** oder **sendet**.
Jede Aktion beginnt bei **Fragt dich**, auch Leseaktionen.
Drück auf ihre Regel, um zwischen **Fragt dich** und **Immer erlaubt** zu wechseln.
Nur du kannst eine Regel ändern.
Der Schalter neben einer Aktion schaltet sie aus, und dann kann niemand sie ausführen.

Wenn dein erster Offizier oder ein Crewmitglied eine Aktion nutzt, die dich fragt, zeigt Infinitary eine eigene Genehmigungskarte.
Die Karte zeigt genau, was ausgeführt würde, und den Grund, der dafür genannt wurde.

- **Immer erlauben** führt sie aus, und diese Aktion läuft dann ohne Rückfrage, bis du es in den Einstellungen änderst, die Verbindung ersetzt oder sich die Aktion ändert.
- **Für den Rest dieser Aufgabe erlauben**, bei der Bitte eines Crewmitglieds, führt sie aus und lässt dieses Crewmitglied dieselbe Aktion am selben Ort ohne Rückfrage ausführen, bis seine Aufgabe geschlossen wird.
  Die Karte sagt, was der Ort ist, etwa ein Repository auf GitHub oder die Empfänger einer Nachricht.
- **Nur dieses Mal** führt sie einmal aus.
- **Nicht jetzt** führt nichts aus.

Wenn ein Crewmitglied mehrmals auf einer Verbindung fragt, teilen sich die Bitten eine Karte, mit einer Zeile je Bitte und einem angekreuzten Kästchen **Erlauben**.
Entferne bei einer Zeile das Häkchen, und sie läuft nie.
Wenn du die Karte beiseitelegst, bleiben ihre Bitten offen.

Wenn Infinitary nicht sagen kann, ob eine Änderung angekommen ist, sendet es sie nie erneut.
Was eine Integration antwortet, sind Informationen für deinen ersten Offizier und deine Crew, nie eine Anweisung.

Auch ein Panel kann die Integrationen nutzen, die es nennt.
Seine Bitten lösen dieselbe Karte aus, auf der das Panel genannt wird.
Siehe [Panels](/de/panels/).

## Was eine Integration melden kann {#what-an-integration-can-tell}

Manche Verbindungen melden, wenn etwas passiert, und eine Automatisierung kann darauf warten.
Eine geöffnete Zeile listet diese mit der Markierung **meldet**.

- GitHub: **Ein Workflow-Lauf schlägt fehl** und **Ein Workflow-Lauf endet**, in einem Repository, das du nennst.
- Gmail: **Eine Nachricht kommt an**.
- Kalender: **Ein Kalendertermin ändert sich**.
- Ein MCP-Server, der es anbietet: **Eine Ressource hat sich geändert**.

Wähl eines unter **Wenn etwas passiert** in der Automatisierung.
Siehe [Automatisierung](/de/automation/#when-it-runs).

## Der Infinitary-Befehl {#the-infinitary-command}

Das Feld **Infinitary-Befehl** ist für Programme, die du auf diesem Computer ausführst, und für deine eigenen KI-Agenten.
Mit einem einzigen Befehl können sie deine Karten und Aufgaben lesen und bearbeiten und als du mit deinem ersten Offizier sprechen.
Ein Crewmitglied bekommt ihn nie.

Er ist aus, bis du ihn einschaltest.
Ist er an, zeigt das Feld die Zeile zum Ausführen mit **Kopieren**, und **Verknüpfen** bietet, wo es geht, einen kürzeren Namen an.
Beim ersten Einschalten schaltet sich auch eine Automatisierung ein, **Infinitary-Posteingangsereignisse**, damit dein erster Offizier von jeder Notiz erfährt, die ein Programm sendet.
Eine Notiz ist eine Information, nie eine Anweisung.

Schalt ihn aus, und der Befehl antwortet mit einem Fehler, während die gespeicherten Notizen bleiben.
**Infinitary-Posteingangsnotizen löschen** unter **Daten** entfernt die Notizen und schaltet ihn aus.

## Private Websites {#private-sites}

Das Feld **Private Websites** listet Seiten in deinem Büro-, Heim- oder VPN-Netzwerk auf, die Aufgabenbrowser öffnen dürfen.
Die Liste gilt auf allen deinen Computern.
Drück **Seite**, um eine hinzuzufügen, oder **Entfernen**, um eine zu entfernen.
Dein erster Offizier fügt nie selbst eine Seite hinzu: Er fragt dich auf einer Karte, und nur dein **Erlauben** fügt sie hinzu.
Siehe [Der Browser der Crew](/de/the-crews-browser/#private-sites).

## Weiter {#next}

- [Geheimnisse](/de/secrets/)
- [Automatisierung](/de/automation/)
