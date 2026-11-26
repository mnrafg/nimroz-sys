# ADMS connection: deployment-managed configuration

The ADMS service is installed separately. The biometric settings screen is now a **read-only monitor**: administrators no longer configure the listener, API origin, or token in the browser.

## Correct endpoints

- Device-facing listener (ZKTeco terminal -> ADMS): typically `http://<server>:8081`.
- Private read-only API (BICMS backend -> ADMS): typically `http://127.0.0.1:8082` **only if running on the same host**, or `https://<server>:8443` over a trusted network with a valid certificate.
- The read-only API has `GET /`, `GET /api/devices/{serial}/status`, and `GET /api/attendance`. These routes **are not on port 8081**.

## Configure once for every user and deployment

Save the connection once on the build workspace using private credential files:

```sh
npm run adms:configure -- --device-url http://your-adms-host:8081 --api-url https://your-adms-host:8443 --token-file /private/adms-api-token --ca-file /private/adms-certificate.pem
```

For an existing saved connection, use `--profile /private/existing-profile.json`.
If its original authentication secret changed, supply `--legacy-secret-file`
with that original secret, or `--token-file` with the current API token.
This migration is needed once; new profiles have an independent encryption key.

The backend stores the encrypted token, certificate, endpoints and read toggle
in `.local/adms/deployment/connection.json`, with its private key in
`connection.key`. These files are ignored by Git and never returned to the
browser. All users share the backend connection; signing out, changing the
login secret, or creating a new application database does not clear it.

`npm run build` (also called by `.zscripts/build.sh`) automatically copies this
configuration into the private standalone server package. Deploy the whole
server package, including its hidden `.local` directory. A new database has no
ADMS setup step: the packaged connection takes precedence over its empty or
old database settings. Database provisioning and device/port assignments are
still part of the application's normal database setup.

Back up both connection files together. Keep the server package private: it
contains the backend's API credential and decryption material, just as a
server environment/secret file would. Never copy these files into `public/`
or distribute them as browser assets. For a managed key instead of a packaged
key file, set `TERMINAL_ADMS_DEPLOYMENT_KEY` once in the build and hosting
secret store and preserve it across releases. `TERMINAL_ADMS_DEPLOYMENT_DIR`
can point to a persistent private configuration directory.

## Optional hosting overrides

Environment values take priority over the packaged connection:

```dotenv
TERMINAL_ADMS_SERVER_URL=http://<device-reachable-host>:8081
TERMINAL_ADMS_API_URL=https://<api-host>:8443
TERMINAL_ADMS_API_TOKEN_FILE=/run/secrets/bicms-adms-api-token
TERMINAL_ADMS_SERVER_ENABLED=true
```

Use an actual routable host and a trusted HTTPS certificate. If BICMS and ADMS share a host, the private API can instead use `http://127.0.0.1:8082`; do not use loopback when they are on different machines. Never send the bearer token across public plaintext HTTP.

Restart the BICMS service after changing its environment. A token file takes
priority over a literal token environment variable. A saved token and pinned
certificate are used only for their matching API origin; overriding the API
address does not send that token to a different server. Legacy database
settings and local connection files remain supported when no portable
connection has been saved. A damaged portable profile reports an error
instead of silently treating the server as unconfigured.

## Diagnose a 404

1. Confirm the BICMS application's `TERMINAL_ADMS_API_URL` is **not** the device listener on port 8081.
2. On the BICMS host, test `GET /` against the actual API URL; then test authenticated `GET /api/devices/JYM6244400083/status`.
3. Distinguish responses: 404 = wrong route/port or service; 401/403 = API token/authentication; a valid status response with `online: false` means the device has not checked in.
4. Check firewall routing and whether port 8443 is exposed safely. Port 8082 should remain loopback-only in the bundled Python service.
5. A successful health response is **not** proof of a live scan feed or device connectivity.

Do not run the installation wizard on an existing ADMS server just to fix an API port mismatch.
