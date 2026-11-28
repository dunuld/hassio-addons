# Home Assistant Add-on: ING Depot

Das Add-on liest PDFs aus dem ING-Depot und erstellt daraus eine Jahresübersicht: investierte
Beträge, realisierte Gewinne, ausgezahlte Dividenden und Kursgewinne.

> **Hinweis:** Der PDF-Parser ist an echten Dokumenten des ING Direkt-Depots (Stand 2026) erprobt:
> Depotauszug, Kauf aus Sparplan, Verkauf und Ertragsgutschrift. Dividenden in Fremdwährung und
> Einzelkäufe mit Provision sind nach dem bekannten Aufbau umgesetzt, aber noch nicht an echten
> Dokumenten geprüft. Wird ein Dokument nicht erkannt, melde das bitte als
> [Issue](https://github.com/dunuld/hassio-addons/issues) – ohne persönliche Daten.

## Installation

1. Das Repository `https://github.com/dunuld/hassio-addons` im Add-on Store hinzufügen
   (**Einstellungen → Add-ons → Add-on Store → ⋮ → Repositories**).
2. Im Add-on Store nach **ING Depot** suchen und auf **Installieren** klicken.
3. Das Add-on **starten**.
4. Optional **In Seitenleiste anzeigen** aktivieren.
5. Über **Benutzeroberfläche öffnen** oder das Panel in der Seitenleiste starten.

## Konfiguration

| Option            | Standard           | Bedeutung                                                                                                                                                                     |
| ----------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inbox_folder`    | `/share/ing_depot` | Eingangsordner, aus dem PDFs automatisch importiert werden. Leer lassen, um ihn abzuschalten.                                                                                 |
| `publish_sensors` | `true`             | Kennzahlen des laufenden Jahres als Sensoren an Home Assistant melden.                                                                                                        |
| `exemption_order` | `0`                | Freistellungsauftrag in Euro (z. B. `1000`). Bei `0` wird die Nutzung nicht angezeigt.                                                                                        |
| `price_update`    | `daily`            | Online-Kurse von Yahoo Finance: `daily` = einmal täglich nach Börsenschluss (22:30 Uhr), `intraday` = zusätzlich laufend während der Handelszeit, `off` = nur auf Knopfdruck. |
| `price_interval`  | `15`               | Abstand der Abrufe in Minuten bei `intraday` (5–120).                                                                                                                         |

Der Zugriff erfolgt ausschließlich über Home Assistant Ingress; es werden keine Ports nach außen
geöffnet.

## Nutzung

### PDFs importieren

Unterstützt werden diese Dokumente aus der ING-Postbox:

| Dokument                                           | Verwendung                                                                   |
| -------------------------------------------------- | ---------------------------------------------------------------------------- |
| Wertpapierabrechnung Kauf (auch Sparplan)          | Investition, Einstandswert, Kurs                                             |
| Wertpapierabrechnung Verkauf                       | Realisierter Gewinn (laut Bank), Gebühren, Steuern                           |
| Wertpapierabrechnung zum steuerrelevanten Umtausch | Abgang des alten und Zugang des neuen Wertpapiers (z. B. Fondsverschmelzung) |
| Vorabpauschale                                     | Steuern, Nutzung des Freistellungsauftrags                                   |
| Ertragsabrechnung (Dividende, Ausschüttung)        | Dividenden brutto/netto, Steuern                                             |
| Depotauszug / Jahresdepotauszug                    | Kurse zum Stichtag, Kontrolle der Stückzahlen, Startpunkt                    |

Es gibt zwei Wege:

- **Upload**: Auf der Seite **Import** PDFs auswählen oder hineinziehen (mehrere gleichzeitig).
- **Eingangsordner**: PDFs in `/share/ing_depot` legen (z. B. über das Samba-Add-on). Der Ordner
  wird jede Minute geprüft. Importierte Dateien wandern nach `importiert/`, nicht erkannte nach
  `fehler/` und erscheinen auf der Seite **Import** unter „Nicht erkannt“.

Jedes Dokument wird nur einmal importiert – erkannt an der Datei und an der Ordernummer bzw. dem
Inhalt. Löschst du ein Dokument, verschwinden auch seine Buchungen.

### Umtausch und Vorabpauschale

- **Umtausch** (z. B. Fondsverschmelzung): Das alte Wertpapier geht zum Kurswert ab – der
  Veräußerungsgewinn der Bank zählt als realisierter Gewinn –, das neue kommt mit demselben Wert als
  Einstandswert hinzu. Es fließt kein Geld, daher zählt der Umtausch nicht als Investition.
  Nennt die Abrechnung das neue Wertpapier nur mit WKN, erscheint es vorläufig als „WKN …“ und wird
  automatisch zugeordnet, sobald ein Dokument mit dieser WKN importiert wird (z. B. ein
  Depotauszug).
- **Vorabpauschale**: Sie wird bei thesaurierenden Fonds jährlich versteuert, ohne dass etwas
  ausgezahlt wird. Das Add-on zählt sie nicht als Dividende, sondern zu den Steuern und zur Nutzung
  des Freistellungsauftrags; die Übersicht nennt die Summe des Jahres in der Fußzeile.

### Mehrere Depots

Jedes Dokument wird anhand der Depotnummer („Direkt-Depot Nr.“) einem Depot zugeordnet; neue
Depots werden beim Import automatisch angelegt. Auf den Seiten **Übersicht** und **Buchungen**
wählst du ein Depot oder **Alle Depots** – dann werden die Depots einzeln gerechnet und die
Ergebnisse addiert. Auf der Seite **Depots** kannst du jedem Depot eine Bezeichnung geben.

Schwärzt du Dokumente, ersetze die Depotnummer durch eine erfundene, aber innerhalb eines Depots
gleiche Nummer – sonst landen die Dokumente in „Depot ohne Nummer“.

### Startpunkt und Startbestand

Realisierte Gewinne und Kursgewinne brauchen den Einstandswert. Am genauesten ist es, **alle
Kaufabrechnungen seit Depoteröffnung** zu importieren. Fehlen ältere Abrechnungen, gibt es zwei
Wege:

- **Depotauszug als Startpunkt** (Seite **Depots**): Ab dem Stichtag des gewählten Auszugs wird
  gerechnet. Die Bestände des Auszugs gehen mit ihrem **Kurswert als Einstandswert** ein; ältere
  Buchungen bleiben gespeichert, zählen aber nicht. „Kursgewinn seit Kauf“ bezieht sich dann auf
  den Wert am Startpunkt. Liegt der Startpunkt im gewählten Jahr, gelten alle Jahreswerte ab
  seinem Stichtag (z. B. „Investiert seit 31.03.2026“).
- **Startbestand** (Seite **Buchungen**): Stückzahl und tatsächlichen Einstandswert einzelner
  Wertpapiere von Hand eintragen.

Die Übersicht weist darauf hin, wenn Käufe fehlen oder der Bestand vom jüngsten Depotauszug
abweicht.

### Kennzahlen

Alle Jahreswerte beziehen sich auf den Zeitraum ab 01.01. des gewählten Jahres (bzw. ab einem
Startpunkt in diesem Jahr).

- **Investiert**: Summe aller Käufe inklusive Gebühren; „netto“ zieht Verkaufserlöse ab.
- **Realisierte Gewinne**: der Veräußerungsgewinn bzw. -verlust, den die ING auf der
  Verkaufsabrechnung ausweist – die Bank kennt die vollständige Kaufhistorie. Fehlt die Angabe,
  rechnet das Add-on selbst: Verkaufserlös nach Gebühren minus Einstandswert der verkauften Stücke,
  zuerst gekaufte Stücke gelten als zuerst verkauft (FIFO). Der Wert ist vor Steuern.
- **Dividenden ausgezahlt**: Gutschriften nach Steuern; zusätzlich der Bruttobetrag.
- **Kursgewinn seit Kauf**: aktueller Wert minus Einstandswert des Bestands.
- **Kursgewinn seit 01.01.**: aktueller Wert plus Verkaufserlöse, minus Wert am 31.12. des
  Vorjahres und minus Käufe des Jahres. Den Kurs zum 31.12. liefert der Jahresdepotauszug oder der
  Online-Abruf; fehlt beides, wird ersatzweise mit dem Einstandswert gerechnet. Verkäufe von Stücken ohne bekannten Kauf
  zählen hier nicht mit.
- **Freistellungsauftrag**: rechnerische Nutzung aus Bruttoerträgen plus realisierten Gewinnen –
  eine Näherung, maßgeblich ist die Abrechnung der Bank.

### Kurse

Der aktuelle Kurs einer Position stammt aus der jeweils jüngsten Quelle:

1. **Dokumente**: Kurs der letzten Abrechnung bzw. des letzten Depotauszugs.
2. **Online (Yahoo Finance)**: siehe unten.
3. **Home-Assistant-Entität**: In der Positionsliste auf **Kurs** klicken und eine Entität
   hinterlegen (z. B. `sensor.msci_world`), deren Zustand der Kurs in Euro ist. Das Add-on liest sie
   alle 15 Minuten.
4. **Manuell**: In der Positionsliste auf **Kurs** klicken und den aktuellen Kurs eintragen.

Liegen für einen Tag mehrere Kurse vor, gilt die Reihenfolge der Liste – ein manueller Kurs
schlägt alle anderen desselben Tages.

### Online-Kurse

Das Add-on ruft die Kurse aller gehaltenen Wertpapiere bei **Yahoo Finance** ab – je nach
Einstellung `price_update` einmal täglich nach Börsenschluss oder laufend während der Handelszeit
(Börsentage 08:00–22:30 Uhr). Über **Kurse jetzt aktualisieren** in der Übersicht lässt sich der
Abruf jederzeit anstoßen, auch mit `price_update: off`. Die Statuszeile zeigt den letzten Abruf und
eventuelle Probleme.

- **Kürzel:** Das Yahoo-Kürzel wird beim ersten Abruf über die ISIN gesucht; Börsenplätze in Euro
  (Xetra zuerst) werden bevorzugt. Findet Yahoo nur eine Notierung in einer anderen Währung (z. B.
  bei irischen ETFs oder US-Aktien), wird der Kurs mit dem aktuellen Devisenkurs in EUR umgerechnet
  und auf Cent gerundet. Er kann dadurch leicht vom Xetra-Kurs abweichen.
- **Eigenes Kürzel:** Unter **Kurs** in der Positionsliste kannst du ein Kürzel fest eintragen, z. B.
  `VGWL.DE` für den Vanguard FTSE All-World an Xetra. Das Kürzel findest du auf
  [finance.yahoo.com](https://finance.yahoo.com) über die Suche nach dem Wertpapier.
- **Abschalten:** Dort lässt sich der Online-Abruf je Wertpapier auch abschalten.
- **Kurs zum 31.12.:** Fehlt für ein zum Jahresende gehaltenes Wertpapier ein Kurs aus den letzten
  Tagen des Jahres (etwa weil der Jahresdepotauszug fehlt), holt das Add-on den Schlusskurs nach.
  Damit stimmt der „Kursgewinn seit 01.01.“ auch ohne Auszug.

Yahoo Finance ist eine inoffizielle, frei zugängliche Schnittstelle ohne Zugangsschlüssel. Sie kann
sich ohne Ankündigung ändern oder Anfragen zeitweise ablehnen; dann behält das Add-on die zuletzt
bekannten Kurse. Übertragen werden dabei nur ISINs bzw. Kürzel, keine Depotdaten.

### Sensoren

Mit `publish_sensors: true` stellt das Add-on diese Sensoren bereit (Werte des laufenden Jahres):

| Entität                                     | Inhalt                              |
| ------------------------------------------- | ----------------------------------- |
| `sensor.ing_depot_wert`                     | Depotwert                           |
| `sensor.ing_depot_investiert_jahr`          | Investiert (Käufe inkl. Gebühren)   |
| `sensor.ing_depot_investiert_netto_jahr`    | Investiert abzüglich Verkaufserlöse |
| `sensor.ing_depot_realisierte_gewinne_jahr` | Realisierte Gewinne                 |
| `sensor.ing_depot_dividenden_jahr`          | Ausgezahlte Dividenden (netto)      |
| `sensor.ing_depot_kursgewinn`               | Kursgewinn seit Kauf in €           |
| `sensor.ing_depot_kursgewinn_prozent`       | Kursgewinn seit Kauf in %           |
| `sensor.ing_depot_kursgewinn_jahr`          | Kursgewinn seit Jahresbeginn in €   |
| `sensor.ing_depot_kursgewinn_jahr_prozent`  | Kursgewinn seit Jahresbeginn in %   |

Die Sensoren werden nach jedem Import und alle 15 Minuten aktualisiert. Nach einem Neustart von
Home Assistant erscheinen sie erst mit der nächsten Aktualisierung wieder.

### Darstellung

Über den Theme-Umschalter in der Navigation wählst du zwischen Hell, Dunkel und System. Im Modus
„System“ übernimmt das Panel Farben, Schrift und Hell/Dunkel des aktiven Home-Assistant-Themes.

## Grenzen

- Aktiensplits, Spin-offs, Ein- und Auslieferungen werden nicht ausgewertet. Fondsverschmelzungen
  werden nur erkannt, wenn die ING sie als „Wertpapierabrechnung zum steuerrelevanten Umtausch“
  abrechnet.
- Beträge werden in Euro geführt; Fremdwährungsdividenden mit dem umgerechneten Betrag der
  Abrechnung.
- Die Übersicht ersetzt keine Steuerbescheinigung.

## Datenspeicherung

Datenbank (`depot.db`) und Original-PDFs (`documents/`) liegen im persistenten Add-on-Verzeichnis
`/data`, das bei Updates erhalten bleibt und in Home-Assistant-Backups des Add-ons enthalten ist.
Depotdaten werden nicht an Dritte übertragen; der Online-Kursabruf fragt bei Yahoo Finance nur
ISINs bzw. Kürzel der gehaltenen Wertpapiere ab.

## Support

- [GitHub Issues](https://github.com/dunuld/hassio-addons/issues) – Fehler melden oder
  Verbesserungen vorschlagen
- [GitHub Discussions](https://github.com/dunuld/hassio-addons/discussions) – Fragen stellen und
  Ideen teilen

## Lizenz

MIT – siehe [LICENSE](https://github.com/dunuld/hassio-addons/blob/main/LICENSE).
