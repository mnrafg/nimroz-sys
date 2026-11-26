/// <reference types="bun-types" />
// ============================================================
// File-contract tests for the python ADMS runtime
// (mini-services/adms-server/python/bicms_adms.py).
//
// The runtime is delivered by a separate workstream — every test
// degrades to a graceful SKIP while the file is absent and activates
// automatically once it lands (verified against the delivered file).
// ============================================================
import { test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const PY_PATH = path.resolve(import.meta.dir, "..", "mini-services", "adms-server", "python", "bicms_adms.py");
const src: string | null = existsSync(PY_PATH) ? readFileSync(PY_PATH, "utf8") : null;
const t = src !== null ? test : test.skip;
// Test closures below run ONLY when src !== null (t degrades to test.skip
// otherwise) — the non-null view keeps the contracts readable.
const code = src as string;

/**
 * Remove python comments and triple-quoted docstrings so that
 * documentation-only mentions (e.g. "no ERPNext synchronization" in the
 * module docstring) are not mistaken for functional integration code.
 */
function stripDocstringsAndComments(s: string): string {
  const lines = s.split(/\r?\n/);
  let inDoc: string | null = null;
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (inDoc !== null) {
      if (trimmed.includes(inDoc)) inDoc = null; // closing delimiter line
      continue;
    }
    if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
      const q = trimmed.slice(0, 3);
      if (!trimmed.slice(3).includes(q)) inDoc = q; // multi-line docstring opener
      continue;
    }
    if (trimmed.startsWith("#")) continue;
    kept.push(line);
  }
  return kept.join("\n");
}

t("bicms_adms.py exposes the iclock endpoint + storage + auth contract", () => {
  for (const needle of [
    "iclock/cdata", // device push endpoint
    "iclock/getrequest", // device command polling endpoint
    "iclock/devicecmd", // device command ack handling
    "bicms_adms_devices", // local device table
    "bicms_adms_attendance", // local attendance table
    "Bearer", // outbound app-API authentication
  ]) {
    expect(code).toContain(needle);
  }
});

t("bicms_adms.py never disables TLS/certificate verification", () => {
  // rejectUnauthorized=false is a node idiom; the python equivalents are
  // requests' verify=False and ssl check_hostname=False / CERT_NONE.
  expect(/rejectUnauthorized/i.test(code)).toBe(false);
  expect(/verify\s*=\s*False/.test(code)).toBe(false);
  expect(/check_hostname\s*=\s*False/.test(code)).toBe(false);
  expect(/CERT_NONE/.test(code)).toBe(false);
});

t("bicms_adms.py contains no ERPNext/Frappe synchronization CODE", () => {
  // The module docstring explicitly declares what the service does NOT
  // do ("no ERPNext synchronization", "any Frappe service are separate").
  // Documentation mentions are therefore allowed — functional integration
  // (imports, REST targets, frappe bench ports) is not.
  const stripped = stripDocstringsAndComments(code);
  expect(/erpnext/i.test(stripped)).toBe(false);
  expect(/frappe/i.test(stripped)).toBe(false);
  expect(/:8000|\/api\/resource|\/api\/method/.test(stripped)).toBe(false);
});

t("bicms_adms.py ATTLOG handling references punch before verify", () => {
  const attIdx = code.indexOf("ATTLOG");
  expect(attIdx).toBeGreaterThanOrEqual(0);

  // Inspect the ATTLOG parsing neighborhood; fall back to the whole file
  // if the neighborhood itself does not mention both concepts.
  const neighborhood = code.slice(Math.max(0, attIdx - 200), attIdx + 3000);
  const scan =
    /punch|\bstate\b/i.test(neighborhood) && /verify/i.test(neighborhood) ? neighborhood : code;

  const punchIdx = scan.search(/punch|\bstate\b/i);
  const verifyIdx = scan.search(/verify|verification/i);
  expect(punchIdx).toBeGreaterThanOrEqual(0);
  expect(verifyIdx).toBeGreaterThanOrEqual(0);
  // Strict per-spec field order: punch state BEFORE verification method.
  expect(punchIdx).toBeLessThan(verifyIdx);
});
