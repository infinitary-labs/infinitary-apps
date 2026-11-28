---
source: 88839f4f7e511529
title: Integrationen
description: Verbinde GitHub, GitLab, Bitbucket, Google und MCP-Server, damit dein erster Offizier und deine Crew sie erreichen, und lege fest, was jede Integration ohne Rückfrage tun darf.
---

Eine Integration ist eine Verbindung zu etwas außerhalb deiner Projekte, etwa GitHub, Gmail oder einem eigenen Dienst.
Jede ist als du angemeldet.
Dein erster Offizier, deine Crew, deine Automatisierungen und deine Panels erreichen sie auf dieselbe Weise, über dieselbe Anmeldung und mit denselben Regeln.

<img class="picture-dark" src="/pictures/integrations-dark.webp" alt="Einstellungen, Bereich Integrationen: ein verbundener Notes-Server, bei dem jede Leseaktion und die Änderungsaktion auf „Fragt dich“ stehen, jeweils neben einem eingeschalteten Schalter, darunter Schaltflächen zum Hinzufügen von GitHub, Google, einem MCP-Server, Notion, Linear, Bitbucket, GitLab oder GitHub Enterprise, der ausgeschaltete Infinitary-Befehl und eine leere Liste privater Seiten." width="1180" height="709" />
<img class="picture-light" src="/pictures/integrations-light.webp" alt="Einstellungen, Bereich Integrationen: ein verbundener Notes-Server, bei dem jede Leseaktion und die Änderungsaktion auf „Fragt dich“ stehen, jeweils neben einem eingeschalteten Schalter, darunter Schaltflächen zum Hinzufügen von GitHub, Google, einem MCP-Server, Notion, Linear, Bitbucket, GitLab oder GitHub Enterprise, der ausgeschaltete Infinitary-Befehl und eine leere Liste privater Seiten." width="1180" height="709" />

## Wo Integrationen liegen {#where-integrations-live}

Öffne die **Einstellungen**, dann **Integrationen**.
Du kannst in der Befehlssuche auch nach **Integrationen öffnen** suchen.

Jede Zeile ist eine Verbindung.
Sie zeigt den Namen der Verbindung, als wer sie angemeldet ist oder was sie ausführt und wie viele ihrer Aktionen eingeschaltet sind.
Öffne eine Zeile, um ihre Aktionen zu sehen und was sie deinen Automatisierungen mitteilen kann.

Das Menü am Ende einer Zeile enthält:

- **Pausiert**: Solange der Schalter an ist, erreicht sie niemand.
- **Jetzt prüfen**: Es prüft, ob die Verbindung noch funktioniert.
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
  Für deinen eigenen Bitbucket-Data-Center-Server ab Version 8.19 gibst du seine Adresse ein und fügst ein HTTP-Zugriffstoken ein, das du dort erstellst, mit den Berechtigungen Project read und Repository write.
  Eine Data-Center-Zeile bietet dieselben Lese- und Schreibaktionen, auf den eigenen Pfaden des Servers, und **Für den Rest dieser Aufgabe erlauben** gilt für ein Repository.

Jede Zeile hat zwei Aktionen: eine, die liest, und eine, die etwas ändert, etwa **Etwas auf GitHub ändern**.
Damit schlagen dein erster Offizier und deine Crew etwas nach oder handeln dort über die eigene Arbeit einer Aufgabe hinaus.
Der Branch einer Aufgabe, ihr Pull Request, ihre Überprüfungen und ihr Zusammenführen folgen stattdessen den Einstellungen deines Projekts.

Wenn ein anderer Computer Arbeit für dich ausführt, hat auch seine eigene GitHub-Anmeldung, zum Klonen und Pushen dort, hier eine Zeile.
Siehe [Deine anderen Computer](/de/your-other-computers/).

Wenn du dich bei GitHub abmeldest, funktionieren private Klone und Pull Requests erst wieder, wenn du dich erneut anmeldest.

## Google: Gmail, Kalender, Drive, Docs und Tabellen {#google-gmail-calendar-drive-docs-and-sheets}

Google ist eine Anmeldung für Gmail, Kalender, Drive, Docs und Tabellen.
Infinitary erreicht sie über Googles eigene Gmail-, Kalender-, Drive-, Docs- und Tabellen-Server für KI-Agenten, mit deiner eigenen Google-Verbindung: einem Client, den du in deinem eigenen Google-Cloud-Projekt im persönlichen Modus von Google erstellst.
Google prüft ihn nicht, zeigt keine Warnung und beendet seine Anmeldung nicht nach 7 Tagen.

1. Drück **Google**, dann öffnet sich **Deine eigene Google-Verbindung einrichten**.
2. Drück **Googles Seite öffnen** und melde dich dort mit dem Google-Konto an, das du verbinden willst.
   Gib dem Projekt einen Namen, setz das Häkchen bei „Use this client for an AI-powered agent“ und schalt die MCP-Dienste für Gmail, Kalender, Drive, Docs und Tabellen ein.
   Akzeptiere dann Googles Richtlinie und drück Continue.
3. Lade die Client-Datei, die Google zeigt, mit Download JSON herunter.
4. Leg diese Datei auf **Client-Datei hier ablegen** ab, wähl sie mit **Datei auswählen** aus oder füg ihren Inhalt in **Client-Datei** ein.
5. Drück **Aufbewahren und anmelden**.
6. Lies **Bevor du Google verbindest**: was Infinitary aus deinem Konto verwendet, wohin es geht und wie lange es bleibt.
7. Drück **Akzeptieren und weiter zu Google**, oder **Abbrechen**, wenn Google nichts erfahren soll.
8. Schließ die Anmeldung auf der Seite von Google in deinem Browser mit dem Google-Konto ab, das deinen Client erstellt hat, und erlaube jede Berechtigung, die dort aufgeführt ist.
   Die Berechtigung für Drive umfasst dein ganzes Drive, Ordner eingeschlossen.

Infinitary bewahrt das Geheimnis des Clients in [Geheimnisse](/de/secrets/) auf diesem Computer auf, und dein erster Offizier und deine Crew sehen es nie.
Dein Client dient nur dem Google-Konto, das ihn erstellt hat.
Du richtest ihn einmal ein: Danach beginnt die Anmeldung bei Google mit dem Hinweis.
Wenn du eine Berechtigung für Gmail oder Kalender nicht ankreuzt, behält Infinitary nichts, und du kannst dich erneut anmelden.
Wenn du nur Drive nicht ankreuzt, werden Gmail und Kalender trotzdem verbunden, und die Google-Zeile zeigt **Drive, Docs und Tabellen nicht hinzugefügt**.
Drück **Erneut anmelden** in der Zeile und lass Drive auf der Seite von Google angekreuzt, um es hinzuzufügen.
Bei jeder Anmeldung bei Google erscheint zuerst der Hinweis.

Die Google-Zeile sagt es, wenn die Verbindung dich braucht:

- **Erneut anmelden**: Eine frühere Verbindung über den Client, den Infinitary mit allen geteilt hat, funktioniert nicht mehr, weil dieser Client weg ist.
  Drück **Erneut anmelden**, dann öffnet sich **Deine eigene Google-Verbindung einrichten**, damit du deinen eigenen Client erstellst und dich neu verbindest.
- **Endet**, mit einem Datum: Dein Client ist nicht im persönlichen Modus, daher beendet Google seine Anmeldung an diesem Tag.
  Drück **Erneut einrichten** und erstelle einen Client im persönlichen Modus.
- **Dein Google-Client funktioniert nicht mehr**: Google akzeptiert deinen Client nicht mehr, vielleicht weil er in Google Cloud gelöscht wurde.
  Drück **Erneut einrichten**.
- **Client für Agenten kennzeichnen**: Die Server von Google für KI-Agenten nehmen nur einen Client an, der für einen KI-gestützten Agenten gekennzeichnet ist, und deiner ist es nicht.
  Drück **Google Cloud öffnen**, setz bei deinem Client das Häkchen bei „Use this client for an AI-powered agent“ und speichere, und wähl dann **Jetzt prüfen** im Menü der Zeile.
- **Ein Google-Dienst ist ausgeschaltet**: Der MCP-Dienst für Gmail, Kalender, Drive, Docs oder Tabellen ist in deinem Google-Cloud-Projekt ausgeschaltet.
  Drück **Google Cloud öffnen**, schalt ihn ein und wähl dann **Jetzt prüfen** im Menü der Zeile.

In diesen beiden letzten Fällen bleibst du angemeldet, und nichts muss neu eingerichtet werden.

Auf deinem iPhone oder iPad richtest du die Verbindung in der Google-Zeile genauso ein: Du wählst die Client-Datei aus oder fügst ihren Inhalt ein.

Mit verbundenem Google können dein erster Offizier und deine Crew deine Mails durchsuchen und lesen, einen Anhang im Ordner einer Aufgabe speichern, eine Nachricht beschriften oder archivieren, eine Nachricht entwerfen und eine senden.
Ab dem 1. Februar 2027 lässt Google keinen KI-Agenten mehr eine an eine Nachricht angehängte Datei abrufen; von da an speicherst du sie selbst aus Gmail.
Im Kalender können sie deine Kalender und Termine auflisten, einen Termin lesen, Zeiten finden, zu denen alle frei sind, und einen Termin anlegen oder ändern.
Keine Aktion löscht einen Kalendertermin.
In Drive können sie deine Dateien durchsuchen, eine Datei als Text lesen und eine Datei im Ordner einer Aufgabe speichern, ein Google-Dokument, eine Tabelle oder eine Präsentation als PDF oder als Office-Datei exportiert.
In Docs können sie ein Dokument aus Text mit Überschriften, Listen, Fettdruck und Links erstellen, Text am Ende eines Dokuments anfügen und Wörter darin ersetzen.
In Tabellen können sie die Tabellenblätter oder Zellen einer Tabelle lesen, eine Tabelle mit ihren Tabellenblättern und ersten Zeilen erstellen, Zellen setzen und Zeilen nach der letzten gefüllten anfügen.
Jede dieser Änderungen wartet auf deine Zustimmung, und **Für den Rest dieser Aufgabe erlauben** gilt für ein Dokument oder eine Tabelle.
Keine Aktion löscht, verschiebt oder teilt eine Datei.

Google kann einen Aufruf stoppen, um zuerst dich zu fragen, auch einen, den du erlaubt hast.
Infinitary zeigt die Frage dann auf einer Karte, die Gmail, Kalender oder Drive als Fragenden nennt, mit jeder von Googles Antwortmöglichkeiten als eigener Schaltfläche, in Googles Worten.
Nichts läuft, bis du eine drückst, und deine Auswahl beantwortet nur diesen einen Aufruf.
Eine Auswahl, immer zu erlauben, speichert Google, nicht Infinitary.

Was dein erster Offizier und deine Crew lesen, bleibt 30 Tage in ihren gespeicherten Unterhaltungen.
Danach tritt ein Vermerk an die Stelle.
Um es früher zu löschen, drück **Löschen** in der Zeile **Google-Inhalte löschen** unter **Daten** am Ende des Tabs.
Ein gespeicherter Anhang oder eine gespeicherte Datei bleibt im Ordner der Aufgabe, bis die Aufgabe geschlossen wird oder 30 Tage vergehen.
Worte, die ein Crewmitglied in einem gespeicherten Anhang oder einer gespeicherten Datei gelesen hat, bleiben auch nach den 30 Tagen in seiner Unterhaltung.
Was dein erster Offizier und deine Crew selbst geschrieben haben, in Karten, Notizen und Dateien, bleibt, bis du die Aufgabe löschst.
Wenn du Google entfernst, wird auch gelöscht, was sie schon gelesen haben, so wie bei **Google-Inhalte löschen**.

Jeder kann dir Worte schicken, die geschrieben sind, um eine KI zu lenken.
Infinitary übergibt deine Mails, Termine und Dateien an deinen ersten Offizier und deine Crew als Informationen von außen gekennzeichnet, nie als Anweisungen.
Eine Nachricht oder eine Datei kann ein KI-Modell trotzdem in die Irre führen.
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

### Ein Server, der eine Anmeldung verlangt {#a-server-that-asks-you-to-sign-in}

Manche Server, die unter einer Adresse erreichbar sind, verlangen eine Anmeldung statt eines Schlüssels.
Bei ihnen öffnet **Verbinden** die Anmeldeseite des Servers in deinem Browser.
Das Formular sagt, dass du die Anmeldung dort abschließen sollst, und nennt die Adresse der Seite, mit **Seite erneut öffnen** und **Abbrechen**.
Sobald du in deinem Browser fertig bist, öffnet sich die neue Zeile mit den Aktionen des Servers.
Wenn du abbrichst, behält Infinitary keine Zeile und keinen Schlüssel.

**Notion**, **Linear** und **Atlassian**, neben **MCP-Server**, verbinden diese drei Dienste mit einem Klick.

Infinitary bewahrt die Anmeldung in [Geheimnisse](/de/secrets/) auf und erneuert sie von selbst.
Wenn der Dienst sie beendet, sagt die Zeile **muss neu angemeldet werden**, mit **Erneut anmelden** in der Zeile und in ihrem Menü.
Beim erneuten Anmelden bleibt der Schalter jeder Aktion, wie er ist, und jede Aktion steht wieder auf **Fragt dich**.
Wenn du den Server entfernst, vergisst Infinitary die Anmeldung und beendet sie beim Dienst, sofern der Dienst das zulässt.
Ein Server, der eine eigene App von dir braucht, lässt sich noch nicht verbinden, und das Formular sagt das.

Dein erster Offizier kann deinen Browser nicht öffnen.
Für einen Server, der eine Anmeldung verlangt, bringt er dir eine Karte mit **Integrationen öffnen**; damit öffnet sich das Formular schon ausgefüllt.
Was ein Server unter einer Adresse antwortet, erreicht deinen ersten Offizier und deine Crew als Informationen von außen gekennzeichnet, nie als Anweisungen.

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

## Ein Crewmitglied, das Texte liest, die jeder schreiben kann {#a-crewmate-that-reads-words-anyone-can-write}

Manche Aufgaben lesen Texte, die ein Fremder geschrieben haben könnte, etwa die Issues und Pull Requests eines öffentlichen Projekts.
Für eine solche Aufgabe kann dein erster Offizier ein Crewmitglied starten, das nur liest.
Es führt keine Programme aus, ändert keine Dateien und hat keinen Browser.
Es liest nur sein eigenes Projekt und öffentliche Webseiten und erreicht sonst nichts auf deinem Computer oder in deinem privaten Netzwerk.
Eine Webseite öffnet es ohne Anmeldung und nur als Text.

Alles, was es liest, ist als Text von außen gekennzeichnet, nie als Anweisung, und sein Bericht an deinen ersten Offizier ebenso.
Auf jeder seiner Karten steht: „Dieses Crewmitglied liest Texte, die jeder schreiben kann, darum kann ein Link oder eine Bitte auf dieser Karte von einem Fremden stammen.“

Was immer es ändern oder aufrufen will, wartet auf dich, als angehakte Zeile auf einer einzigen Genehmigungskarte, etwa „Diese Aufrufe erlauben?“.
Diese Karte bietet nur **Nur dieses Mal** und **Nicht jetzt** an.
Eine Leseaktion über eine Integration läuft nur dann ohne Rückfrage, wenn du diese Aktion auf **Immer erlaubt** gestellt hast, und auf einem MCP-Server nie.
Auch eine Aufgabe, die es aus einem Issue vorschlägt, wartet auf der Karte, mit **Jetzt starten**, **Für später behalten** und **Nicht ablegen**.

Solange es nichts von dir hat, öffnet es jede öffentliche Webseite sofort.
Es hat etwas von dir, sobald es ein Projekt gelesen hat, das nicht öffentlich ist, oder die Antwort einer Integration.
Von da an öffnet es eine Seite, die seine Aufgabe nennt, weiterhin sofort.
Jede andere Adresse wartet als Zeile auf der Karte „Webseiten öffnen?“, mit der ganzen Adresse, denn eine Adresse kann das Gelesene an den Betreiber der Website tragen.

## Was eine Integration melden kann {#what-an-integration-can-tell}

Manche Verbindungen melden, wenn etwas passiert, und eine Automatisierung kann darauf warten.
Eine geöffnete Zeile listet diese mit der Markierung **meldet**.

- GitHub: **Ein Workflow-Lauf schlägt fehl** und **Ein Workflow-Lauf endet**, in einem Repository, das du nennst.
- Gmail: **Eine Nachricht kommt an**.
- Kalender: **Ein Kalendertermin ändert sich**.
- Ein MCP-Server, der es anbietet: **Eine Ressource hat sich geändert**.

Eine Gmail-Automatisierung erfährt ein bis zwei Minuten nach dem Eingang, welche Unterhaltung neue Mail bekommen hat; die Mail selbst zu lesen ist ein eigener Schritt, zu dem Google dich vorher fragen kann.

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
