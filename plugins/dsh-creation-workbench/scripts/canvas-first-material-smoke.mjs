import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WorkbenchService } from '../src/service.mjs';

export async function checkFirstMaterial(page, workspace, api) {
  const action = name => page.getByRole('button', { name, exact: true });
  const canvas = page.locator('.wtt-course-canvas:visible');
  const composer = canvas.locator('.wcc-card-composer:visible');
  const capture = async name => {
    const directory = process.env.WTT_SMOKE_ARTIFACTS;
    if (!directory) return;
    await mkdir(directory,{recursive:true});
    await page.screenshot({path:path.join(directory, name+'.png')});
  };
  await canvas.locator('.wcc-first-material').getByRole('button',{name:'添加素材',exact:true}).waitFor();
  const assistant = action('打开小瓦');
  const emptyPosition = await assistant.boundingBox();
  await assistant.click();
  await action('收起小瓦').click();
  assert.equal(await assistant.evaluate(el => el === document.activeElement), true);
  const picker = page.getByLabel('选择素材文件');
  await picker.setInputFiles({ name:'采访笔记.exe', mimeType:'application/octet-stream', buffer:Buffer.from('sample') });
  await page.getByText(/请选择文本、PDF/).first().waitFor();
  assert.equal(await canvas.getByRole('article').count(),0);
  const chooser = page.waitForEvent('filechooser');
  await action('添加素材').click();
  await (await chooser).setFiles({ name:'采访笔记.md', mimeType:'text/markdown',buffer:Buffer.from('# 城市清晨\n第一班公交，卷帘门和面包店。') });
  await composer.locator('textarea').first().waitFor();
  assert(await composer.locator('textarea').first().evaluate(el => el === document.activeElement),'导入后输入框应已获得焦点');
  assert.deepEqual(await assistant.boundingBox(), emptyPosition, '首份素材导入后 W 按钮仍在原位');
  await composer.locator('textarea').first().fill('整理成三个分镜');
  assert.equal(await page.getByRole('combobox',{name:'当前画布'}).locator('option').count(),1);
  assert.equal(await canvas.getByRole('button',{name:'AI 创作',exact:true}).count(),0);
  await capture('02-导入后创作');
  let created;
  const isApi = url => url.pathname === api.pathname;
  const intercept = async route => {
    if (route.request().method() !== 'POST' || route.request().postDataJSON()?.action !== 'create-task') return route.continue();
    try {
      const response = await route.fetch();
      const result = await response.json();
      assert.ok(response.ok(),JSON.stringify(result));
      const task=result.task;
      const journal=await page.request.post(api.href,{data:{action:'set-task-dispatch',data:{taskId:task.id,status:'unknown'}}});
      assert.ok(journal.ok());
      await route.fulfill({response,json:{...result,task:{...task,dispatchStatus:'unknown'}}});
      created.resolve(result);
    } catch(error) {created.reject(error);await route.abort().catch(()=>{});}
  };
  async function submit(label) {
    created = Promise.withResolvers();
    await page.route(isApi,intercept);
    try {
      await action(label).click();
      return await Promise.race([created.promise,new Promise((_,reject)=>{
        const timer=setTimeout(()=>reject(Error('任务未登记')),10000);
        timer.unref();
      })]);
    } finally { await page.unroute(isApi,intercept); }
  }
  const {task,prepared}=await submit('生成文本');
  assert.equal(task.input.sources.length,1);
  assert.match(task.input.sources[0].title,/采访笔记/);
  assert.equal(task.instruction,'整理成三个分镜');
  assert.equal(task.input.sources[0].hash,task.input.sourceRefs[0].hash);
  const service=new WorkbenchService({workspaceRoot:workspace});
  try {
    const file=path.join(prepared.deliveryDirectory,'三个分镜.md');
    await mkdir(path.dirname(path.resolve(workspace,file)),{recursive:true});
    await writeFile(path.resolve(workspace,file),'# 城市清晨\n镜一：开门。镜二：公交。镜三：灯亮。');
    const sessionId='synthetic-first-material';
    service.tasks.bindSession({taskId:task.id,sessionId});
    await service.tasks.files.register({taskId:task.id,path:file,kind:'text',title:'三个分镜',primary:true,operationId:randomUUID()},{sessionId});
  } finally {service.close();}
  await action('刷新画布').click();
  const resultCard=canvas.getByRole('article',{name:/三个分镜/});
  await resultCard.locator('.wcc-card-body').click();
  await action('基于此版修改').click();
  await composer.locator('textarea').first().fill('第二镜改成电车');
  await action('生成新版本').waitFor();
  await capture('03-继续修改');
  const versionId=await resultCard.getByRole('combobox').inputValue();
  const revised=await submit('生成新版本');
  assert.equal(revised.task.baseCardVersionId,versionId);
  assert.equal(revised.task.instruction,'第二镜改成电车');
  await action('画布菜单').click();
  await page.getByRole('menuitem',{name:'资产看板'}).click();
  await page.getByRole('dialog',{name:'资产看板'}).waitFor();
  await action('关闭资产看板').click();
  await action('画布菜单').click();
  await page.getByRole('menuitem',{name:'新建画布'}).click();
  const dialog=page.getByRole('dialog',{name:'新建画布'});
  await dialog.getByRole('textbox').fill('空画布');
  await dialog.getByRole('button',{name:/创建|新建画布/}).click();
  await canvas.locator('.wcc-first-material').getByRole('button',{name:'添加素材',exact:true}).waitFor();
  await page.setViewportSize({width:390,height:780});
  await capture('01-空画布窄屏');
  assert.equal(await canvas.getByRole('search').count(),0);
  assert.equal(await canvas.getByRole('toolbar',{name:'画布缩放与导航'}).count(),0);
  const transfer=await page.evaluateHandle(()=>{const transfer=new DataTransfer();transfer.items.add(new File(['采访第二稿'],'第二份采访.txt',{type:'text/plain'}));return transfer;});
  await canvas.locator('.wcc-graph').dispatchEvent('drop',{dataTransfer:transfer,clientX:180,clientY:300});
  await composer.locator('textarea').first().waitFor();
  await canvas.getByRole('article',{name:/第二份采访/}).waitFor();
  console.log('PASS 空项目文件选择、沿用默认画布、固定引用、真实任务登记、模拟成果续改、资产看板、空画布窄屏拖入');
}
