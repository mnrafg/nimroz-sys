// Isolated process: mocks must never replace the application's database in
// other Bun test files. The simulated peer uses independent wire packing.
import { mock } from "bun:test";
import assert from "node:assert/strict";
import net from "node:net";
mock.module("server-only", () => ({}));
const actualRules = await import("../src/lib/biometric/terminal-rules");
mock.module("../src/lib/biometric/terminal-rules", () => ({ ...actualRules, LAN_HEARTBEAT_MS: 40 }));
const devices = new Map<string, Record<string, unknown>>();
const ingested: Array<Record<string, unknown>> = [];
mock.module("../src/lib/db", () => ({ db: { terminalDevice: {
  findUnique: async ({where}: {where:{serial:string}}) => devices.get(where.serial),
  updateMany: async () => ({count:1}),
} } }));
mock.module("../src/lib/biometric/terminal-security", () => ({ decryptTerminalSecret: (value: string) => value }));
mock.module("../src/lib/biometric/terminal-ingestion", () => ({ ingestTerminalScan: async (scan: Record<string, unknown>) => {
  ingested.push(scan); return {ok:true};
} }));
const manager = await import("../src/lib/biometric/terminal-manager");
const sockets = new Set<net.Socket>();
const serials: string[] = [];
let serialReads = 0;
function packet(cmd:number,session:number,reply:number,data=Buffer.alloc(0)) {
  const body=Buffer.alloc(8+data.length);
  body.writeUInt16LE(cmd);body.writeUInt16LE(session,4);body.writeUInt16LE(reply,6);data.copy(body,8);
  let sum=0;for(let i=0;i<body.length;i+=2)sum+=body[i]+((body[i+1]??0)<<8);
  while(sum>>>16)sum=(sum&65535)+(sum>>>16);
  body.writeUInt16LE((~sum)&65535,2);
  const top=Buffer.from("5050827d00000000","hex");top.writeUInt32LE(body.length,4);
  return Buffer.concat([top,body]);
}
async function scenario(name:string,key:string|null,reportedSerial:string,expected:string) {
  const commands:number[]=[];
  const server=net.createServer(sock=>{
    sockets.add(sock);sock.on("error",()=>{});sock.on("close",()=>sockets.delete(sock));
    let buffer=Buffer.alloc(0);
    sock.on("data",chunk=>{
      buffer=Buffer.concat([buffer,Buffer.from(chunk)]);
      while(buffer.length>=8) {
        assert.equal(buffer.subarray(0,4).toString("hex"),"5050827d");
        const n=buffer.readUInt32LE(4);if(buffer.length<n+8)return;
        const body=buffer.subarray(8,n+8);buffer=buffer.subarray(n+8);
        const cmd=body.readUInt16LE(0),reply=body.readUInt16LE(6);commands.push(cmd);
        if(cmd===1000)sock.write(packet(2005,42,reply));
        else if(cmd===1102) {
          // Independent known zero-key/session-42 vector (low session byte
          // is replaced by the tick byte in the SDK scramble).
          const accepted=body.subarray(8).equals(Buffer.from("617d3279","hex"));
          sock.write(packet(accepted?2000:2005,42,reply));
        } else if(cmd===11) {
          serialReads++;assert.equal(body.subarray(8).toString(),"~SerialNumber\0");
          const wire=packet(2000,42,reply,Buffer.from(`~SerialNumber=${reportedSerial}\0`));
          sock.write(wire.subarray(0,5));setTimeout(()=>sock.write(wire.subarray(5)),2);
        } else if(cmd===500) {
          assert.equal(body.readUInt32LE(8),1);
          sock.write(packet(2000,42,reply));
          setTimeout(()=>{
            const now=new Date(Date.now()+270*60000),data=Buffer.alloc(32);data.write("12");
            data[24]=1;data[25]=0;
            Buffer.from([now.getUTCFullYear()-2000,now.getUTCMonth()+1,now.getUTCDate(),now.getUTCHours(),now.getUTCMinutes(),now.getUTCSeconds()]).copy(data,26);
            // Physical uFace terminal uses asynchronous event session 1.
            sock.write(packet(500,1,reply,data));
          },10);
        } else if(cmd===1001)sock.end();
      }
    });
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const port=(server.address() as net.AddressInfo).port;
  devices.set(name,{id:1,serial:name,transport:"LAN",isEnabled:true,host:"127.0.0.1",port,commKeyEnc:key,timezoneOffsetMinutes:270});
  serials.push(name);
  try {
    await manager.startLanSession(name);
    const deadline=Date.now()+2000;
    while(Date.now()<deadline && ![expected,"FAILED"].includes(manager.lanStageInfo(name)?.stage??""))await Bun.sleep(10);
    const state=manager.lanStageInfo(name)!;
    assert.equal(state.stage,expected,JSON.stringify(state));
    if(expected==="SUBSCRIBED") {
      await Bun.sleep(150);
      assert.equal(manager.lanStageInfo(name)?.stage,"SUBSCRIBED","heartbeat must preserve subscribed status");
      assert(serialReads>2);assert(ingested.some(s=>s.serial===name && s.verify===1 && s.punch===0 && s.source==="LAN_LIVE"));
      assert.deepEqual(commands.slice(0,4),[1000,1102,11,500]);
    } else {
      assert.equal(state.completedStage,key===null || key==="wrong"?"CONNECTED":"AUTHENTICATED");
      assert(!commands.includes(500),"failed identities must never subscribe");
    }
  } finally {
    manager.stopLanSession(name);
    for(const sock of sockets)sock.destroy();
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
}
try {
  await scenario("TESTNO",null,"TESTNO","FAILED");
  await scenario("TESTBAD","wrong","TESTBAD","FAILED");
  await scenario("TESTSERIAL","0","FOREIGN","FAILED");
  await scenario("TESTGOOD","0","TESTGOOD","SUBSCRIBED");
  console.log("LAN manager scenarios passed: missing/wrong key, serial mismatch, key 0, binary scan, heartbeat");
} finally { for(const serial of serials)manager.stopLanSession(serial); }
