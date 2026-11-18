import React,{createContext,useContext,useLayoutEffect,useRef} from 'react';

const TOKEN='/项目';
export const ProjectInputContext=createContext(null);

export function projectInputBridge(ctx){
  const owners=new Map();
  const claim=(id,frozen)=>({name:'项目',token:TOKEN+' ',hint:'交给项目总 Agent',attachments:true,
    async submit(text,_actx,attachments){
      const owner=owners.get(id);
      if(!owner&&!frozen)throw Error('请重新打开项目总 Agent 后发送');
      const turn=frozen||await owner.current.freeze(id,text);
      const done=owner?.current.submitting?.();
      try {
        const response=await ctx.remote.session.prompt({sessionId:id,requestId:turn.id,mode:'queue',
          content:[...attachments,{type:'text',text:turn.text}],clientTimeZone:Intl.DateTimeFormat().resolvedOptions().timeZone});
        if(!response.ok || response.value?.accepted!==true)throw Error(response.error?.message||'DSH 未返回受理回执，请核对原对话');
        return {kind:'success'};
      } finally {done?.();}
    }});
  return {owners,claim,begin(id,span){
    const scope=ctx.sessions.binding(id)?.ctx;
    return scope?.bail(scope,'slash/input-begin-command',{claim:claim(id),span});
  },source:{trigger:'/',name:'wtt-project-agent',order:3,showGroupTitle:false,
    async candidates({sessionId},{query}){return owners.has(sessionId)&&'项目'.includes(query)?[{name:'项目',label:'项目总 Agent'}]:[];},
    onPick(){return {text:TOKEN+' ',continue:true};},lexicon:()=>['项目'],
    matchSpace({sessionId},token){if(owners.has(sessionId)&&token===TOKEN)return {claim:claim(sessionId)};},
    async matchClaim({sessionId},token){if(owners.has(sessionId)&&token===TOKEN)return claim(sessionId);},
    async matchEnter({sessionId},line,signal){
      if(!owners.has(sessionId)||!/^\/项目(?:\s|$)/u.test(line))return;
      const frozen=await owners.get(sessionId).current.freeze(sessionId,line.slice(TOKEN.length).trim());
      signal.throwIfAborted();return {claim:claim(sessionId,frozen)};
    }}};
}

export function ProjectInputDock({sessionId,useInput,inputActions,bridge}){
  const owner=useContext(ProjectInputContext),latest=useRef(owner);
  latest.current=owner;
  const draft=useInput(v=>v.draft),phase=useInput(v=>v.phase),draftRev=useInput(v=>v.draftRev);
  useLayoutEffect(()=>{
    if(!owner)return;
    bridge.owners.set(sessionId,latest);
    return ()=>{if(bridge.owners.get(sessionId)===latest)bridge.owners.delete(sessionId);};
  },[sessionId,!!owner]);
  useLayoutEffect(()=>{
    if(!owner||phase!=='plain')return;
    const hasToken=/^\/项目(?:\s|$)/u.test(draft);
    if(!bridge.begin(sessionId,{start:0,end:hasToken?TOKEN.length:0,draftRev})&&!hasToken)
      inputActions.setDraft(TOKEN+' '+draft);
  },[!!owner,phase,draft,draftRev,inputActions,bridge,sessionId]);
  return null;
}
