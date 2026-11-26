import {setTimeout as delay} from 'node:timers/promises';
import {stockDirectory} from './market-history';
import {SyncCheckpoint,type Stock} from './sync-checkpoint';

export function bulkSync(sync:(symbol:string,signal:AbortSignal)=>Promise<unknown>, reusable:()=>Promise<Set<string>>, favorites:()=>string[],checkpoint:SyncCheckpoint) {
  let task:AbortController|undefined;
  const initial=()=>({phase:'idle',total:0,done:0,failed:0,skipped:0,current:'',error:''});
  function restore(){
    const saved=checkpoint.summary();
    if(!saved)return initial();
    const {total,skipped,pending,failed,error}=saved;
    return {phase:pending?'paused':failed?'partial':'complete',total,skipped,done:total-pending,failed,error,current:''};
  }
  let state=restore();
  const status=()=>({...state});

  async function run(controller:AbortController,resume:boolean) {
    const {signal}=controller;
    try {
      let queue:Stock[];
      if(resume){
        queue=checkpoint.remaining().filter(stock=>stock.failure===null);
      }else{
        const directory=await stockDirectory(signal);
        signal.throwIfAborted();
        const current=await reusable();
        signal.throwIfAborted();
        queue=directory.filter(stock=>!current.has(stock.symbol));
        const skipped=directory.length-queue.length;
        checkpoint.begin(queue,skipped);
        state.skipped=skipped;state.done=skipped;state.total=directory.length;
      }
      const rank=new Map(favorites().map((symbol,index)=>[symbol,index]));
      queue.sort((a,b)=>(rank.get(a.symbol)??rank.size)-(rank.get(b.symbol)??rank.size));
      let consecutive=0,nextStart=0,cursor=0;
      const active=new Set<string>();
      async function worker(){
        try{
          while(cursor<queue.length && !signal.aborted){
            const start=Math.max(performance.now(),nextStart);
            nextStart=start+150;
            await delay(Math.max(0,start-performance.now()),undefined,{signal});
            const stock=queue[cursor++];
            if(!stock || signal.aborted)return;
            const label=stock.name+' '+stock.symbol;
            active.add(label);state.current=[...active].join('、');
            try{
              let failure='';
              try{await sync(stock.symbol,signal)}
              catch(error){
                if(signal.aborted)return;
                failure=label+'：'+error.message;
                state.error=failure;
                if(error.status===429 || ++consecutive>=3){
                  checkpoint.message(failure);
                  controller.abort();return;
                }
              }
              if(failure){
                checkpoint.failed(stock.symbol,failure);state.failed++;
              }else{
                // The archive worker has committed. An interrupted request otherwise stays pending.
                checkpoint.finished(stock.symbol);consecutive=0;
              }
              state.done++;
            }finally{
              active.delete(label);state.current=[...active].join('、');
            }
          }
        }catch(error){
          if(!signal.aborted){state.error=error.message;controller.abort()}
        }
      }
      await Promise.all(Array.from({length:Math.min(3,queue.length)},worker));
      state.phase=state.failed?'partial':'complete';
      if(!signal.aborted)checkpoint.message(state.failed?state.error:'');
    }catch(error){
      if(!signal.aborted){state.error=error.message;state.phase=error.status===429?'paused':'error'}
    }finally{
      if(signal.aborted)state.phase='paused';
      checkpoint.release();task=undefined;
    }
  }

  return {status,stop(){task?.abort();return status()},start(){
    if(task)return status();
    checkpoint.acquire();
    try{
      state=restore();
      const resume=state.phase==='paused' || state.phase==='partial';
      if(state.phase==='partial'){
        checkpoint.retryFailed();state.done-=state.failed;state.failed=0;
      }
      if(!resume)state=initial();
      else checkpoint.message('');
      state.error='';state.phase='running';task=new AbortController();
      void run(task,resume);
      return status();
    }catch(error){checkpoint.release();throw error}
  }};
}
