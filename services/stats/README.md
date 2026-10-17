# FORGE-Statistik (services/stats)

Kleiner Dienst unter https://forge-stats.vanturis.de. Er nimmt die anonymen Nutzungszahlen der FORGE-Desktop-App an und zeigt die Summen aller Installationen öffentlich auf der Seite „FORGE in Zahlen“.

Der Ordner gehört nicht zum pnpm-Workspace von FORGE. Er hat ein eigenes `package.json` und ein eigenes `pnpm-lock.yaml`.

Stack: Next.js (App Router), TypeScript strict, `pg`, `zod`. Schlichtes CSS ohne Framework.

Die Seite übernimmt das Design der Desktop-App: Die Farb-, Schrift- und Radius-Tokens aus `apps/desktop/src/styles.css` stehen als CSS-Variablen in `src/app/globals.css` (nur das dunkle Theme, ein helles hat die App nicht). Die Bausteine in `src/components/blocks.tsx` bilden die Kacheln des Tagesberichts und die Karten der Einstellungen nach. Ändert die App ihre Tokens, hier nachziehen. Schrift ist Geist (Paket `geist`, SIL Open Font License, per `next/font` eingebunden), Icons kommen aus `lucide-react`. Logo und Favicon sind Kopien von `apps/desktop/src/assets/forge-logo.png` und `logo.svg`.

## Was gespeichert wird

Eine Zeile pro Installation in der Tabelle `installs`: zufällige Installations-ID, erste und letzte Meldung, FORGE-Version, Betriebssystem und die kumulativen Zähler als JSON. Die App schickt immer den Gesamtstand, der Dienst überschreibt den letzten Stand.

Keine IP-Adressen in der Datenbank oder in Logs. Für die Sperre gegen massenhaft neue IDs hält der Prozess gesalzene Hashes der IP-Adressen im Speicher, nur für den laufenden Tag.

Die Tabelle legt der Dienst beim ersten Zugriff selbst an (`CREATE TABLE IF NOT EXISTS`). Eine Migration ist nicht nötig.

## API

| Methode und Pfad | Zweck | Antworten |
| --- | --- | --- |
| `POST /api/v1/report` | Stand einer Installation melden | 204; 400 ungültig; 413 Body über 4 KB; 429 zu häufig; 503 DB weg |
| `DELETE /api/v1/report/<installId>` | Datensatz löschen (Statistik in FORGE abgeschaltet) | 204, auch wenn es ihn nicht gab; 400 keine UUID v4 |
| `GET /api/v1/totals` | Summen als JSON, `Cache-Control: public, max-age=300` | 200; 503 |
| `GET /api/v1/downloads` | Downloads des Installers (`*-setup.exe`) über alle Releases, ohne Updates, Signaturen und Marker; für das README-Badge, höchstens alle 30 Minuten von GitHub | 200; 503 |
| `GET /api/health` | Healthcheck mit DB-Abfrage | 200 `ok`; 503 |
| `GET /` | Öffentliche Seite | 200, bei DB-Ausfall mit Hinweis statt Zahlen |

Body der Meldung:

```json
{
  "schema": 1,
  "installId": "<uuid v4>",
  "appVersion": "0.1.80",
  "os": "Windows 10.0.26200",
  "counters": {
    "tokensInput": 0, "tokensOutput": 0, "tokensCacheRead": 0, "tokensCacheWrite": 0,
    "claudeTurns": 0, "claudeWorkMs": 0, "sessions": 0, "projectsCreated": 0,
    "agentsStarted": 0, "agentsMerged": 0, "phoneCalls": 0
  }
}
```

Regeln (siehe `src/lib/report.ts`):

- Zähler sind ganze Zahlen ab 0. Unbekannte Schlüssel werden ignoriert, fehlende zählen als 0.
- Obergrenzen pro Installation: Token-Felder 10^12, `claudeWorkMs` 10^11, alle anderen 10^7. Darüber: 400.
- `appVersion` höchstens 32 Zeichen aus `[0-9A-Za-z.+-]`, `os` höchstens 64 Zeichen ohne Steuerzeichen.
- Die App meldet alle 5 Minuten. Höchstens eine Meldung pro Installation alle 4 Minuten (429). Die App wertet 429 als gesendet.
- Höchstens 20 neue Installations-IDs pro IP-Adresse und Tag (429). Der Zähler liegt nur im Speicher und beginnt nach einem Neustart von vorn.

Die Summen werden höchstens alle 5 Minuten neu aus der Datenbank berechnet (Zwischenspeicher im Prozess). Neue Meldungen erscheinen also mit bis zu 5 Minuten Verzögerung.

## Umgebungsvariablen

| Variable | Pflicht | Bedeutung |
| --- | --- | --- |
| `DATABASE_URL` | ja | Postgres-Verbindung, z. B. `postgres://user:pass@host:5432/forge_stats` |
| `PORT` | nein | Port des Servers, im Image `3000` |
| `CLIENT_IP_HEADER` | nein | Header, in dem ein Proxy vor Coolify die Client-Adresse mitgibt, z. B. `x-client-ip` |

Die Client-IP liest der Dienst aus dem Header in `CLIENT_IP_HEADER` (falls gesetzt), sonst aus `CF-Connecting-Ip`, sonst aus `X-Real-Ip`, sonst aus dem letzten Eintrag von `X-Forwarded-For`. Die beiden letzten setzt Traefik.

### Hinter dem eigenen HAProxy (so betrieben)

HAProxy beendet TLS mit eigenem Zertifikat und leitet per HTTP an Traefik weiter. Deshalb:

- Domain in Coolify mit **`http://`**: `http://forge-stats.vanturis.de:3000`. Mit `https://` leitet Traefik jede
  Anfrage auf HTTPS um, HAProxy schickt sie wieder per HTTP, und der Browser meldet `ERR_TOO_MANY_REDIRECTS`.
- Im HAProxy-Frontend die Client-Adresse mitgeben (überschreibt, was der Client selbst schickt):
  `http-request set-header X-Client-IP %[src]`
- In Coolify die Umgebungsvariable `CLIENT_IP_HEADER=x-client-ip` setzen. Ohne beides sieht der Dienst bei
  jedem Nutzer die Adresse des HAProxy, und die Sperre für neue Installationen gilt für alle zusammen.

Hinter Cloudflare (Proxy an) muss der SSL-Modus **Full (strict)** sein, aus demselben Grund.

## Einrichtung in Coolify (eine Ressource mit Postgres)

`docker-compose.yml` startet den Dienst und seine Postgres zusammen. Die Datenbank ist nur im internen Netz
erreichbar, ihre Daten liegen im Volume `stats-db`.

1. DNS: A-Record `forge-stats.vanturis.de` auf den Coolify-Server.
2. In Coolify: Projekt wählen, **+ New**, **Public Repository** (oder **Private Repository (with GitHub App)**,
   solange das Repo privat ist), URL `https://github.com/vanturis/forge`, Branch `main`.
3. Build Pack: **Docker Compose**. Base Directory: **`/services/stats`**. Docker Compose Location:
   **`/docker-compose.yml`**. Speichern: Coolify liest die Datei und zeigt die Dienste `stats` und `postgres`.
4. Beim Dienst `stats` als Domain **`https://forge-stats.vanturis.de:3000`** eintragen. Das `:3000` ist der Port
   im Container, nicht der öffentliche Port. Traefik macht TLS (Let's Encrypt) und Kompression.
5. Unter Environment Variables nichts eintragen: `SERVICE_USER_POSTGRES` und `SERVICE_PASSWORD_POSTGRES` erzeugt
   Coolify beim ersten Deploy selbst. Erscheinen sie dort nicht, beide von Hand setzen (Passwort nur aus
   Buchstaben und Ziffern, es steht in einer URL).
6. **Deploy**. Danach prüfen: `https://forge-stats.vanturis.de/api/health` liefert `ok`.
7. Auto-Deploy: Mit der GitHub App baut Coolify bei jedem Push neu. Mit **Watch Paths** `services/stats/**`
   nur dann, wenn sich der Dienst ändert.

Das Image läuft als Benutzer `nextjs` (nicht root) und startet die Standalone-Ausgabe von Next mit
`node server.js`. Es bringt einen `HEALTHCHECK` auf `/api/health` mit.

Ohne Compose geht es auch: Postgres als eigene Coolify-Ressource, Anwendung mit Build Pack **Dockerfile**,
Base Directory `/services/stats`, Port `3000`, `DATABASE_URL` auf die interne URL der Datenbank.

Das Image läuft als Benutzer `nextjs` (nicht root) und startet die Standalone-Ausgabe von Next mit `node server.js`.

## Lokal starten

```sh
cd services/stats
pnpm install --ignore-workspace
DATABASE_URL=postgres://user:pass@127.0.0.1:5432/forge_stats pnpm dev
```

Danach läuft die Seite auf http://localhost:3000. Eine Testmeldung:

```sh
curl -i -X POST http://localhost:3000/api/v1/report \
  -H 'Content-Type: application/json' \
  -d '{"schema":1,"installId":"00000000-0000-4000-8000-000000000001","appVersion":"0.1.80","os":"Windows","counters":{"sessions":1}}'
curl http://localhost:3000/api/v1/totals
```

Weitere Befehle:

```sh
pnpm test             # Unit-Tests (vitest, ohne Datenbank)
pnpm exec tsc --noEmit
pnpm build            # Standalone-Ausgabe in .next/standalone
```

Docker lokal:

```sh
docker build -t forge-stats services/stats
docker run --rm -p 3000:3000 -e DATABASE_URL=postgres://... forge-stats
```
