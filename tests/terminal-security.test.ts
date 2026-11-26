// ============================================================
// Unit tests: terminal security helpers (secret encryption at rest,
// credential salts, HMAC signing, canonical strings, replay receipts).
//
// The `server-only` mock must be registered before the modules load;
// bun does not hoist mock.module above static imports, so the modules
// under test are imported dynamically after the mock call.
// ============================================================
import { mock, test, expect, describe } from "bun:test";
import { createHash, createHmac } from "node:crypto";

mock.module("server-only", () => ({}));

const sec = await import("../src/lib/biometric/terminal-security");

const {
  encryptTerminalSecret,
  decryptTerminalSecret,
  generateCredentialSalt,
  signWithSalt,
  canonicalIngestionString,
  newReceiptId,
  safeEqualHex,
  sha256Hex,
  sanitizeDetail,
} = sec;

describe("encryptTerminalSecret / decryptTerminalSecret (AES-256-GCM at rest)", () => {
  test("round trip preserves the plaintext", () => {
    const plain = "CQJH-key-123";
    const enc = encryptTerminalSecret(plain);
    expect(typeof enc).toBe("string");
    expect(enc).not.toBe(plain);
    expect(decryptTerminalSecret(enc)).toBe(plain);
  });

  test("round trip preserves non-ASCII (utf8) secrets", () => {
    const plain = "کلید ارتباط ۱۲۳";
    expect(decryptTerminalSecret(encryptTerminalSecret(plain))).toBe(plain);
  });

  test("output is base64 in iv|tag|ciphertext layout", () => {
    const enc = encryptTerminalSecret("k");
    expect(enc).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    const raw = Buffer.from(enc, "base64");
    // 12-byte iv + 16-byte auth tag + at least 1 byte ciphertext
    expect(raw.length).toBeGreaterThanOrEqual(12 + 16 + 1);
  });

  test("random IV → same plaintext encrypts to different ciphertexts", () => {
    const a = encryptTerminalSecret("same-key");
    const b = encryptTerminalSecret("same-key");
    expect(a).not.toBe(b);
    expect(decryptTerminalSecret(a)).toBe("same-key");
    expect(decryptTerminalSecret(b)).toBe("same-key");
  });

  test("tampered ciphertext throws (GCM auth tag mismatch)", () => {
    const enc = encryptTerminalSecret("tamper-me");
    const raw = Buffer.from(enc, "base64");
    raw[raw.length - 1] ^= 0xff; // flip a ciphertext byte
    expect(() => decryptTerminalSecret(raw.toString("base64"))).toThrow();
  });

  test("tampered IV throws as well", () => {
    const enc = encryptTerminalSecret("tamper-me");
    const raw = Buffer.from(enc, "base64");
    raw[0] ^= 0x01; // flip an IV byte
    expect(() => decryptTerminalSecret(raw.toString("base64"))).toThrow();
  });

  test("truncated payload throws", () => {
    const enc = encryptTerminalSecret("truncate-me");
    const raw = Buffer.from(enc, "base64").subarray(0, 20);
    expect(() => decryptTerminalSecret(raw.toString("base64"))).toThrow();
  });
});

describe("generateCredentialSalt", () => {
  test("32 lowercase hex chars (16 bytes)", () => {
    const salt = generateCredentialSalt();
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
    expect(salt.length).toBe(32);
  });

  test("two salts differ", () => {
    expect(generateCredentialSalt()).not.toBe(generateCredentialSalt());
  });
});

describe("signWithSalt (HMAC-SHA256 over hex-decoded salt)", () => {
  test("deterministic, 64 hex chars, matches independent node:crypto computation", () => {
    const salt = generateCredentialSalt();
    const canonical = "CQJH214560083\n1735725600000\nn-1\nabc";
    const sig1 = signWithSalt(salt, canonical);
    const sig2 = signWithSalt(salt, canonical);
    expect(sig1).toBe(sig2);
    expect(sig1).toMatch(/^[0-9a-f]{64}$/);
    const expected = createHmac("sha256", Buffer.from(salt, "hex")).update(canonical, "utf8").digest("hex");
    expect(sig1).toBe(expected);
  });

  test("different salt or different canonical string → different signature", () => {
    const s1 = signWithSalt("00", "a");
    const s2 = signWithSalt("01", "a");
    const s3 = signWithSalt("00", "b");
    expect(s1).not.toBe(s2);
    expect(s1).not.toBe(s3);
  });

  test("salt is interpreted as hex bytes (not raw ascii)", () => {
    expect(signWithSalt("0000", "x")).toBe(
      createHmac("sha256", Buffer.from([0x00, 0x00])).update("x", "utf8").digest("hex")
    );
  });
});

describe("canonicalIngestionString", () => {
  test("stable documented format: serial\\nts\\nnonce\\nsha256(body)", () => {
    const body = '{"op":"ATTLOG","rows":1}';
    const s = canonicalIngestionString({
      serial: "CQJH214560083",
      body,
      timestampMs: 1735725600000,
      nonce: "n-1",
    });
    const bodyHash = createHash("sha256").update(body, "utf8").digest("hex");
    expect(s).toBe(`CQJH214560083\n1735725600000\nn-1\n${bodyHash}`);
  });

  test("same inputs → same canonical string; changed body hash changes output", () => {
    const args = { serial: "SN1", body: "A", timestampMs: 1, nonce: "x" };
    const a = canonicalIngestionString(args);
    expect(canonicalIngestionString({ ...args })).toBe(a);
    const b = canonicalIngestionString({ ...args, body: "B" });
    expect(b).not.toBe(a);
    expect(b.endsWith(sha256Hex("B"))).toBe(true);
  });
});

describe("safeEqualHex", () => {
  test("equal strings → true", () => {
    expect(safeEqualHex("aabbcc", "aabbcc")).toBe(true);
    expect(safeEqualHex("", "")).toBe(true);
    expect(safeEqualHex(sha256Hex("x"), sha256Hex("x"))).toBe(true);
  });

  test("different content (same length) → false", () => {
    expect(safeEqualHex("aabbcc", "aabbbc")).toBe(false);
  });

  test("different lengths → false", () => {
    expect(safeEqualHex("aa", "aabb")).toBe(false);
    expect(safeEqualHex("", "a")).toBe(false);
  });
});

describe("newReceiptId (replay receipts)", () => {
  test("100 samples are all distinct and UUID-shaped", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(newReceiptId());
    expect(seen.size).toBe(100);
    for (const id of seen) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });
});

describe("sha256Hex (re-exported from device crypto)", () => {
  test("known vectors", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("sanitizeDetail", () => {
  test("strips newlines/tabs/CRs and truncates to 240 chars", () => {
    expect(sanitizeDetail("line1\nline2\tcol\rd")).toBe("line1 line2 col d");
    expect(sanitizeDetail("x".repeat(300)).length).toBe(240);
    expect(sanitizeDetail("abcdef", 3)).toBe("abc");
  });
});
