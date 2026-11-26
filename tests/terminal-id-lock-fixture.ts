// Separate process to keep database mocks isolated from other test suites.
import { mock } from "bun:test";
import assert from "node:assert/strict";
mock.module("server-only",()=>({}));
let identities = new Map<number, any>();
const pending = new Map<string,any>();
let consumed=0,hideNextRead=false;
const identityApi={
 findUnique:async({where}:any)=>{
  if(hideNextRead){hideNextRead=false;return null;}
  if(where.deviceKey_importerId)return identities.get(where.deviceKey_importerId.importerId)??null;
  return [...identities.values()].find(x=>x.terminalUserId===where.deviceKey_terminalUserId.terminalUserId)??null;
 },
 upsert:async({where,create,update}:any)=>{
  assert(!("terminalUserId" in update),"upsert must never overwrite the permanent ID");
  const old=identities.get(where.deviceKey_importerId.importerId);
  const row=old?{...old,...update}:{id:identities.size+1,...create};identities.set(row.importerId,row);return row;
 }
};
const db:any={
 importer:{findFirst:async()=>({id:1,status:"ACTIVE",membershipStatus:"ACTIVE",registeredCheckpointId:1,entries:[],limits:[]}),update:async()=>({})},
 terminalDevice:{findUnique:async()=>({checkpointId:1,isEnabled:true})},
 terminalIdentity:identityApi,
 terminalEnrollment:{
  findMany:async()=>[],updateMany:async()=>({count:0}),
  create:async({data}:any)=>{const row={id:`request-${pending.size+1}`,status:"PENDING",createdAt:new Date(Date.now()-1000),...data,device:{isEnabled:true}};pending.set(row.id,row);return row;},
  findUnique:async({where}:any)=>pending.get(where.id)??null,
  update:async({where,data}:any)=>Object.assign(pending.get(where.id),data),
 },
 auditLog:{create:async()=>({})},
};
db.$transaction=async(fn:any)=>{
 const before=structuredClone(identities),beforePending=structuredClone(pending),beforeConsumed=consumed;
 try{return await fn(db);}catch(e){identities=before;pending.clear();for(const [k,v]of beforePending)pending.set(k,v);consumed=beforeConsumed;throw e;}
};
mock.module("../src/lib/db",()=>({db}));
mock.module("../src/lib/biometric/terminal-ingestion",()=>({
 consumeTerminalScan:async()=>{consumed++;return{ok:true,scan:{method:"FINGERPRINT",scanId:"real-scan"}};},
 purgeExpiredTerminalReceipts:async()=>{},
}));
const {terminalUserIdRegistration,startEnrollment,completeEnrollment}=await import("../src/lib/biometric/terminal-enrollment");
const admin:any={id:1,role:"ADMIN",checkpointId:null};
const officer:any={id:2,role:"OFFICER",checkpointId:1};
const deviceKey="TESTLOCK";
assert.deepEqual(await terminalUserIdRegistration(deviceKey,1),{terminalUserId:"1",locked:false});
identities.set(1,{id:1,deviceKey,importerId:1,terminalUserId:"12345",revokedAt:new Date()});
assert.deepEqual(await terminalUserIdRegistration(deviceKey,1),{terminalUserId:"12345",locked:true},"revocation never unlocks ID");
for(const user of [admin,officer]) {
 await assert.rejects(startEnrollment(user,{deviceKey,importerId:1,terminalUserId:"99"}),/قابل تغییر نیست/);
 await assert.rejects(startEnrollment(user,{deviceKey,importerId:2,terminalUserId:"12345"}),/دیگری/);
}
const same=await startEnrollment(admin,{deviceKey,importerId:1,terminalUserId:"12345"});
assert((await completeEnrollment(admin,same.enrollmentId,"scan")).ok,"same-ID confirmation remains supported");
assert.equal(identities.get(1).terminalUserId,"12345");
const request=await startEnrollment(admin,{deviceKey,importerId:2,terminalUserId:"77"});
identities.set(2,{id:2,deviceKey,importerId:2,terminalUserId:"88",revokedAt:null});
const before=consumed;
const stale=await completeEnrollment(admin,request.enrollmentId,"scan");
assert(!stale.ok&&stale.message.includes("قابل تغییر نیست"));assert.equal(consumed,before);
hideNextRead=true; // competing first confirmation appears between read and upsert
const race=await completeEnrollment(admin,request.enrollmentId,"scan");
assert(!race.ok&&race.message.includes("قابل تغییر نیست"));
assert.equal(identities.get(2).terminalUserId,"88");assert.equal(consumed,before,"failed replacement rolls back scan consumption");
assert.equal(pending.get(request.enrollmentId).status,"PENDING");
console.log("Permanent ID checks passed: admin/officer, revoked links, same-ID retry and competing confirmations");
