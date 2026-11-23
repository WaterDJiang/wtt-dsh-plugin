import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

// Isolated Messages transport. DSH still admits the prompt, executes each tool,
// publishes the session events and persists the exact primary output.
export async function projectAgentModel(fixture){
  const calls=[], evidence=[], skillInvocations=[], followups=[], newContexts=[];
  const reviews=[],routes=[],defaultProbes=[];
  const firstReview=Promise.withResolvers();
  const loop=process.env.WTT_AGENT_SMOKE_LOOP==='1';
  const server=createServer(async(req,res)=>{
    try{
      let raw='';for await(const chunk of req)raw+=chunk;
      const body=JSON.parse(raw),messages=body.messages||[],text=messages.flatMap(m=>typeof m.content==='string'?[m.content]:m.content.filter(b=>b.type==='text').map(b=>b.text)).join('\n');
      const ended=messages.at(-1)?.content?.some?.(b=>b.type==='tool_result');
      if(text.includes('回忆验收')&&ended)evidence.push(JSON.stringify(messages.at(-1).content));
      const turn=text.match(/"turnId":"([\da-f-]+)"/),task=text.match(/taskId=([\da-f-]{36})/),canvas=text.match(/requirementId=([\da-f-]{36})/);
      if(!ended&&turn&&text.includes('回忆验收')){
        const snapshot=text.match(/\[工作台发送现场\] (\{[^\n]+\})/u);
        if(snapshot)newContexts.push({snapshot:JSON.parse(snapshot[1]),oldMessages:text.includes('从采访写脚本和分镜')});
      }
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
      if(fixture.wechat){
        name=null;
        const latest=messages.at(-1)?.content;
        const content=typeof latest==='string'?latest:latest?.filter?.(item=>item.type==='text').map(item=>item.text).join('\n')||'';
        const turnId=text.match(/"turnId":"([\da-f-]+)"/g)?.at(-1)?.match(/[\da-f-]{36}/)?.[0];
        if(!ended&&turnId&&content.includes('微信生成采访稿')){
          name='workbench_project';
          input={action:'plan',turnId,data:JSON.stringify({title:'微信验收委托',steps:[{title:'微信采访稿',type:'text',instruction:'生成稿件'}]})};
        }
        if(!ended&&task&&canvas){
          name='course_save_outline';
          input={requirementId:canvas[1],taskId:task[1],primary:true,markdown:'# 微信验收采访稿',operationId:randomUUID()};
        }
      }
      if(loop){
        const review=text.match(/\[工作台成果验收\] (\{[^\n]+\})/gu)?.at(-1);
        name=null;
        if(turn&&!review&&!task&&!ended){
          name='workbench_project';input={action:'context',turnId:turn[1]};
        }
        if(turn&&!review&&!task&&ended&&!calls.some(call=>call.action==='plan')){
          const contextText=JSON.stringify(messages.at(-1).content);
          const options=['deepseek-flash','deepseek-v4-flash'].find(model=>contextText.includes(model));
          if(!options||!contextText.includes('deepseek-v4-pro')||!contextText.includes('codex'))
            throw Error('没有发现验收配置的模型和 Codex 路线：'+contextText.slice(0,2200));
          routes.push({default:body.model,flash:options,pro:'deepseek-v4-pro'});
          const criteria={criteria:['脚本包含评分标准','配套表为独立正式成果'],minCards:2};
          name='workbench_project';input={action:'plan',turnId:turn[1],data:JSON.stringify({title:'成果验收委托',steps:[
            {title:'脚本与配套表',type:'text',instruction:'编写验收脚本和配套表',requirementId:fixture.other,acceptance:criteria,
              modelSelection:{provider:'deepseek-official',model:options}},
            {title:'本地 CLI 核验',type:'text',instruction:'基于通过验收的两张卡交付核验报告',requirementId:fixture.id,
              useSelection:false,dependsOn:[1],executor:'codex'},
            {title:'归档摘要',type:'text',instruction:'根据报告编写归档摘要',requirementId:fixture.other,
              useSelection:false,dependsOn:[2],modelSelection:{provider:'deepseek-official',model:'deepseek-v4-pro'}},
          ]})};
        }
        if(review&&!ended){
          const details=JSON.parse(review.slice(review.indexOf('{')));
          if(!reviews.some(item=>item.reviewId===details.reviewId)){
            reviews.push({...details,model:body.model});
            const original=details.artifacts[0];
            if(reviews.length===1)await firstReview.promise;
            name='workbench_project_review';
            input=original.excerpt.includes('评分标准')
              ?{reviewId:details.reviewId,decision:'accept',reason:'V2 已加评分标准，配套表仍为 V1'}
              :{reviewId:details.reviewId,decision:'revise',reason:'脚本未包含评分标准，保留表格',
                data:JSON.stringify({cardId:original.cardId,versionId:original.versionId,instruction:'补写评分标准'})};
          }
        }
        if(task&&canvas&&!ended){
          const draft=text.includes('编写验收脚本和配套表');
          const revision=draft&&text.includes('本次修订要求：补写评分标准');
          const directory='courses/'+canvas[1]+'/tasks/'+task[1]+'/delivery';
          const output=draft?[['评分快速脚本',revision?'# 评分快速脚本\n\n评分标准：总分 10。':'# 评分快速脚本\n\n待填正文。'],
            ...revision?[]:[['配套表','# 配套表\n\n项目与备注。']]]:[['归档摘要','# 归档摘要\n\n已核对报告。']];
          const files=[];
          for(const [index,[title,content]] of output.entries()){
            const relative=directory+'/file-'+index+'.md';
            await writeFile(path.join(fixture.workspace,relative),content);
            files.push({kind:'text',title,path:relative,operationId:randomUUID(),...(index===0?{primary:true}:{})});
          }
          name='course_register_artifacts';input={taskId:task[1],files};
        }
        if(turn&&text.includes('默认模型探针')){
          defaultProbes.push(body.model);
          name=null;
        }
      }
      const available=(body.tools||[]).map(t=>t.name);
      if(!available.includes(name)&&!available.includes('run_code'))name=null;
      if(name){
        const effort=body.thinking?.type==='disabled'?'off':body.output_config?.effort;
        calls.push({name,id:input.taskId||input.turnId||input.reviewId||task?.[1],action:input.action||input.decision,model:body.model,effort});
        if(!available.includes(name)&&available.includes('run_code')){input={description:'工作台验收',code:'return await tools.'+name+'('+JSON.stringify(input)+')'};name='run_code';}
      }
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
  return {calls,evidence,skillInvocations,followups,newContexts,reviews,routes,defaultProbes,releaseReview:firstReview.resolve,
    env:{DEEPSEEK_API_KEY:'sk-'+'0'.repeat(32),DEEPSEEK_BASE_URL:'http://127.0.0.1:'+server.address().port},
    close:()=>{firstReview.resolve();server.close();server.closeAllConnections();}};
}
