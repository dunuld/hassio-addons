# Changelog

## 1.1.0 (2026-11-28)

### Hinzugefügt

- Import von „Wertpapierabrechnung zum steuerrelevanten Umtausch“ (z. B. Fondsverschmelzung):
  Abgang zum Kurswert mit Veräußerungsgewinn der Bank, Zugang des neuen Wertpapiers zum selben
  Einstandswert, ohne Investition. Ist das neue Wertpapier nur per WKN genannt, wird es später
  automatisch zugeordnet (z. B. über einen Depotauszug)
- Import von Vorabpauschalen: zählen zu Steuern und Freistellungsauftrag, Summe in der Übersicht
- Eigenes Icon und Logo für den Add-on Store

### Behoben

- Umtausch-Abrechnungen und Vorabpauschalen wurden beim Import als unbekannt abgelehnt

### Technik

- Schema v4: Dokument- und Buchungsart ohne CHECK-Einschränkung (Tabellen werden beim Start einmalig
  umgebaut)

## 1.0.0 (2026-11-28)

### Hinzugefügt

- Import von ING-PDFs: Wertpapierabrechnungen (Kauf, Sparplan, Verkauf), Ertragsabrechnungen und
  Depotauszüge – per Upload oder aus einem Eingangsordner, mit Duplikaterkennung
- Jahresübersicht ab 01.01.: investierter Betrag (brutto/netto), realisierte Gewinne (FIFO),
  ausgezahlte Dividenden, Kursgewinn seit Kauf und seit Jahresbeginn in Euro und Prozent
- Positionsliste, Monatsverlauf, Buchungsliste und manueller Startbestand
- Kurse aus Dokumenten, manuell oder aus einer Home-Assistant-Entität
- Kennzahlen als Home-Assistant-Sensoren (`sensor.ing_depot_*`)
- Hinweise bei Datenlücken (fehlende Käufe, fehlende Kurse, Abweichung zum Depotauszug)
- Mehrere Depots: Zuordnung anhand der Depotnummer, Auswahl je Depot oder alle zusammen,
  eigene Bezeichnungen
- Depotauszug als Startpunkt: Rechnung ab dessen Stichtag mit den Kurswerten als Einstandswert
- Realisierter Gewinn aus dem Veräußerungsgewinn der Verkaufsabrechnung
- Parser an echten Dokumenten des ING Direkt-Depots ausgerichtet (Depotauszug, Sparplan, Verkauf,
  Ertragsgutschrift)
- Online-Kurse von Yahoo Finance: Abruf einmal täglich nach Börsenschluss oder laufend während der
  Handelszeit (Option `price_update`, Abstand über `price_interval`), dazu „Kurse jetzt
  aktualisieren“ in der Übersicht
- Kürzel werden per ISIN gefunden (Xetra bevorzugt); Kurse in Fremdwährung werden mit dem
  Devisenkurs in EUR umgerechnet; je Wertpapier lassen sich ein eigenes Kürzel eintragen und der
  Online-Abruf abschalten
- Fehlende Schlusskurse zum 31.12. werden nachgeholt, damit der „Kursgewinn seit 01.01.“ auch ohne
  Jahresdepotauszug stimmt

### Technik

- Angular 22, Node.js 24/Express (TypeScript), SQLite (`node:sqlite`), pdf.js
- Zugriff ausschließlich über Home Assistant Ingress (IP-Filter auf den Ingress-Proxy)
