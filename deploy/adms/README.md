# aogc-bicms-adms -- deployment and operations guide

How to run the Python ADMS runtime (`mini-services/adms-server/python/bicms_adms.py`)
as a systemd service on the Linux host that physical ZKTeco terminals reach
over the LAN. Runtime behavior, configuration and security notes live in
`mini-services/adms-server/python/README.md`; this file covers the host
layout, installation and service lifecycle.

## Architecture on the host

| Listener | Default bind:port | Purpose | Auth |
|----------|-------------------|---------|------|
| Device-facing PUSH (native HTTP) | `0.0.0.0:8081` | ZKTeco PUSH `/iclock/cdata|getrequest|devicecmd` (+ `.aspx`) | none (plaintext device protocol; allowlist + CIDR policy only) |
| Private read-only API | `127.0.0.1:8082` | app polling over loopback | Bearer token |
| Private read-only API (TLS) | `0.0.0.0:8443` | app polling over TLS | Bearer token |

Never run anything else on 8080 on this host -- the legacy ADMS service (and
any Frappe service) are separate deployments; the BICMS runtime never binds
8080 and never shares their databases.

## Filesystem layout

```
/opt/aogc-bicms-adms/
  releases/<checksum>/          immutable release payloads (see install-bundle.txt)
    bicms_adms.py
    requirements.lock
    README.md
    run.sh
  current -> releases/<checksum>   symlink switched by the installer
  venv/                          virtualenv built from requirements.lock (reused across releases)
/etc/aogc-bicms-adms/
  tls.pem                        combined cert+key PEM (optional; pre-generated
                                 or self-signed via `openssl`; 0600, owner bicms-adms)
/var/lib/aogc-bicms-adms/        StateDirectory (only writable path of the service)
  bicms_adms.json                config (created on first run; contains the bearer token; 0600)
  bicms-adms.db                  SQLite database (WAL mode, dedicated to this service)
  bicms-adms.db-wal / -shm       WAL siblings
  tls.pem                        fallback location for the TLS cert when /etc is not writable
```

The service account:

```
useradd --system --home-dir /var/lib/aogc-bicms-adms --shell /usr/sbin/nologin bicms-adms
```

## Install steps (summary)

1. Build the bundle exactly as described in `install-bundle.txt`
   (checksum-named release directory; the checksum doubles as the release id).
2. Create the venv once:
   `python3 -m venv /opt/aogc-bicms-adms/venv &&
   /opt/aogc-bicms-adms/venv/bin/pip install -r
   /opt/aogc-bicms-adms/current/requirements.lock`
3. Create user and directories (commands above), `chown bicms-adms:bicms-adms`
   on `/var/lib/aogc-bicms-adms` and `/etc/aogc-bicms-adms`.
4. Copy `aogc-bicms-adms.service` to `/etc/systemd/system/`, then
   `systemctl daemon-reload && systemctl enable --now aogc-bicms-adms.service`.
5. First start creates `/var/lib/aogc-bicms-adms/bicms_adms.json` with a random
   bearer token and `allowAnyNetwork: true` (sandbox convenience) and prints a
   warning. IMMEDIATELY switch to production mode:
   - stop the service,
   - set `"allowAnyNetwork": false`,
   - add one entry per terminal under `"serials"` (optionally with
     `allowedNetworks` CIDRs),
   - copy the printed token into the application's ADMS API settings
     (stored encrypted app-side),
   - start the service again.
6. Verify: `curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8082/`
   returns the health JSON; the journal shows the three listener lines.

## systemd unit expectations

`deploy/adms/aogc-bicms-adms.service` in this directory is the unit template:

- `Type=simple`, `ExecStart=/opt/aogc-bicms-adms/venv/bin/python bicms_adms.py`
  with `WorkingDirectory=/opt/aogc-bicms-adms/current`
- `User=bicms-adms`, `Environment=BICMS_ADMS_DATA_DIR=/var/lib/aogc-bicms-adms`
- graceful stop: the runtime handles SIGTERM (all three listeners drain), so
  `KillSignal=SIGTERM`, `TimeoutStopSec=15`
- hardened: `NoNewPrivileges`, `ProtectSystem=strict`,
  `ReadWritePaths=/var/lib/aogc-bicms-adms` (the only writable path;
  `/etc/aogc-bicms-adms` is read-only at runtime, so place `tls.pem` there
  BEFORE starting, or let the runtime fall back to the data directory),
  `PrivateTmp`, `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`
- `Restart=on-failure`, `RestartSec=3`

Release upgrades: place the new checksum directory under `releases/`, run the
pip install step if `requirements.lock` changed, `ln -sfn` `current` to the new
release, `systemctl restart aogc-bicms-adms`. The SQLite schema upgrade path is
additive-only; existing attendance rows and ids are always preserved
(`INSERT OR IGNORE`, never delete, never renumber).

## Monitoring

- `GET /` (8082/8443, bearer token) -> health JSON; use as a reachability
  probe only -- it does NOT prove any terminal is online.
- `GET /api/devices/<serial>/status` -> `online` is true when the terminal
  pushed anything within the last 90 seconds.
- journal: registrations, ATTLOG batches (`valid/stored/duplicates`), CIDR
  rejections and unknown-serial denials are logged.

## Security posture (read before exposing anything)

- Device traffic on 8081 is plaintext and self-identifying: the serial is
  claimed by the client. The allowlist/`allowedNetworks` policy is access
  control, NOT cryptographic authentication. Keep 8081 on an isolated
  terminal VLAN; do not reverse-proxy it.
- The private API is bearer-token protected; port 8082 refuses any
  non-loopback bind by design, so the token should only traverse loopback or
  the TLS listener on 8443. The application never sends the token over
  plain public HTTP.
- The HTTPS listener uses a self-signed certificate by default (CN
  `aogc-bicms-adms`, SAN `DNS:localhost,IP:127.0.0.1`). For remote API access
  replace `tls.pem` with a real certificate (combined cert+key PEM) matching
  the hostname the application connects to; the application pins the CA and
  never disables TLS verification.
- `allowAnyNetwork: true` must not survive to production.
