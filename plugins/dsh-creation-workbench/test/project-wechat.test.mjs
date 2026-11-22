import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync,mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectAgent } from '../src/project-agent.mjs';
import { ProjectRegistry } from '../src/project-registry.mjs';
import { readProjectPrompt } from '../src/project-agent-host.mjs';
import { ProjectWeChat } from '../src/project-wechat.mjs';
import { createWeChatTransport,wechatApiOrigin } from '../src/wechat-ilink.mjs';

test('iLink 按官方协议发送二维码、PIN、精确消息 ID、会话令牌与业务错误',async()=>{
  const calls=[];
  const transport=createWeChatTransport(async(url,options)=>{
    calls.push({url,options});
    if(url.pathname.endsWith('get_bot_qrcode'))return Response.json({qrcode:'fixture-key',qrcode_img_content:'https://weixin.qq.com/qr'});
    if(url.pathname.endsWith('get_qrcode_status'))return Response.json({status:'need_verifycode'});
    if(url.pathname.endsWith('getupdates'))return new Response('{"ret":0,"msgs":[{"message_id":9223372036854775807}]}');
    return Response.json({ret:-2});
  });
  const origin=wechatApiOrigin('https://ilinkai.weixin.qq.com');
  assert.throws(()=>wechatApiOrigin('https://ilinkai.weixin.qq.com.evil.example'));
  assert.throws(()=>wechatApiOrigin('https://ilinkai.weixin.qq.com/path'));
  assert.equal((await transport.qr()).key,'fixture-key');
  assert.equal(calls[0].options.method,'POST');
  assert.equal(calls[0].options.headers.Authorization,undefined);
  assert.equal((await transport.qrStatus(origin,'fixture-key','1234')).status,'need_verifycode');
  assert.equal(calls[1].url.searchParams.get('verify_code'),'1234');
  const account={origin,token:'only-test-credential',owner:'fixture-owner'};
  assert.equal((await transport.updates(account,'fixture-cursor')).msgs[0].message_id,'9223372036854775807');
  await assert.rejects(transport.send(account,'fixture-context','stable-sent-id','回执'),error=>error.code===-2);
  assert.deepEqual(JSON.parse(calls[3].options.body).msg,{from_user_id:'',to_user_id:'fixture-owner',client_id:'stable-sent-id',
    message_type:2,message_state:2,context_token:'fixture-context',item_list:[{type:1,text_item:{text:'回执'}}]});
  assert(calls.every(item=>item.options.redirect==='error'));
});

test('微信的普通问答只读取对应用户消息的一轮',()=>{
  const events=[
    {type:'turn/start',data:{turn:1}},
    {type:'user/message',data:{source:{kind:'user',rpcId:'desktop'}}},
    {type:'assistant/message',data:{turn:1,message:{content:[{type:'text',text:'不要串到桌面对话'}]}}},
    {type:'turn/end',data:{turn:1,reason:{kind:'completed'}}},
    {type:'turn/start',data:{turn:2}},
    {type:'user/message',data:{source:{kind:'user',rpcId:'wechat'}}},
    {type:'assistant/message',data:{turn:2,message:{content:[{type:'text',text:'对应回答'}]}}},
    {type:'turn/end',data:{turn:2,reason:{kind:'completed'}}},
  ];
  assert.equal(readProjectPrompt(events,'wechat').answer,'对应回答');
  assert.equal(readProjectPrompt(events,'never').state,'missing');
  assert.equal(readProjectPrompt(events.slice(0,-1),'wechat').state,'entered');
});

test('微信扫码、中文接续、已送达计划确认和真实成果跨项目归属',async t=>{
  const root=mkdtempSync(path.join(tmpdir(),'wtt-wechat-'));
  const first=path.join(root,'甲项目'),second=path.join(root,'乙项目');
  const file=path.join(root,'state','wechat.sqlite');
  mkdirSync(first);mkdirSync(second);mkdirSync(path.dirname(file));
  const previous=new DatabaseSync(file);
  previous.exec("CREATE TABLE wx_outbox(seq INTEGER PRIMARY KEY,account TEXT NOT NULL,notice TEXT NOT NULL,client_id TEXT NOT NULL,text TEXT NOT NULL,phase TEXT NOT NULL DEFAULT 'pending',UNIQUE(account,notice)); INSERT INTO wx_outbox VALUES(1,'old-account','old-reply','old-client-id','旧回执','sent')");
  previous.close();
  const projects=new ProjectRegistry({workspaceRoot:first,registryFile:path.join(root,'state','projects.json')});
  const firstRecord=projects.records.get(projects.defaultProjectId);
  const secondRecord=projects.open(second);
  const firstService=projects.get(firstRecord.id);
  const firstCanvas=firstService.store.createCanvas({title:'采访画布',operationId:randomUUID()});
  const secondCanvas=projects.get(secondRecord.id).store.createCanvas({title:'素材画布',operationId:randomUUID()});
  const credentials=new Map(),runners=new Map(),sent=[],failed=[],incoming=[],workerRuns=[],arrivals=[],cursors=[];
  let denyCompletion=false,denyApproval=false,qrCalls=0,wx;
  const ctx={credentials:{resolve:async key=>({value:credentials.get(key)}),
    set:async(key,value)=>credentials.set(key,value),unset:async key=>credentials.delete(key)}};
  const host={createSession:async()=>randomUUID(),
    createTask:(service,input,sources,settings,allowed,title)=>allowed()&&service.createTask({...input,selectedSkills:[]},{projectInputs:{sources,settings,title}}),
    prompt:async(service,sessionId,prepared)=>{workerRuns.push({service,sessionId,prepared});return {accepted:true};},
  };
  const coordinators={
    get(service){
      if(!runners.has(service))runners.set(service,new ProjectAgent(service,host));
      return runners.get(service);
    },
    async sendWechat(service,request){
      const runner=this.get(service);
      runner.turn({sessionId:request.sessionId,requirementId:request.canvasId,text:request.text,mode:'plan'},
        {id:request.requestId,origin:'wechat'});
      arrivals.push(request);
      if(request.text==='写采访稿')runner.tool(request.sessionId,'plan',request.requestId,{title:'采访交付',steps:[
        {title:'采访稿',instruction:'写正式采访稿',type:'text',review:true},
      ]});
    },
    async inspectWechat(){return {state:'ended',answer:'这是同一个 WTT 会话的回答。'};},
  };
  const transport={
    async qr(){qrCalls++;return {key:'qr-test',content:'https://weixin.qq.com/fixture'};},
    async qrStatus(_origin,_key,pin){
      if(pin!=='123456')return {status:'need_verifycode'};
      return {status:'confirmed',bot_token:'token-test-only',ilink_bot_id:'bot-fixture',ilink_user_id:'owner-fixture'};
    },
    async updates(_auth,cursor){
      cursors.push(cursor);
      return {get_updates_buf:'cursor-'+cursors.length,msgs:incoming.splice(0)};
    },
    async send(_auth,token,_id,text){
      if(denyApproval&&text.includes('同意的话，回「按这个做」')){failed.push(text);throw Error('ret=-2');}
      if(denyCompletion&&text.includes('已完成')){failed.push(text);throw Error('ret=-2');}
      sent.push({token,text});
    },
  };
  const delay=()=>new Promise(resolve=>setTimeout(resolve,10));
  async function until(predicate) {
    for(let attempt=0;attempt<200;attempt++){
      wx.tick();
      if(predicate())return;
      await delay();
    }
    throw Error('等待微信测试动作超时 '+JSON.stringify({status:wx.status().phase,sent:sent.slice(-4),failed:failed.slice(-2)}));
  }
  function put(id,text,extra={}){
    incoming.push({message_id:String(id),message_type:1,from_user_id:'owner-fixture',context_token:'context-'+id,
      item_list:[{type:1,text_item:{text}}],...extra});
  }
  const saw=(snippet,id)=>sent.some(item=>(id===undefined||item.token==='context-'+id)&&item.text.includes(snippet));
  wx=new ProjectWeChat(ctx,projects,coordinators,{transport});
  t.after(()=>{wx.close();projects.close();rmSync(root,{recursive:true,force:true});});
  await Promise.all([
    wx.action('connect',{canvasId:firstCanvas.id},firstRecord.id),
    wx.action('connect',{canvasId:secondCanvas.id},secondRecord.id),
  ]);
  assert.equal(qrCalls,1);
  await until(()=>wx.status().phase==='pin');
  const pair=wx.status().pairingId;
  await wx.action('pin',{pairingId:pair,pin:'9999'});
  await until(()=>wx.status().phase==='pin');
  await wx.action('pin',{pairingId:pair,pin:'123456'});
  await until(()=>wx.status().phase==='online');
  assert.equal(wx.state.db.prepare("SELECT text FROM wx_outbox WHERE account='old-account'").get().text,'旧回执');
  assert.equal(credentials.size,1);
  const reopened=await wx.action('connect',{canvasId:secondCanvas.id},secondRecord.id);
  assert.equal(reopened.parentProjectId,firstRecord.id);
  assert.equal(reopened.bound,true);
  assert.equal(qrCalls,1);
  assert(!JSON.stringify(wx.status()).includes('token-test-only'));
  put('foreign','新建项目 不该创建',{from_user_id:'foreign'});
  put('group','新建项目 群聊项目',{group_id:'group'});
  put('hello','你好');
  await until(()=>saw('现在在「甲项目 / 采访画布」。','hello'));
  put(1,'我想换张画布');
  await until(()=>saw('想去哪张画布？',1));
  put(2,'采访画布');
  await until(()=>saw('甲项目 / 采访画布',2));
  denyApproval=true;
  put(3,'写采访稿');
  await until(()=>failed.some(text=>text.includes('采访交付')));
  assert.equal(arrivals.length,1);
  assert.equal(arrivals[0].canvasId,firstCanvas.id);
  const runner=coordinators.get(firstService);
  const planId=arrivals[0].requestId;
  put('failed-plan','可以');
  await until(()=>saw('先把计划发给你核对','failed-plan'));
  assert.equal(runner.plans()[0].state,'approval');
  denyApproval=false;
  put('recover-plan','刚才的计划发我看看');
  await until(()=>saw('按这个做','recover-plan'));
  const offer=wx.state.db.prepare("SELECT dialog FROM wx_outbox WHERE phase='sent' ORDER BY seq DESC LIMIT 1").get();
  const {code}=JSON.parse(offer.dialog);
  assert(!sent.at(-1).text.includes(code));
  put(4,'换个项目');
  await until(()=>saw('想去哪一个项目？',4));
  const number=sent.find(item=>item.token==='context-4').text.match(/(\d+)\. 乙项目/u)[1];
  put('ordinal','第'+number+'个');
  await until(()=>saw('乙项目 / 素材画布','ordinal'));
  put('stale-plan','按这个做');
  await until(()=>saw('先把计划发给你核对','stale-plan'));
  assert.equal(runner.plans()[0].state,'approval');
  put('expired-plan','刚才的计划发我看看');
  await until(()=>saw('按这个做','expired-plan'));
  wx.state.db.exec("UPDATE wx_outbox SET dialog=json_set(dialog,'$.expiresAt',0) WHERE seq=(SELECT MAX(seq) FROM wx_outbox)");
  put('expired-agree','可以开始了');
  await until(()=>saw('先把计划发给你核对','expired-agree'));
  assert.equal(runner.plans()[0].state,'approval');
  put(6,'帮我建一张叫飞行记录的画布');
  await until(()=>saw('乙项目 / 飞行记录',6));
  put('name','新建个项目');
  await until(()=>saw('新项目叫什么','name'));
  put(7,'微信演示');
  put(7,'新建项目 微信演示');
  await until(()=>saw('微信演示 / 主画布',7));
  put('ready','刚才的计划发我看看');
  await until(()=>saw('按这个做','ready'));
  put(5,'可以');
  put(5,'可以');
  await until(()=>saw('采访交付」已确认',5));
  await until(()=>saw('这一步需要你确认',5));
  put('approve-step','开始做吧');
  await until(()=>saw('采访交付」这一步已确认','approve-step'));
  put('legacy','确认 '+code);
  await until(()=>saw('已经确认过了','legacy'));
  put(8,'这是普通问题');
  await until(()=>saw('同一个 WTT 会话的回答',8));
  const child=projects.list().projects.find(item=>item.name==='微信演示');
  assert.equal(child.path,path.join(firstRecord.path,'微信演示'));
  assert.equal(projects.activeProjectId,secondRecord.id);
  assert(projects.get(secondRecord.id).store.listCanvases().some(canvas=>canvas.title==='飞行记录'));
  assert.equal(projects.get(secondRecord.id).store.getCanvas(secondCanvas.id).title,'素材画布');
  assert.equal(projects.list().projects.length,3);
  assert.equal(runner.plans()[0].state,'running');
  assert.equal(arrivals.length,2);
  const startCursor=cursors.at(-1);
  wx.close();wx=new ProjectWeChat(ctx,projects,coordinators,{transport});
  const beforeRestart=cursors.length;
  put(3,'写采访稿');put(7,'新建项目 微信演示');
  await until(()=>cursors.length>beforeRestart);
  // The last request's next cursor, not the input cursor, is saved after it settles.
  assert.notEqual(cursors.at(-1),'');
  assert.notEqual(startCursor,'');
  denyCompletion=true;
  await runner.tick();
  const {service,sessionId,prepared}=workerRuns[0];
  const relative=prepared.deliveryDirectory+'/wechat-report.md';
  writeFileSync(path.join(first,relative),'# 微信验收成果\n\n正文');
  await service.tasks.files.register({taskId:prepared.taskId,operationId:randomUUID(),kind:'text',title:'采访稿',path:relative,primary:true},{sessionId});
  await runner.tick();await runner.tick();
  assert.equal(runner.plans()[0].id,planId);
  assert.equal(runner.plans()[0].state,'done');
  await until(()=>failed.some(text=>text.includes('采访稿 · V1（采访画布）')));
  denyCompletion=false;
  put(9,'刚才那个做好了吗');
  await until(()=>sent.some(item=>item.token==='context-9'&&item.text.includes('采访稿 · V1（采访画布）')));
  assert.equal(projects.list().projects.length,3);
  assert.equal(arrivals.length,2);
  assert.equal(workerRuns.length,1);
  await wx.action('disconnect');
  assert.equal(wx.status().phase,'unbound');
  assert.equal(credentials.size,0);
  assert.equal(runner.plans()[0].state,'done');
});
