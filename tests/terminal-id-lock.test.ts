import {test,expect} from "bun:test";
test("terminal ID is permanent across roles, revocation and competing confirmations",async()=>{
 const child=Bun.spawn([process.execPath,"tests/terminal-id-lock-fixture.ts"],{cwd:process.cwd(),stdout:"pipe",stderr:"pipe"});
 const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
 expect({code,output:code===0?"passed":stdout+stderr}).toEqual({code:0,output:"passed"});
},10000);
