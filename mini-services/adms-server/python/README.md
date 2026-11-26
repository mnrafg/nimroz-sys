# aogc-bicms-adms (Python runtime)

Single-file FastAPI runtime (`bicms_adms.py`, Python 3.10+) that receives
ZKTeco PUSH attendance from physical terminals (for example a uFace800 Plus)
and exposes a strictly read-only, authenticated API that the AOGC Border
Import Control System (BICMS) application polls.

It is deliberately small:

- two pinned dependencies (`fastapi`, `uvicorn` -- see `requirements.lock`),
  SQLite from the standard library, TLS certificates via the `openssl` CLI.
- one process, three listeners, no external message broker, no ERPNext/Frappe
  integration, no device command channel.

## The three listeners

| # | Listener | Default bind | Default port | Protocol | Auth |
|---|----------|--------------|--------------|----------|------|
| 1 | Device-facing native HTTP | `0.0.0.0` | `8081` | ZKTeco PUSH (`/iclock/cdata`, `/iclock/getrequest`, `/iclock/devicecmd` and `.aspx` variants) | none (plaintext device protocol; serial allowlist + CIDR policy only -- see limitations) |
| 2 | Private read-only API (HTTP) | `127.0.0.1` (enforced) | `8082` | JSON over HTTP | `Authorization: Bearer <token>` (constant-time compare) |
| 3 | Private read-only API (HTTPS) | `0.0.0.0` | `8443` | Same JSON API over TLS | same bearer token |

The legacy ADMS service on port 8080 and any Frappe service are separate:
this runtime never binds 8080 and never touches their databases.

Port 8081 is the device destination configured in the terminal's ADMS/Comm
menu. Ports 8082/8443 are what the application reads (adapter endpoints
`GET /`, `GET /api/devices/{serial}/status`,
`GET /api/attendance?device_sn=...`).

## Device-facing behavior (port 8081)

- `GET/POST /iclock/cdata` (and `/iclock/cdata.aspx`) -- handshake registers
  the serial in `bicms_adms_devices` (first_seen/last_seen/last_ip/push_version);
  POST bodies are parsed as ATTLOG. Replies plain text `OK`.
- `GET/POST /iclock/getrequest` (and `.aspx`) -- the response body is the
  device command channel. It is always EMPTY, so this server can never issue
  commands: no user/template/photo requests, no attendance deletion.
- `GET/POST /iclock/devicecmd` (and `.aspx`) -- device command
  acknowledgements are discarded; reply `OK`, store nothing.
- Query params are matched case-insensitively for `SN` (`sn=`, `SN=`, `Sn=`).
  Multiple SN params with CONFLICTING values are rejected with HTTP 400 and
  plain text `ERROR`.
- last_seen/last_ip are refreshed on every device-facing request that carries
  a permitted serial.
- ATTLOG parsing is strict. Field order per TAB-separated line:
  `user id`, device-local timestamp `YYYY-MM-DD HH:mm:ss`, `punch state`,
  `verification method`. A leading `TRANS` token per line is tolerated.
  Punch state (field 3) and verification method (field 4) are never
  interchanged. Invalid lines are skipped, never guessed. Bounds: 100 lines
  per request, 512 KB body (larger bodies are rejected with HTTP 413).
- Attendance rows are stored with `INSERT OR IGNORE` against the UNIQUE key
  `(device_sn, user_id, device_time, punch_state, verify_method)`: duplicate
  pushes never duplicate rows, ids are immutable and never renumbered, rows
  are never deleted.

## Access policy (allowlist is NOT authentication)

Configured serials may carry an optional `allowedNetworks` CIDR list; sources
outside it are rejected with HTTP 403. Unknown serials are NOT registered and
receive the same neutral reply as permitted ones (registration state is not
revealed). Honesty notes that also apply in production:

- The PUSH protocol is plaintext HTTP and the serial is self-reported by the
  client. Any host on the network can claim any serial. The allowlist and
  CIDR policy are access control, not authentication, and provide no
  encryption for device traffic.
- Keep 8081 on an isolated terminal LAN. Do not expose it through reverse
  proxies that add spoofable headers (this runtime ignores
  `X-Forwarded-For`; the socket peer address is used for CIDR checks).
- `allowAnyNetwork: true` registers ANY serial -- sandbox convenience only.

## Private API (ports 8082 + 8443) -- read-only

All three endpoints require `Authorization: Bearer <token>`; wrong or missing
token returns 401. There are no write endpoints, no template/photo endpoints,
no deletion, no sync endpoints. Exactly:

- `GET /` -> `{"service":"aogc-bicms-adms","version":"1.0.0","ok":true}`
- `GET /api/devices/{serial}/status` ->
  `{"serial":"...","online":true|false,"last_seen":"...","ip":"..."}`;
  `online` = last_seen within 90 seconds; unknown serial -> 404 JSON.
- `GET /api/attendance?device_sn=<serial>&limit=200&offset=0&include_total=false` ->
  `{"attendance":[...],"total":N|null}` with rows
  `{"id":int,"device_sn":"...","user_id":"...","timestamp":"YYYY-MM-DD HH:mm:ss","state":int,"verify":int,"received_at":"..."}`.
  Parameters `device_sn`, `limit`, `offset`, `include_total` are preserved for
  adapter compatibility. `limit` clamps to [1,200], `offset` to [0,1000000].
  Rows are scoped STRICTLY by the registered `device_sn`; an unregistered
  serial returns an empty list (not an error), matching the legacy adapter.
  Rows are returned newest-first (`ORDER BY id DESC`) so an offset-0 poll
  always covers the latest window; consumers re-sort by `id` when they need
  chronological order. `total` is `null` unless `include_total=true`.

Timestamps: `timestamp` is the device-local clock verbatim; `last_seen`,
`first_seen`, `received_at` are UTC (`YYYY-MM-DDTHH:mm:ssZ`). The application
applies its own timezone offset to the device-local timestamp.

## Configuration

Data directory: `/var/lib/aogc-bicms-adms` (override with
`BICMS_ADMS_DATA_DIR`). Files inside: `bicms_adms.json` (config, created on
first run with mode 0600), `bicms-adms.db` + WAL siblings, `tls.pem`
(fallback TLS certificate location).

`bicms_adms.json` reference:

```json
{
  "serials": {
    "SERIAL-OF-DEVICE-1": { "allowedNetworks": ["10.20.30.0/24"], "note": "front gate" },
    "SERIAL-OF-DEVICE-2": { "allowedNetworks": null, "note": "any source" }
  },
  "allowAnyNetwork": false,
  "bearer_token": "<random, generated on first run>",
  "ports": { "device": 8081, "internalApi": 8082, "httpsApi": 8443 },
  "bind": { "device": "0.0.0.0", "internalApi": "127.0.0.1", "httpsApi": "0.0.0.0" }
}
```

- `serials` -- the allowlist. `allowedNetworks: null` = any source; an empty
  list rejects every source. Unknown serials are never registered.
- `allowAnyNetwork` -- `true` registers any serial (sandbox convenience;
  first-run config ships `true` with a printed warning). For production set
  `false` and list serials explicitly.
- `bearer_token` -- token for ports 8082/8443. Generated randomly on first
  run; the file is never committed anywhere.
- `ports` / `bind` -- listeners. `bind.internalApi` is refused if it is not a
  loopback address (the private API cannot be accidentally exposed).

Environment overrides:

| Variable | Meaning |
|----------|---------|
| `BICMS_ADMS_DATA_DIR` | data directory (default `/var/lib/aogc-bicms-adms`) |
| `BICMS_ADMS_TOKEN` | bearer token override (wins over config, never persisted) |
| `BICMS_ADMS_PORTS` | JSON object overriding ports, e.g. `{"device":18081,...}` |
| `BICMS_ADMS_BIND` | JSON object overriding binds |
| `BICMS_ADMS_TLS_PEM` | explicit path to a combined cert+key PEM (overrides the search order: `/etc/aogc-bicms-adms/tls.pem` then `<data>/tls.pem`) |

A malformed config is refused (never silently regenerated -- that would
rotate the token). Startup refuses to open `bicms-adms.db` when the file
exists but is not a BICMS ADMS database (checked via the `bicms_adms_meta`
service marker + `schema_version`); a newer schema_version is also refused.
Schema upgrades are additive only (`CREATE TABLE IF NOT EXISTS`); existing
rows and ids are always preserved.

## Pointing devices at this server

On the terminal (example: uFace800 Plus), MENU -> COMM -> Ethernet/ADMS
("Cloud Server" on some firmwares):

- Server IP: the host running this runtime
- Server Port: `8081` (this listener -- NOT 8080, NOT the 4370 SDK port)
- Server Address / path (if the firmware asks): `/iclock/`

See `deploy/terminal/README.md` for the full physical-terminal guide
including the note that reference values such as serial `JYM6244400083`,
host `192.168.1.168` and port `4370` are examples from the original
deployment, not defaults.

## How this relates to the application

The BICMS app (Next.js) polls this service through
`src/lib/biometric/terminal-adms-api.ts`: a health probe on `GET /`, device
presence on `GET /api/devices/{serial}/status`, and new scans on
`GET /api/attendance?...`. The app interprets device-local timestamps with
its configured timezone offset, enforces freshness/biometric-verify rules,
and deduplicates on the immutable row `id`. This runtime stays deliberately
dumb: storage, dedup, and read-only delivery -- no business logic, no writes
to the application database, no ERPNext/Frappe involvement.

Connection profiles (API URL, bearer token, pinned `tls.pem` CA) are stored
encrypted by the app; the token lives in `bicms_adms.json` on this side and
in the app's encrypted profile store -- never in git.

## Running (sandbox)

The sandbox command works with no installation when `fastapi`/`uvicorn` are
importable by `python3` (otherwise `bash run.sh` bootstraps a `.venv` from
`requirements.lock`):

```bash
cd mini-services/adms-server/python
BICMS_ADMS_DATA_DIR=./tmp-data \
BICMS_ADMS_PORTS='{"device":18081,"internalApi":18082,"httpsApi":18443}' \
python3 bicms_adms.py
```

`./tmp-data` and `.venv` are runtime artifacts and must not be committed.

Quick verification against a sandbox instance (token from
`./tmp-data/bicms_adms.json`):

```bash
TOKEN=$(python3 -c "import json;print(json.load(open('./tmp-data/bicms_adms.json'))['bearer_token'])")
curl -s http://127.0.0.1:18081/iclock/cdata?SN=TESTSN123          # OK (registers)
curl -s -X POST 'http://127.0.0.1:18081/iclock/cdata?SN=TESTSN123&table=ATTLOG' \
     --data-binary $'101\t2026-01-01 08:00:00\t0\t1\n102\t2026-01-01 08:05:00\t1\t2'
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:18082/api/devices/TESTSN123/status
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:18082/api/attendance?device_sn=TESTSN123
curl -sk -H "Authorization: Bearer $TOKEN" https://127.0.0.1:18443/
```

## systemd (production)

Production runs as `aogc-bicms-adms.service`, user `bicms-adms`:

- release layout: `/opt/aogc-bicms-adms/releases/<checksum>/` with
  `/opt/aogc-bicms-adms/current` symlink (see `deploy/adms/install-bundle.txt`)
- config + data: `/etc/aogc-bicms-adms/` (TLS cert) and
  `/var/lib/aogc-bicms-adms/` (config JSON, SQLite, fallback TLS)
- unit template: `deploy/adms/aogc-bicms-adms.service`; full ops guide:
  `deploy/adms/README.md`

Signals: SIGTERM/SIGINT trigger a graceful shutdown of all three listeners
(in-flight requests finish, then the process exits). A bind failure on any
listener terminates the process non-zero with a clear log line.
