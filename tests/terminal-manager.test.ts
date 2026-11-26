import { test, expect } from "bun:test";

test("LAN manager handles authentication, serial pinning, binary events and heartbeat", async () => {
  const child=Bun.spawn([process.execPath,"tests/terminal-manager-fixture.ts"],{cwd:process.cwd(),stdout:"pipe",stderr:"pipe"});
  const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  expect({code,output:code===0?"passed":stdout+stderr}).toEqual({code:0,output:"passed"});
},10000);
