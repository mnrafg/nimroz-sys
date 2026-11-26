import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { packageAdmsConfig } from "./package-adms-config.mjs";

const project = process.cwd();
const build = spawnSync(process.execPath, [join(project, "node_modules/next/dist/bin/next"), "build"], { stdio: "inherit" });
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);
const server = join(project, ".next/standalone");
mkdirSync(join(server, ".next"), { recursive: true });
cpSync(join(project, ".next/static"), join(server, ".next/static"), { recursive: true });
if (existsSync(join(project, "public"))) cpSync(join(project, "public"), join(server, "public"), { recursive: true });
if (packageAdmsConfig(project, server)) console.log("Saved ADMS connection included in the private server package.");
