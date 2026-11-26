import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { readAdmsDeploymentConnection, writeAdmsDeploymentConnection } from "../src/lib/biometric/adms-deployment-config";
import { packageAdmsConfig } from "../scripts/package-adms-config.mjs";

const connection = {
  serverUrl: "http://adms.example.test:8081",
  apiUrl: "https://adms.example.test:8443",
  readEnabled: true,
  token: "private-test-token-for-deployment",
  caPem: null,
};
let directory: string;
let savedEnvironment: Record<string, string | undefined>;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "bicms-adms-deployment-"));
  savedEnvironment = Object.fromEntries(["AUTH_SECRET", "DEVICE_MASTER_KEY", "TERMINAL_ADMS_DEPLOYMENT_KEY", "TERMINAL_ADMS_DEPLOYMENT_DIR"].map(k => [k, process.env[k]]));
  delete process.env.TERMINAL_ADMS_DEPLOYMENT_KEY;
  delete process.env.TERMINAL_ADMS_DEPLOYMENT_DIR;
});
afterEach(() => {
  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(directory, { recursive: true, force: true });
});

describe("ADMS connection survives independent deployments", () => {
  test("a missing configuration is distinct from a damaged one", () => {
    expect(readAdmsDeploymentConnection(directory)).toBeNull();
    writeAdmsDeploymentConnection(connection, directory);
    writeFileSync(join(directory, "connection.json"), "invalid json");
    expect(() => readAdmsDeploymentConnection(directory)).toThrow("cannot be read");
  });

  test("a new process and different authentication secret can reuse the saved connection", async () => {
    writeAdmsDeploymentConnection(connection, directory);
    const modulePath = join(import.meta.dir, "../src/lib/biometric/adms-deployment-config.ts");
    const child = Bun.spawn([process.execPath, "--conditions=react-server", "-e",
      `import {readAdmsDeploymentConnection} from ${JSON.stringify(modulePath)};const c=readAdmsDeploymentConnection();if(c?.token!==${JSON.stringify(connection.token)}||c?.apiUrl!==${JSON.stringify(connection.apiUrl)})process.exit(1);`], {
      env: { ...process.env, AUTH_SECRET: "different-login-secret", DEVICE_MASTER_KEY: "ab".repeat(32), DATABASE_URL: "mysql://unused:new@127.0.0.1/new_database", TERMINAL_ADMS_DEPLOYMENT_DIR: directory },
      stdout: "pipe", stderr: "pipe",
    });
    expect(await child.exited).toBe(0);
    expect(readFileSync(join(directory, "connection.json"), "utf8")).not.toContain(connection.token);
  });

  test("changing an endpoint cannot redirect the saved token", () => {
    writeAdmsDeploymentConnection(connection, directory);
    const file = join(directory, "connection.json");
    const saved = JSON.parse(readFileSync(file, "utf8"));
    saved.apiUrl = "https://other.example.test:8443";
    writeFileSync(file, JSON.stringify(saved));
    expect(() => readAdmsDeploymentConnection(directory)).toThrow("cannot be read");
  });

  test("the application resolver uses the saved connection with a fresh database", async () => {
    writeAdmsDeploymentConnection(connection, directory);
    const modulePath = join(import.meta.dir, "../src/lib/biometric/terminal-adms-server.ts");
    const source = `import {mock} from 'bun:test';
      mock.module('server-only',()=>({}));
      mock.module('@/lib/db',()=>({db:{systemSetting:{findUnique:async()=>null}}}));
      const {resolveAdmsSettings}=await import(${JSON.stringify(modulePath)});
      const result=await resolveAdmsSettings();
      if(result.configError!==null||result.apiUrl!==${JSON.stringify(connection.apiUrl)}||result.serverUrl!==${JSON.stringify(connection.serverUrl)}||result.apiToken!==${JSON.stringify(connection.token)}||!result.settings.readEnabled)throw new Error('Fresh database did not reuse the saved connection');`;
    const child = Bun.spawn([process.execPath, "-e", source], {
      env: { ...process.env, ADMS_RUNTIME_AUTOSTART: "0", TERMINAL_ADMS_DEPLOYMENT_DIR: directory },
      stdout: "pipe", stderr: "pipe",
    });
    const error = await new Response(child.stderr).text();
    expect({ exit: await child.exited, error }).toEqual({ exit: 0, error: "" });
  });

  test("an environment override for another API never receives the saved token", async () => {
    writeAdmsDeploymentConnection(connection, directory);
    const modulePath = join(import.meta.dir, "../src/lib/biometric/terminal-adms-server.ts");
    const source = `import {mock} from 'bun:test';
      mock.module('server-only',()=>({}));
      mock.module('@/lib/db',()=>({db:{systemSetting:{findUnique:async()=>null}}}));
      const {resolveAdmsSettings}=await import(${JSON.stringify(modulePath)});
      const result=await resolveAdmsSettings();
      if(result.apiUrl!=='https://other.example.test:8443'||result.apiToken!==null)throw new Error('Credential crossed API origins');`;
    const child = Bun.spawn([process.execPath, "-e", source], {
      env: { ...process.env, ADMS_RUNTIME_AUTOSTART: "0", TERMINAL_ADMS_DEPLOYMENT_DIR: directory, TERMINAL_ADMS_API_URL: "https://other.example.test:8443", TERMINAL_ADMS_API_TOKEN: "", TERMINAL_ADMS_API_TOKEN_FILE: "" },
      stdout: "pipe", stderr: "pipe",
    });
    const error = await new Response(child.stderr).text();
    expect({ exit: await child.exited, error }).toEqual({ exit: 0, error: "" });
  });

  test("missing and mismatched keys fail closed", () => {
    writeAdmsDeploymentConnection(connection, directory);
    writeFileSync(join(directory, "connection.key"), "ab".repeat(32));
    expect(() => readAdmsDeploymentConnection(directory)).toThrow("cannot be read");
    unlinkSync(join(directory, "connection.key"));
    expect(() => readAdmsDeploymentConnection(directory)).toThrow("cannot be read");
  });

  test("rejects bearer credentials sent over public HTTP", () => {
    expect(() => writeAdmsDeploymentConnection({ ...connection, apiUrl: "http://adms.example.test:8082" }, directory)).toThrow();
  });

  test("updating the connection preserves the deployment key", () => {
    writeAdmsDeploymentConnection(connection, directory);
    const key = readFileSync(join(directory, "connection.key"), "utf8");
    writeAdmsDeploymentConnection({ ...connection, readEnabled: false, token: "replacement-token" }, directory);
    expect(readFileSync(join(directory, "connection.key"), "utf8")).toBe(key);
    expect(readAdmsDeploymentConnection(directory)?.readEnabled).toBe(false);
    expect(readAdmsDeploymentConnection(directory)?.token).toBe("replacement-token");
  });

  test("the server package works after the original workspace is gone", () => {
    const source = join(directory, "workspace/.local/adms/deployment");
    const server = join(directory, "release");
    writeAdmsDeploymentConnection(connection, source);
    expect(packageAdmsConfig(join(directory, "workspace"), server)).toBe(true);
    rmSync(join(directory, "workspace"), { recursive: true });
    expect(readAdmsDeploymentConnection(join(server, ".local/adms/deployment"))).toEqual(connection);
    expect(existsSync(join(server, "public"))).toBe(false);
  });

  test("packaging fails if the saved key was lost", () => {
    const source = join(directory, "workspace/.local/adms/deployment");
    writeAdmsDeploymentConnection(connection, source);
    unlinkSync(join(source, "connection.key"));
    expect(() => packageAdmsConfig(join(directory, "workspace"), join(directory, "release"))).toThrow("key is missing");
  });

  test("one-time setup verifies the credential before saving it", async () => {
    const server = createServer((request, response) => {
      response.writeHead(request.headers.authorization === `Bearer ${connection.token}` ? 200 : 401, { "content-type": "application/json" });
      response.end(JSON.stringify({ service: "adms-test" }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as { port: number };
      const tokenFile = join(directory, "token");
      const saved = join(directory, "saved");
      writeFileSync(tokenFile, connection.token);
      const configure = () => Bun.spawn([process.execPath, "--conditions=react-server", join(import.meta.dir, "../scripts/configure-adms.ts"),
        "--device-url", connection.serverUrl, "--api-url", `http://127.0.0.1:${address.port}`, "--token-file", tokenFile], {
        env: { ...process.env, TERMINAL_ADMS_DEPLOYMENT_DIR: saved, TERMINAL_ADMS_API_CA_FILE: "" }, stdout: "pipe", stderr: "pipe",
      });
      const successful = configure();
      expect(await successful.exited).toBe(0);
      expect(readAdmsDeploymentConnection(saved)?.token).toBe(connection.token);
      const before = readFileSync(join(saved, "connection.json"), "utf8");
      writeFileSync(tokenFile, "incorrect-token");
      const refused = configure();
      expect(await refused.exited).toBe(1);
      expect(readFileSync(join(saved, "connection.json"), "utf8")).toBe(before);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
