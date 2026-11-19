import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';

// Isolated Messages transport. DSH still admits the prompt, executes each tool,
// publishes the session events and persists the exact primary output.
export async function projectAgentModel(fixture){
  const calls=[], evidence=[], skillInvocations=[], followups=[];
  const server=createServer(async(req,res)=>{
    try{
      let raw='';for await(const chunk of req)raw+=chunk;
      const body=JSON.parse(raw),messages=body.messages||[],text=messages.flatMap(m=>typeof m.content==='string'?[m.content]:m.content.filter(b=>b.type==='text').map(b=>b.text)).join('\n');
      const ended=messages.at(-1)?.content?.some?.(b=>b.type==='tool_result');
      if(text.includes('回忆验收')&&ended)evidence.push(JSON.stringify(messages.at(-1).content));
      const turn=text.match(/"turnId":"([\da-f-]+)"/),task=text.match(/taskId=([\da-f-]{36})/),canvas=text.match(/requirementId=([\da-f-]{36})/);
      const skill=text.includes('WTT-SKILL-CONTENT-VERIFIED');
      if(skill)skillInvocations.push(task?'task':'supervisor');
      let name,input;
      if(!ended&&turn){name='workbench_project';input={action:'plan',turnId:turn[1],data:JSON.stringify({title:'浏览器跨画布委托',steps:[{title:'脚本',type:'text',instruction:skill&&text.includes('"skills":["wtt-qa-layout"]')?'/wtt-qa-layout 写验收脚本':'写验收脚本',requirementId:fixture.other},{title:'分镜',type:'text',instruction:'从脚本写分镜',requirementId:fixture.other,useSelection:false,dependsOn:[1]}]})};}
      if(!ended&&task&&canvas){name='course_save_outline';input={requirementId:canvas[1],taskId:task[1],primary:true,markdown:'# '+(text.includes('从脚本写分镜')?'验收分镜':'验收脚本'),operationId:randomUUID()};}
      if(!ended&&turn&&text.includes('回忆验收')){name='workbench_project';input={action:'context',turnId:turn[1],data:'{"query":"脚本"}'};}
      const gate=process.env.WTT_AGENT_SMOKE_QUESTION==='1'&&task&&canvas&&text.includes('写验收脚本');
      if(gate&&!ended&&!calls.some(c=>c.name==='ask_user_question'&&c.id===task[1])){
        name='ask_user_question';input={questions:[{id:'wtt-review',question:'验收脚本是否采用采访原文？',options:[{label:'采用采访原文'},{label:'调整脚本'}]}]};
      } else if(gate&&ended&&calls.some(c=>c.name==='ask_user_question'&&c.id===task[1])&&!calls.some(c=>c.name==='course_save_outline'&&c.id===task[1])){
        name='course_save_outline';input={requirementId:canvas[1],taskId:task[1],primary:true,markdown:'# 验收脚本',operationId:randomUUID()};
      }
      if(process.env.WTT_AGENT_SMOKE_NATIVE_FOLLOWUP==='1'&&task&&text.includes('验收手动补充')){
        followups.push(task[1]);name=null;
      }
      const available=(body.tools||[]).map(t=>t.name);
      if(!available.includes(name)&&!available.includes('run_code'))name=null;
      if(name){calls.push({name,id:input.taskId||input.turnId||task?.[1]});if(!available.includes(name)&&available.includes('run_code')){input={description:'工作台验收',code:'return await tools.'+name+'('+JSON.stringify(input)+')'};name='run_code';}}
      const id='msg_'+randomUUID(),model=body.model;
      const block=name?{type:'tool_use',id:'tool_'+randomUUID(),name,input}:{type:'text',text:'已核对工作台回执。'};
      const usage={input_tokens:80,output_tokens:30};
      if(!body.stream){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({id,type:'message',role:'assistant',model,content:[block],stop_reason:name?'tool_use':'end_turn',usage}));return;}
      res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
      const emit=(type,data)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,...data})+'\n\n');
      emit('message_start',{message:{id,type:'message',role:'assistant',model,content:[],stop_reason:null,usage}});
      emit('content_block_start',{index:0,content_block:name?{...block,input:{}}:{type:'text',text:''}});
      emit('content_block_delta',{index:0,delta:name?{type:'input_json_delta',partial_json:JSON.stringify(input)}:{type:'text_delta',text:block.text}});
      emit('content_block_stop',{index:0});emit('message_delta',{delta:{stop_reason:name?'tool_use':'end_turn',stop_sequence:null},usage});emit('message_stop',{});res.end();
    }catch(e){console.error('合成模型请求',e.message);res.writeHead(500);res.end();}
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  return {calls,evidence,skillInvocations,followups,env:{DEEPSEEK_API_KEY:'sk-'+'0'.repeat(32),DEEPSEEK_BASE_URL:'http://127.0.0.1:'+server.address().port},close:()=>server.close()};
}
