import { test, expect } from "bun:test";
test("live scans ignore device clock while preserving freshness, identity and single-use",async()=>{
 const child=Bun.spawn([process.execPath,"tests/terminal-receipt-fixture.ts"],{cwd:process.cwd(),stdout:"pipe",stderr:"pipe"});
 const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
 expect({code,output:code===0?"passed":stdout+stderr}).toEqual({code:0,output:"passed"});
},10000);
