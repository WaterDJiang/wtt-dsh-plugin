import {setTimeout as delay} from 'node:timers/promises';
import {stockDirectory} from './market-history';

type Stock = {symbol:string;name:string};

export function bulkSync(sync:(symbol:string,signal:AbortSignal)=>Promise<unknown>, reusable:()=>Set<string>) {
  let task:AbortController|undefined;
  let queue:Stock[]=[];
  let failed:Stock[]=[];
  const initial=()=>({phase:'idle',total:0,done:0,failed:0,skipped:0,current:'',error:''});
  let state=initial();
  const status=()=>({...state});

  async function run(controller:AbortController,resume:boolean) {
    const {signal}=controller;
    try {
      if(!resume){
        const directory=await stockDirectory(signal);
        signal.throwIfAborted();
        const current=reusable();
        queue=directory.filter(stock=>!current.has(stock.symbol));
        state.skipped=directory.length-queue.length;
        state.done=state.skipped;
      }
      state.total=state.done+queue.length;
      let consecutive=0, nextStart=0;
      const active=new Set<string>();
      async function worker(){
        while(queue.length && !signal.aborted){
          // Share a launch cadence across all workers; fast replies cannot flood the provider.
          const start=Math.max(performance.now(),nextStart);
          nextStart=start+150;
          await delay(Math.max(0,start-performance.now()),undefined,{signal}).catch(()=>{});
          if(signal.aborted)return;
          const stock=queue.shift();
          if(!stock)return;
          const label=stock.name+' '+stock.symbol;
          active.add(label);
          state.current=[...active].join('、');
          try {
            await sync(stock.symbol,signal);
            consecutive=0;
          } catch(e){
            if(signal.aborted){queue.push(stock);return}
            state.error=label+'：'+e.message;
            if(e.status===429 || ++consecutive>=3){
              queue.unshift(stock);
              controller.abort();
              return;
            }
            failed.push(stock);
            state.failed++;
          } finally {
            active.delete(label);
            state.current=[...active].join('、');
          }
          state.done++;
        }
      }
      await Promise.all(Array.from({length:Math.min(3,queue.length)},worker));
      state.phase=failed.length?'partial':'complete';
    } catch(e){
      if(!signal.aborted){state.error=e.message;state.phase=e.status===429?'paused':'error'}
    } finally {
      if(signal.aborted)state.phase='paused';
      task=undefined;
    }
  }
  return {status,stop(){task?.abort();return status()},start(){
    if(task)return status();
    let resume=state.phase==='paused' && queue.length>0;
    if(state.phase==='partial'){queue=failed;failed=[];state.done-=state.failed;state.failed=0;resume=true}
    if(!resume){queue=[];failed=[];state=initial()}
    state.error='';
    task=new AbortController();state.phase='running';
    void run(task,resume);return status();
  }};
}
