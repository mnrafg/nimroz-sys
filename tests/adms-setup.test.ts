// ============================================================
// Unit tests for the signed ADMS setup plan module
// (src/lib/biometric/adms-setup-plan.ts).
//
// The module is delivered by a concurrent workstream: every test
// degrades to a graceful SKIP while the file is absent and activates
// automatically once it lands. Assertions below are written against
// the ACTUAL exported API:
//   canonicalPlanJson / signPlan / verifyPlanSignature /
//   createSetupPlan / verifyPlanToken (+ SetupPlan contract types
//   and ADMS_PLAN_TTL_MS from adms-setup-contract.ts).
// ============================================================
import { mock, test, expect, describe } from "bun:test";
import { existsSync } from "node:fs";
import { createHmac, randomUUID } from "node:crypto";
import path from "node:path";

mock.module("server-only", () => ({}));

const PLAN_FILE = path.resolve(import.meta.dir, "..", "src", "lib", "biometric", "adms-setup-plan.ts");
const CONTRACT_FILE = path.resolve(import.meta.dir, "..", "src", "lib", "biometric", "adms-setup-contract.ts");
const bothExist = existsSync(PLAN_FILE) && existsSync(CONTRACT_FILE);

const planMod = bothExist
  ? await import("../src/lib/biometric/adms-setup-plan")
  : null;
const contractMod = bothExist
  ? await import("../src/lib/biometric/adms-setup-contract")
  : null;
const secretMod = bothExist ? await import("@/lib/secret") : null;

const t = bothExist && planMod ? test : test.skip;

// ---------- fixtures ----------

function planArgs(nowMs: number, mode: "install" | "resume" | "connect" | "upgrade" = "install") {
  return {
    adminId: 7,
    host: "192.168.1.50",
    ports: { ssh: 22, deviceListener: 8081, internalApi: 8082, httpsApi: 8443 },
    deviceSerial: "CQJH214560083",
    sshFingerprint: `SHA256:${"A".repeat(42)}=`,
    arch: "x86_64",
    artifactChecksum: "ab".repeat(32),
    mode,
    nowMs,
  };
}

describe("canonicalPlanJson", () => {
  t("recursively sorts object keys; preserves array order", () => {
    const small = { b: 1, a: { d: 2, c: [3, 1] } } as never;
    expect(planMod!.canonicalPlanJson(small)).toBe('{"a":{"c":[3,1],"d":2},"b":1}');
  });

  t("is stable across repeated calls", () => {
    const { plan } = planMod!.createSetupPlan(planArgs(Date.now()));
    const c1 = planMod!.canonicalPlanJson(plan);
    const c2 = planMod!.canonicalPlanJson(plan);
    expect(c1).toBe(c2);
    expect(c1).toContain('"deviceSerial":"CQJH214560083"');
    // ports object is sorted inside the canonical string
    expect(c1).toContain('"ports":{"deviceListener":8081,"httpsApi":8443,"internalApi":8082,"ssh":22}');
  });
});

describe("signPlan / verifyPlanSignature", () => {
  t("HMAC-SHA256 over canonical JSON with the utf8 auth secret (independent check)", () => {
    const { plan } = planMod!.createSetupPlan(planArgs(Date.now()));
    const sig = planMod!.signPlan(plan);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    const secret = secretMod!.getAuthSecret();
    const expected = createHmac("sha256", Buffer.from(secret, "utf8"))
      .update(planMod!.canonicalPlanJson(plan), "utf8")
      .digest("hex");
    expect(sig).toBe(expected);
  });

  t("deterministic; any plan or signature change fails verification", () => {
    const { plan } = planMod!.createSetupPlan(planArgs(Date.now()));
    const sig = planMod!.signPlan(plan);
    expect(planMod!.signPlan(plan)).toBe(sig);
    expect(planMod!.verifyPlanSignature(plan, sig)).toBe(true);

    // tampered plan field → false
    const tampered = { ...plan, host: "10.0.0.9" };
    expect(planMod!.verifyPlanSignature(tampered, sig)).toBe(false);

    // tampered signature (right length, wrong content) → false
    expect(planMod!.verifyPlanSignature(plan, "0".repeat(64))).toBe(false);

    // wrong-length signature → false (timing-safe compare guard)
    expect(planMod!.verifyPlanSignature(plan, "00")).toBe(false);
  });
});

describe("createSetupPlan", () => {
  t("issues a plan bound to the requested fields with ~10 min TTL", () => {
    const fixedNow = Date.now();
    const { plan, planToken } = planMod!.createSetupPlan(planArgs(fixedNow));

    expect(plan.planId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(plan.adminId).toBe(7);
    expect(plan.host).toBe("192.168.1.50");
    expect(plan.ports).toEqual({ ssh: 22, deviceListener: 8081, internalApi: 8082, httpsApi: 8443 });
    expect(plan.deviceSerial).toBe("CQJH214560083");
    expect(plan.sshFingerprint).toBe(`SHA256:${"A".repeat(42)}=`);
    expect(plan.arch).toBe("x86_64");
    expect(plan.artifactChecksum).toBe("ab".repeat(32));
    expect(plan.mode).toBe("install");
    expect(plan.issuedAt).toBe(fixedNow);
    expect(plan.expiresAt).toBe(fixedNow + contractMod!.ADMS_PLAN_TTL_MS);
    expect(contractMod!.ADMS_PLAN_TTL_MS).toBe(10 * 60 * 1000);
    expect(plan.nonce).toMatch(/^[0-9a-f]{32}$/);

    // token format: "<planId>.<hex signature>"
    expect(planToken).toBe(`${plan.planId}.${planMod!.signPlan(plan)}`);
  });

  t("two plans for the same inputs differ (fresh planId + nonce)", () => {
    const a = planMod!.createSetupPlan(planArgs(Date.now()));
    const b = planMod!.createSetupPlan(planArgs(Date.now()));
    expect(a.plan.planId).not.toBe(b.plan.planId);
    expect(a.plan.nonce).not.toBe(b.plan.nonce);
    expect(a.planToken).not.toBe(b.planToken);
  });
});

describe("verifyPlanToken", () => {
  t("round trip returns the exact stored plan; repeatable without consume", async () => {
    const { plan, planToken } = planMod!.createSetupPlan(planArgs(Date.now()));

    const v = await planMod!.verifyPlanToken(planToken);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.plan).toEqual(plan);
      expect(v.plan.nonce).toBe(plan.nonce);
    }

    // verification WITHOUT consume must not burn the token
    const v2 = await planMod!.verifyPlanToken(planToken);
    expect(v2.ok).toBe(true);
  });

  t("field binding options reject mismatched consumers", async () => {
    const { plan, planToken } = planMod!.createSetupPlan(planArgs(Date.now()));

    for (const options of [
      { host: "10.9.9.9" },
      { deviceSerial: "OTHERSN9999" },
      { mode: "upgrade" as const },
      { adminId: 999 },
    ]) {
      const v = await planMod!.verifyPlanToken(planToken, options);
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.reason.length).toBeGreaterThan(0);
    }

    // matching bindings still verify
    const ok = await planMod!.verifyPlanToken(planToken, {
      host: plan.host,
      deviceSerial: plan.deviceSerial,
      mode: plan.mode,
      adminId: plan.adminId,
    });
    expect(ok.ok).toBe(true);
  });

  t("malformed or unknown tokens are rejected", async () => {
    expect((await planMod!.verifyPlanToken("")).ok).toBe(false);
    expect((await planMod!.verifyPlanToken("no-dot-token")).ok).toBe(false);
    expect((await planMod!.verifyPlanToken(".leading-dot")).ok).toBe(false);
    expect((await planMod!.verifyPlanToken("trailing-dot.")).ok).toBe(false);

    // well-shaped token for a planId that was never issued
    const unknown = `${randomUUID()}.${"0".repeat(64)}`;
    expect((await planMod!.verifyPlanToken(unknown)).ok).toBe(false);

    // issued planId but tampered signature half
    const { planToken } = planMod!.createSetupPlan(planArgs(Date.now()));
    const dot = planToken.indexOf(".");
    const sig = planToken.slice(dot + 1);
    const badSig = (sig[0] === "b" ? "c" : "b") + sig.slice(1);
    expect((await planMod!.verifyPlanToken(`${planToken.slice(0, dot + 1)}${badSig}`)).ok).toBe(false);
  });

  t("expired plans are rejected (TTL window enforced)", async () => {
    const past = Date.now() - 2 * contractMod!.ADMS_PLAN_TTL_MS;
    const { planToken } = planMod!.createSetupPlan(planArgs(past));

    // one second past the TTL boundary → rejected
    const v = await planMod!.verifyPlanToken(planToken, {
      nowMs: past + contractMod!.ADMS_PLAN_TTL_MS + 1,
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason.length).toBeGreaterThan(0);

    // exactly AT the boundary → still valid (strict `expiresAt < now`)
    const { planToken: atBoundary } = planMod!.createSetupPlan(planArgs(Date.now()));
    const v2 = await planMod!.verifyPlanToken(atBoundary, {
      nowMs: Date.now() + contractMod!.ADMS_PLAN_TTL_MS,
    });
    expect(v2.ok).toBe(true);
  });

  t("single-use replay: consumed token cannot verify again", async () => {
    const { planToken } = planMod!.createSetupPlan(planArgs(Date.now()));

    const first = await planMod!.verifyPlanToken(planToken, { consume: true });
    expect(first.ok).toBe(true);

    // second use of the SAME token — replay — must be rejected
    const second = await planMod!.verifyPlanToken(planToken, { consume: true });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason.length).toBeGreaterThan(0);

    // even a non-consuming re-check stays rejected
    const third = await planMod!.verifyPlanToken(planToken);
    expect(third.ok).toBe(false);
  });
});
