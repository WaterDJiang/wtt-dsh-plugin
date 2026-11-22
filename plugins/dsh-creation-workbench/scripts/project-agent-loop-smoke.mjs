import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function prepareCodexFixture(root) {
  const bin = path.join(root,'bin');
  await mkdir(bin);
  await writeFile(path.join(bin,'codex'),`#!/usr/bin/env node
const assert = require('node:assert/strict');
const args=process.argv.slice(2);
for(const arg of ['shell_tool','never','--ignore-user-config','--ephemeral','read-only','--json','-']) assert(args.includes(arg));
assert(process.cwd().includes('wtt-codex-'));
let input='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>input+=chunk);
process.stdin.on('end',()=>{
  const data=JSON.parse(input.split('\\n\\n').at(-1));
  assert.equal(data.sources.length,2);
  assert(data.sources[0].text.includes('评分标准：总分 10'));
  assert(data.sources[1].text.includes('项目与备注'));
  for(const source of data.sources) assert(source.versionId && source.hash && !source.path);
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'# CLI 核验报告\\n\\n已复核 V2 评分标准及 V1 配套表。'}}));
  console.log(JSON.stringify({type:'turn.completed'}));
});
`,{mode:0o700});
  return bin;
}

export async function checkProjectAgentLoop(page,canvas,api,fixture,model) {
  assert.match(await page.title(),/DeepSeek Harness/);
  assert.equal(new URL(page.url()).origin,api.origin);
  const call=async()=>{
    const response=await page.request.post(api.href,{data:{action:'project-agent-state',data:{}}});
    assert(response.ok(),await response.text());
    return response.json();
  };
  const state=async predicate=>{
    const deadline=Date.now()+40000;
    let latest;
    do {
      latest=await call();
      if(predicate(latest))return latest;
      if(latest.plans[0]?.steps.some(step=>['blocked','review-waiting'].includes(step.state)))break;
      await new Promise(resolve=>setTimeout(resolve,250));
    }while(Date.now()<deadline);
    throw Error('成果验收冒烟未到达目标状态：'+JSON.stringify({latest,calls:model.calls,reviews:model.reviews,routes:model.routes}));
  };
  const launcher=canvas.getByRole('button',{name:'打开WTT 项目助手'});
  await launcher.click();
  const panel=canvas.locator('.wtt-agent-float.is-open');
  const input=panel.locator('[contenteditable=true]').last();
  await input.waitFor();
  await input.click();
  await page.keyboard.insertText('请制作两张成果卡，复核评分标准，再由本机 Codex 核对并写出归档摘要。');
  await input.press('Enter');
  const files=process.env.WTT_SMOKE_ARTIFACTS;
  if(files)await mkdir(files,{recursive:true});
  const approval=panel.getByRole('region',{name:'对话授权'});
  await approval.getByText('计划已生成 · 待授权',{exact:true}).waitFor({timeout:25000});
  await approval.getByText(/本地 CLI 核验 · .* · Codex/u).click();
  await approval.getByText('执行者 · Codex CLI',{exact:true}).waitFor();
  assert((await call()).plans[0].steps.every(step=>!step.taskId));
  if(files)await panel.screenshot({path:path.join(files,'cw127-plan.png')});
  await approval.getByRole('button',{name:'授权并执行'}).click();
  const collapse=panel.getByRole('button',{name:'收起WTT 项目助手'});
  await collapse.click();
  await panel.waitFor({state:'hidden'});
  const pending=await state(value=>value.plans[0]?.steps[0].state==='checking'&&model.reviews.length===1);
  const [initial,unchanged]=pending.plans[0].steps[0].receipts;
  assert.equal(initial.number,1);
  assert.equal(unchanged.number,1);
  assert.equal(pending.plans[0].steps[1].taskId,null);
  await launcher.click();
  await panel.getByRole('button',{name:'委托',exact:true}).click();
  await panel.getByText('待验收',{exact:true}).first().waitFor();
  await panel.getByRole('button',{name:unchanged.title+' · V1',exact:true}).waitFor();
  if(files)await panel.screenshot({path:path.join(files,'cw127-review.png')});
  await collapse.click();
  model.releaseReview();
  const completed=await state(value=>value.plans[0]?.state==='done');
  assert.equal(completed.sessionId,pending.sessionId);
  const [first,report,archive]=completed.plans[0].steps;
  assert.equal(first.revisionCount,1);
  assert.equal(first.receipts[0].number,2);
  assert.equal(first.receipts[0].cardId,initial.cardId);
  assert.deepEqual(first.receipts[1],unchanged);
  assert.equal(model.reviews.length,2);
  assert.deepEqual(model.reviews.map(result=>result.model),[model.routes[0].default,model.routes[0].default]);
  assert.deepEqual(model.calls.filter(call=>call.name==='course_register_artifacts').map(call=>call.model),
    [model.routes[0].flash,model.routes[0].flash,model.routes[0].pro]);
  const taskUrl=new URL(api.href);
  taskUrl.searchParams.set('task',report.taskId);
  const task=await (await page.request.get(taskUrl.href)).json();
  assert.deepEqual(task.input.sources.map(({versionId,hash})=>({versionId,hash})),first.receipts.map(({versionId,hash})=>({versionId,hash})));
  assert.equal(report.receipt.number,1);
  assert.equal(archive.receipt.number,1);
  await launcher.click();
  await panel.getByRole('button',{name:'委托',exact:true}).click();
  const summary=panel.getByText('成果验收委托',{exact:true});
  const link=panel.getByRole('button',{name:first.receipts[0].title+' · V2',exact:true});
  await summary.waitFor();
  if(!await link.isVisible())await summary.click();
  await link.waitFor();
  if(files)await panel.screenshot({path:path.join(files,'cw127-completed.png')});
  await link.click();
  await panel.waitFor({state:'hidden'});
  const selector=page.getByRole('combobox',{name:'当前画布',exact:true});
  await page.waitForFunction(id=>document.querySelector('select[aria-label="当前画布"]')?.value===id,fixture.other);
  assert.equal(await selector.inputValue(),fixture.other);
  assert.match(await launcher.getAttribute('title'),/返回委托/u);
  assert(await launcher.locator('.wtt-agent-return').isVisible());
  await launcher.click();
  await link.waitFor();
  assert.equal(await panel.getByRole('button',{name:'委托',exact:true}).getAttribute('aria-pressed'),'true');
  await page.setViewportSize({width:440,height:680});
  const nativeSidebar=page.getByRole('button',{name:/^(收起侧边栏|Collapse sidebar)$/u});
  if(await nativeSidebar.isVisible())await nativeSidebar.click();
  await page.waitForFunction(()=>{
    const assistant=document.querySelector('.wtt-agent-float.is-open');
    const heading=assistant?.querySelector('h2,h3');
    if(!heading)return false;
    const box=assistant.getBoundingClientRect(),label=heading.getBoundingClientRect();
    return box.width<440&&box.left>=0&&box.right<=440&&assistant.contains(document.elementFromPoint(label.left+8,label.top+6));
  });
  if(files)await page.screenshot({path:path.join(files,'cw127-return-narrow.png')});
  await panel.getByRole('button',{name:'新建对话',exact:true}).click();
  const fresh=await state(value=>value.sessionId!==completed.sessionId);
  assert(fresh.sessionId);
  await input.click();
  await page.keyboard.insertText('默认模型探针');
  await input.press('Enter');
  await panel.getByText('已核对工作台回执。',{exact:true}).waitFor();
  assert.deepEqual(model.defaultProbes,[model.routes[0].default]);
  console.log('PASS 多卡验收、原卡 V2 与配套表 V1、两模型路由、Codex 报告、跨画布返回及新对话默认模型');
}
