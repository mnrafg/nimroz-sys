/**
 * Bun test preload — stubs the React-Server-Components-only
 * `server-only` guard so server libraries (src/lib/biometric/*,
 * src/lib/scope, src/lib/api) can be integration-tested under
 * `bun test`. The stub is a NO-OP; it never weakens any runtime
 * behavior — the guard exists solely to crash Client-Component
 * imports inside Next.js.
 *
 * Registered in bunfig.toml → [test] preload.
 */
import { plugin } from "bun";

plugin({
  name: "server-only-stub",
  setup(build) {
    build.module("server-only", () => ({
      contents: "export default null;",
      loader: "js",
    }));
  },
});
