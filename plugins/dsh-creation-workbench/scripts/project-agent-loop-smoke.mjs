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
  const launcher=canvas.getByRole('button',{name:'打开小瓦'});
  const material=canvas.locator(`article[data-card-id="${fixture.nodeId}"] .wcc-card-body`);
  const materialComposer=canvas.locator('.wcc-card-composer:visible');
  const materialModel=materialComposer.locator('.wcc-native-model-selection button[aria-haspopup="menu"]');
  const readCardModel=async()=>{
    await material.click({position:{x:30,y:24}});
    await materialModel.locator('[data-model-id]').waitFor();
    const current=await materialModel.getAttribute('title');
    await materialComposer.getByRole('button',{name:'关闭卡片创作框'}).click();
    return current;
  };
  const originalCardModel=await readCardModel();
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
  const pendingPlan=(await call()).plans[0];
  assert(pendingPlan.steps.every(step=>!step.taskId));
  assert.equal(await approval.getByRole('group',{name:'本地 CLI 核验的模型'}).count(),0);
  if(files)await panel.screenshot({path:path.join(files,'cw127-plan.png')});

  const firstModel={provider:'deepseek-official',model:model.routes[0].pro,reasoningEffort:'max'};
  const lastModel={provider:'deepseek-official',model:model.routes[0].flash,reasoningEffort:'off'};
  const nativeTrigger=(surface,step)=>surface.getByRole('group',{name:step+'的模型'})
    .locator('.wcc-native-model-selection button[aria-haspopup="menu"]');
  const nativeMenu=page.getByRole('menu',{name:/^(模型与推理等级|Model and reasoning effort)$/u});
  async function pickModel(trigger,selection,effortLabel,screenshot) {
    await trigger.click();
    await nativeMenu.getByRole('menuitem',{name:/^(模型|Model)\s/u}).click();
    const option=page.getByRole('menuitemradio').filter({has:page.locator(`[data-model-id="${selection.model}"]`)});
    if(screenshot&&files) {
      const box=await option.boundingBox(), viewport=page.viewportSize();
      assert(box&&box.x>=0&&box.x+box.width<=viewport.width&&box.y>=0&&box.y+box.height<=viewport.height);
      await page.screenshot({path:path.join(files,screenshot)});
    }
    await option.click();
    await trigger.locator(`[data-model-id="${selection.model}"]`).waitFor();
    await trigger.click();
    await nativeMenu.getByRole('menuitem',{name:/^(推理等级|Reasoning effort)\s/u}).click();
    await nativeMenu.getByRole('menuitemradio',{name:effortLabel}).click();
    await nativeMenu.waitFor({state:'hidden'});
  }
  const collapse=panel.getByRole('button',{name:'收起小瓦'});
  const chatTab=panel.getByRole('button',{name:'对话',exact:true});
  const plansTab=panel.getByRole('button',{name:'委托',exact:true});
  await pickModel(nativeTrigger(approval,'脚本与配套表'),firstModel,/^(Max|最高|最大)$/iu,'cw132-model-menu.png');
  await state(value=>value.plans[0]?.steps[0].modelSelection?.reasoningEffort===firstModel.reasoningEffort);
  await plansTab.click();
  const plans=panel.getByRole('region',{name:'项目委托'});
  const viewport=page.viewportSize();
  await page.setViewportSize({width:390,height:750});
  const nativeSidebar=page.getByRole('button',{name:/^(收起侧边栏|Collapse sidebar)$/u});
  if(await nativeSidebar.isVisible())await nativeSidebar.click();
  await plans.getByText(/归档摘要 · /u).click();
  await plans.getByRole('button',{name:'恢复默认模型',exact:true}).click();
  await state(value=>value.plans[0]?.steps[2].modelSelection===null);
  await plans.getByText(/归档摘要 · /u).click();
  const lastTrigger=nativeTrigger(plans,'归档摘要');
  const modelBounds=await lastTrigger.evaluate(button=>{
    const list=button.closest('.wtt-agent-queue'), row=button.closest('.wtt-agent-step');
    return {width:list.clientWidth,scrollWidth:list.scrollWidth,modelRight:button.getBoundingClientRect().right,rowRight:row.getBoundingClientRect().right};
  });
  assert(modelBounds.scrollWidth<=modelBounds.width+1&&modelBounds.modelRight<=modelBounds.rowRight+1,
    '窄窗口的每个模型按钮须留在当前节点内：'+JSON.stringify(modelBounds));
  await lastTrigger.click();
  await nativeMenu.waitFor();
  await page.keyboard.press('Escape');
  await nativeMenu.waitFor({state:'hidden'});
  assert(await lastTrigger.evaluate(button=>document.activeElement===button),'Esc 后焦点应回到当前节点的模型按钮');
  await pickModel(lastTrigger,lastModel,/^(Off|关闭)$/iu,'cw132-model-menu-narrow.png');
  await state(value=>value.plans[0]?.steps[2].modelSelection?.reasoningEffort===lastModel.reasoningEffort);
  await page.setViewportSize(viewport);
  await chatTab.click();
  await collapse.click();
  assert.equal(await readCardModel(),originalCardModel);
  await launcher.click();
  await nativeTrigger(approval,'脚本与配套表').locator(`[data-model-id="${firstModel.model}"]`).waitFor();
  await nativeTrigger(approval,'归档摘要').locator(`[data-model-id="${lastModel.model}"]`).waitFor();
  const saved=(await call()).plans[0];
  assert.deepEqual(saved.steps.filter(step=>step.executor==='dsh').map(step=>step.modelSelection),[firstModel,lastModel]);
  assert(saved.steps.every(step=>!step.taskId));
  if(files)await panel.screenshot({path:path.join(files,'cw132-plan-selected.png')});
  await approval.getByRole('button',{name:'授权并执行'}).click();
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
  assert.deepEqual(model.calls.filter(call=>call.name==='course_register_artifacts').map(({model,effort})=>[model,effort]),
    [firstModel,firstModel,lastModel].map(selection=>[selection.model,selection.reasoningEffort]));
  const taskUrl=new URL(api.href);
  for(const [step,selection] of [[first,firstModel],[archive,lastModel]]) {
    taskUrl.searchParams.set('task',step.taskId);
    const task=await (await page.request.get(taskUrl.href)).json();
    assert.deepEqual(task.input.modelSelection,selection);
  }
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
  console.log('PASS 原生菜单逐节点保存模型及推理等级，窄窗选择、恢复默认和焦点通过');
  console.log('PASS 精确派发两种模型、同卡修订沿用、Codex 报告、跨画布返回及普通卡片与新对话模型独立');
}
