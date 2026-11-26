import "server-only";

// ============================================================
// ADMS address helpers — split a pasted server origin into
// protocol / host / port, with strict validation.
//
// A pasted value like "http://193.181.211.71:8080" or "10.0.0.5:8081"
// or "adms.example.gov.af" is normalized into components. The DEVICE-
// facing destination and the APPLICATION-facing authenticated API are
// kept apart by the caller; changing these values in the application
// never claims to change Windows network settings, the terminal's
// Ethernet address, its ADMS menu, router configuration or hosting
// provider firewall rules.
// ============================================================

export const ADMS_PROTOCOLS = ["http", "https"] as const;
export type AdmsProtocol = (typeof ADMS_PROTOCOLS)[number];

export const DEFAULT_ADMS_PORTS = {
  ssh: 22,
  deviceListener: 8081,
  internalApi: 8082,
  httpsApi: 8443,
} as const;

export interface ParsedAdmsAddress {
  protocol: AdmsProtocol;
  host: string;
  port: number;
}

const HOST_RE = /^[a-zA-Z0-9._-]{1,253}$/;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function validHost(host: string): boolean {
  if (!HOST_RE.test(host)) return false;
  const m = IPV4_RE.exec(host);
  if (m) return m.slice(1).every((p) => Number(p) <= 255);
  return true; // hostname (loose validation, DNS decides at connect time)
}

/**
 * Parse a full origin, host:port pair or bare host.
 * Returns null for anything unsafe/unparseable.
 */
export function parseAdmsAddress(input: string, fallbackPort = 8081, fallbackProtocol: AdmsProtocol = "http"): ParsedAdmsAddress | null {
  if (typeof input !== "string") return null;
  let value = input.trim();
  if (!value || value.length > 253) return null;
  let protocol: AdmsProtocol = fallbackProtocol;
  const protoMatch = /^(https?):\/\/(.+)$/i.exec(value);
  if (protoMatch) {
    protocol = protoMatch[1].toLowerCase() as AdmsProtocol;
    value = protoMatch[2];
  }
  // strip path / trailing slashes — a bare origin is required
  value = value.split("/")[0].trim();
  if (!value) return null;

  let host = value;
  let port = 0;
  // bracketed IPv6 is not supported for terminals (IPv4/hostname only)
  const lastColon = value.lastIndexOf(":");
  if (lastColon > 0 && !value.includes("]")) {
    host = value.slice(0, lastColon);
    const portStr = value.slice(lastColon + 1);
    if (!/^\d{1,5}$/.test(portStr)) return null;
    port = Number(portStr);
    if (port < 1 || port > 65535) return null;
  }
  host = host.toLowerCase();
  if (!validHost(host)) return null;
  return { protocol, host, port: port || fallbackPort };
}

/** Rebuild a normalized origin from components. */
export function admsOrigin(a: ParsedAdmsAddress): string {
  return `${a.protocol}://${a.host}:${a.port}`;
}

/** Is this host loopback (protected tunnel allowance for token auth)? */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".localhost") || h === "0.0.0.0";
}
