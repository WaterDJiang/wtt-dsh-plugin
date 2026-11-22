import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createWeChatTransport, wechatApiOrigin, wechatOrigin } from './wechat-ilink.mjs';
import { ProjectWeChatState } from './project-wechat-state.mjs';
import { ProjectWeChatDispatch } from './project-wechat-dispatch.mjs';

function validField(value,max=512) {
  return typeof value==='string'&&Boolean(value.trim())&&value.length<=max&&!/[\u0000-\u001f\u007f]/u.test(value);
}

function inbound(messages,owner) {
  return (Array.isArray(messages)?messages:[]).flatMap(message=>{
    if (!message||message.from_user_id!==owner||message.group_id||message.message_type!==1||message.message_state===1)
      return [];
    const text=(Array.isArray(message.item_list)?message.item_list:[]).filter(item=>item?.type===1)
      .map(item=>typeof item.text_item?.text==='string'?item.text_item.text:'').join('\n').trim().slice(0,8001);
    const id=String(message.message_id??message.client_id??'');
    return validField(id)?[{id,text,token:validField(message.context_token,8192)?message.context_token:null}]:[];
  });
}

export class ProjectWeChat {
  constructor(ctx,projects,coordinators,{transport=createWeChatTransport(),file=path.join(path.dirname(projects.registryFile),'wechat.sqlite')}={}) {
    this.ctx=ctx;this.projects=projects;this.coordinators=coordinators;this.transport=transport;this.file=file;
    this.holder=randomUUID();this.controller=new AbortController();
    if(existsSync(file))this.init();
  }

  init() {
    if(this.closed)throw new Error('微信助手已关闭');
    if(this.state)return;
    this.state=new ProjectWeChatState(this.file);
    this.dispatch=new ProjectWeChatDispatch(this.state,this.projects,this.coordinators);
    this.interval=setInterval(()=>this.tick(),1250);
    this.interval.unref?.();
  }

  provider() {
    const value=this.ctx.get?.('credentials')||this.ctx.credentials;
    if(!value?.resolve||!value?.set||!value?.unset)throw new Error('DSH 凭据服务不可用，无法绑定微信');
    return value;
  }

  async credential(account) {
    const record=await this.provider().resolve(account.ref);
    if(!validField(record?.value,8192))throw new Error('微信凭据不可用，请重新扫码');
    return {...account,token:record.value};
  }

  lease() {
    if(!this.state.lease(this.holder))throw new Error('微信通道已在另一个 DSH 实例运行');
    this.owns=true;
  }

  active(account) {
    if(this.closed||!this.owns||this.bindingPending)return false;
    const current=this.state.binding();
    return current?.ref===account.ref&&!current.expired;
  }

  status(defaultProjectId) {
    const account=this.state?.binding(), pair=this.pairing;
    const choices=this.projects.list().projects.map(({id,name,path:pathName})=>({id,name,path:pathName}));
    return {
      phase:pair?.phase||(account?.expired?'expired':account?(this.connection||'connecting'):'unbound'),
      bound:Boolean(account),parentProjectId:pair?.parentProjectId||account?.parentProjectId||defaultProjectId||this.projects.defaultProjectId,
      projects:choices,...(pair?.content?{qr:pair.content,pairingId:pair.id}:{}),
      ...(this.error?{error:this.error}:{}),...(account?this.state.status(account.key):{}),
    };
  }

  async action(action,data={},defaultProjectId) {
    if(action==='status')return this.status(defaultProjectId);
    this.init();
    if(action==='connect'||action==='pair'){
      const account=this.state.binding();
      if(this.pairing&&(action==='connect'||data.refresh!==true))return this.status(defaultProjectId);
      if(account&&action==='connect')return this.status(defaultProjectId);
      if(account&&!account.expired)throw new Error('当前微信已绑定，请先断开再换账号');
      const projectId=defaultProjectId??data.parentProjectId??this.projects.defaultProjectId;
      const parentProjectId=data.parentProjectId??account?.parentProjectId??projectId;
      if(!this.projects.records.has(parentProjectId))throw new Error('请选择已登记的项目目录');
      const service=this.projects.get(projectId);
      const canvasId=typeof data.canvasId==='string'?service.store.getCanvas(data.canvasId)?.id:undefined;
      this.lease();
      this.cancelPairing();
      const attempt={id:randomUUID(),phase:'preparing',projectId,canvasId,parentProjectId,controller:new AbortController(),origin:wechatOrigin,
        deadline:Date.now()+6*60000,refreshes:0};
      this.pairing=attempt;this.error=null;
      await this.loadQR(attempt);
      this.tick();
      return this.status(defaultProjectId);
    }
    if(action==='pin'){
      const attempt=this.pairing;
      if(!attempt||attempt.id!==data.pairingId||attempt.phase!=='pin')throw new Error('当前没有等待校验的微信绑定');
      if(typeof data.pin!=='string'||!/^\d{1,10}$/.test(data.pin))throw new Error('请输入手机微信显示的数字校验码');
      attempt.pin=data.pin;attempt.phase='scanned';this.error=null;this.tick();
    } else if(action==='cancel'){
      if(!this.pairing||this.pairing.id!==data.pairingId)throw new Error('微信二维码已更换，请刷新状态');
      this.cancelPairing();this.error=null;
    } else if(action==='parent'){
      this.lease();
      const account=this.state.binding();
      if(!account)throw new Error('请先绑定微信');
      if(!this.projects.records.has(data.parentProjectId))throw new Error('请选择已登记的项目目录');
      this.projects.get(data.parentProjectId);
      this.state.bind({...account,parentProjectId:data.parentProjectId});
    } else if(action==='disconnect'){
      this.lease();
      this.cancelPairing();
      const account=this.state.binding();
      if(account){
        this.pollController?.abort();
        this.sendController?.abort();
        this.state.transaction(()=>{
          this.state.bind(null);
          this.state.db.prepare('UPDATE wx_peer SET token=NULL WHERE account=?').run(account.key);
          this.state.db.prepare("UPDATE wx_outbox SET phase='failed' WHERE account=? AND phase IN ('pending','sending')").run(account.key);
        });
        await this.provider().unset(account.ref);
      }
      this.error=null;this.connection=null;this.state.release(this.holder);this.owns=false;
    } else throw new Error('未知的微信设置操作');
    return this.status(defaultProjectId);
  }

  cancelPairing() {
    this.pairing?.controller.abort();
    this.pairing=null;
  }

  async loadQR(attempt) {
    let qr;
    try {qr=await this.transport.qr(attempt.controller.signal);}
    catch(error){if(this.pairing===attempt){this.error=error.message;this.cancelPairing();}return;}
    if(this.pairing!==attempt||this.closed)return;
    Object.assign(attempt,{key:qr.key,content:qr.content,phase:'scan',origin:wechatOrigin,pin:null});
  }

  async checkPairing(attempt) {
    if(Date.now()>attempt.deadline){this.error='微信扫码已超时，请重新开始';this.cancelPairing();return;}
    if(!attempt.key||attempt.phase==='pin')return;
    const pin=attempt.pin;
    attempt.pin=null;
    let answer;
    try{answer=await this.transport.qrStatus(attempt.origin,attempt.key,pin,attempt.controller.signal);}
    catch(error){
      if(this.pairing!==attempt||this.closed)return;
      if(pin)attempt.phase='pin';
      if(error.code!=='timeout')this.error=error.message;
      return;
    }
    if(this.pairing!==attempt||this.closed)return;
    const status=String(answer.status||'wait');
    if(status.includes('need_verifycode')){
      attempt.phase='pin';
      this.error=pin?'请重新核对手机上的校验码':null;
    }else if(status==='scaned'){
      attempt.phase='scanned';this.error=null;
    }else if(status==='scaned_but_redirect'){
      attempt.phase='scanned';
      if(answer.redirect_host)attempt.origin=wechatApiOrigin('https://'+answer.redirect_host);
    }else if(status==='expired'||status==='verify_code_blocked'){
      if(++attempt.refreshes>=3){this.error='微信二维码已失效，请重新开始绑定';this.cancelPairing();return;}
      await this.loadQR(attempt);
    }else if(status==='binded_redirect'){
      this.error='微信返回已有绑定，请从手机微信核对绑定后重试';this.cancelPairing();
    }else if(status==='confirmed')await this.saveBinding(attempt,answer);
  }

  async saveBinding(attempt,answer) {
    if(!validField(answer.ilink_bot_id)||!validField(answer.ilink_user_id)||!validField(answer.bot_token,8192))
      throw new Error('微信未返回完整的本人绑定凭据');
    const previous=this.state.binding();
    const ref='WTT_WECHAT_BOT_'+randomUUID().replaceAll('-','').toUpperCase();
    const key=createHash('sha256').update(JSON.stringify([answer.ilink_bot_id,answer.ilink_user_id])).digest('hex');
    const account={ref,key,owner:answer.ilink_user_id,origin:wechatApiOrigin(answer.baseurl||attempt.origin),parentProjectId:attempt.parentProjectId};
    this.bindingPending=true;
    try {
      await this.provider().set(ref,answer.bot_token);
      if(this.pairing!==attempt||this.closed){await this.provider().unset(ref);return;}
      try{
        this.state.transaction(()=>{
          this.state.bind(account);
          if(!this.state.peer(account.key).project_id)this.state.select(account.key,attempt.projectId,attempt.canvasId);
        });
      }
      catch(error){await this.provider().unset(ref);throw error;}
      this.cancelPairing();this.connection='connecting';this.error=null;
      if(previous)await this.provider().unset(previous.ref);
    }finally{this.bindingPending=false;}
  }

  tick() {
    if(this.closed||!this.state)return;
    try{
      const account=this.state.binding();
      if(!this.pairing&&(!account||account.expired)){
        if(this.owns){this.state.release(this.holder);this.owns=false;}
        return;
      }
      this.owns=this.state.lease(this.holder);
      if(!this.owns){this.connection='elsewhere';return;}
      if(this.pairing&&!this.qrPoll){
        const attempt=this.pairing;
        this.qrPoll=this.checkPairing(attempt).catch(error=>{
          if(this.pairing===attempt){this.error=error.message;this.cancelPairing();}
        }).finally(()=>{this.qrPoll=null;});
      }
      if(!account||!this.active(account))return;
      if(!this.poll&&!this.retryUntilTime())this.poll=this.pollUpdates(account).finally(()=>{this.poll=null;});
      if(!this.work)this.work=this.process(account).finally(()=>{this.work=null;});
      if(!this.delivery)this.delivery=this.flush(account).finally(()=>{this.delivery=null;});
    }catch(error){this.error=error.message;}
  }

  retryUntilTime() {return this.retryAt>Date.now();}

  async pollUpdates(account) {
    const abort=new AbortController();
    this.pollController=abort;
    try{
      const auth=await this.credential(account);
      if(!this.active(account))return;
      const response=await this.transport.updates(auth,this.state.peer(account.key).cursor||'',AbortSignal.any([abort.signal,this.controller.signal]));
      if(!this.active(account))return;
      this.state.accept(account.key,response,inbound(response.msgs,account.owner));
      this.connection='online';
      if(this.receiveError){if(this.error===this.receiveError)this.error=null;this.receiveError=null;}
    }catch(error){
      if(!this.active(account))return;
      if(error.code===-14){
        this.state.bind({...this.state.binding(),expired:true});
        this.connection='expired';this.error='微信授权已过期，请重新扫码';
      }else if(error.code!=='timeout'){
        this.receiveError=error.message;this.error=error.message;this.connection='retrying';this.retryAt=Date.now()+6000;
      }
    }finally{this.pollController=null;}
  }

  async process(account) {
    const db=this.state.db,active=()=>this.active(account);
    try{
      const waiting=db.prepare("SELECT * FROM wx_inbox WHERE account=? AND phase='queued' ORDER BY seq LIMIT 8").all(account.key);
      for(const row of waiting){
        if(!active())return;
        try{await this.dispatch.process(row,account,active);}
        catch(error){if(active())this.state.finish(row,String(error.message).slice(0,1200));}
      }
      const jobs=db.prepare("SELECT * FROM wx_inbox WHERE account=? AND phase IN ('sending','submitted','tracking') ORDER BY seq").all(account.key);
      for(const row of jobs){
        if(!active())return;
        try{await this.dispatch.inspect(row,active);}
        catch(error){if(active())this.error='微信委托 '+row.seq+' 待核对：'+String(error.message).slice(0,260);}
      }
    }catch(error){if(active())this.error=error.message;}
  }

  async flush(account) {
    const db=this.state.db,active=()=>this.active(account);
    try{
      const context=this.state.peer(account.key).token;
      const waiting=db.prepare("SELECT * FROM wx_outbox WHERE account=? AND phase='pending' ORDER BY seq LIMIT 1").get(account.key);
      if(!context||!waiting)return;
      const auth=await this.credential(account);
      if(!active())return;
      const claim=db.prepare("UPDATE wx_outbox SET phase='sending' WHERE seq=? AND phase='pending'").run(waiting.seq);
      if(!claim.changes)return;
      const abort=new AbortController();this.sendController=abort;
      try {
        await this.transport.send(auth,context,waiting.client_id,waiting.text,AbortSignal.any([abort.signal,this.controller.signal]));
        if(active())db.prepare("UPDATE wx_outbox SET phase='sent' WHERE seq=?").run(waiting.seq);
      }catch(error){
        if(active()){
          db.prepare("UPDATE wx_outbox SET phase='failed' WHERE seq=?").run(waiting.seq);
          this.error='微信回执未送达，可在微信问「做好了吗」取回。'+error.message;
        }
      }finally{this.sendController=null;}
    }catch(error){if(active())this.error=error.message;}
  }

  close() {
    if(this.closed)return;
    this.closed=true;
    clearInterval(this.interval);this.cancelPairing();
    this.controller.abort();
    this.state?.release(this.holder);
    this.state?.close();
  }
}
