import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recycleHostAdb } from '../src/server-host';
import { claimsDir, claimDevice, deviceFileStem, setProcessScoped } from '../src/device/claims';

test('host recycling excludes another live job and serializes concurrent supervisors',async()=>{
  const home=mkdtempSync(join(tmpdir(),'vk-host-lock-'));
  const opts={home,env:{},cwd:'foreign-job'};
  setProcessScoped(true);
  try{
    const claim = claimDevice('foreign','android',opts);
    assert.equal(claim.ok,true);
    if (claim.ok) writeFileSync(join(claimsDir(opts),`${deviceFileStem('foreign')}.json`),JSON.stringify({...claim.claim,pid:process.ppid}));
    let restarts=0;
    assert.equal(await recycleHostAdb(opts,async()=>{restarts++;return true}),false);
    assert.equal(restarts,0);
    rmSync(claimsDir(opts),{recursive:true,force:true});
    let finish!:()=>void;const busy=new Promise<void>(r=>finish=r);
    const first=recycleHostAdb(opts,async()=>{restarts++;await busy;return true});
    const second=await recycleHostAdb(opts,async()=>{restarts++;return true});
    assert.equal(second,false);finish();assert.equal(await first,true);assert.equal(restarts,1);
    writeFileSync(join(claimsDir(opts),'adb-recycle.lock'),'999999999');
    assert.equal(await recycleHostAdb(opts,async()=>true),true,'dead-owner locks recover');
  }finally{setProcessScoped(false);rmSync(home,{recursive:true,force:true});}
});
