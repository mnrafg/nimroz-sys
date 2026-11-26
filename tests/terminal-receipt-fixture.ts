// Isolated process: receipt-time regressions never touch the business DB.
import { mock } from "bun:test";
import assert from "node:assert/strict";
mock.module("server-only",()=>({}));
const scans: any[]=[];
const matches=(s:any,w:any)=>Object.entries(w).every(([k,v]:[string,any])=>{
  if(v && typeof v==="object" && !(v instanceof Date)) {
    if(v.gt!==undefined && !(s[k]>v.gt))return false;
    if(v.gte!==undefined && !(s[k]>=v.gte))return false;
    if(v.lt!==undefined && !(s[k]<v.lt))return false;
    return true;
  }
  return s[k]===v;
});
const db={
 terminalDevice:{findUnique:async()=>({isEnabled:true})},
 terminalIdentity:{findUnique:async()=>null},
 terminalScan:{
  create:async({data}:any)=>{
   if(scans.some(s=>s.eventKey===data.eventKey))throw Error("Unique constraint");
   const row={...data,id:scans.length+1,scanId:`scan-${scans.length+1}`,usedAt:null};scans.push(row);return row;
  },
  findUnique:async({where}:any)=>scans.find(s=>matches(s,where))??null,
  findFirst:async({where}:any)=>scans.find(s=>matches(s,where))??null,
  updateMany:async({where,data}:any)=>{const row=scans.find(s=>matches(s,where));if(!row)return{count:0};Object.assign(row,data);return{count:1};},
 }
};
mock.module("../src/lib/db",()=>({db}));
const {ingestTerminalScan,consumeTerminalScan}=await import("../src/lib/biometric/terminal-ingestion");
const {latestEnrollmentScan}=await import("../src/lib/biometric/terminal-enrollment");
const input={serial:"TESTCLOCK",terminalUserId:"12345",punch:0,verify:1,deviceLocalMs:Date.now()+270*60000-30*60000,timezoneOffsetMinutes:270};
assert.equal((await ingestTerminalScan(input)).ok,false,"ADMS/history must not bypass clock freshness");
const createdAt=new Date(Date.now()-1000);
const result=await ingestTerminalScan({...input,source:"LAN_LIVE"});
assert(result.ok,"a fresh live socket scan must ignore a 30-minute clock offset");
assert.equal(scans[0].deviceTime.getTime(),input.deviceLocalMs-270*60000,"preserve device time for provenance");
assert(Date.now()-scans[0].receivedAt.getTime()<1000);
const enr={deviceKey:input.serial,terminalUserId:input.terminalUserId,createdAt};
assert(await latestEnrollmentScan(enr,0),"fresh receipt confirms matching enrollment despite old device time");
assert.equal(await latestEnrollmentScan({...enr,createdAt:new Date(Date.now()+1000)},0),null,"pre-enrollment scans stay rejected");
assert.equal(await latestEnrollmentScan({...enr,terminalUserId:"999"},0),null,"wrong user cannot confirm");
const mismatch=await latestEnrollmentScan({...enr,terminalUserId:"999"},0,true);
assert.equal(mismatch?.terminalUserId,"12345","stream can report wrong-user scans without linking them");
assert.equal(scans[0].usedAt,null,"mismatch notification does not consume scan");
assert.equal(await latestEnrollmentScan({...enr,terminalUserId:"999"},scans[0].id,true),null,"mismatch cursor prevents repeat notices");
const replay=await ingestTerminalScan({...input,source:"LAN_LIVE"});
assert(replay.ok&&replay.duplicate,"clock-independent path must still deduplicate");
assert.equal(scans.length,1);
const card=await ingestTerminalScan({...input,source:"LAN_LIVE",verify:2});
assert(!card.ok&&card.reason==="NON_BIOMETRIC","card does not become a fingerprint");
let consumed=await consumeTerminalScan(result.scanId,{deviceKey:input.serial,terminalUserId:input.terminalUserId,receivedAfter:new Date(Date.now()+1000)});
assert(!consumed.ok&&consumed.reason==="STALE","direct completion must also reject pre-enrollment receipt");
consumed=await consumeTerminalScan(result.scanId,{deviceKey:input.serial,terminalUserId:input.terminalUserId,receivedAfter:createdAt});
assert(consumed.ok,"fresh receipt is consumable despite device clock");
const twice=await consumeTerminalScan(result.scanId);
assert(!twice.ok&&twice.reason==="ALREADY_USED");
scans[0].usedAt=null;scans[0].receivedAt=new Date(Date.now()-120000);
const stale=await consumeTerminalScan(result.scanId);
assert(!stale.ok&&stale.reason==="STALE","old receipts must expire even when device time is ignored");
assert.equal(await latestEnrollmentScan({...enr,createdAt:new Date(Date.now()-180000)},0),null);
console.log("Receipt-time checks passed");
