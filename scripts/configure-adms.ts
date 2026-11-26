/** One-time backend setup. Credentials are read from private files or environment. */
import { createDecipheriv, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { getAuthSecret } from "../src/lib/secret";
import { validateAdmsDeploymentConnection, writeAdmsDeploymentConnection } from "../src/lib/biometric/adms-deployment-config";
import { admsApiHealth } from "../src/lib/biometric/terminal-adms-api";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "device-url": { type: "string" },
    "api-url": { type: "string" },
    "token-file": { type: "string" },
    "ca-file": { type: "string" },
    "profile": { type: "string" },
    "legacy-secret-file": { type: "string" },
    "disabled": { type: "boolean", default: false },
    "help": { type: "boolean", default: false },
  },
});

if (values.help) {
  console.log("One-time ADMS setup:\n  npm run adms:configure -- --device-url http://host:8081 --api-url https://host:8443 --token-file PRIVATE_TOKEN_FILE [--ca-file CERTIFICATE_FILE]\n  npm run adms:configure -- --profile EXISTING_PROFILE [--legacy-secret-file PRIVATE_OLD_SECRET_FILE]\nThe saved connection is included in subsequent private server builds. No database or user-specific setup is needed.");
  process.exit(0);
}

try {
  let serverUrl = values["device-url"] || process.env.TERMINAL_ADMS_SERVER_URL || null;
  let apiUrl = values["api-url"] || process.env.TERMINAL_ADMS_API_URL || "";
  const tokenFile = values["token-file"] || process.env.TERMINAL_ADMS_API_TOKEN_FILE;
  let token = tokenFile ? readFileSync(tokenFile, "utf8").trim() : process.env.TERMINAL_ADMS_API_TOKEN?.trim() || "";
  const caFile = values["ca-file"] || process.env.TERMINAL_ADMS_API_CA_FILE;
  let caPem = caFile ? readFileSync(caFile, "utf8") : null;
  if (values.profile) {
    const profile = JSON.parse(readFileSync(values.profile, "utf8"));
    serverUrl ||= profile.deviceUrl || profile.serverUrl || null;
    apiUrl ||= profile.apiUrl || "";
    caPem ||= profile.caPem || null;
    if (!token) {
      const secret = values["legacy-secret-file"]
        ? readFileSync(values["legacy-secret-file"], "utf8").trim()
        : getAuthSecret();
      const raw = Buffer.from(profile.encryptedToken || profile.tokenEnc || "", "base64");
      if (raw.length < 29) throw new Error("The existing profile has no usable API credential.");
      const key = profile.encryptedToken
        ? createHash("sha256").update(`bicms-adms-profile-v1\0${secret}`).digest()
        : process.env.DEVICE_MASTER_KEY && /^[a-f\d]{64}$/i.test(process.env.DEVICE_MASTER_KEY)
          ? Buffer.from(process.env.DEVICE_MASTER_KEY, "hex")
          : createHash("sha256").update(`${secret}::device-comm-key::v1`).digest();
      const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
      if (profile.encryptedToken) {
        decipher.setAAD(Buffer.from(JSON.stringify({
          deviceUrl: new URL(profile.deviceUrl).origin,
          apiUrl: new URL(profile.apiUrl).origin,
          certificate: createHash("sha256").update(profile.caPem).digest("hex"),
        })));
      }
      decipher.setAuthTag(raw.subarray(12, 28));
      try { token = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8"); }
      catch { throw new Error("The existing profile uses a different encryption key. Supply its original secret file or the current ADMS API token file once."); }
    }
  }
  if (!apiUrl || !token) throw new Error("Supply the ADMS API address and a private token file once. Use --help for the setup command.");
  const connection = validateAdmsDeploymentConnection({ serverUrl, apiUrl, token, caPem, readEnabled: !values.disabled });
  const health = await admsApiHealth({ url: connection.apiUrl, bearerToken: connection.token, caPem: connection.caPem, timeoutMs: 6000 });
  if (!health.reachable) throw new Error(`ADMS API verification failed: ${health.message}`);
  writeAdmsDeploymentConnection(connection);
  console.log("ADMS connection saved for all users and future server builds, independently of the application database.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "ADMS setup failed.");
  process.exitCode = 1;
}
