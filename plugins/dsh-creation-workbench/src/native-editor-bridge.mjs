export const EDIT_COMMAND='课件修改';
export const EDIT_TOKEN=`/${EDIT_COMMAND}`;
const matches=line=>line===EDIT_TOKEN||line.startsWith(EDIT_TOKEN+' ')||line.startsWith(EDIT_TOKEN+'\n');
/** Uses the public input-trigger contract; never replaces the native send service. */
export function createNativeEditorBridge(){
  const entries=new Map(),listeners=new Set();let version=0;
  const changed=()=>{version++;for(const fn of listeners)fn()};
  const resolve=sessionId=>{const entry=entries.get(sessionId);if(!entry)throw new Error('请先从课件卡打开编辑页，输入内容已保留');return entry};
  const claim=(sessionId,frozen)=>({name:EDIT_COMMAND,token:EDIT_TOKEN+' ',hint:'修改右侧选中的课件内容',attachments:true,async submit(args,_ctx,attachments){const entry=resolve(sessionId),owner=entry.get();if(!owner.ready)throw new Error('课件资料尚未就绪，请稍后发送');await owner.submit(args,attachments,frozen||await owner.prepare(),sessionId);return {kind:'success'}}});
  return {getVersion:()=>version,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},get:sessionId=>entries.get(sessionId),
    register(sessionId,get){if(entries.has(sessionId))throw new Error('该课件对话已在另一个编辑器中打开');const entry={get,mode:Boolean(get().autoCommand),signature:'',autoCommand:Boolean(get().autoCommand)};entries.set(sessionId,entry);changed();return()=>{if(entries.get(sessionId)===entry){entries.delete(sessionId);changed()}}},
    update(sessionId,signature){const entry=entries.get(sessionId);if(entry&&entry.signature!==signature){entry.signature=signature;const auto=Boolean(entry.get().autoCommand);if(auto!==entry.autoCommand)entry.mode=auto;entry.autoCommand=auto;changed()}},
    setMode(sessionId,mode){const entry=resolve(sessionId);entry.mode=mode;changed()},
    source:{trigger:'/',name:'wtt-course-native-editor',order:5,showGroupTitle:false,
      async candidates({sessionId},{query}){return entries.has(sessionId)&&EDIT_COMMAND.includes(query)?[{name:EDIT_COMMAND,label:'修改选中课件',description:entries.get(sessionId).get().label}]:[]},
      onPick(){return {text:EDIT_TOKEN+' ',continue:true}},lexicon:()=>[EDIT_COMMAND],
      async matchEnter({sessionId},line,signal){if(!matches(line))return;const entry=resolve(sessionId),owner=entry.get();if(!owner.ready)throw new Error('课件资料尚未就绪');if(!line.slice(EDIT_TOKEN.length).trim())throw new Error('请在课件修改命令后输入要求');const frozen=await owner.prepare();signal.throwIfAborted();return {claim:claim(sessionId,frozen)}},
      async matchClaim({sessionId},token){if(token===EDIT_TOKEN){resolve(sessionId);return claim(sessionId)}},
    },
  };
}
