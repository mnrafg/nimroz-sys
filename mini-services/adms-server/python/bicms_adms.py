#!/usr/bin/env python3
"""
aogc-bicms-adms -- single-file ADMS runtime for the AOGC Border Import
Control System (BICMS).

One process, three simultaneous listeners:

  1. Device-facing native HTTP (default 0.0.0.0:8081)
     ZKTeco PUSH protocol: /iclock/cdata (+ .aspx), /iclock/getrequest
     (+ .aspx), /iclock/devicecmd (+ .aspx). Receives ATTLOG punch rows.
     This listener NEVER issues device commands and never binds 8080
     (the legacy ADMS service and any Frappe service are separate).

  2. Loopback-only authenticated read-only API (default 127.0.0.1:8082)
     GET /, GET /api/devices/{serial}/status,
     GET /api/attendance?device_sn=...&limit=...&offset=...&include_total=...
     Bearer-token protected (constant-time compare).

  3. Authenticated HTTPS API (default 0.0.0.0:8443)
     Same private API over TLS with a self-signed certificate generated
     at install (/etc/aogc-bicms-adms/tls.pem) or, when that path is not
     writable, generated into the data directory on first run using the
     `openssl` CLI.

Design guarantees:
  - Read-only toward the world: the private API has no write endpoints,
    no template/photo endpoints, no ERPNext synchronization, no attendance
    deletion, and the server never sends device commands.
  - Separate SQLite storage: <data>/bicms-adms.db (WAL mode) with a
    service metadata table; a foreign database file is refused, not reused.
  - Strict ATTLOG field order: user id, device timestamp, punch state,
    verification method. Punch state and verification method are never
    interchanged. Invalid lines are skipped, never guessed.
  - Immutable attendance rows: INSERT OR IGNORE against a UNIQUE key;
    rows are never deleted and ids are never renumbered.
  - Serial allowlist / per-serial CIDR policy are access control only,
    NOT cryptographic authentication (the device-side PUSH protocol is
    plaintext and self-identifying; see README.md).

Python 3.10+. Dependencies: fastapi + uvicorn only (see requirements.lock).
"""

from __future__ import annotations

import asyncio
import hmac
import ipaddress
import json
import logging
import os
import secrets
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from typing import Any, Optional

import uvicorn
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse, Response

VERSION = "1.0.0"
SERVICE_NAME = "aogc-bicms-adms"
SCHEMA_VERSION = 1

DEFAULT_DATA_DIR = "/var/lib/aogc-bicms-adms"
CONFIG_FILENAME = "bicms_adms.json"
DB_FILENAME = "bicms-adms.db"
SYSTEM_TLS_PEM = "/etc/aogc-bicms-adms/tls.pem"

DEFAULT_PORTS = {"device": 8081, "internalApi": 8082, "httpsApi": 8443}
DEFAULT_BINDS = {"device": "0.0.0.0", "internalApi": "127.0.0.1", "httpsApi": "0.0.0.0"}
PORT_KEYS = ("device", "internalApi", "httpsApi")

MAX_ATTLOG_LINES = 100
MAX_BODY_BYTES = 512 * 1024
ONLINE_WINDOW_SEC = 90
MAX_LIMIT = 200
MAX_OFFSET = 1_000_000
MAX_USER_ID_LEN = 64
INT_FIELD_MIN = -(2**31)
INT_FIELD_MAX = 2**31

logger = logging.getLogger("bicms_adms")


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------


class ConfigError(Exception):
    """Fatal configuration problem (process refuses to start)."""


class DatabaseError(Exception):
    """Fatal storage problem, including foreign database refusal."""


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------


def utc_now_iso() -> str:
    """UTC timestamp used for first_seen/last_seen/received_at."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_int_port(value: Any, ctx: str) -> int:
    if isinstance(value, bool):
        raise ConfigError(f"invalid port for {ctx}: {value!r}")
    try:
        port = int(value)
    except (TypeError, ValueError):
        raise ConfigError(f"invalid port for {ctx}: {value!r}") from None
    if not 1 <= port <= 65535:
        raise ConfigError(f"port out of range for {ctx}: {port}")
    return port


def is_loopback_bind(host: str) -> bool:
    host = host.strip()
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


def parse_networks(spec: Any, serial: str) -> list:
    """Validate an allowedNetworks value into a list of ip_network objects."""
    if spec is None:
        return []
    if not isinstance(spec, list):
        raise ConfigError(
            f"serial {serial!r}: allowedNetworks must be null or a list of CIDR strings"
        )
    nets = []
    for item in spec:
        if not isinstance(item, str) or not item.strip():
            raise ConfigError(f"serial {serial!r}: invalid CIDR entry {item!r}")
        try:
            nets.append(ipaddress.ip_network(item.strip(), strict=False))
        except ValueError:
            raise ConfigError(f"serial {serial!r}: invalid CIDR entry {item!r}") from None
    if not nets:
        logger.warning(
            "serial %s has an empty allowedNetworks list: all sources will be rejected",
            serial,
        )
    return nets


def write_default_config(path: str) -> None:
    """First-run config: random bearer token, empty serials, sandbox-friendly."""
    payload = {
        "serials": {},
        "allowAnyNetwork": True,
        "bearer_token": secrets.token_urlsafe(32),
        "ports": dict(DEFAULT_PORTS),
    }
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2)
        fh.write("\n")
    logger.warning(
        "first-run configuration created at %s with allowAnyNetwork=true "
        "(sandbox convenience: any device serial may register). For production, "
        'set "allowAnyNetwork": false and add explicit entries under "serials".',
        path,
    )


def merge_overrides(base: dict, raw: Any, env_json: Any, ctx: str, key_ok) -> dict:
    merged = dict(base)
    for source_name, source in (("config file", raw), (f"env {ctx}", env_json)):
        if source is None:
            continue
        if not isinstance(source, dict):
            raise ConfigError(f"{ctx}: {source_name} must be a JSON object")
        for k, v in source.items():
            if not key_ok(k):
                logger.warning("%s: ignoring unknown key %r in %s", ctx, k, source_name)
                continue
            merged[k] = v
    return merged


class Runtime:
    """Prepared, validated runtime state shared by all three listeners."""

    def __init__(self, data_dir: str) -> None:
        self.data_dir = data_dir
        self.config_path = os.path.join(data_dir, CONFIG_FILENAME)
        self.db_path = os.path.join(data_dir, DB_FILENAME)
        self.store: Optional[Store] = None
        self.device_app: Optional[FastAPI] = None
        self.api_app: Optional[FastAPI] = None
        self.token = ""
        self.ports: dict = {}
        self.binds: dict = {}
        self.allow_any = False
        # serial -> {"networks": [...], "note": ...}; networks pre-parsed
        self.serials: dict = {}
        self._unknown_logged: set = set()

    # ---- configuration ---------------------------------------------------

    def load_config(self) -> None:
        if not os.path.exists(self.config_path):
            write_default_config(self.config_path)
        try:
            with open(self.config_path, "r", encoding="utf-8") as fh:
                raw = json.load(fh)
        except (OSError, json.JSONDecodeError) as exc:
            raise ConfigError(
                f"cannot read configuration {self.config_path}: {exc} "
                "(a malformed config is never silently regenerated, because it "
                "would rotate the bearer token)"
            ) from None
        if not isinstance(raw, dict):
            raise ConfigError(f"configuration {self.config_path} must be a JSON object")

        # bearer token: env wins; an env override is never persisted back
        env_token = os.environ.get("BICMS_ADMS_TOKEN", "").strip()
        token = env_token or raw.get("bearer_token")
        if not isinstance(token, str) or not token.strip():
            raise ConfigError(
                f"configuration {self.config_path} has no usable bearer_token "
                "(and BICMS_ADMS_TOKEN is not set)"
            )
        self.token = token.strip()

        # ports: config "ports" merged over defaults, env BICMS_ADMS_PORTS on top
        env_ports = None
        raw_env_ports = os.environ.get("BICMS_ADMS_PORTS", "").strip()
        if raw_env_ports:
            try:
                env_ports = json.loads(raw_env_ports)
            except json.JSONDecodeError as exc:
                raise ConfigError(f"BICMS_ADMS_PORTS is not valid JSON: {exc}") from None
        ports_raw = merge_overrides(
            DEFAULT_PORTS, raw.get("ports"), env_ports, "BICMS_ADMS_PORTS",
            lambda k: k in PORT_KEYS,
        )
        for key in PORT_KEYS:
            self.ports[key] = parse_int_port(ports_raw.get(key), f"ports.{key}")

        # binds: optional overrides; internalApi stays loopback-only (enforced)
        env_binds = None
        raw_env_binds = os.environ.get("BICMS_ADMS_BIND", "").strip()
        if raw_env_binds:
            try:
                env_binds = json.loads(raw_env_binds)
            except json.JSONDecodeError as exc:
                raise ConfigError(f"BICMS_ADMS_BIND is not valid JSON: {exc}") from None
        binds_raw = merge_overrides(
            DEFAULT_BINDS, raw.get("bind"), env_binds, "BICMS_ADMS_BIND",
            lambda k: k in PORT_KEYS,
        )
        for key in PORT_KEYS:
            bind = binds_raw.get(key)
            if not isinstance(bind, str) or not bind.strip():
                raise ConfigError(f"bind.{key} must be a non-empty host string")
            bind = bind.strip()
            if key == "internalApi" and not is_loopback_bind(bind):
                raise ConfigError(
                    f"bind.internalApi must be loopback-only (127.0.0.0/8 or ::1); "
                    f"refusing to expose the private API on {bind!r}"
                )
            self.binds[key] = bind

        # allowAnyNetwork: a missing key in a hand-written config means False (safe)
        allow_any = raw.get("allowAnyNetwork", False)
        if not isinstance(allow_any, bool):
            raise ConfigError("allowAnyNetwork must be true or false")
        self.allow_any = allow_any

        # serials
        serials_raw = raw.get("serials", {})
        if serials_raw is None:
            serials_raw = {}
        if not isinstance(serials_raw, dict):
            raise ConfigError("serials must be a JSON object keyed by device serial")
        for serial, entry in serials_raw.items():
            if not isinstance(serial, str) or not serial.strip():
                raise ConfigError(f"invalid serial key {serial!r} in serials")
            serial = serial.strip()
            if entry is None:
                entry = {}
            if not isinstance(entry, dict):
                raise ConfigError(f"serials.{serial} must be a JSON object")
            networks = parse_networks(entry.get("allowedNetworks"), serial)
            note = entry.get("note")
            if note is not None and not isinstance(note, str):
                raise ConfigError(f"serials.{serial}.note must be a string")
            self.serials[serial] = {"networks": networks, "note": note}

    # ---- device access policy -------------------------------------------

    PERMITTED = "permitted"
    POLICY_REJECT = "policy_reject"
    UNKNOWN_DENY = "unknown_deny"

    def evaluate_serial(self, serial: str, client_ip: str) -> str:
        """Access-control decision for a self-reported device serial.

        This is a network/allowlist policy only. It is NOT authentication:
        the device-facing PUSH protocol is plaintext and the serial is
        self-reported by the client (see README.md).
        """
        entry = self.serials.get(serial)
        if entry is not None:
            networks = entry["networks"]
            if networks:
                try:
                    ip = ipaddress.ip_address(client_ip)
                except ValueError:
                    return self.POLICY_REJECT
                if not any(ip in net for net in networks):
                    return self.POLICY_REJECT
            return self.PERMITTED
        if self.allow_any:
            return self.PERMITTED
        if serial not in self._unknown_logged:
            self._unknown_logged.add(serial)
            logger.info(
                "unknown serial %r from %s denied registration (neutral reply, "
                "no data stored)",
                serial,
                client_ip or "-",
            )
        return self.UNKNOWN_DENY


# ---------------------------------------------------------------------------
# SQLite storage (dedicated BICMS ADMS database)
# ---------------------------------------------------------------------------


class Store:
    def __init__(self, path: str) -> None:
        self.path = path
        self.con: Optional[sqlite3.Connection] = None

    def open(self) -> None:
        existed_nonempty = os.path.exists(self.path) and os.path.getsize(self.path) > 0
        try:
            con = sqlite3.connect(self.path, timeout=5)
        except sqlite3.Error as exc:
            raise DatabaseError(f"cannot open {self.path}: {exc}") from None
        con.isolation_level = None  # autocommit; each statement is atomic
        try:
            con.execute("PRAGMA busy_timeout=5000")
            con.execute("PRAGMA journal_mode=WAL")
            if existed_nonempty:
                self._verify_identity(con)
            self._ensure_schema(con)
        except sqlite3.Error as exc:
            con.close()
            raise DatabaseError(f"cannot initialize {self.path}: {exc}") from None
        self.con = con

    def _verify_identity(self, con: sqlite3.Connection) -> None:
        """Refuse foreign or newer databases instead of silently reusing them."""
        tables = {
            row[0] for row in con.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
        if "bicms_adms_meta" not in tables:
            raise DatabaseError(
                f"refusing to open {self.path}: the file exists but has no "
                f"bicms_adms_meta service metadata table; it is not a BICMS ADMS "
                f"database (tables present: {sorted(tables) or 'none'})"
            )
        row = con.execute("SELECT value FROM bicms_adms_meta WHERE key='service'").fetchone()
        if row is None or row[0] != SERVICE_NAME:
            raise DatabaseError(
                f"refusing to open {self.path}: service marker mismatch "
                f"(found {row[0] if row else 'none'!r}, expected {SERVICE_NAME!r})"
            )
        row = con.execute(
            "SELECT value FROM bicms_adms_meta WHERE key='schema_version'"
        ).fetchone()
        try:
            version = int(row[0]) if row else 0
        except (TypeError, ValueError):
            version = 0
        if version > SCHEMA_VERSION:
            raise DatabaseError(
                f"refusing to open {self.path}: schema_version {version} is newer "
                f"than this runtime ({SCHEMA_VERSION}); upgrade the runtime first"
            )

    def _ensure_schema(self, con: sqlite3.Connection) -> None:
        # Idempotent and additive only: existing rows and ids are preserved.
        con.execute(
            "CREATE TABLE IF NOT EXISTS bicms_adms_meta "
            "(key TEXT PRIMARY KEY, value TEXT NOT NULL)"
        )
        con.execute(
            "INSERT OR IGNORE INTO bicms_adms_meta(key, value) VALUES('service', ?)",
            (SERVICE_NAME,),
        )
        con.execute(
            "INSERT OR IGNORE INTO bicms_adms_meta(key, value) VALUES('schema_version', ?)",
            (str(SCHEMA_VERSION),),
        )
        con.execute(
            "CREATE TABLE IF NOT EXISTS bicms_adms_devices ("
            "serial TEXT PRIMARY KEY, "
            "first_seen TEXT, "
            "last_seen TEXT, "
            "last_ip TEXT, "
            "push_version TEXT)"
        )
        con.execute(
            "CREATE TABLE IF NOT EXISTS bicms_adms_attendance ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT, "
            "device_sn TEXT NOT NULL, "
            "user_id TEXT NOT NULL, "
            "device_time TEXT NOT NULL, "
            "punch_state INTEGER, "
            "verify_method INTEGER, "
            "received_at TEXT NOT NULL, "
            "UNIQUE(device_sn, user_id, device_time, punch_state, verify_method))"
        )
        con.execute(
            "CREATE INDEX IF NOT EXISTS idx_bicms_adms_attendance_device "
            "ON bicms_adms_attendance(device_sn, id)"
        )

    # ---- writes ----------------------------------------------------------

    def record_device(self, serial: str, ip: str, push_version: Optional[str]) -> bool:
        """Upsert a device row. Returns True when the serial was first seen."""
        now = utc_now_iso()
        assert self.con is not None
        row = self.con.execute(
            "SELECT 1 FROM bicms_adms_devices WHERE serial=?", (serial,)
        ).fetchone()
        if row is None:
            self.con.execute(
                "INSERT INTO bicms_adms_devices"
                "(serial, first_seen, last_seen, last_ip, push_version) "
                "VALUES(?,?,?,?,?)",
                (serial, now, now, ip, push_version),
            )
            logger.info(
                "device registered: serial=%s ip=%s push_version=%s",
                serial,
                ip or "-",
                push_version or "-",
            )
            return True
        self.con.execute(
            "UPDATE bicms_adms_devices SET last_seen=?, last_ip=?, "
            "push_version=COALESCE(?, push_version) WHERE serial=?",
            (now, ip, push_version, serial),
        )
        return False

    def insert_attendance(self, device_sn: str, rows: list) -> int:
        """Insert ATTLOG rows with INSERT OR IGNORE; returns rows actually added.

        Duplicate punches collapse on the UNIQUE key; ids are never renumbered
        and rows are never deleted.
        """
        if not rows:
            return 0
        received = utc_now_iso()
        payload = [(device_sn, uid, ts, st, vf, received) for (uid, ts, st, vf) in rows]
        before = self.con.total_changes
        self.con.executemany(
            "INSERT OR IGNORE INTO bicms_adms_attendance"
            "(device_sn, user_id, device_time, punch_state, verify_method, received_at) "
            "VALUES(?,?,?,?,?,?)",
            payload,
        )
        return self.con.total_changes - before

    # ---- reads -----------------------------------------------------------

    def get_device(self, serial: str) -> Optional[tuple]:
        row = self.con.execute(
            "SELECT serial, first_seen, last_seen, last_ip, push_version "
            "FROM bicms_adms_devices WHERE serial=?",
            (serial,),
        ).fetchone()
        return tuple(row) if row else None

    def get_attendance(self, device_sn: str, limit: int, offset: int) -> list:
        # Newest-first (ORDER BY id DESC) so a consumer paging forward from
        # offset 0 always holds the latest window of rows; consumers re-sort
        # by id when they need chronological order.
        cur = self.con.execute(
            "SELECT id, device_sn, user_id, device_time, punch_state, verify_method, "
            "received_at FROM bicms_adms_attendance WHERE device_sn=? "
            "ORDER BY id DESC LIMIT ? OFFSET ?",
            (device_sn, limit, offset),
        )
        return [tuple(r) for r in cur.fetchall()]

    def count_attendance(self, device_sn: str) -> int:
        row = self.con.execute(
            "SELECT COUNT(*) FROM bicms_adms_attendance WHERE device_sn=?", (device_sn,)
        ).fetchone()
        return int(row[0]) if row else 0

    def close(self) -> None:
        if self.con is not None:
            try:
                self.con.close()
            except sqlite3.Error:
                pass
            self.con = None


# ---------------------------------------------------------------------------
# ATTLOG parsing (strict field order, never guessed)
# ---------------------------------------------------------------------------


def parse_attlog(body: bytes) -> list:
    """Parse TAB-separated ATTLOG records.

    STRICT field order per line:
        [user id] [device timestamp "YYYY-MM-DD HH:mm:ss"] [punch state]
        [verification method]
    A leading TRANS token per line is tolerated and dropped. Lines with fewer
    than four fields, unparsable integers, or unparsable timestamps are
    skipped (never guessed). At most MAX_ATTLOG_LINES lines are considered
    per request.
    """
    text = body.decode("utf-8", errors="replace")
    lines = text.splitlines()
    if len(lines) > MAX_ATTLOG_LINES:
        logger.warning(
            "ATTLOG batch of %d lines exceeds the %d-line cap; the excess is ignored",
            len(lines),
            MAX_ATTLOG_LINES,
        )
        lines = lines[:MAX_ATTLOG_LINES]
    rows = []
    for line in lines:
        tokens = [t.strip() for t in line.split("\t")]
        if tokens and tokens[0].upper() == "TRANS":
            tokens = tokens[1:]
        if len(tokens) < 4:
            continue  # strict field order requires all four fields
        user_id = tokens[0]
        if not user_id or len(user_id) > MAX_USER_ID_LEN:
            continue
        if any(ord(c) < 32 for c in user_id):
            continue
        try:
            parsed = datetime.strptime(tokens[1], "%Y-%m-%d %H:%M:%S")
        except ValueError:
            continue  # device-local timestamp must match exactly
        device_time = parsed.strftime("%Y-%m-%d %H:%M:%S")
        try:
            state = int(tokens[2])
            verify = int(tokens[3])
        except ValueError:
            continue
        if not (
            INT_FIELD_MIN <= state <= INT_FIELD_MAX
            and INT_FIELD_MIN <= verify <= INT_FIELD_MAX
        ):
            continue
        rows.append((user_id, device_time, state, verify))
    return rows


# ---------------------------------------------------------------------------
# Device-facing PUSH application (port 8081)
# ---------------------------------------------------------------------------


def extract_unique_param(request: Request, name: str) -> tuple:
    """Case-insensitive single-valued query parameter extraction.

    Returns (value, conflicted). Repeated occurrences of the parameter with
    the SAME value are accepted; CONFLICTING values mark the request invalid.
    """
    values = {v.strip() for k, v in request.query_params.multi_items() if k.lower() == name}
    values.discard("")
    if len(values) > 1:
        return None, True
    if values:
        return values.pop(), False
    return None, False


async def read_bounded_body(request: Request) -> bytes:
    """Read at most MAX_BODY_BYTES from the request body."""
    length = request.headers.get("content-length", "")
    if length.isdigit() and int(length) > MAX_BODY_BYTES:
        raise ValueError("payload too large")
    buf = bytearray()
    async for chunk in request.stream():
        buf += chunk
        if len(buf) > MAX_BODY_BYTES:
            raise ValueError("payload too large")
    return bytes(buf)


def client_ip_of(request: Request) -> str:
    # Socket peer address only. X-Forwarded-For is deliberately ignored: it
    # is spoofable and allowedNetworks is a security control.
    client = request.client
    return client.host if client is not None else ""


def build_device_app(rt: Runtime) -> FastAPI:
    app = FastAPI(
        title=f"{SERVICE_NAME} device listener",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    def _evaluate(request: Request, sn: str) -> str:
        """One access-control decision per request; logs policy rejections."""
        decision = rt.evaluate_serial(sn, client_ip_of(request))
        if decision == Runtime.POLICY_REJECT:
            logger.warning(
                "source %s rejected by allowedNetworks policy for serial %s",
                client_ip_of(request) or "-",
                sn,
            )
        return decision
        # UNKNOWN_DENY is handled by the caller as a neutral reply:
        # no registration, no writes, identical acknowledgement.

    async def _handle_cdata(request: Request) -> Response:
        sn, conflicted = extract_unique_param(request, "sn")
        if conflicted:
            return PlainTextResponse("ERROR", status_code=400)
        try:
            body = await read_bounded_body(request)
        except ValueError:
            return PlainTextResponse("ERROR", status_code=413)
        if sn:
            decision = _evaluate(request, sn)
            if decision == Runtime.POLICY_REJECT:
                return PlainTextResponse("ERROR", status_code=403)
            if decision == Runtime.PERMITTED:
                push_version, _ = extract_unique_param(request, "pushver")
                rt.store.record_device(sn, client_ip_of(request), push_version)
                rows = parse_attlog(body)
                if rows:
                    stored = rt.store.insert_attendance(sn, rows)
                    logger.info(
                        "ATTLOG serial=%s valid=%d stored=%d duplicates=%d",
                        sn,
                        len(rows),
                        stored,
                        len(rows) - stored,
                    )
        # Permitted and denied serials both get the same neutral acknowledgement.
        return PlainTextResponse("OK")

    async def _handle_getrequest(request: Request) -> Response:
        sn, conflicted = extract_unique_param(request, "sn")
        if conflicted:
            return PlainTextResponse("ERROR", status_code=400)
        if sn:
            decision = _evaluate(request, sn)
            if decision == Runtime.POLICY_REJECT:
                return PlainTextResponse("ERROR", status_code=403)
            if decision == Runtime.PERMITTED:
                rt.store.record_device(sn, client_ip_of(request), None)
        # The response body IS the command channel on this endpoint. It stays
        # EMPTY: this server never issues device commands of any kind
        # (no user/template/photo requests, no deletions, nothing).
        return Response(status_code=200, media_type="text/plain")

    async def _handle_devicecmd(request: Request) -> Response:
        sn, conflicted = extract_unique_param(request, "sn")
        if conflicted:
            return PlainTextResponse("ERROR", status_code=400)
        try:
            await read_bounded_body(request)  # ack payload: stored nowhere
        except ValueError:
            return PlainTextResponse("ERROR", status_code=413)
        if sn:
            decision = _evaluate(request, sn)
            if decision == Runtime.POLICY_REJECT:
                return PlainTextResponse("ERROR", status_code=403)
            if decision == Runtime.PERMITTED:
                rt.store.record_device(sn, client_ip_of(request), None)
        return PlainTextResponse("OK")

    for path in ("/iclock/cdata", "/iclock/cdata.aspx"):
        app.add_api_route(path, _handle_cdata, methods=["GET", "POST"])
    for path in ("/iclock/getrequest", "/iclock/getrequest.aspx"):
        app.add_api_route(path, _handle_getrequest, methods=["GET", "POST"])
    for path in ("/iclock/devicecmd", "/iclock/devicecmd.aspx"):
        app.add_api_route(path, _handle_devicecmd, methods=["GET", "POST"])
    return app


# ---------------------------------------------------------------------------
# Private read-only API (ports 8082 + 8443)
# ---------------------------------------------------------------------------


def is_online(last_seen: str) -> bool:
    try:
        ts = datetime.strptime(last_seen, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        return False
    age = (datetime.now(timezone.utc) - ts).total_seconds()
    return 0 <= age <= ONLINE_WINDOW_SEC


def build_api_app(rt: Runtime) -> FastAPI:
    app = FastAPI(
        title=f"{SERVICE_NAME} private API",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    def require_token(request: Request) -> None:
        header = request.headers.get("authorization", "")
        parts = header.split(None, 1)
        supplied = parts[1].strip() if len(parts) == 2 and parts[0].lower() == "bearer" else ""
        ok = bool(supplied) and hmac.compare_digest(
            supplied.encode("utf-8"), rt.token.encode("utf-8")
        )
        if not ok:
            raise HTTPException(
                status_code=401,
                detail="unauthorized",
                headers={"WWW-Authenticate": "Bearer"},
            )

    @app.get("/", dependencies=[Depends(require_token)])
    async def health() -> dict:
        return {"service": SERVICE_NAME, "version": VERSION, "ok": True}

    @app.get("/api/devices/{serial}/status", dependencies=[Depends(require_token)])
    async def device_status(serial: str):
        row = rt.store.get_device(serial)
        if row is None:
            return JSONResponse(status_code=404, content={"detail": "unknown serial"})
        stored_serial, _first, last_seen, last_ip, _push = row
        return {
            "serial": stored_serial,
            "online": is_online(last_seen) if last_seen else False,
            "last_seen": last_seen,
            "ip": last_ip,
        }

    @app.get("/api/attendance", dependencies=[Depends(require_token)])
    async def attendance(
        device_sn: str = "",
        limit: int = MAX_LIMIT,
        offset: int = 0,
        include_total: bool = False,
    ):
        serial = device_sn.strip()
        limit = max(1, min(MAX_LIMIT, limit))
        offset = max(0, min(MAX_OFFSET, offset))
        # Strict scoping by the registered device serial. An unregistered (or
        # empty) serial yields an empty list, not an error -- matching the
        # legacy adapter behavior.
        rows = rt.store.get_attendance(serial, limit, offset) if serial else []
        total = rt.store.count_attendance(serial) if (include_total and serial) else None
        return {
            "attendance": [
                {
                    "id": r[0],
                    "device_sn": r[1],
                    "user_id": r[2],
                    "timestamp": r[3],
                    "state": r[4],
                    "verify": r[5],
                    "received_at": r[6],
                }
                for r in rows
            ],
            "total": total,
        }

    return app


# ---------------------------------------------------------------------------
# TLS certificate (self-signed; openssl CLI, no extra Python dependencies)
# ---------------------------------------------------------------------------


def generate_tls_pem(target: str) -> str:
    directory = os.path.dirname(target) or "."
    os.makedirs(directory, exist_ok=True)
    tmp = tempfile.mkdtemp(prefix=".tls-", dir=directory)
    key_path = os.path.join(tmp, "key.pem")
    crt_path = os.path.join(tmp, "cert.pem")
    cmd = [
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-sha256",
        "-days", "3650", "-nodes",
        "-subj", "/CN=aogc-bicms-adms",
        "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
        "-keyout", key_path, "-out", crt_path,
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True, timeout=120)
        with open(crt_path, "r", encoding="utf-8") as fh:
            cert = fh.read()
        with open(key_path, "r", encoding="utf-8") as fh:
            key = fh.read()
        pem = cert.rstrip("\n") + "\n" + key
        fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(pem)
        logger.info("generated self-signed TLS certificate at %s", target)
        return target
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def resolve_tls_pem(data_dir: str) -> Optional[str]:
    """Find or create the combined cert+key PEM for the HTTPS listener.

    Order: BICMS_ADMS_TLS_PEM override, /etc/aogc-bicms-adms/tls.pem, then
    <data>/tls.pem. Existing files win over generation.
    """
    env_path = os.environ.get("BICMS_ADMS_TLS_PEM", "").strip()
    candidates = [p for p in (env_path, SYSTEM_TLS_PEM, os.path.join(data_dir, "tls.pem")) if p]
    for candidate in candidates:
        if os.path.isfile(candidate):
            logger.info("using existing TLS certificate: %s", candidate)
            return candidate
    if shutil.which("openssl") is None:
        logger.warning(
            "openssl CLI not available and no TLS PEM found; the HTTPS API "
            "listener will not start (HTTP API on the internal port still runs)"
        )
        return None
    for target in candidates:
        try:
            return generate_tls_pem(target)
        except (OSError, subprocess.SubprocessError) as exc:
            logger.info("cannot generate TLS PEM at %s: %s", target, exc)
    logger.warning("no TLS certificate could be created; HTTPS API listener disabled")
    return None


# ---------------------------------------------------------------------------
# Process: three uvicorn servers, graceful shutdown
# ---------------------------------------------------------------------------


class ManagedServer(uvicorn.Server):
    """uvicorn Server that shuts down ALL listeners on one signal.

    Each server installs handle_exit while it runs; the last installation
    owns the OS signal handler, so the override below fans the shutdown out
    to every listener in the registry.
    """

    def __init__(self, config: uvicorn.Config, registry: list) -> None:
        super().__init__(config)
        self._registry = registry

    def handle_exit(self, sig: int, frame: Any) -> None:
        self._captured_signals.append(sig)
        for server in self._registry:
            if server.should_exit and sig == signal.SIGINT:
                server.force_exit = True
            else:
                server.should_exit = True


def print_banner(rt: Runtime, tls_pem: Optional[str]) -> None:
    logger.info("%s %s starting", SERVICE_NAME, VERSION)
    logger.info(
        "device listener:     http://%s:%d  (ZKTeco PUSH; never issues commands)",
        rt.binds["device"],
        rt.ports["device"],
    )
    logger.info(
        "private API (http):  http://%s:%d  (loopback-only, bearer token required)",
        rt.binds["internalApi"],
        rt.ports["internalApi"],
    )
    if tls_pem:
        logger.info(
            "private API (https): https://%s:%d  (TLS cert: %s)",
            rt.binds["httpsApi"],
            rt.ports["httpsApi"],
            tls_pem,
        )
    else:
        logger.warning(
            "private API (https): DISABLED on port %d (no TLS certificate available)",
            rt.ports["httpsApi"],
        )
    logger.info("data dir: %s  database: %s", rt.data_dir, rt.db_path)
    logger.info(
        "serial policy: %d explicit serial(s), allowAnyNetwork=%s",
        len(rt.serials),
        rt.allow_any,
    )
    if rt.allow_any:
        logger.warning(
            "allowAnyNetwork=true: ANY device serial may register and push "
            "attendance. Acceptable for sandboxes only."
        )


async def serve(rt: Runtime, tls_pem: Optional[str]) -> int:
    registry: list = []

    def make_server(app: FastAPI, bind: str, port: int, **ssl_kwargs: Any) -> ManagedServer:
        config = uvicorn.Config(
            app,
            host=bind,
            port=port,
            log_level="info",
            access_log=False,
            lifespan="off",
            ws="none",
            server_header=False,
            timeout_graceful_shutdown=5,
            **ssl_kwargs,
        )
        server = ManagedServer(config, registry)
        registry.append(server)
        return server

    servers = [
        make_server(rt.device_app, rt.binds["device"], rt.ports["device"]),
        make_server(rt.api_app, rt.binds["internalApi"], rt.ports["internalApi"]),
    ]
    if tls_pem:
        servers.append(
            make_server(
                rt.api_app,
                rt.binds["httpsApi"],
                rt.ports["httpsApi"],
                ssl_certfile=tls_pem,
                ssl_keyfile=tls_pem,
            )
        )

    tasks = [
        asyncio.create_task(s.serve(), name=f"listener-{i}")
        for i, s in enumerate(servers)
    ]
    # A bind failure inside uvicorn raises SystemExit and terminates the
    # process with a clear log; any other unexpected failure stops siblings
    # via the shared handle_exit fan-out.
    results = await asyncio.gather(*tasks, return_exceptions=True)
    failures = [r for r in results if isinstance(r, Exception)]
    for failure in failures:
        logger.error("listener failed: %r", failure)
    return 1 if failures else 0


def build_runtime() -> Runtime:
    data_dir = os.environ.get("BICMS_ADMS_DATA_DIR", "").strip() or DEFAULT_DATA_DIR
    data_dir = os.path.abspath(os.path.expanduser(data_dir))
    os.makedirs(data_dir, mode=0o750, exist_ok=True)
    rt = Runtime(data_dir)
    rt.load_config()
    rt.store = Store(rt.db_path)
    rt.store.open()
    rt.device_app = build_device_app(rt)
    rt.api_app = build_api_app(rt)
    return rt


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s | %(message)s",
        stream=sys.stderr,
    )
    try:
        rt = build_runtime()
    except (ConfigError, DatabaseError) as exc:
        logger.critical("%s", exc)
        return 2
    tls_pem = resolve_tls_pem(rt.data_dir)
    print_banner(rt, tls_pem)
    try:
        code = asyncio.run(serve(rt, tls_pem))
    finally:
        rt.store.close()
    logger.info("%s stopped", SERVICE_NAME)
    return code


if __name__ == "__main__":
    sys.exit(main())
