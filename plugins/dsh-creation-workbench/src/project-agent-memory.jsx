import React,{useEffect,useRef,useState} from 'react';
import {UiButton} from './ui/controls.jsx';

const blank={name:'',scope:'项目',body:'',revision:null};
export function ProjectMemoryPanel({call,suggestions,onChanged,onLocate}){
  const [query,setQuery]=useState(''),[data,setData]=useState(null),[draft,setDraft]=useState(null),[conflict,setConflict]=useState(null),[error,setError]=useState(''),[revision,refresh]=useState(0),[saving,setSaving]=useState(false);
  const latest=useRef(0);
  useEffect(()=>{
    let live=true; const id=++latest.current;
    const t=setTimeout(()=>{call('memory',{query}).then(r=>{if(live&&id===latest.current){setData(r);setError('');}}).catch(e=>{if(live)setError(e.message);});},query?170:0);
    return ()=>{live=false;clearTimeout(t);};
  },[query,revision,call]);
  function edit(item){
    setDraft({...blank,...item,baseBody:item.body||''});setConflict(null);setError('');
  }
  async function save(remove=false){
    setSaving(true);
    try{
      const r=draft.binding?await call('bind-document',draft):await call('save',{name:draft.name,scope:draft.scope,body:remove?'':draft.body,baseRevision:draft.revision,suggestionId:draft.suggestionId});
      if(r.conflict){setConflict(r.current);return;}
      setDraft(null);setConflict(null);refresh(v=>v+1);onChanged();
    }catch(e){setError(e.message);}finally{setSaving(false);}
  }
  if(draft)return <div className="wtt-agent-memory">
    <label>设定名称<input value={draft.name} disabled={!!draft.id} maxLength={80} onChange={e=>setDraft({...draft,name:e.target.value})}/></label>
    <label>适用范围<input value={draft.scope} disabled={!!draft.id} maxLength={120} onChange={e=>setDraft({...draft,scope:e.target.value})}/></label>
    {draft.relative&&<small>原文 · {draft.document||'.wtt-workbench/memory/'+draft.relative}</small>}
    {draft.binding?<label>项目内 Markdown 路径<input placeholder="资料/画幅.md" value={draft.document||''} onChange={e=>setDraft({...draft,document:e.target.value})}/></label>:<label>设定原文<textarea autoFocus value={draft.body} maxLength={4000} rows={6} onChange={e=>setDraft({...draft,body:e.target.value})}/></label>}
    {conflict&&<div role="alert"><strong>原文已被修改</strong><details><summary>打开编辑时的原文</summary><pre>{draft.baseBody}</pre></details><pre>{conflict.body||'原文已移除'}</pre>
      <UiButton onClick={()=>edit(conflict)}>载入当前原文</UiButton><UiButton onClick={()=>{setDraft({...draft,revision:conflict.revision,baseBody:conflict.body});setConflict(null);}}>保留草稿继续编辑</UiButton></div>}
    {error&&<p role="alert">{error}</p>}
    <div><UiButton disabled={saving||!!conflict||!draft.name.trim()||!(draft.binding?draft.document?.trim():draft.body.trim())} onClick={()=>save()}>{draft.binding?'绑定原文':'保存设定'}</UiButton>
    {(draft.revision||draft.id)&&<UiButton disabled={saving||!!conflict} onClick={()=>save(true)}>撤销设定</UiButton>}
    <UiButton disabled={saving} onClick={()=>setDraft(null)}>取消</UiButton></div>
  </div>;
  return <div className="wtt-agent-memory">
    {error&&<p role="alert">{error}</p>}
    <div className="wtt-agent-section"><strong>现行设定</strong><UiButton size="compact" onClick={()=>edit(blank)}>新增设定</UiButton><UiButton size="compact" onClick={()=>edit({...blank,binding:true})}>绑定原文</UiButton></div>
    {data?.settings.map(item=><UiButton key={item.id} onClick={()=>edit(item)}>{item.name} · {item.scope}</UiButton>)}
    {suggestions?.map(s=><div key={s.id}><strong>{s.name}</strong><pre>{s.body}</pre><UiButton onClick={()=>edit({...data?.settings.find(x=>x.name===s.name&&x.scope===s.scope),...s,id:data?.settings.find(x=>x.name===s.name&&x.scope===s.scope)?.id,suggestionId:s.id})}>审阅设定</UiButton>
    <UiButton onClick={()=>call('dismiss',{id:s.id}).then(onChanged).catch(e=>setError(e.message))}>忽略</UiButton></div>)}
    <label>查项目日志<input type="search" value={query} placeholder="关键词、卡片或版本" onChange={e=>setQuery(e.target.value)}/></label>
    {data&&!data.hits.length&&<p>暂无匹配日志</p>}
    {data?.hits.map(h=><details key={h.id}><summary>{h.day} · {h.title}</summary><pre>{h.body}</pre><small>{h.relative}</small>
      {h.evidence.cardId&&h.evidence.versionId&&<UiButton onClick={()=>onLocate(h.evidence)}>定位成果</UiButton>}</details>)}
    <UiButton size="compact" onClick={()=>call('memory',{query,rebuild:true}).then(setData).catch(e=>setError(e.message))}>重建记忆索引</UiButton>
  </div>;
}
