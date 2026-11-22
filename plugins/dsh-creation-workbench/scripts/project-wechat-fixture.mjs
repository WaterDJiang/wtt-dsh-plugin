import { appendFile,readFile,writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const directory=process.env.WTT_WECHAT_FIXTURE_DIR;
if(!directory)throw new Error('微信协议替身缺少隔离目录');
writeFileSync(path.join(directory,'preloaded'),'ready');
const fetch=globalThis.fetch;
let firstPoll=true,qrRequests=0;
globalThis.fetch=async (input,options={})=>{
  const url=new URL(input.url||input);
  if(url.hostname!=='ilinkai.weixin.qq.com')return fetch(input,options);
  const action=url.pathname.split('/').at(-1);
  const request=options.body&&JSON.parse(options.body);
  if(action==='get_bot_qrcode'){
    await writeFile(path.join(directory,'qr-requests'),String(++qrRequests));
    return Response.json({qrcode:'fixture-binding',qrcode_img_content:'https://weixin.qq.com/wtt-qa-qr-'+qrRequests});
  }
  if(action==='get_qrcode_status'){
    const mode=await readFile(path.join(directory,'scan-mode'),'utf8');
    if(mode==='waiting')return Response.json({status:'wait'});
    if(mode==='pin'&&url.searchParams.get('verify_code')!=='246810')return Response.json({status:'need_verifycode'});
    return Response.json({status:'confirmed',bot_token:'wtt-qa-only',ilink_user_id:'wechat-owner',ilink_bot_id:'wechat-bot'});
  }
  if(options.headers?.Authorization!=='Bearer wtt-qa-only')return Response.json({ret:-14});
  if(action==='getupdates'){
    const cursor=Number(request.get_updates_buf)||0;
    if(firstPoll){firstPoll=false;return Response.json({ret:0,msgs:[],get_updates_buf:String(cursor)});}
    while(!options.signal?.aborted){
      const messages=JSON.parse(await readFile(path.join(directory,'inbox.json'),'utf8'));
      if(messages.length>cursor)return Response.json({ret:0,msgs:messages.slice(cursor),get_updates_buf:String(messages.length)});
      await delay(200,undefined,{signal:options.signal});
    }
    options.signal?.throwIfAborted();
  }
  if(action==='sendmessage'){
    const text=request.msg.item_list[0].text_item.text;
    const code=text.includes('已完成')&&request.msg.context_token!=='context-recovery'?-2:0;
    await appendFile(path.join(directory,'sent.jsonl'),JSON.stringify({text,to:request.msg.to_user_id,token:request.msg.context_token,code})+'\n');
    return Response.json({ret:code,message_id:'mock-'+request.msg.client_id});
  }
  return Response.json({ret:404});
};
