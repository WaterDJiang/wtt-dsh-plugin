import {setTimeout as delay} from 'node:timers/promises';
import {stockDirectory} from './market-history';

export function bulkSync(sync:(symbol:string,signal:AbortSignal)=>Promise<unknown>) {
  let task:AbortController|undefined;
  let queue:{symbol:string;name:string}[]=[];
  let failed:{symbol:string;name:string}[]=[];
  let state={phase:'idle',total:0,done:0,failed:0,current:'',error:''};
  const status=()=>({...state});
  async function run(controller:AbortController,resume:boolean) {
    try {
      if(!resume) queue=await stockDirectory(controller.signal);
      if(controller.signal.aborted)return;
      state.total=state.done+queue.length;
      let consecutive=0;
      while(queue.length && !controller.signal.aborted){
        const stock=queue[0]!;
        state.current=stock.name+' '+stock.symbol;
        try {await sync(stock.symbol,controller.signal);consecutive=0}
        catch(e){
          if(controller.signal.aborted)break;
          state.error=state.current+'：'+e.message;
          if(e.status===429 || ++consecutive>=3){state.phase='paused';return}
          failed.push(stock);state.failed++;
        }
        queue.shift();state.done++;
        await delay(300,undefined,{signal:controller.signal});
      }
      if(!controller.signal.aborted)state.phase=failed.length?'partial':'complete';
    } catch(e){if(!controller.signal.aborted){state.error=e.message;state.phase='error'}}
    finally{if(controller.signal.aborted)state.phase='paused';task=undefined}
  }
  return {status,stop(){task?.abort();return status()},start(){
    if(task)return status();
    let resume=state.phase==='paused' && queue.length>0;
    if(state.phase==='partial'){queue=failed;failed=[];state.done-=state.failed;state.failed=0;resume=true}
    if(!resume){queue=[];failed=[];state={phase:'idle',total:0,done:0,failed:0,current:'',error:''}}
    task=new AbortController();state.phase='running';state.error='';
    void run(task,resume);return status();
  }};
}
