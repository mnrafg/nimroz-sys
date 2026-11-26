import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

/** Copy backend-only files; never copy credentials into public/ or client assets. */
export function packageAdmsConfig(projectDirectory, serverDirectory) {
  const source = resolve(process.env.TERMINAL_ADMS_DEPLOYMENT_DIR || join(projectDirectory, ".local/adms/deployment"));
  const profile = join(source, "connection.json");
  if (!existsSync(profile)) return false;
  const saved = JSON.parse(readFileSync(profile, "utf8"));
  if (saved.version !== 1 || typeof saved.tokenEnc !== "string" || !saved.tokenEnc) {
    throw new Error("The saved ADMS deployment profile is invalid; refusing to package it.");
  }
  const destination = join(serverDirectory, ".local/adms/deployment");
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  copyFileSync(profile, join(destination, "connection.json"));
  const keyFile = join(source, "connection.key");
  // A hosting secret can supply the key; otherwise carry the private key file
  // with the private server artifact so fresh databases need no ADMS setup.
  if (!process.env.TERMINAL_ADMS_DEPLOYMENT_KEY?.trim()) {
    if (!existsSync(keyFile)) throw new Error("The private ADMS deployment key is missing.");
    const key = readFileSync(keyFile, "utf8").trim();
    if (!/^[a-f\d]{64}$/i.test(key)) throw new Error("The private ADMS deployment key is invalid.");
    writeFileSync(join(destination, "connection.key"), key, { mode: 0o600 });
  }
  return true;
}
