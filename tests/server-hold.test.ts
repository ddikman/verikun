import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { request } from 'node:http';
import { AddressInfo } from 'node:net';
import { buildServer } from '../src/server';
import { DevicePool, DeviceHandle } from '../src/server-pool';
import { createRemoteBackend, pingServer } from '../src/agent/remote';
import { LeaseResponse } from '../src/rpc';
import { spawnCollect } from '../src/exec';
import { join } from 'node:path';

async function fixture(holdIdleMs = 30000) {
  const calls: string[] = [];
  const h: DeviceHandle = {
    serial:'a', exec: async req => {
      calls.push(req.positionals.join(' '));
      return {code:0, ...(req.positionals.includes('dark=on') ? {originals:{dark:'off'}} : {})};
    }, elements:async()=>[],logs:async()=>'',install:async()=>{},reads:async()=>null,preflight:async()=>{},dispose:async()=>{},
  };
  const pool: DevicePool = { serials:()=>['a'], get:s=>s==='a'?h:undefined,adopt:async()=>true,retire:()=>{},
    rebind:async()=>{},onLoss:()=>{},disposeAll:async()=>{} };
  const server=buildServer({platform:'android',pool,allowInstall:false,reconcileMs:0,holdIdleMs,probe:async()=>true,deadlineFloorMs:15});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {server,url,calls,h,close:async()=>{server.closeAllConnections(); await new Promise<void>(r=>server.close(()=>r()));}};
}
function hold(url:string,token:string,wait=1000) {
  let reject!: (e:Error)=>void;
  const first=new Promise<LeaseResponse>((resolve,r)=>{
    reject=r;
    const req=request(`${url}/v1/lease`,{method:'POST',headers:{'x-verikun-run':token,'x-verikun-hold':'1','x-verikun-wait-ms':String(wait),'transfer-encoding':'chunked'}},res=>{
      let body='';res.setEncoding('utf8');res.on('data',c=>{body+=c;if(body.includes('\n')) resolve(JSON.parse(body.split('\n')[0]));});
      res.on('error',()=>{});
    });
    req.on('error',()=>{}); req.flushHeaders(); req.write('.');
    handles.set(token,req);
  });
  const req=handles.get(token)!;
  return {req,first,reject};
}
const handles=new Map<string,ReturnType<typeof request>>();
const lease=(url:string,token:string)=>fetch(`${url}/v1/exec`,{method:'POST',headers:{'x-verikun-run':token},body:JSON.stringify({command:'home',positionals:[],flags:{}})});
async function until(fn:()=>Promise<boolean>) {
  const end=Date.now()+1500;
  while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,10));}
  assert.fail('condition did not settle');
}
test('held socket close frees the phone, tombstones its token and admits a FIFO waiter',async()=>{
  const f=await fixture(); const a=hold(f.url,'a1');await a.first;
  const b=hold(f.url,'b1');let gotB=false;b.first.then(()=>gotB=true);
  try {
    await new Promise(r=>setTimeout(r,30));assert.equal(gotB,false);
    assert.equal((await lease(f.url,'outsider')).status,428,'execution requires a hold');
    a.req.destroy();assert.equal((await b.first).serial,'a');
    const old=await lease(f.url,'a1');assert.equal(old.status,409);
    assert.equal((await old.json() as {errorKind:string}).errorKind,'RunEvictedError');
  } finally {a.req.destroy();b.req.destroy();await f.close();}
});
test('heartbeat silence expires even while the TCP socket remains open',async()=>{
  const f=await fixture(40);const a=hold(f.url,'silent');await a.first;
  const b=hold(f.url,'new');
  try {await b.first;assert.equal((await lease(f.url,'silent')).status,409);}
  finally {a.req.destroy();b.req.destroy();await f.close();}
});
test('FIFO has no bypass: a third hold follows the second, never jumps it',async()=>{
  const f=await fixture();const a=hold(f.url,'fifo1');await a.first;
  const b=hold(f.url,'fifo2');const c=hold(f.url,'fifo3');let third=false;c.first.then(()=>third=true);
  try {a.req.destroy();await b.first;assert.equal(third,false);b.req.destroy();await c.first;}
  finally {a.req.destroy();b.req.destroy();c.req.destroy();await f.close();}
});
test('lease end restores original settings before dealing the next run',async()=>{
  const f=await fixture();const a=hold(f.url,'settings');await a.first;
  const response=await fetch(`${f.url}/v1/exec`,{method:'POST',headers:{'x-verikun-run':'settings'},body:JSON.stringify({command:'device',positionals:['set','dark=on'],flags:{}})});
  assert.equal(response.status,200);
  const b=hold(f.url,'after-settings');
  try {a.req.destroy();await b.first;assert.deepEqual(f.calls,['set dark=on','set dark=off']);}
  finally {a.req.destroy();b.req.destroy();await f.close();}
});
test('heartbeat thread renews a lease while the client main thread is synchronously blocked',async()=>{
  const f=await fixture(15000);
  try {
    const childScript=`const {createRemoteBackend,pingServer}=require(${JSON.stringify(join(__dirname,'../src/agent/remote.js'))});
      (async()=>{const opts={url:${JSON.stringify(f.url)}};const b=createRemoteBackend(opts,await pingServer(opts));await b.lease();
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,11000);
      const r=await b.exec('home',[],{});await b.close();if(r.code)process.exit(3);})();`;
    const r=await spawnCollect(process.execPath,['-e',childScript],{timeout:20000});
    assert.equal(r.code,0,r.stderr);
  }finally{await f.close();}
});
test('remote backend can acquire and close an advertised hold',async()=>{
  const f=await fixture();
  try {const opts={url:f.url};const b=createRemoteBackend(opts,await pingServer(opts));assert.equal((await b.lease())?.serial,'a');await b.close?.();const other=hold(f.url,'other-client');await other.first;other.req.destroy();}
  finally{await f.close();}
});

test('a closing client cannot lose a setting snapshot returned after the hold ends',async()=>{
  const f=await fixture();const a=hold(f.url,'late-setting');await a.first;
  let unblock!:()=>void;const blocked=new Promise<void>(r=>unblock=r);const original=f.h.exec;
  f.h.exec=async req=>{const result=await original(req);if(req.positionals.includes('dark=on'))await blocked;return result;};
  const exec=fetch(`${f.url}/v1/exec`,{method:'POST',headers:{'x-verikun-run':'late-setting'},body:JSON.stringify({command:'device',positionals:['set','dark=on'],flags:{}})});
  await until(async()=>f.calls.includes('set dark=on'));
  a.req.destroy();const b=hold(f.url,'next-setting');let dealt=false;void b.first.then(()=>dealt=true);
  try{await new Promise(r=>setTimeout(r,30));assert.equal(dealt,false);unblock();assert.equal((await exec).status,200);await b.first;assert.deepEqual(f.calls,['set dark=on','set dark=off']);}
  finally{unblock();a.req.destroy();b.req.destroy();await f.close();}
});
test('late originals from a soft-deadline call restore before readmission',async()=>{
  const f=await fixture();const a=hold(f.url,'deadline-setting');await a.first;
  let unblock!:()=>void;const blocked=new Promise<void>(r=>unblock=r);const original=f.h.exec;
  f.h.exec=async req=>{const result=await original(req);if(req.positionals.includes('dark=on'))await blocked;return result;};
  const response=await fetch(`${f.url}/v1/exec`,{method:'POST',headers:{'x-verikun-run':'deadline-setting','x-verikun-deadline-ms':'15'},body:JSON.stringify({command:'device',positionals:['set','dark=on'],flags:{}})});
  assert.equal(response.status,500);a.req.destroy();const b=hold(f.url,'after-deadline');let dealt=false;void b.first.then(()=>dealt=true);
  try{await new Promise(r=>setTimeout(r,30));assert.equal(dealt,false);unblock();await b.first;assert.deepEqual(f.calls,['set dark=on','set dark=off']);}
  finally{unblock();a.req.destroy();b.req.destroy();await f.close();}
});


test('the major protocol rejects no-hold clients and implicit device execution',async()=>{
  const f=await fixture();
  try {
    const old=await fetch(`${f.url}/v1/lease`,{method:'POST',headers:{'x-verikun-run':'old'},body:'{}'});
    assert.equal(old.status,426);assert.match((await old.json() as {error:string}).error,/upgrade/);
    assert.equal((await lease(f.url,'implicit')).status,428);
    assert.deepEqual(f.calls,[]);
  }finally{await f.close();}
});
