import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { spawn, spawnSync } from '../src/local-process.mjs';

test('文档工具的同步和异步进程只继承运行环境白名单', async () => {
  process.env.WTT_PROCESS_FIXTURE_SECRET = 'synthetic-only';
  try {
    const command = ['-e', "process.stdout.write(JSON.stringify([Boolean(process.env.PATH),process.env.PYTHONDONTWRITEBYTECODE,Object.hasOwn(process.env,'WTT_PROCESS_FIXTURE_SECRET'),Object.hasOwn(process.env,'OPENAI_API_KEY')]))"];
    const options = {env:{PYTHONDONTWRITEBYTECODE:'1'},stdio:['ignore','pipe','pipe']};
    const expected = [true,'1',false,false];
    const sync = spawnSync(process.execPath,command,options);
    assert.equal(sync.status,0);
    assert.deepEqual(JSON.parse(sync.stdout),expected);
    const child = spawn(process.execPath,command,options);
    const complete = once(child,'close');
    const chunks = [];
    for await (const chunk of child.stdout) chunks.push(chunk);
    const [status] = await complete;
    assert.equal(status,0);
    assert.deepEqual(JSON.parse(Buffer.concat(chunks)),expected);
  } finally { delete process.env.WTT_PROCESS_FIXTURE_SECRET; }
});
