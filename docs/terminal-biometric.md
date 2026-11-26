# Terminal Biometric Integration (بایومتریک ترمینال بندر)

Reproduced from reference branch `biometric-setup` (commit `2a9c2c22076d66cca60b2daf77b640c11e844dba`).
The reference repository was **not accessible** during implementation (private 404), so the
behavior below was implemented from the integration specification + the publicly documented
ZKTeco standalone-TCP / PUSH(ADMS) protocols. Every reference file that could not be inspected
is listed under «Unverified against reference source» in the delivery report.

Identity = **DEVICE SERIAL + TERMINAL USER ID** (never a generated website code).
User ID 12 on one terminal is a different person from user ID 12 on another terminal.
Switching a terminal between LAN and ADMS keeps all importer mappings (serial unchanged).

## Two connection methods (exactly what the registration UI offers)

| Method | Label | Data path | Requires |
|---|---|---|---|
| `LAN` | شبکه محلی | App backend opens TCP (default 4370) directly to the terminal. Server-side only — never browser TCP, no native SDK, no USB scanner at the terminal. | Backend network reachability to the terminal |
| `ADMS_SERVER` | سرور ADMS | Terminal pushes to the dedicated ADMS service; the app READS device status + fresh events from that service's authenticated API. | App network reachability to the ADMS API |

This is the ONLY biometric identity system in the application. The legacy
`DeviceGateway`/`BiometricDevice`/`ImporterFingerprint` stacks (مدیریت دستگاه‌ها,
USB scanner + localhost bridge) were REMOVED — models, routes, components,
the Windows gateway client and the bridge service were deleted; their tables
were dropped by the reviewed migration `prisma/migrate-remove-legacy-biometric.ts`
(empty-table verified, backup taken).

The legacy in-app RELAY receiver was removed in the follow-up reviewed
migration `prisma/migrate-finish-legacy-removal.ts`: the
`/api/iclock/[operation]` and `/api/biometric/terminal/receiver` routes were
deleted, and the `TerminalReceiverConfig` table was dropped AFTER its row
was archived verbatim into `SystemSetting["terminal.legacyReceiver.archived"]`
(nothing was silently deleted). The dedicated Python ADMS service is the
only device-facing listener. The signed machine-only ingest route
(`/api/biometric/terminal/ingest`) is retained as the private
application-facing API contract used by the ADMS integration.

## Components

| Path | Purpose |
|---|---|
| `src/lib/biometric/terminal-protocol.ts` | ZKTeco TCP codec: 8-byte `50 50 82 7d` prefix + 8-byte command header, one's-complement checksum, SDK command values, comm-key scramble, option reads, native binary attendance events (verify before punch) and PUSH text events (punch before verify) |
| `src/lib/biometric/terminal-rules.ts` | Verify-mode mapping (1=fingerprint, 15–20=face, 25–29=palm, 2/4=card, 0/3=password, else unknown), 9-digit terminal-user-id rule, freshness (90 s max age / 10 s future), Kabul +270 default, stage messages |
| `src/lib/biometric/terminal-manager.ts` | LAN sessions: connect → comm-key auth (only when the terminal asks) → ~SerialNumber read + verification → realtime subscription → event ACK → ~20 s serial-verification heartbeat → bounded reconnect. NEVER sends user-write/template-delete/clock/door/reset commands |
| `src/lib/biometric/terminal-ingestion.ts` | Single ingestion point for both transports: biometric-only, dedup by deterministic eventKey, single-use consumption (`consumeTerminalScan`) |
| `src/lib/biometric/terminal-enrollment.ts` | Enrollment = CONFIRMING an identity enrolled ON the terminal: owner-bound 120 s request, conflict checks, atomic completion (exact device+user, freshness, consume once, mapping upsert, importer status, audit) |
| `src/lib/biometric/terminal-adms-api.ts` | Read-only ADMS adapter: `GET /`, `GET /api/devices/{serial}/status`, `GET /api/attendance?device_sn&limit=200&offset=0&include_total=false`; strict shape validation, bounded size/timeouts, TLS pinning support, never `rejectUnauthorized=false` |
| `src/lib/biometric/terminal-adms-feed.ts` | Remote feed: ~1 s polling while in use, baseline first response (history never becomes live identification), chronological delivery by immutable row id, duplicate/stale/foreign/offline rejection |
| `src/lib/biometric/terminal-adms-server.ts` + `adms-deployment-config.ts` | Shared backend connection, independent of user sessions and new databases; AES-256-GCM profile in `.local/adms/deployment` is automatically included in private server builds; environment overrides and legacy profiles remain supported |
| `src/lib/biometric/adms-setup-*.ts`, `adms-ssh.ts`, `adms-python-package.ts` | SSH wizard backend: fingerprint-first (no password before pin match), signed 10-min single-use plans, checksum-verified bundle upload with progress, namespace/port guards, 3-listener verification, rollback, pinned-CA activation |
| `mini-services/adms-server/python/bicms_adms.py` | Dedicated Python/FastAPI runtime: device-facing 8081, loopback authenticated API 8082, authenticated HTTPS API 8443; `bicms_adms_devices` + `bicms_adms_attendance` SQLite (WAL), strict ATTLOG order, no commands/templates/photos/ERPNext |
| `deploy/adms/`, `deploy/terminal/` | systemd unit (`aogc-bicms-adms.service`, user `bicms-adms`, releases `<checksum>`, `/etc/aogc-bicms-adms`, `/var/lib/aogc-bicms-adms`) + physical terminal guide |
| `src/components/views/terminal-devices-view.tsx` + `src/components/biometric/terminal-*.tsx` | Admin page (تنظیمات سیستم ← تنظیمات دستگاه‌های بایومتریک), device panel, ADMS settings, setup wizard, enroll dialog, entries import listener |

## API surface

```
GET/POST/PATCH/PUT  /api/biometric/terminal/devices
GET                 /api/biometric/terminal/status?deviceKey=<serial>
POST                /api/biometric/terminal/enroll        (propose-user | start | complete | cancel)
GET (SSE)           /api/biometric/terminal/events?deviceKey=<serial>
GET (SSE)           /api/biometric/terminal/events?enrollmentId=<uuid>
GET/PUT             /api/biometric/terminal/adms-server   (?check=1)
POST                /api/biometric/terminal/adms-server/setup   (fingerprint | inspect | plan | install(NDJSON) | activate)
POST                /api/biometric/terminal/ingest        (private authenticated read contract)
```

(REMOVED: `GET/PUT /api/biometric/terminal/receiver`, `GET/POST /iclock/[operation]`
— the legacy in-app receiver. Routes deleted, model dropped with data archived;
see `prisma/migrate-finish-legacy-removal.ts`.)

## ADMS destination separation (two different addresses)

The device-facing listener address and the application-facing API address
are SEPARATE concepts, stored separately (`terminal.admsServer` JSON:
`host`/`port`/`protocol` vs `apiHost`/`apiPort`/`apiProtocol`), and shown
separately in the admin UI:

| Concept | Stored in | Reachable by | Loopback validity |
|---|---|---|---|
| آدرس دستگاه‌شنونده (device ← server) | `terminal.admsServer.host/port` | the physical terminal's ADMS menu | NEVER a valid terminal destination — a loopback value is flagged with an explicit warning and a loopback value saved earlier is relocated by migration |
| آدرس API خصوصی (app backend ← ADMS service) | `terminal.admsServer.apiHost/apiPort` (or env `TERMINAL_ADMS_API_URL`) | the application backend only | VALID when the ADMS service runs on the same machine as the app backend (local service/tunnel) |

Environment variable `TERMINAL_ADMS_API_URL` still overrides the stored API
address and is displayed read-only when set. Internal filesystem paths are
never shown in the ordinary administrator summary.

## Migration

```
bun prisma/migrate-terminal.ts
```
Verifies the intended DB, creates a consistent backup (`db/backups/pre-terminal-*.db`, WAL
checkpointed via VACUUM INTO), then applies the ADDITIVE schema (`prisma db push`, never
`--accept-data-loss`, never a reset, never the reference database). Repeatable.
Existing importers/accounts/quotas/history/legacy device links/secrets are untouched.

## Environment configuration reference (no secrets committed)

| Variable | Meaning |
|---|---|
| `TERMINAL_HOST`, `TERMINAL_PORT`, `TERMINAL_SERIAL`, `TERMINAL_COMM_KEY` | Reference single-terminal defaults for scripted provisioning (the reference device: uFace800 Plus, 192.168.1.168:4370, serial JYM6244400083 — an EXAMPLE, never a default identity) |
| `TERMINAL_LAN_COMM_KEYS` | JSON map serial→comm key, server-side only |
| `TERMINAL_ADMS_SERVER_URL` | Device-facing ADMS origin (env override, shown read-only) |
| `TERMINAL_ADMS_SERVER_ENABLED` | Force reading toggle (`1`/`true`) |
| `TERMINAL_ADMS_API_URL` | Application-facing authenticated API origin |
| `TERMINAL_ADMS_API_TOKEN_FILE` / `TERMINAL_ADMS_API_TOKEN` | Bearer token source (file preferred). NEVER sent over public plaintext HTTP — HTTPS or explicit loopback only |
| `TERMINAL_ADMS_CONNECTION_DIR` | Encrypted connection profiles dir (default `.local/adms/connections`) |
| `TERMINAL_ADMS_DEPLOYMENT_DIR` | Private portable connection directory (default `.local/adms/deployment`); see `docs/adms-deployment-connection.md` |
| `TERMINAL_ADMS_DEPLOYMENT_KEY` | Optional managed 64-hex key for the portable profile; otherwise the generated private key file travels with the private server package |
| `DEVICE_MASTER_KEY` | 64-hex AES-256-GCM master key for comm keys / ADMS tokens / connection profiles. MUST be set in production; without it a documented fallback derivation is used |
| `TERMINAL_TRUST_PROXY_HEADERS` | `1` = trust `X-Real-IP`/XFF (only with an explicitly trusted proxy in front, as the Caddy gateway here); otherwise socket address only |

## Sandbox / development runtime supervision

In the development sandbox the ADMS runtime cannot be kept alive as an
independently spawned background process, so two guarded paths exist:

| Path | Mechanism | Guard |
|---|---|---|
| Next.js dev instrumentation (`src/instrumentation.ts` → `src/instrumentation-adms.ts`) | spawns `python/run.sh` as a CHILD of the dev server when `127.0.0.1:18082` is free; never in production | `NODE_ENV !== production`, `ADMS_RUNTIME_AUTOSTART=0` opt-out, port probe, working-interpreter resolution |
| Mini-service discovery (`mini-services/adms-server/package.json` → `dev-guard.sh`) | `bun run dev` starts the runtime only when port 18082 is free | port probe |

Whichever path starts first wins; the other skips with an explicit log
line. Production deployments use systemd only
(`deploy/adms/aogc-bicms-adms.service`) — nothing is auto-spawned when
`NODE_ENV=production`.

## What is NOT done (by design)

- No remote fingerprint capture, no template storage, no photos.
- No user modification / template deletion / clock change / door control / device reset commands.
- No ERPNext synchronization, no attendance deletion, no device commands to the ADMS service.
- No one-IN/one-OUT attendance rules.
- No Supervisor role or approval queue — existing ADMIN/OFFICER rules apply.
- No legacy in-app RELAY receiver — removed with data preservation; the
  Python ADMS service is the sole device-facing listener.

## LAN connection diagnosis

The standalone TCP path uses CONNECT 1000, AUTH 1102, OPTIONS_RRQ 11,
REG_EVENT 500 with EF_ATTLOG=1, and EXIT 1001. A 2005 response means the
terminal requires its Comm Key; a configured key of `0` is a valid key and
must be entered explicitly when the terminal requests authentication.
The application never changes that key on the physical terminal.

The status dialog retains completed stages for the current attempt and
marks later, unattempted stages as pending. Editing host, port, timezone or
Comm Key restarts the application connection. Successful subscription and
serial-verification heartbeats update the persisted last-contact time.

Wire reference: https://github.com/fananimi/pyzk/blob/master/zk/base.py and
https://github.com/fananimi/pyzk/blob/master/zk/const.py. Independent connect
packet fixture: `5050827d08000000e80317fc00000000`.

Regression command (loopback access needed):
`bun test tests/terminal.test.ts tests/terminal-manager.test.ts tests/terminal-security.test.ts tests/terminal-adms-api.test.ts tests/adms-python.test.ts tests/adms-setup.test.ts`
The isolated manager fixture does not use the business database. A real
finger/face scan is still required to validate device event delivery and
importer identification on the deployed hardware.

## Device clock independence for native live scans

Native LAN attendance events arrive on the authenticated, serial-verified
live socket. Enrollment freshness and single-use consumption use the
server's `receivedAt`, so a wrong terminal clock cannot block confirmation.
The original interpreted device timestamp remains in `deviceTime`; it is
never rewritten to pretend the device clock was correct. Historical ADMS
polling and signed HTTP ingestion keep their existing device-time checks.
An enrollment can only consume a matching device/user scan received after
that enrollment started, within the 90-second receipt window. Replay keys
and biometric-only method filtering still apply.

The tested physical terminal sends asynchronous CMD_REG_EVENT packets with
sessionId=1, independently of its negotiated command-session ID. Live events
are bound to the current authenticated, serial-verified socket; a different
event session field is not a reason to discard them. Replaced/stopped sockets
are ignored. A captured 36-byte attendance packet is covered by a wire-level
regression and the isolated manager fixture uses this event-session behavior.

## Permanent terminal user IDs

After the first successful confirmation, an importer's terminal user ID on
that device is permanent. The enrollment form loads the saved ID read-only.
Start and completion both enforce the restriction, including for ADMIN.
Revoking a mapping does not unlock or release its terminal user ID. Repeating
confirmation with the same ID remains supported. Completion never updates
the terminalUserId column, and a competing first confirmation cannot replace
the winning mapping. Existing registered IDs are preserved.

## Existing BICMS ADMS v2 server (managed outside the application)

The v2 FastAPI service exposes device health/PUSH on port 8081, its
loopback API on 8082, and the token-protected HTTPS API on 8443. BCMIS
understands v2 device fields `serial_number`, `is_online`, `ip_address`,
and attendance fields `status` (punch) and `verify_mode` (verification).
The API routes remain `/api/devices/{serial}/status` and `/api/attendance`.

Configure these once in the BCMIS backend environment, using the actual
HTTPS hostname that matches the existing server certificate:

```
TERMINAL_ADMS_API_URL=https://your-adms-host:8443
TERMINAL_ADMS_API_TOKEN_FILE=/absolute/private/path/adms-api-token
TERMINAL_ADMS_API_CA_FILE=/absolute/private/path/adms-certificate.pem
```

The source server files are identified by its `ADMS_API_TOKEN_FILE` and
`ADMS_TLS_CERT_FILE` environment variables. Make the existing token and public
certificate available to the BCMIS backend in protected files; the TLS private
key (`ADMS_TLS_KEY_FILE`) stays on the ADMS server. The certificate must match
the API hostname/IP, and verification stays enabled. The device-facing address
remains the existing port 8081 address. No browser setup or server reinstall
is required. Environment changes require restarting the BCMIS backend.
