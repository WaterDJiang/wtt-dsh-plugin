import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import qrcode from 'qrcode-generator';
import { DialogBody, DialogFooter, DialogHeader, UiButton } from './ui/controls.jsx';
import { UserError } from './user-feedback.jsx';

const labels={unbound:'微信未连接',preparing:'正在获取二维码…',scan:'用微信扫一扫',scanned:'请在手机微信上确认',
  pin:'微信需要验证',connecting:'微信已绑定',online:'微信已连接',expired:'微信授权已过期',
  retrying:'正在重连微信…',elsewhere:'微信已在另一个 DSH 实例运行'};

function qrImage(text) {
  if(!text)return null;
  const code=qrcode(0,'M');
  code.addData(text);
  code.make();
  return code.createDataURL(4,16);
}

export function ProjectWeChatDialog({ projectId, canvasId, request, onClose }) {
  const titleId=useId(),dialog=useRef(null),busyRef=useRef(false),epoch=useRef(0);
  const openingCanvas=useRef(canvasId);
  const [state,setState]=useState(null),[parent,setParent]=useState('');
  const [pin,setPin]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{
    dialog.current?.showModal();
    const controller=new AbortController();
    let ready=false;
    async function read(action,data={}){
      if(busyRef.current)return;
      const version=epoch.current;
      try{
        const result=await request('project-wechat-'+action,data,projectId,undefined,controller.signal);
        if(!controller.signal.aborted&&version===epoch.current){
          setState(result);setParent(current=>current||result.parentProjectId||'');
        }
      }catch(cause){if(!controller.signal.aborted&&version===epoch.current)setError(cause.message);}
    }
    void read('connect',{canvasId:openingCanvas.current}).finally(()=>{ready=true;});
    const timer=setInterval(()=>{if(ready)void read('status');},1300);
    return ()=>{epoch.current++;clearInterval(timer);controller.abort();};
  },[projectId,request]);

  const qr=useMemo(()=>{
    if(state?.phase!=='scan')return {};
    try{return {image:qrImage(state.qr)};}catch{return {error:'二维码内容无法显示，请重新获取'};}
  },[state?.phase,state?.qr]);

  async function change(action,data) {
    if(busyRef.current)return;
    busyRef.current=true;setBusy(true);setError('');
    const version=++epoch.current;
    try{
      const result=await request('project-wechat-'+action,data,projectId);
      if(version===epoch.current){setState(result);setParent(result.parentProjectId||'');}
    }catch(cause){if(version===epoch.current)setError(cause.message);}
    finally{
      if(version===epoch.current){setBusy(false);setPin('');}
      busyRef.current=false;
    }
  }

  const phase=state?.phase;
  const pairing=['preparing','scan','scanned','pin'].includes(phase);
  const selected=state?.projects.find(item=>item.id===parent);
  const canPair=phase==='unbound'||phase==='expired'||Boolean(qr.error)||(!state&&Boolean(error));
  const canSave=state?.bound&&!pairing&&parent&&parent!==state.parentProjectId;
  const visibleError=error||qr.error||state?.error;
  return <dialog ref={dialog} className="wtt-dialog wtt-wechat-dialog" aria-labelledby={titleId} onCancel={event=>{
    event.preventDefault();onClose();
  }}>
    <form onSubmit={event=>{event.preventDefault();if(phase==='pin'&&pin)void change('pin',{pairingId:state.pairingId,pin});}}>
      <DialogHeader title="微信项目助手" titleId={titleId} onClose={onClose}/>
      <DialogBody>
        <p className={phase==='scan'?'wtt-wechat-scan':undefined} role="status">
          {labels[phase]||(error?'无法获取二维码':'正在获取二维码…')}
        </p>
        {qr.image&&<img className="wtt-wechat-qr" src={qr.image} alt="微信扫码绑定二维码"/>}
        {phase==='pin'&&<label className="wtt-field"><span>手机微信校验码</span>
          <input autoFocus type="password" inputMode="numeric" autoComplete="one-time-code" maxLength={10} value={pin}
            onChange={event=>setPin(event.target.value.replace(/[^0-9]/g,''))} disabled={busy}/>
        </label>}
        {(phase==='connecting'||phase==='online')&&<p className="wtt-muted">在微信里打开 ClawBot，说一句「你好」。</p>}
        {visibleError&&<UserError error={visibleError}/>}
        {state?.bound&&!pairing&&<details className="wtt-wechat-settings">
          <summary>连接设置</summary>
          <label className="wtt-field"><span>微信新建项目的存放目录</span>
            <select className="wtt-select" value={parent} disabled={busy} onChange={event=>setParent(event.target.value)}>
              {state.projects.map(project=><option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
            {selected&&<small className="wtt-muted wtt-wechat-path" title={selected.path}>{selected.path}</small>}
          </label>
          <div className="wtt-wechat-actions">
            <UiButton disabled={busy} onClick={()=>void change('disconnect',{})}>断开微信</UiButton>
            {canSave&&<UiButton variant="primary" disabled={busy} onClick={()=>void change('parent',{parentProjectId:parent})}>保存目录</UiButton>}
          </div>
        </details>}
      </DialogBody>
      {(canPair||phase==='pin')&&<DialogFooter>
        {canPair&&<UiButton variant="primary" disabled={busy} onClick={()=>void change('pair',{canvasId:openingCanvas.current,refresh:Boolean(qr.error)})}>{busy?'正在获取…':'获取二维码'}</UiButton>}
        {phase==='pin'&&<UiButton type="submit" variant="primary" disabled={busy||!pin}>提交校验码</UiButton>}
      </DialogFooter>}
    </form>
  </dialog>;
}
