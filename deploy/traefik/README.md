# Gods Eye View mit Traefik und Google-Anmeldung

Diese Vorlage ergänzt den vorhandenen Traefik auf deinem Server.
Sie verwendet das Netz `proxy`, den Eingang `websecure` und den Zertifikatsanbieter `le`.
Traefik übernimmt HTTPS. OAuth2 Proxy prüft die Google-Anmeldung und die erlaubten E-Mail-Adressen.

Der Weg lautet: Browser → Traefik → OAuth2 Proxy → App.
Beide Container veröffentlichen keinen Anschluss auf dem Server.
Nur OAuth2 Proxy erhält eine Traefik-Freigabe.
Die App verwendet ein eigenes Docker-Netz. Dieses Netz erlaubt ausgehende Anfragen an die Datenanbieter.

## Voraussetzungen

- Docker mit Linux-Containern und Docker Compose ab Version 2.24.
- Ein vorhandener Traefik mit dem Netz `proxy` und dem Zertifikatsanbieter `le`.
- Eine Domain, die auf den Server zeigt.
- Ein Image aus unserem Docker-Branch mit den Änderungen für ENV-Werte.
- Ein Google-Anmeldeclient vom Typ „Webanwendung“.

Der Fork hat noch kein Image veröffentlicht. Ein Image entsteht erst nach der Freigabe zur Veröffentlichung.
Alternativ kannst du es aus diesem Branch auf deinem Server bauen:

```bash
docker build -t gods-eye-view:local .
```

Führe diesen Befehl im Hauptordner dieses Branches aus.
Verwende danach `GEV_IMAGE=gods-eye-view:local`.
Ein Image vom Mac steht nicht automatisch auf dem Server zur Verfügung.

## Dateien und ENV-Werte

Kopiere `compose.yml` und `.env.example` gemeinsam in den App-Ordner auf dem Server.
Die Namen entsprechen deinem Muster unter `server_setup/apps/<app-name>/`.
Der Compose-Projektname lautet fest `gods-eye-view`.
Damit verwendet die App einen anderen Projektnamen als der vorhandene Traefik.

**Vorsicht:** Die `.env` enthält geheime Werte. Teile diese Datei nicht und füge sie nicht zu Git hinzu.

```bash
cp .env.example .env
chmod 600 .env
```

Trage die Werte in `.env` ein:

| Wert | Bedeutung |
| --- | --- |
| `GEV_IMAGE` | Das lokale oder veröffentlichte Image aus diesem Branch. |
| `APP_DOMAIN` | Die Domain ohne `https://`, Anschlussnummer oder Pfad. |
| `GOOGLE_CLIENT_ID` | Die Client-ID für die Google-Anmeldung. |
| `GOOGLE_CLIENT_SECRET` | Der geheime Wert für die Google-Anmeldung. |
| `OAUTH2_PROXY_COOKIE_SECRET` | Ein neuer Zufallswert für die Anmelde-Cookies. |
| `GEV_ALLOWED_EMAILS` | Die erlaubten Google-Adressen, jeweils eine pro Zeile. |
| `TRAEFIK_TRUSTED_IPS` | Die Adresse von Traefik im Netz `proxy`, mit `/32` bei IPv4. |

Die Vorlage zeigt das Format für mehrere erlaubte Adressen.
Eine leere Liste verhindert den Start. Füge keine Freigabe für alle E-Mail-Domains hinzu.
Der Dienst `prepare-login` erzeugt die Datei mit den erlaubten Adressen aus `.env`.
Er endet danach mit dem Status 0. Der Anmelde-Container liest die Datei aus einem eigenen Volume mit Schreibschutz.
Eine zusätzliche Datei auf dem Server ist dafür nicht nötig.

Erzeuge den Zufallswert für die Cookies auf dem Server:

```bash
openssl rand -base64 32 | tr -- '+/' '-_'
```

Ermittle die Adresse von Traefik auf dem Server:

```bash
docker inspect traefik --format '{{(index .NetworkSettings.Networks "proxy").IPAddress}}'
```

Ergänze `/32` hinter der IPv4-Adresse für `TRAEFIK_TRUSTED_IPS`.
Prüfe den Wert erneut, wenn Docker den Traefik-Container ersetzt.
Diese Freigabe erlaubt Traefik, Angaben zur ursprünglichen Anfrage weiterzugeben. Sie ersetzt keine Anmeldung.
Verwende nicht `0.0.0.0/0`.
Bei einem anderen Netz musst du auch `TRAEFIK_NETWORK` und den Prüfbefehl anpassen.

## Google einrichten

Erstelle in der Google-Konsole einen Anmeldeclient vom Typ „Webanwendung“.
Trage die folgenden Adressen mit deiner Domain ein:

- Ursprung: `https://gev.kaproblem.com`
- Weiterleitungsadresse: `https://gev.kaproblem.com/oauth2/callback`

Konfiguriere auch den Zustimmungsbildschirm in Google.
Füge bei einer Google-App im Testbetrieb die zugelassenen Testnutzer hinzu.
Übernimm die Client-ID und den geheimen Wert in `.env`.
Der Google-Maps-Schlüssel ist ein anderer Wert.
Die [Anleitung von OAuth2 Proxy](https://oauth2-proxy.github.io/oauth2-proxy/configuration/providers/google/) beschreibt die Einrichtung.

## Start und Prüfung

**Vorsicht:** Verwende diese Compose-Datei allein. Eine Kombination mit der lokalen `compose.yaml` kann einen direkten App-Anschluss freigeben.

Prüfe zunächst die Pflichtwerte, ohne geheime Werte auszugeben:

```bash
docker compose config --quiet
```

Starte die Container nach der Prüfung der Werte:

```bash
docker compose up -d
docker compose ps
```

Öffne die Domain in einem privaten Browserfenster.
Prüfe die Anmeldung mit einer erlaubten Google-Adresse.
Prüfe danach eine Google-Adresse, die nicht in der Liste steht. Der Zugriff muss scheitern.
Prüfe ohne Anmeldung außerdem `/api/realtime/token`. Die Antwort muss den Status `401` haben.
Prüfe nach der Anmeldung die Karte und die benötigten Live-Funktionen.
Für das Mikrofon benötigt der Browser HTTPS und deine Freigabe.

Ein Aufruf von `/oauth2/sign_out` beendet die Sitzung dieser App.
Die Google-Sitzung bleibt dabei bestehen.

## Änderungen und Grenzen

Nach einer Änderung an `.env` ersetzt du die Container:

```bash
docker compose up -d --force-recreate
```

Ein einfacher Neustart übernimmt keine neuen ENV-Werte.
Für einen sofortigen Entzug aller Sitzungen ändere zusätzlich den Cookie-Zufallswert.
Bestehende Verbindungen können bis zum Verbindungsende bestehen bleiben. Das Ersetzen des Anmelde-Containers beendet sie.

Alle erlaubten Nutzer teilen die API-Schlüssel und deren Kostenlimits.
Die App erhält damit keine eigene Kontoverwaltung, Rollen oder Kostenlimits pro Nutzer.
Die App erhält nur die ausdrücklich aufgeführten Anbieterwerte.
Ergänze weitere benötigte Anbieterwerte unter `app.environment`. Reiche nicht die gesamte `.env` an die App weiter.
Google Maps und Cesium erhalten ihre öffentlichen Schlüssel im Browser. Beschränke diese Schlüssel beim Anbieter auf deine Domain.

Die App nutzt weiterhin den vorhandenen Vite-Server für ihre Live-Funktionen.
Die Anmeldung ersetzt keine Prüfung der App für öffentliche Nutzung durch fremde Nutzer.
Diese Vorlage eignet sich für den begrenzten Zugriff durch bekannte Nutzer.
Docker-Administratoren können weiterhin auf die App und die ENV-Werte zugreifen.

Dein Prüfprogramm `check_app_networks.py` erwartet ausschließlich gemeinsame, externe Netze.
Diese Vorlage weicht davon bewusst ab: Die App darf nur ihr eigenes Netz verwenden.
Die Compose-Datei benötigt deshalb eine passende Ausnahme in diesem Prüfprogramm, falls du sie dort prüfen lässt.

## Lokale Prüfung des Entwurfs

```bash
node scripts/test-traefik-compose.mjs
```

Führe den Befehl im Hauptordner des Projekts aus.
Er prüft die Netzgrenzen, die Trennung der Schlüssel, die E-Mail-Liste und fehlende Pflichtwerte.
Er benötigt keinen laufenden Docker-Dienst. Der Docker-Workflow führt diese Prüfung ebenfalls aus.

Die lokale Prüfung mit dem offiziellen OAuth2-Proxy-Programm 7.15.4 akzeptierte die ENV-Werte.
Sie sperrte Anfragen ohne Anmeldung und prüfte die Google-Weiterleitung mit Testwerten.
Der Docker-Workflow prüft zusätzlich den echten Start mit Compose und die Sperre ohne Anmeldung.
Ein vollständiger Test mit Traefik und echten Google-Konten steht noch aus.
