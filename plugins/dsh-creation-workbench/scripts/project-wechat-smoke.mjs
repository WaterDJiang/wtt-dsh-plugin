import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir,readFile,rename,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkbenchService } from '../src/service.mjs';

export async function prepareWechatSmoke(temporary) {
  const dir=path.join(temporary,'wechat-fixture'), projectB=path.join(temporary,'乙验收项目');
  await mkdir(dir);await mkdir(projectB);
  await writeFile(path.join(dir,'inbox.json'),'[]');
  await writeFile(path.join(dir,'sent.jsonl'),'');
  await writeFile(path.join(dir,'scan-mode'),'waiting');
  const second=new WorkbenchService({workspaceRoot:projectB});
  try{second.store.createCanvas({title:'乙原画布',operationId:randomUUID()});}finally{second.close();}
  return {dir,projectB};
}

export async function checkProjectWechat(page,canvas,api,fixture,workspace,mock) {
  assert.match(await page.title(),/DeepSeek Harness/);
  assert.equal(await readFile(path.join(mock.dir,'preloaded'),'utf8'),'ready','DSH 没有加载微信协议替身');
  const post=async(action,data={},url=api)=>{
    const headers=action.startsWith('project-wechat-')?{'X-WTT-WeChat':'1'}:{};
    const response=await page.request.post(url.href,{headers,data:{action,data}});
    assert(response.ok(),await response.text());
    return response.json();
  };
  const registry=new URL(api);
  registry.searchParams.set('projects','1');
  const {project:second}=await post('open-project',{path:mock.projectB});
  await post('open-project',{path:workspace});
  const first=api.searchParams.get('projectId');
  const crossSite=await page.request.post(api.href,{
    headers:{'X-WTT-WeChat':'1','Sec-Fetch-Site':'cross-site'},data:{action:'project-wechat-status',data:{}},
  });
  assert.equal(crossSite.status(),403);
  const messages=[];
  async function input(text,id='fixture-'+randomUUID(),extra={}){
    messages.push({message_id:id,from_user_id:'wechat-owner',message_type:1,context_token:'context-'+id,
      item_list:[{type:1,text_item:{text}}],...extra});
    const pending=path.join(mock.dir,'inbox.new');
    await writeFile(pending,JSON.stringify(messages));
    await rename(pending,path.join(mock.dir,'inbox.json'));
  }
  async function until(check) {
    const deadline=Date.now()+45000;
    do {const match=await check();if(match)return match;await delay(200);}while(Date.now()<deadline);
    throw Error('微信冒烟目标未到达：'+JSON.stringify(await post('project-wechat-status'))+'\n'+await readFile(path.join(mock.dir,'sent.jsonl'),'utf8'));
  }
  const deliveries=async()=> (await readFile(path.join(mock.dir,'sent.jsonl'),'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line));
  const reply=predicate=>until(async()=> (await deliveries()).find(predicate));
  const dialog=page.getByRole('dialog',{name:'微信项目助手'});
  async function openWechat(){
    await canvas.getByRole('button',{name:'画布菜单'}).click();
    await canvas.getByRole('menuitem',{name:'微信项目助手'}).click();
  }
  await openWechat();
  const qr=dialog.getByRole('img',{name:'微信扫码绑定二维码'});
  await qr.waitFor();
  const image=await qr.getAttribute('src');
  assert.match(image,/^data:image\/gif;base64,/);
  assert.equal(await dialog.getByRole('combobox').count(),0);
  assert.equal(await dialog.getByLabel('手机微信校验码').count(),0);
  assert.equal(await dialog.getByRole('button',{name:/扫码绑定|获取二维码/u}).count(),0);
  const artifacts=process.env.WTT_SMOKE_ARTIFACTS;
  if(artifacts){await mkdir(artifacts,{recursive:true});await dialog.screenshot({path:path.join(artifacts,'cw130-首次打开二维码.png')});}
  await dialog.getByRole('button',{name:'关闭窗口'}).click();
  await openWechat();
  await qr.waitFor();
  assert.equal(await qr.getAttribute('src'),image);
  assert.equal(await readFile(path.join(mock.dir,'qr-requests'),'utf8'),'1');
  const pinRequired=process.env.WTT_WECHAT_SMOKE_PIN==='1';
  await writeFile(path.join(mock.dir,'scan-mode'),pinRequired?'pin':'scan');
  if(pinRequired){
    await dialog.getByLabel('手机微信校验码').fill('246810');
    await dialog.getByRole('button',{name:'提交校验码'}).click();
  }
  await dialog.getByText('微信已连接',{exact:true}).waitFor();
  await dialog.getByText('在微信里打开 ClawBot，说一句「你好」。').waitFor();
  assert.equal(await dialog.getByLabel('手机微信校验码').count(),0);
  assert.equal(await dialog.getByRole('combobox').count(),0);
  if(artifacts)await dialog.screenshot({path:path.join(artifacts,'cw130-微信已连接.png')});
  const uiStatus=await post('project-wechat-status');
  assert.equal(uiStatus.bound,true);
  assert.equal(uiStatus.parentProjectId,first);
  assert(!JSON.stringify(uiStatus).includes('wtt-qa-only'));
  await dialog.getByRole('button',{name:'关闭窗口'}).click();
  await openWechat();
  await dialog.getByText('微信已连接',{exact:true}).waitFor();
  assert.equal(await readFile(path.join(mock.dir,'qr-requests'),'utf8'),'1');
  await dialog.getByText('连接设置',{exact:true}).click();
  const folder=dialog.getByRole('combobox',{name:'微信新建项目的存放目录'});
  await folder.selectOption(second.id);
  await dialog.getByRole('button',{name:'保存目录'}).click();
  await until(async()=> (await post('project-wechat-status')).parentProjectId===second.id);
  await folder.selectOption(first);
  await dialog.getByRole('button',{name:'保存目录'}).click();
  await until(async()=> (await post('project-wechat-status')).parentProjectId===first);
  await dialog.getByRole('button',{name:'关闭窗口'}).click();
  await input('新建项目 不可创建','foreign',{from_user_id:'other-user'});
  await input('你好');
  await reply(message=>message.text.includes('现在在「workspace / 冒烟验收画布」')&&message.text.includes('直接告诉我想做什么'));
  await input('画布 冒烟验收画布');
  await reply(message=>message.text.includes('已切到「workspace / 冒烟验收画布」'));
  await input('微信生成采访稿','plan-unique');
  await input('微信生成采访稿','plan-unique');
  const plan=await reply(message=>message.text.includes('微信验收委托')&&message.text.includes('等你确认'));
  assert(plan.text.includes('按这个做')&&!/确认 [\dA-F]{7}/u.test(plan.text));
  await input('看看有哪些项目');
  const options=await reply(message=>message.text.includes('想去哪一个项目'));
  const number=options.text.match(/(\d+)\. 乙验收项目/u)?.[1];
  assert(number);
  await input('第'+number+'个');
  await reply(message=>message.text.includes('已切到「乙验收项目 / 乙原画布」'));
  await input('这是一条普通问答');
  await reply(message=>message.text==='已核对工作台回执。');
  await input('帮我建一张叫微信建画布的画布','canvas-unique');
  await input('帮我建一张叫微信建画布的画布','canvas-unique');
  await reply(message=>message.text.includes('建好了。现在在「乙验收项目 / 微信建画布」'));
  await input('新建个项目');
  await reply(message=>message.text.includes('新项目叫什么'));
  await input('微信建项目');
  await reply(message=>message.text.includes('建好了。现在在「微信建项目 / 主画布」'));
  await input('可以');
  await reply(message=>message.text.includes('先把计划发给你核对'));
  assert.equal((await post('project-agent-state')).plans[0].state,'approval');
  await input('刚才的计划发我看看','review-again');
  await reply(message=>message.token==='context-review-again'&&message.text.includes('微信验收委托')&&message.text.includes('按这个做'));
  await input('就按这个做');
  await reply(message=>message.text.includes('微信验收委托」已确认'));
  const rejected=await reply(message=>message.code===-2&&message.text.includes('V1'));
  const before=await post('project-agent-state');
  assert.equal(before.plans.length,1);
  assert.equal(before.plans[0].state,'done');
  const receipt=before.plans[0].steps[0].receipt;
  assert.equal(receipt.requirementId,fixture.id);
  const back=receipt.title+' · V'+receipt.number+'（冒烟验收画布）';
  assert(rejected.text.includes(back));
  await input('刚才那个做好了吗','recovery');
  await reply(message=>message.code===0&&message.token==='context-recovery'&&message.text.includes(back));
  const registryResponse=await page.request.get(registry.href);
  const projects=await registryResponse.json();
  assert.equal(projects.activeProjectId,first);
  assert.deepEqual(projects.projects.map(project=>project.name).sort(),['workspace','乙验收项目','微信建项目'].sort());
  const other=new URL(api);
  other.searchParams.set('projectId',second.id);
  const otherView=await (await page.request.get(other.href)).json();
  assert.equal(otherView.requirements.filter(canvas=>canvas.title==='微信建画布').length,1);
  assert((await deliveries()).every(item=>item.to==='wechat-owner'));
  await canvas.getByRole('button',{name:'打开WTT 项目助手'}).click();
  const panel=canvas.locator('.wtt-agent-float.is-open');
  await panel.getByRole('button',{name:'委托',exact:true}).click();
  await panel.getByText('微信验收委托',{exact:true}).click();
  await panel.getByRole('button',{name:'定位 V1',exact:true}).waitFor();
  if(artifacts)await panel.screenshot({path:path.join(artifacts,'cw130-微信委托已保存.png')});
  await canvas.getByRole('button',{name:'打开文件栏 · workspace'}).click();
  await page.getByRole('button',{name:'项目：workspace'}).click();
  await page.getByRole('menuitem',{name:'打开项目…'}).click();
  const picker=page.getByRole('dialog',{name:'选择项目文件夹'});
  await picker.getByRole('button',{name:'打开项目 微信建项目'}).waitFor();
  await picker.getByRole('button',{name:'关闭项目选择'}).click();
  await openWechat();
  await dialog.getByText('连接设置',{exact:true}).click();
  await dialog.getByRole('button',{name:'断开微信'}).click();
  await dialog.getByText('微信未连接',{exact:true}).waitFor();
  assert.equal(await readFile(path.join(mock.dir,'qr-requests'),'utf8'),'1');
  console.log('PASS 一步打开二维码、重开复用、'+(pinRequired?'微信按需校验码':'直接扫码')+'、当前画布问候、连接设置与断开、对话委托和原画布 V1');
}
