/**
 * ADMS setup-wizard backend UNIT-LEVEL smoke test.
 *
 * bun --conditions react-server tests/adms-setup-smoke.ts
 *
 * (--conditions react-server lets the server-only marker modules resolve
 *  outside Next.js; nothing here contacts a real server and NO real SSH
 *  connection is attempted.)
 *
 * Coverage:
 *  1. python bundle builder: builds tar.gz (placeholder runtime when the
 *     real bicms_adms.py is absent), deterministic checksum, tar contents.
 *  2. signed setup plans: signature verify positive/negative, tamper
 *     rejection, expiry rejection, single-use replay rejection.
 *  3. ss -tlnp listener parsing (pure guard function).
 *  4. NDJSON stream writer: line framing + Dari Unicode integrity.
 */

import { spawnSync } from "child_process";
import { existsSync } from "fs";

import {
  buildPythonBundle,
  disposeBundleCache,
  ADMS_PYTHON_ENTRY,
} from "@/lib/biometric/adms-python-package";
import {
  createSetupPlan,
  verifyPlanSignature,
  verifyPlanToken,
} from "@/lib/biometric/adms-setup-plan";
import { parseSsListeners, occupancyFor } from "@/lib/biometric/adms-setup-guard";
import { createNdjsonResponse } from "@/lib/biometric/adms-setup-response";
import { ADMS_PLAN_TTL_MS, type SetupEvent, type SetupPlan } from "@/lib/biometric/adms-setup-contract";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    failures++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  // ---------------- 1) python bundle ----------------
  console.log("== bundle builder ==");
  const artifact = buildPythonBundle();
  check("bundle built", existsSync(artifact.path), artifact.path);
  check("checksum is sha256 hex", /^[0-9a-f]{64}$/.test(artifact.checksum), artifact.checksum);
  check("size > 0", artifact.sizeBytes > 0, `${artifact.sizeBytes} bytes`);

  const listing = spawnSync("tar", ["-tzf", artifact.path], { encoding: "utf8" });
  const entries = listing.stdout.split(/\r?\n/).filter(Boolean);
  check("tar lists bicms_adms.py", entries.some((e) => e.includes(ADMS_PYTHON_ENTRY)), entries.join(" | "));
  check("tar lists requirements.lock", entries.some((e) => e.includes("requirements.lock")));
  check("tar lists README.md", entries.some((e) => e.includes("README.md")));
  const realRuntimeExists = existsSync(new URL("../mini-services/adms-server/python/bicms_adms.py", import.meta.url).pathname);
  check(
    "runtime source matches repo state",
    artifact.pythonSource === (realRuntimeExists ? "repo" : "placeholder"),
    `pythonSource=${artifact.pythonSource}, repoFile=${realRuntimeExists}`
  );

  const again = buildPythonBundle();
  check("bundle cached per checksum", again.checksum === artifact.checksum && again.path === artifact.path);

  // ---------------- 2) signed plans ----------------
  console.log("== signed plans ==");
  const planArgs = {
    adminId: 42,
    host: "198.51.100.10",
    ports: { ssh: 22, deviceListener: 8081, internalApi: 8082, httpsApi: 8443 },
    deviceSerial: "CY841-TEST-1",
    sshFingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA0",
    arch: "x86_64",
    artifactChecksum: artifact.checksum,
    mode: "install" as const,
  };
  const created = createSetupPlan(planArgs);
  const plan: SetupPlan = created.plan;

  const fresh = await verifyPlanToken(created.planToken, { adminId: 42, artifactChecksum: artifact.checksum });
  check("fresh plan verifies", fresh.ok, fresh.ok ? `${fresh.plan.planId}` : fresh.reason);

  const tokenSig = created.planToken.slice(created.planToken.indexOf(".") + 1);
  check("token signature matches plan", verifyPlanSignature(plan, tokenSig));
  check("signature negative", !verifyPlanSignature(plan, tokenSig.replace(/^./, tokenSig[0] === "0" ? "1" : "0")));

  const tampered = `${plan.planId}.${tokenSig.slice(0, -2)}xy`;
  const tamperedRes = await verifyPlanToken(tampered);
  check("tampered token rejected", !tamperedRes.ok, tamperedRes.ok ? "" : tamperedRes.reason);

  const expired = createSetupPlan({ ...planArgs, nowMs: Date.now() - ADMS_PLAN_TTL_MS - 60_000 });
  const expiredRes = await verifyPlanToken(expired.planToken, { nowMs: Date.now() });
  check(
    "expired plan rejected",
    !expiredRes.ok,
    expiredRes.ok ? "" : expiredRes.reason
  );

  const wrongAdmin = await verifyPlanToken(created.planToken, { adminId: 999 });
  check("wrong admin rejected", !wrongAdmin.ok, wrongAdmin.ok ? "" : wrongAdmin.reason);

  const wrongChecksum = await verifyPlanToken(created.planToken, { adminId: 42, artifactChecksum: "0".repeat(64) });
  check("changed bundle checksum rejected", !wrongChecksum.ok, wrongChecksum.ok ? "" : wrongChecksum.reason);

  const consumed = await verifyPlanToken(created.planToken, { adminId: 42, consume: true });
  check("consume ok (single-use burn)", consumed.ok, consumed.ok ? "" : consumed.reason);

  const replayed = await verifyPlanToken(created.planToken, { adminId: 42, consume: true });
  check("replay rejected", !replayed.ok, replayed.ok ? "" : replayed.reason);

  // ---------------- 3) ss parsing (pure) ----------------
  console.log("== ss -tlnp parsing ==");
  const sample = [
    "State  Recv-Q  Send-Q  Local Address:Port  Peer Address:Port  Process",
    "LISTEN 0      128     0.0.0.0:22          0.0.0.0:*          users:((\"sshd\",pid=812,fd=3))",
    "LISTEN 0      511     0.0.0.0:8081        0.0.0.0:*          users:((\"nginx\",pid=901,fd=6))",
    "LISTEN 0      128     [::]:8443           [::]:*             users:((\"python3\",pid=1200,fd=7))",
    "LISTEN 0      128     127.0.0.1:9999      0.0.0.0:*",
  ].join("\n");
  const rows = parseSsListeners(sample);
  check("ssh 22 detected", occupancyFor(rows, 22).occupied && occupancyFor(rows, 22).byWhom?.includes("sshd") === true, occupancyFor(rows, 22).byWhom ?? "");
  check("8081 detected with process", occupancyFor(rows, 8081).byWhom?.includes("nginx") === true);
  check("[::]:8443 detected", occupancyFor(rows, 8443).occupied);
  check("9999 detected w/o process name", occupancyFor(rows, 9999).occupied && occupancyFor(rows, 9999).byWhom?.includes("ناشناس") === true);
  check("8443 process name parsed", occupancyFor(rows, 8443).byWhom?.includes("python3") === true, occupancyFor(rows, 8443).byWhom ?? "");

  // ---------------- 4) NDJSON stream writer ----------------
  console.log("== ndjson writer ==");
  const events: SetupEvent[] = [
    { type: "stage", stage: "connecting", message: "در حال اتصال به سرور…" },
    { type: "progress", percent: 50, bytesSent: 512, bytesTotal: 1024 },
    { type: "log", message: "بسته منتقل شد (جملات دری: «تست» و newline امن می‌ماند).\nاین خط داخل رشته است و نباید فریم را بشکند." },
    { type: "need-inspect", message: "احتمال: فایروال…" },
    { type: "error", message: "قطع اتصال", uncertain: true },
    { type: "done", result: { apiUrl: "https://198.51.100.10:8443", caPem: "-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----", tokenSaved: true, listenersOk: true, apiOk: true } },
  ];
  const res = createNdjsonResponse({
    run: async (emit) => {
      for (const ev of events) emit.send(ev);
    },
  });
  const text = await new Response(res.body).text();
  const lines = text.split("\n").filter((l) => l.length > 0);
  check("one line per event", lines.length === events.length, `${lines.length} lines`);
  let parseOk = true;
  let unicodeOk = false;
  let framingOk = false;
  const parsed: SetupEvent[] = [];
  for (const line of lines) {
    try {
      const ev = JSON.parse(line) as SetupEvent;
      parsed.push(ev);
      if ("message" in ev && typeof ev.message === "string" && ev.message.includes("جملات دری")) unicodeOk = true;
    } catch {
      parseOk = false;
    }
  }
  check("all lines are JSON objects", parseOk);
  check("dari unicode preserved", unicodeOk);
  // The embedded \n must be JSON-escaped ("\\n") in the raw text so line
  // framing survives; line count == event count already proves framing.
  framingOk = text.includes("\\n") && lines.length === events.length;
  check("embedded newline escaped, framing intact", framingOk);
  const last = parsed[parsed.length - 1] as Extract<SetupEvent, { type: "done" }>;
  check("done event last with result", last?.type === "done" && last.result.apiUrl === "https://198.51.100.10:8443" && last.result.listenersOk === true);

  // ---------------- cleanup ----------------
  disposeBundleCache();
  try {
    const { db } = await import("@/lib/db");
    await db.terminalReceipt.deleteMany({ where: { deviceKey: "adms-setup-plan" } });
  } catch {
    // dev DB not reachable in this environment — receipts are TTL-bound anyway
  }

  console.log("");
  if (failures > 0) {
    console.log(`SMOKE RESULT: ${failures} FAILURE(S)`);
    process.exit(1);
  }
  console.log("SMOKE RESULT: ALL CHECKS PASSED");
}

main().catch((e) => {
  console.error("SMOKE ERROR:", e instanceof Error ? e.message : e);
  process.exit(1);
});
