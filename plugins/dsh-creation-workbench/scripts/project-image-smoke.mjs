import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

export async function checkProjectFileOrganization(page,canvas,workspace,artifacts){
  await page.getByRole('button',{name:/^打开文件栏/}).click();
  const explorer=page.getByRole('complementary',{name:'项目文件',exact:true});
  const file=relative=>explorer.locator('[data-project-file-path="'+relative+'"]');
  const key=process.platform==='darwin'?'Meta':'Control';
  for(const folder of ['分镜 A','分镜 B'])await explorer.getByRole('button',{name:'展开 '+folder,exact:true}).click();
  const original=file('分镜 A/镜头说明.md');
  await original.dblclick();
  const preview=canvas.getByRole('complementary',{name:'成果文件预览'});
  await preview.getByRole('button',{name:'取消固定',exact:true}).waitFor();
  await explorer.getByRole('button',{name:'添加到画布',exact:true}).click();
  const card=canvas.locator('article[data-card-id^="material:"]');
  await card.waitFor();
  await original.press('F2');
  const input=explorer.getByRole('textbox',{name:'新名称'});
  await input.waitFor();
  assert.deepEqual(await input.evaluate(element=>[element.selectionStart,element.selectionEnd]),[0,'镜头说明'.length]);
  await page.screenshot({path:path.join(artifacts,'organize-rename.png')});
  await input.fill('镜头记录.md');
  await input.press('Enter');
  const renamed=file('分镜 A/镜头记录.md');
  await renamed.waitFor();
  await preview.getByRole('heading',{name:'镜头记录.md',exact:true}).waitFor();
  await preview.getByRole('button',{name:'取消固定',exact:true}).waitFor();
  await preview.getByRole('button',{name:'关闭成果预览',exact:true}).click();
  await card.getByRole('button',{name:/卡片操作/}).click();
  await card.getByRole('button',{name:'在项目文件中定位',exact:true}).click();
  await page.waitForFunction(()=>document.activeElement?.dataset.projectFilePath==='分镜 A/镜头记录.md');
  await renamed.press(key+'+x');
  await file('分镜 B').press(key+'+v');
  const moved=file('分镜 B/镜头记录.md');
  await moved.waitFor();
  await assert.rejects(readFile(path.join(workspace,'分镜 A','镜头记录.md')),{code:'ENOENT'});
  assert.equal(await readFile(path.join(workspace,'分镜 B','镜头记录.md'),'utf8'),'# 分镜 A');
  await moved.press(key+'+z');
  await renamed.waitFor();
  await moved.waitFor({state:'detached'});

  await file('分镜 A/提示词.md').click();
  await file('分镜 A/提示词.md').press(key+'+c');
  await file('分镜 B').press(key+'+v');
  const conflict=page.getByRole('dialog',{name:'目标位置含同名文件',exact:true});
  await conflict.waitFor();
  assert.equal(await file('分镜 B/提示词 副本.md').count(),0);
  await page.screenshot({path:path.join(artifacts,'organize-conflict.png')});
  await conflict.getByRole('button',{name:'保留副本',exact:true}).click();
  const copy=file('分镜 B/提示词 副本.md');
  await copy.waitFor();
  assert.equal(await readFile(path.join(workspace,'分镜 B','提示词.md'),'utf8'),'# 分镜 B 合成提示词');
  assert.equal(await readFile(path.join(workspace,'分镜 B','提示词 副本.md'),'utf8'),'# 分镜 A 合成提示词');

  await file('分镜 A').click();
  await file('分镜 A').dragTo(file('分镜 B'));
  await file('分镜 B/分镜 A').waitFor();
  assert.equal(await readFile(path.join(workspace,'分镜 B','分镜 A','镜头记录.md'),'utf8'),'# 分镜 A');
  await file('分镜 B').click({button:'right'});
  const chooser=page.waitForEvent('filechooser');
  await explorer.getByRole('menuitem',{name:'从电脑导入…',exact:true}).click();
  await (await chooser).setFiles({name:'键盘导入.txt',mimeType:'text/plain',buffer:Buffer.from('快捷导入')});
  await file('分镜 B/键盘导入.txt').waitFor();
  assert.equal(await readFile(path.join(workspace,'分镜 B','键盘导入.txt'),'utf8'),'快捷导入');
  const transfer=await page.evaluateHandle(()=>{
    const data=new DataTransfer(),content=new Uint8Array(4*1024*1024+17);
    content[0]=85;
    content[content.length-1]=95;
    data.items.add(new File([content],'系统素材.bin',{type:'application/octet-stream'}));
    return data;
  });
  await file('分镜 B').dispatchEvent('dragover',{dataTransfer:transfer});
  await explorer.getByText('复制到此',{exact:true}).waitFor();
  await file('分镜 B').dispatchEvent('drop',{dataTransfer:transfer});
  await file('分镜 B/系统素材.bin').waitFor();
  const upload=await readFile(path.join(workspace,'分镜 B','系统素材.bin'));
  assert.equal(upload.length,4*1024*1024+17);
  assert.deepEqual([upload[0],upload.at(-1)],[85,95]);

  await page.setViewportSize({width:390,height:900});
  await explorer.getByRole('button',{name:'文件栏操作',exact:true}).click();
  const undo=explorer.getByRole('menuitem',{name:'撤销文件操作',exact:true});
  await undo.waitFor();
  const bounds=await explorer.getByRole('menu').boundingBox();
  assert(bounds&&bounds.x>=0&&bounds.x+bounds.width<=390);
  await page.screenshot({path:path.join(artifacts,'organize-mobile.png')});
  await undo.click();
  await file('分镜 B/系统素材.bin').waitFor({state:'detached'});
  console.log('PASS 原地改名、固定预览与卡片来源、剪切粘贴、键盘撤销、同名副本、树内移动、菜单导入、分片拖入和窄屏恢复');
}

export async function checkProjectFileNavigation(page,canvas,workspace,artifacts){
  await page.getByRole('button',{name:/^打开文件栏/}).click();
  const explorer=page.getByRole('complementary',{name:'项目文件',exact:true});
  const row=file=>explorer.locator('[data-project-file-path]').filter({hasText:file});
  const file=filePath=>explorer.locator('[data-project-file-path="'+filePath+'"]');
  const search=explorer.getByRole('button',{name:'查找文件',exact:true});
  await search.click();
  const input=explorer.getByRole('combobox',{name:'按文件名或路径查找'});
  await input.fill('镜头说明.md');
  await explorer.getByRole('option',{name:'镜头说明.md 分镜 B'}).waitFor();
  assert.equal(await explorer.getByRole('option').count(),2);
  assert.equal(await input.evaluate(element=>element===document.activeElement),true);
  await page.screenshot({path:path.join(artifacts,'navigator-search.png')});
  await input.press('ArrowDown');
  await input.press('Enter');
  const target=file('分镜 B/镜头说明.md');
  await target.waitFor();
  assert.equal(await target.evaluate(element=>element===document.activeElement),true);
  assert.equal(await target.evaluate(element=>element.closest('[role=treeitem]').getAttribute('aria-selected')),'true');
  await target.press('ArrowUp');
  assert.equal(await target.evaluate(element=>element.closest('[role=treeitem]').getAttribute('aria-selected')),'true');
  await target.dblclick();
  const preview=canvas.getByRole('complementary',{name:'成果文件预览'});
  await preview.getByRole('button',{name:'取消固定',exact:true}).waitFor();
  await file('分镜 B/提示词.md').click();
  assert.equal(await preview.getByRole('heading',{level:2}).innerText(),'镜头说明.md');
  await target.click({modifiers:['Shift']});
  await explorer.getByText('已选 2 项',{exact:true}).waitFor();
  await preview.getByRole('heading',{name:'分镜 B',exact:true}).waitFor();
  await page.screenshot({path:path.join(artifacts,'navigator-multiselect.png')});
  await rm(path.join(workspace,'分镜 B','提示词.md'));
  await explorer.getByRole('button',{name:'添加到画布',exact:true}).click();
  await explorer.getByText('已添加 1 项，1 项需重试',{exact:true}).waitFor();
  await writeFile(path.join(workspace,'分镜 B','提示词.md'),'# 恢复后的提示词');
  await explorer.getByRole('button',{name:'重试',exact:true}).click();
  await explorer.getByText('已添加 1 项',{exact:true}).waitFor();
  assert.equal(await preview.getByRole('heading',{level:2}).innerText(),'镜头说明.md');
  await preview.getByRole('button',{name:'关闭成果预览',exact:true}).click();
  const source=canvas.locator('article[data-card-id^="material:"]').filter({hasText:'镜头说明.md'});
  await source.waitFor();
  await source.getByRole('button',{name:/卡片操作/}).click();
  await source.getByRole('button',{name:'在项目文件中定位'}).click();
  await page.waitForFunction(()=>document.activeElement?.dataset.projectFilePath==='分镜 B/镜头说明.md');
  await file('分镜 B/提示词.md').click({modifiers:[process.platform==='darwin'?'Meta':'Control']});
  await explorer.getByRole('button',{name:'所选项操作',exact:true}).click();
  await explorer.getByRole('menuitem',{name:'添加为对话引用',exact:true}).click();
  const composer=canvas.locator('.wcc-card-composer:visible');
  await composer.locator('textarea').first().waitFor();
  const draft=composer.locator('textarea').first();
  await draft.fill('保留这一句草稿');
  await file('分镜 B/分镜预览.png').click({button:'right'});
  await explorer.getByRole('menuitem',{name:'添加为对话引用',exact:true}).click();
  await composer.getByText('分镜预览.png',{exact:false}).first().waitFor();
  assert.equal(await draft.inputValue(),'保留这一句草稿');
  assert.equal(await canvas.locator('article[data-card-id^="material:"]').count(),3);
  await composer.getByRole('button',{name:'关闭卡片创作框',exact:true}).click();
  const firstDrag=file('拖入 1.txt');
  await firstDrag.click();
  await file('拖入 2.txt').click({modifiers:['Shift']});
  await explorer.getByText('已选 2 项',{exact:true}).waitFor();
  await preview.getByRole('button',{name:'关闭成果预览',exact:true}).click();
  const graph=canvas.locator('.react-flow__pane');
  await firstDrag.dragTo(graph,{targetPosition:{x:100,y:600}});
  await canvas.getByText('已添加 2 项',{exact:true}).waitFor();
  assert.equal(await canvas.locator('article[data-card-id^="material:"]').count(),5);
  await page.evaluate(()=>{document.documentElement.dataset.dsThemeSource='dark';document.documentElement.style.colorScheme='dark';document.body.setAttribute('data-ds-dark-theme','')});
  await page.setViewportSize({width:390,height:900});
  await search.click();
  await input.fill('分镜预览');
  await explorer.getByRole('option').first().waitFor();
  assert.equal(await explorer.getByRole('option').first().evaluate(element=>getComputedStyle(element).justifyContent),'flex-start');
  await page.screenshot({path:path.join(artifacts,'navigator-mobile.png')});
  await input.press('Escape');
  assert.equal(await input.count(),0);
  assert.equal(await row('分镜 B').count(),1);
  await page.setViewportSize({width:1440,height:1000});
  await explorer.getByRole('button',{name:'新建文件',exact:true}).click();
  const filename=explorer.getByRole('textbox',{name:'文件名',exact:true});
  await filename.fill('回收站验收.md');
  await filename.press('Enter');
  const created=file('回收站验收.md');
  await created.click({button:'right'});
  await explorer.getByRole('menuitem',{name:'删除…',exact:true}).click();
  const remove=page.getByRole('dialog',{name:'移到回收站',exact:true});
  await remove.getByRole('button',{name:'移到回收站',exact:true}).click();
  await created.waitFor({state:'detached'});
  await explorer.getByRole('button',{name:'文件栏操作',exact:true}).click();
  await explorer.getByRole('menuitem',{name:'项目回收站',exact:true}).click();
  const recycle=page.getByRole('dialog',{name:'项目回收站',exact:true});
  await recycle.getByRole('button',{name:'恢复',exact:true}).click();
  await recycle.getByRole('button',{name:'关闭',exact:true}).click();
  await created.waitFor();
  assert.equal((await readFile(path.join(workspace,'回收站验收.md'))).length,0);
  console.log('PASS 文件名搜索与同名路径、键盘焦点、固定预览、范围多选、局部失败与重试、原卡定位、草稿引用、批量拖放、390px 搜索、新建与回收恢复');
}

export async function seedProjectImages(workspace, run) {
  const directory = '素材 测试/版本 V001';
  await mkdir(path.join(workspace, directory), { recursive: true });
  const files = [
    ['F14 同版静态片尾素材 V1.png', 'PNG', 'image/png'],
    ['编码不同的图片.png', 'JPEG', 'image/jpeg'],
    ['大写后缀.PNG', 'PNG', 'image/png'],
    ['照片.jpg', 'JPEG', 'image/jpeg'],
    ['照片.jpeg', 'JPEG', 'image/jpeg'],
    ['透明图.webp', 'WEBP', 'image/webp'],
    ['动画.gif', 'GIF', 'image/gif'],
  ];
  for (const [name, format] of files) await run('python3', ['-c', 'from PIL import Image;import sys;Image.new("RGB",(641,427),"#1476c8").save(sys.argv[1],format=sys.argv[2])', path.join(workspace, directory, name), format]);
  await writeFile(path.join(workspace, directory, '损坏.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return { directory, files };
}

export async function checkProjectImages(page, canvas, fixture, workspace, artifacts) {
  let phase = '打开文件树';
  const logWarning = message => { if (message.type() === 'warning') console.log('WARN_PHASE', phase, message.text()); };
  page.on('console', logWarning);
  await page.getByRole('button', { name: /^打开文件栏/ }).click();
  const explorer = page.getByRole('complementary', { name: '项目文件', exact: true });
  for (const directory of fixture.directory.split('/')) await explorer.getByRole('button', { name: `展开 ${directory}`, exact: true }).click();
  const viewer = canvas.getByRole('complementary', { name: '成果文件预览', exact: true });
  const row = name => explorer.getByRole('treeitem', { name, exact: true }).locator('.wtt-file-name');
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  // Isolate the existing responsive layout on an older candidate, before image assertions.
  if (process.env.WTT_FILE_LAYOUT_ONLY === '1') {
    await row(fixture.files[0][0]).click(); await viewer.waitFor();
    await viewer.getByRole('link', { name: '下载当前文件', exact: true }).waitFor();
    await explorer.getByRole('button', { name: '收起文件栏', exact: true }).click();
    phase = '缩小视口'; await page.setViewportSize({ width: 390, height: 900 });
    await viewer.getByRole('button', { name: '关闭成果预览', exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    page.off('console', logWarning); return;
  }
  async function check(name, mime) {
    phase = `预览 ${name}`;
    const relative = `${fixture.directory}/${name}`, bytes = await readFile(path.join(workspace, relative));
    await row(name).click(); await viewer.waitFor();
    const image = viewer.locator('img.wtt-output-image'); await image.waitFor();
    await image.evaluate(async img => { await img.decode(); if (img.naturalWidth !== 641 || img.naturalHeight !== 427) throw new Error('未显示所选图片'); });
    const href = new URL(await image.getAttribute('src'));
    assert.equal(href.searchParams.get('reviewImage'), relative); assert.equal(href.searchParams.get('hash'), sha(bytes)); assert(href.searchParams.get('projectId'));
    const response = await page.request.get(href.href); assert.equal(response.status(), 200); assert.equal(response.headers()['content-type'], mime); assert.equal(response.headers()['x-content-type-options'], 'nosniff');
    assert.deepEqual(await response.body(), bytes);
    const download = viewer.getByRole('link', { name: '下载当前文件', exact: true });
    const original = await page.request.get(await download.getAttribute('href')); assert.deepEqual(await original.body(), bytes);
    assert.deepEqual(await readFile(path.join(workspace, relative)), bytes, '预览不可改写原图');
    const rect = await image.boundingBox(); assert(rect.width > 100 && rect.height > 100, '图片必须实际占有可见尺寸');
    assert.equal(await viewer.locator('.wtt-native-document-preview').count(), 0);
    return href;
  }
  for (const [name, , mime] of fixture.files) await check(name, mime);
  const [name, , mime] = fixture.files[0];
  const firstHref = await check(name, mime);
  await viewer.getByRole('button', { name: '展开侧栏', exact: true }).click(); await check(name, mime);
  await viewer.getByRole('button', { name: '还原侧栏宽度', exact: true }).click();
  await page.screenshot({ path: path.join(artifacts, 'file-tree-light.png') });
  await page.evaluate(() => { document.documentElement.dataset.dsThemeSource = 'dark'; document.documentElement.style.colorScheme = 'dark'; document.body.setAttribute('data-ds-dark-theme', ''); });
  await check(name, mime); await page.screenshot({ path: path.join(artifacts, 'file-tree-dark.png') });
  // A late response for the previous file must never replace the next file.
  const captured = Promise.withResolvers(), release = Promise.withResolvers(), done = Promise.withResolvers();
  const delayed = url => url.searchParams.get('nativePreview') === '' && url.searchParams.get('projectPath') === `${fixture.directory}/${name}`;
  await page.route(delayed, async route => { const response = await route.fetch(); captured.resolve(); await release.promise; await route.fulfill({ response }); done.resolve(); });
  await row(name).click(); await captured.promise;
  await check(fixture.files[1][0], fixture.files[1][2]); release.resolve(); await done.promise; await page.unroute(delayed);
  assert.equal(new URL(await viewer.locator('img').getAttribute('src')).searchParams.get('reviewImage'), `${fixture.directory}/${fixture.files[1][0]}`);
  await row('损坏.png').click(); await viewer.getByText('此版本图片未能加载，可下载原图查看。', { exact: true }).waitFor();
  // Modify/delete after metadata resolution, before the verified byte request.
  for (const operation of ['change', 'remove']) {
    const relative = `${fixture.directory}/${name}`, absolute = path.join(workspace, relative), bytes = await readFile(absolute);
    const matcher = url => url.searchParams.get('reviewImage') === relative;
    await page.route(matcher, async route => { if (operation === 'change') await writeFile(absolute, 'changed'); else await rm(absolute); await route.continue(); });
    await row(name).click(); await viewer.getByText('此版本图片未能加载，可下载原图查看。', { exact: true }).waitFor();
    await page.unroute(matcher); await writeFile(absolute, bytes);
    assert.equal((await page.request.get(firstHref.href)).status(), 200);
    await check(fixture.files[1][0], fixture.files[1][2]);
  }
  await check(name, mime);
  phase = '关闭文件树';
  await explorer.getByRole('button', { name: '收起文件栏', exact: true }).click();
  await explorer.waitFor({ state: 'detached' });
  phase = '缩小视口';
  await page.setViewportSize({ width: 390, height: 900 });
  const image = viewer.locator('img.wtt-output-image'); await image.waitFor({ state: 'visible' }); await image.evaluate(img => img.decode());
  const rect = await image.boundingBox(); assert(rect.width > 100 && rect.x >= 0 && rect.x + rect.width <= 391);
  await viewer.getByRole('button', { name: '关闭成果预览', exact: true }).waitFor({ state: 'visible' });
  await page.screenshot({ path: path.join(artifacts, 'file-tree-390.png') });
  phase = '关闭窄屏预览';
  await viewer.getByRole('button', { name: '关闭成果预览', exact: true }).click(); await viewer.waitFor({ state: 'detached' });
  phase = '还原视口';
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: /^打开文件栏/ }).click();
  // Existing file-tree document/video routes still render their real content.
  await explorer.getByRole('button', { name: '展开 working', exact: true }).click();
  await row('document.md').click(); await viewer.getByText('导演文档唯一正文。', { exact: false }).waitFor();
  await row('video.mp4').click(); const video = viewer.locator('video'); await video.waitFor();
  await video.evaluate(async item => { await item.play(); item.pause(); if (item.videoWidth !== 32) throw new Error('视频未正确解码'); });
  await viewer.getByRole('button', { name: '关闭成果预览', exact: true }).click();
  page.off('console', logWarning);
  for (const directory of fixture.directory.split('/')) await explorer.getByRole('button', { name: `展开 ${directory}`, exact: true }).click();
  const href = await check(name, mime);
  const api = new URL(href); api.searchParams.delete('reviewImage'); api.searchParams.delete('hash');
  const imported = page.waitForResponse(response => response.request().method() === 'POST' && response.url().startsWith(api.origin) && response.request().postDataJSON()?.action === 'project-file-reference-batch');
  await viewer.getByRole('button', { name: '添加到画布', exact: true }).click();
  const result = await (await imported).json(); assert.equal(result.added?.length,1); await viewer.waitFor({ state: 'detached' });
  const card = canvas.locator(`.react-flow__node[data-id="${result.added[0].cardId}"]`); await card.waitFor();
  const cardImage = card.locator('img'); await cardImage.evaluate(img => img.decode());
  assert.equal(await cardImage.evaluate(img => img.naturalWidth), 641);
  await cardImage.dblclick(); await viewer.waitFor();
  await viewer.locator('img.wtt-output-image').evaluate(async img => { await img.decode(); if (img.naturalWidth !== 641) throw new Error('原素材预览失败'); });
  await viewer.getByRole('button', { name: '关闭成果预览', exact: true }).click();
  console.log('PASS 真实文件树：中文路径、PNG/JPEG/WebP/GIF、编码错名、下载原字节、展开关闭、明暗390px、迟到响应、损坏变化缺失、文档视频、添加画布及素材预览');
}
