import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

export async function checkProjectAgentIdle(page, canvas, api, model) {
  const calls = [];
  const record = request => {
    if (request.method() !== 'POST' || new URL(request.url()).pathname !== api.pathname) return;
    const action = request.postDataJSON()?.action;
    if (action === 'project-agent-state') calls.push(Date.now());
  };
  page.on('request', record);
  const observe = async () => {
    const start = Date.now();
    await sleep(10000);
    return calls.filter(t => t >= start).map(t => t - start);
  };
  try {
    const closedBeforeUse = await observe();
    const launcher = canvas.getByRole('button', { name: '打开项目总 Agent' });
    const panel = canvas.locator('.wtt-agent-float.is-open');
    const times = [];
    for (let i = 0; i < 8; i++) {
      const start = performance.now();
      await launcher.click();
      const input = panel.locator('[contenteditable=true]').last();
      await input.waitFor();
      times.push(Math.round(performance.now() - start));
      if (i === 7) {
        await input.click(); await input.press('End');
        await page.keyboard.insertText('回忆验收，只查项目记忆'); await input.press('Enter');
        const deadline = Date.now() + 20000;
        while (!model.evidence.length && Date.now() < deadline) await sleep(150);
        assert.ok(model.evidence.length, '只读工具应已返回记忆');
        assert.ok(!model.calls.some(c => c.name === 'course_save_outline'), '只读请求不应派发创作');
      }
      await panel.getByRole('button', { name: '收起项目总 Agent' }).click();
    }
    const result = await page.evaluate(async url => (await fetch(url, { method: 'POST',
      body: JSON.stringify({ action: 'project-agent-state', data: {} }) })).json(), api.href);
    assert.equal(result.plans.length, 0);
    await sleep(300);
    const closedAfterQuery = await observe();
    assert.equal(closedAfterQuery.length,0,'只读对话结束并收起后不能持续轮询完整状态');
    console.log('AGENT_IDLE ' + JSON.stringify({ closedBeforeUse, closedAfterQuery, openUntilInputVisibleMs: times, plans: result.plans.length }));
  } finally {
    page.off('request', record);
  }
}
export async function checkProjectAgentStop(page,canvas,api,model){
  await canvas.getByRole('button',{name:'打开项目总 Agent'}).click();
  const panel=canvas.locator('.wtt-agent-float.is-open');
  const input=panel.locator('[contenteditable=true]').last();
  await input.click();await input.press('End');await page.keyboard.insertText('从采访写脚本和分镜');await input.press('Enter');
  await panel.getByRole('button',{name:'按计划执行',exact:true}).click({timeout:26000});
  await panel.getByText('原任务待确认',{exact:true}).waitFor({timeout:20000});
  await panel.getByRole('button',{name:'停止委托',exact:true}).click();
  await panel.getByText(/浏览器跨画布委托 · 已停止/).waitFor({timeout:20000});
  await sleep(2400);
  const live=await page.evaluate(async url=>(await fetch(url,{method:'POST',body:JSON.stringify({action:'project-agent-state',data:{}})})).json(),api.href);
  assert.equal(live.plans[0].state,'stopped');
  assert.equal(live.plans[0].steps[0].state,'stopped');
  assert.equal(live.plans[0].steps[1].taskId,null);
  assert.equal(model.calls.filter(c=>c.name==='course_save_outline').length,0);
  console.log('PASS 原生提问中停止委托，确认原任务已退，后续步骤零派发');
}

export async function checkProjectAgentPages(canvas){
  await canvas.getByRole('button',{name:'打开项目总 Agent'}).click();
  const panel=canvas.locator('.wtt-agent-float.is-open');
  for(let page=1;page<6;page++){
    await panel.getByText(page+' / 6',{exact:true}).waitFor();
    await panel.getByRole('button',{name:'下一页'}).click();
  }
  const oldest=panel.locator('.wtt-agent-plans details').filter({has:panel.page().getByText('待办 1 · 待授权',{exact:true})}).first();
  await oldest.getByRole('button',{name:'停止委托'}).click();
  await panel.getByText('待办 1 · 已停止',{exact:true}).waitFor();
  await panel.getByRole('button',{name:'收起项目总 Agent'}).click();
  await canvas.getByLabel('100 项待确认',{exact:true}).waitFor();
  console.log('PASS 分页定位并处理第 101 份待办，浮标显示其余 100 份');
}
