import "server-only";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// ============================================================
// ADMS python runtime bundle builder.
//
// Packs the device-facing ADMS runtime (mini-services/adms-server/
// python/bicms_adms.py) together with requirements.lock + README.md
// into a deterministic tar.gz, and reports its sha256 checksum.
//
// The packaging is CONTENT-AGNOSTIC: whatever bicms_adms.py exists at
// build time is packed. When the real runtime file is not present yet
// (the runtime is delivered by a separate workstream), the bundle is
// built with a clearly-marked placeholder so the installer pipeline
// can be exercised end-to-end; once the real runtime lands in
// mini-services/adms-server/python/bicms_adms.py the SAME builder
// packs it with no code changes.
//
// Determinism: GNU tar is invoked with fixed ordering, owner, group,
// mode and mtime so equal content produces an equal checksum.
// ============================================================

export interface BundleArtifact {
  /** sha256 hex of the tar.gz bytes */
  checksum: string;
  /** local tar.gz path (ready for SFTP upload) */
  path: string;
  sizeBytes: number;
  /** where the python entry came from for this build */
  pythonSource: "repo" | "placeholder";
  builtAt: number;
}

const PYTHON_DIR_ENV = "BICMS_ADMS_PYTHON_DIR";

export function admsPythonDir(): string {
  return process.env[PYTHON_DIR_ENV]?.trim() || join(process.cwd(), "mini-services", "adms-server", "python");
}

export const ADMS_PYTHON_ENTRY = "bicms_adms.py";

const PLACEHOLDER_PY = `# ============================================================
# PLACEHOLDER — AOGC BICMS ADMS runtime (bicms_adms.py)
#
# This file is a build-time placeholder produced by the packaging
# builder because the REAL device-facing ADMS runtime has not landed
# yet in mini-services/adms-server/python/bicms_adms.py.
#
# The bundle packaging is content-agnostic: when the real runtime file
# is committed, the very same builder packs it verbatim and the bundle
# checksum changes automatically. No installer code change is needed.
#
# This placeholder MUST NOT be deployed as a working service; the
# installer treats a placeholder bundle as invalid for activation.
# ============================================================

PLACEHOLDER = "aogc-bicms-adms-runtime-pending"


def main() -> None:
    raise SystemExit(
        "bicms_adms.py placeholder build — real ADMS runtime not installed"
    )


if __name__ == "__main__":
    main()
`;

const PLACEHOLDER_REQUIREMENTS = `# PLACEHOLDER requirements.lock — replaced by the real runtime workstream.
# Empty dependency set: the placeholder runtime has no third-party imports.
`;

const BUNDLE_README = `# AOGC BICMS ADMS runtime bundle

This tarball is produced by the BICMS application installer
(src/lib/biometric/adms-python-package.ts) and contains:

  bicms_adms.py      device-facing ADMS runtime (single-file service)
  requirements.lock  pinned python dependencies for the runtime
  README.md          this file

Deployment layout (installed by the application setup wizard):

  /opt/aogc-bicms-adms/releases/<checksum>/   immutable release copies
  /etc/aogc-bicms-adms/                       config (API token, cert)
  /var/lib/aogc-bicms-adms/                   state incl. bicms-adms.db
  systemd unit: aogc-bicms-adms.service       account: bicms-adms

Listener ports: 8081 device, 8082 internal API, 8443 HTTPS API.
`;

/** systemd unit template embedded for the installer (deploy on target). */
export const SYSTEMD_UNIT_TEMPLATE = `[Unit]
Description=AOGC BICMS ADMS device listener (bicms_adms.py)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=bicms-adms
Group=bicms-adms
WorkingDirectory=/opt/aogc-bicms-adms/current
Environment=BICMS_ADMS_DATA_DIR=/var/lib/aogc-bicms-adms
Environment=BICMS_ADMS_TLS_PEM=/etc/aogc-bicms-adms/tls.pem
ExecStart=/opt/aogc-bicms-adms/venv/bin/python /opt/aogc-bicms-adms/current/bicms_adms.py
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/aogc-bicms-adms

[Install]
WantedBy=multi-user.target
`;

/** Config filename expected by the runtime inside the data dir. */
export const ADMS_CONFIG_FILENAME = "bicms_adms.json";

const artifacts = new Map<string, BundleArtifact>();
let lastFingerprint: string | null = null;

function sourceFingerprint(pythonContent: string, reqsContent: string): string {
  return createHash("sha256")
    .update(pythonContent)
    .update(reqsContent)
    .update(BUNDLE_README)
    .update(SYSTEMD_UNIT_TEMPLATE)
    .digest("hex");
}

function tarBundle(stageDir: string, outPath: string): void {
  // Deterministic tar.gz: sorted entries, fixed mtime/owner/group so the
  // same content always yields the same checksum.
  const res = spawnSync(
    "tar",
    [
      "-czf",
      outPath,
      "--sort=name",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "--mtime=1970-01-01 00:00:00 UTC",
      "-C",
      stageDir,
      "./",
    ],
    { encoding: "utf8", timeout: 30_000 }
  );
  if (res.error || res.status !== 0) {
    throw new Error("ساخت بسته‌ی نصبی پایتون ناموفق بود (tar).");
  }
}

/**
 * Build (or return cached) bundle artifact for the CURRENT python
 * source state. Synchronous. Throws with a Dari message on failure.
 */
export function buildPythonBundle(): BundleArtifact {
  const dir = admsPythonDir();
  const entryPath = join(dir, ADMS_PYTHON_ENTRY);
  const reqsPath = join(dir, "requirements.lock");

  const hasRealPython = existsSync(entryPath);
  const pythonContent = hasRealPython ? readFileSync(entryPath, "utf8") : PLACEHOLDER_PY;
  const reqsContent = existsSync(reqsPath) ? readFileSync(reqsPath, "utf8") : PLACEHOLDER_REQUIREMENTS;

  const fingerprint = sourceFingerprint(pythonContent, reqsContent);
  if (fingerprint === lastFingerprint && artifacts.has(fingerprint)) {
    const cached = artifacts.get(fingerprint)!;
    if (existsSync(cached.path)) return cached;
    artifacts.delete(fingerprint);
  }

  const stageDir = mkdtempSync(join(tmpdir(), "bicms-adms-stage-"));
  const outDir = mkdtempSync(join(tmpdir(), "bicms-adms-bundle-"));
  try {
    writeFileSync(join(stageDir, ADMS_PYTHON_ENTRY), pythonContent, { mode: 0o644 });
    writeFileSync(join(stageDir, "requirements.lock"), reqsContent, { mode: 0o644 });
    writeFileSync(join(stageDir, "README.md"), BUNDLE_README, { mode: 0o644 });
    const outPath = join(outDir, "bicms-adms-bundle.tgz");
    tarBundle(stageDir, outPath);
    const bytes = readFileSync(outPath);
    const checksum = createHash("sha256").update(bytes).digest("hex");
    // Final resting path is keyed by checksum — stable across processes.
    const finalPath = join(outDir, `${checksum}.tgz`);
    if (finalPath !== outPath) {
      writeFileSync(finalPath, bytes, { mode: 0o600 });
      rmSync(outPath, { force: true });
    }
    const artifact: BundleArtifact = {
      checksum,
      path: finalPath,
      sizeBytes: bytes.length,
      pythonSource: hasRealPython ? "repo" : "placeholder",
      builtAt: Date.now(),
    };
    artifacts.set(fingerprint, artifact);
    lastFingerprint = fingerprint;
    return artifact;
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
}

/** Current bundle checksum (builds the bundle if not cached yet). */
export function getBundleChecksum(): string {
  return buildPythonBundle().checksum;
}

/**
 * Drop cached artifacts and delete their files — used by tests and
 * administrative cleanup; the next build re-creates everything.
 */
export function disposeBundleCache(): void {
  for (const artifact of artifacts.values()) {
    try {
      rmSync(artifact.path, { force: true });
    } catch {
      // ignore
    }
  }
  artifacts.clear();
  lastFingerprint = null;
}
