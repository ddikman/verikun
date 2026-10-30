import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkerDevicePool } from '../src/server-pool';
import { DeviceUnresponsiveError } from '../src/errors';

test('a blocked hard-timeout worker rejects its queue and forbids a successor until exit and cleanup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vk-zombie-'));
  const path = join(dir, 'worker.cjs');
  const starts = join(dir, 'starts');
  const workerPid = join(dir,'worker-pid');
  const childPid = join(dir, 'child-pid');
  writeFileSync(path, `process.on('SIGTERM',()=>{});
    require('node:fs').writeFileSync(${JSON.stringify(workerPid)},String(process.pid));
    require('node:fs').appendFileSync(${JSON.stringify(starts)},'start\\n');
    process.send({kind:'ready',serial:'blocked'});
    process.on('message',req=>{
      require('node:child_process').spawnSync('/bin/sh',['-c', 'echo $$ > '+${JSON.stringify(childPid)}+'; exec sleep 120']);
      process.send({kind:'reply',id:req.id,ok:true,value:{code:0}});
    });`);
  const old = process.env.VERIKUN_NO_CLAIM;
  process.env.VERIKUN_NO_CLAIM = '1';
  const pool = await WorkerDevicePool.start('android', ['blocked'], {workerFile: path, callTimeoutMs: 150});
  let finishCleanup!: () => void;
  const cleanup = new Promise<void>(r => finishCleanup = r);
  let cleaned = false;
  pool.onLoss(async () => { await cleanup; cleaned = true; });
  try {
    const h = pool.get('blocked')!;
    process.kill(Number(readFileSync(workerPid,'utf8')), 'SIGTERM');
    await new Promise(r=>setTimeout(r,10));
    process.kill(Number(readFileSync(workerPid,'utf8')),0);
    const started = Date.now();
    const first = h.exec({command:'home',positionals:[],flags:{}});
    const queued = h.elements();
    const rejected = await Promise.allSettled([first,queued]);
    assert.ok(rejected.every(r => r.status === 'rejected' && r.reason instanceof DeviceUnresponsiveError));
    assert.deepEqual(pool.serials(), []);
    assert.equal(await pool.adopt('blocked'), false);
    assert.equal(readFileSync(starts,'utf8').trim().split('\n').length, 1);
    assert.ok(Date.now()-started < 2000, 'SIGKILL interrupts the blocking device tool');
    assert.ok(existsSync(childPid), 'the executor really started a child tool');
    const pid = Number(readFileSync(childPid,'utf8').trim());
    finishCleanup();
    await pool.disposeAll();
    assert.equal(cleaned, true, 'disposal also waits for async exit cleanup');
    assert.throws(()=>process.kill(pid,0), 'the process-group kill leaves no orphan tool');
    assert.equal(await pool.adopt('blocked'), true);
    assert.equal(readFileSync(starts,'utf8').trim().split('\n').length, 2);
  } finally {
    finishCleanup();
    await pool.disposeAll();
    if(old===undefined)delete process.env.VERIKUN_NO_CLAIM;else process.env.VERIKUN_NO_CLAIM=old;
    rmSync(dir,{recursive:true,force:true});
  }
});

test('forked IPC preserves binary artifacts and disables child claims',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'vk-ipc-'));
  const path=join(dir,'worker.cjs');
  writeFileSync(path, `if(process.env.VERIKUN_NO_CLAIM!=='1')throw Error('child owns claims');
    process.send({kind:'ready',serial:process.argv[3]});
    process.on('message',req=>process.send({kind:'reply',id:req.id,ok:true,value:{code:0,artifacts:{'shot.png':Buffer.from([0,127,128,255])}}}));`);
  const old=process.env.VERIKUN_NO_CLAIM;process.env.VERIKUN_NO_CLAIM='1';
  const pool=await WorkerDevicePool.start('android',['binary'],{workerFile:path});
  try { const r=await pool.get('binary')!.exec({command:'screenshot',positionals:[],flags:{}});
    assert.equal(Buffer.isBuffer(r.artifacts!['shot.png']),true);
    assert.deepEqual([...r.artifacts!['shot.png']],[0,127,128,255]);
  }finally{await pool.disposeAll();if(old===undefined)delete process.env.VERIKUN_NO_CLAIM;else process.env.VERIKUN_NO_CLAIM=old;rmSync(dir,{recursive:true,force:true});}
});
