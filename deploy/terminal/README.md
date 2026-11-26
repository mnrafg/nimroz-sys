# Physical terminal configuration guide (ZKTeco PUSH / ADMS)

How to point a physical ZKTeco terminal (reference hardware: uFace800 Plus)
at the `aogc-bicms-adms` runtime so that punches arrive as ATTLOG pushes and
the BICMS application can read them.

Menu names differ slightly between firmwares; below are the common variants.
If your exact firmware differs, look for the terms "COMM", "Ethernet" and
"ADMS"/"Cloud Server Settings".

## 0. Before you touch the terminal

- The host running `aogc-bicms-adms` must be reachable from the terminal LAN
  on the **device listener port, default 8081** (TCP). Check any host
  firewall.
- The terminal must be registered in the server config
  (`/var/lib/aogc-bicms-adms/bicms_adms.json`, `serials` section, or the
  sandbox `allowAnyNetwork: true` mode). Unknown serials are silently ignored
  by the server (neutral reply, no registration).
- Decide on the timezone plan now: the terminal sends its LOCAL clock value
  verbatim (`YYYY-MM-DD HH:mm:ss`), and the application applies the configured
  timezone offset (Kabul +4:30 by default). Keep the terminal clock accurate
  (NTP if the firmware supports it, otherwise set it manually at each
  daylight-saving change).

## 1. Terminal network settings

On the terminal: `MENU -> COMM -> Ethernet`:

| Field | Value |
|-------|-------|
| IP address | static IP on the terminal LAN (example below) |
| Subnet mask | per your LAN |
| Gateway | per your LAN |
| Communication / Comm. key | see section 3 |

## 2. ADMS / Cloud Server settings

On the terminal: `MENU -> COMM -> Cloud Server Settings` (some firmwares
label it `ADMS`, or put the fields directly under `COMM -> Ethernet`):

| Field | Value | Notes |
|-------|-------|-------|
| Server IP | host running `aogc-bicms-adms` | must be the LAN address of the runtime host |
| Server Port | **8081** | the device-facing listener. NEVER 8080 (legacy service), NEVER 4370 (that is the local SDK port, unrelated) |
| Server Address (path) | `/iclock/` | default PUSH path; the runtime also accepts `.aspx` variants |
| Enable Domain Name | `No` | use a plain IP unless your site actually serves DNS |
| HTTPS | leave off | the device-facing PUSH listener is plain HTTP by design; see security notes |

After saving, the terminal attempts a PUSH handshake
(`GET /iclock/cdata?SN=<serial>&pushver=...`). On success the firmware usually
shows a connected/"OK" status indicator. You can force a handshake by saving
again or rebooting the terminal.

Verify server-side:

- journal/log line `device registered: serial=<SN> ip=<terminal IP>` on the
  first handshake; repeated handshakes only refresh last_seen.
- application side: `GET /api/devices/<serial>/status` shows `online: true`
  for 90 seconds after the last push.

## 3. Comm key notes (important)

- The uFace800 Plus firmware has a "Comm. key" field. **This server does not
  verify any comm key and does not implement the encrypted PUSH variant.**
  You may leave the device comm key empty or at its default; whatever value
  you set is not checked by `aogc-bicms-adms`.
- Consequence: device-to-server traffic is plaintext HTTP and the serial is
  self-reported by the client. The serial allowlist and `allowedNetworks`
  CIDR policy on the server are ACCESS CONTROL, NOT authentication. Anyone on
  the network can claim a known serial. Keep the terminal LAN isolated.
- The bearer token that protects ports 8082/8443 is a server-to-application
  secret; it never appears on the device and is unrelated to the comm key.

## 4. Reference values are EXAMPLES, not defaults

Values you may find in older documents or photos of the original deployment:

| Value | Meaning | Default? |
|-------|---------|----------|
| Serial `JYM6244400083` | serial number of ONE specific physical device from the original installation | NO -- read the real serial from each terminal (`MENU -> System Info -> Device Info` or the device label) and register that |
| Host `192.168.1.168` | LAN address of the original server machine | NO -- use your own server host address |
| Port `4370` | the ZKTeco local SDK TCP port used by pull-based tools | NO -- the ADMS/PUSH destination port of this runtime is **8081** |

Do not copy any of these values into a new installation.

## 5. Behavior you should expect

- The terminal polls `/iclock/getrequest` every few seconds. This server
  ALWAYS answers with an empty body: it never issues commands, never asks the
  device for users/templates/photos, and never requests attendance deletion.
- Punches arrive as `POST /iclock/cdata?...&table=ATTLOG` with TAB-separated
  lines. Field order is strict: user id, device-local timestamp, punch state,
  verification method (state and method are never swapped by the server).
- Duplicate pushes (same serial, user, timestamp, state, method) are
  collapsed server-side; the immutable row id never changes.
- If the terminal is unregistered on the server, pushes are accepted with a
  neutral `OK` but NOTHING is stored and the device never appears as
  registered -- by design (the registration state is not revealed to the
  device). Check the config `serials` list if punches never show up.

## 6. Troubleshooting checklist

1. Terminal shows no connection: ping the server from the terminal LAN, check
   that port 8081 is not firewalled, confirm the Server Port is 8081.
2. Server journal shows `unknown serial '<SN>' ... denied registration`:
   add the serial to the server config (`serials`) or enable the sandbox
   `allowAnyNetwork` mode, then restart the service.
3. Server journal shows `source ... rejected by allowedNetworks policy`:
   the terminal's source IP is outside the CIDR list configured for that
   serial; fix the CIDR or the LAN path (no NAT surprises -- the policy sees
   the socket peer address).
4. Punches appear with a wrong time: fix the terminal clock; the server
   stores the device-local timestamp verbatim and the application applies the
   configured timezone offset.
5. Application shows the device offline although it pings: `online` means
   "pushed within the last 90 seconds" -- a terminal that only idles on the
   LAN without successful handshakes is offline from the application's point
   of view.
