import { randomBytes } from 'node:crypto';

export const wechatOrigin = 'https://ilinkai.weixin.qq.com';
// Tencent's documented cross-host format puts the iLink client version first.
const protocolVersion = '3.0.0/WTT';
const clientVersion = '196608';
const botPath = '/ilink/bot/';

export function wechatApiOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.weixin.qq.com') || url.port ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('微信接口返回了无法使用的服务地址');
  return url.origin;
}

export class WeChatTransportError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export function createWeChatTransport(request = globalThis.fetch) {
  async function call(origin, action, { query, body, token, signal, timeout = 12000 } = {}) {
    const url = new URL(botPath + action, wechatApiOrigin(origin));
    if (query) url.search = new URLSearchParams(query);
    const headers = {'iLink-App-Id':'bot','iLink-App-ClientVersion':clientVersion};
    if (body) {
      headers['Content-Type'] = 'application/json';
      headers.AuthorizationType = 'ilink_bot_token';
      headers['X-WECHAT-UIN'] = Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64');
    }
    if (token) headers.Authorization = 'Bearer ' + token;
    const deadline = AbortSignal.timeout(timeout);
    const cancellation = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      const reply = await request(url, {method:body?'POST':'GET',headers,redirect:'error',
        signal:cancellation,...(body?{body:JSON.stringify(body)}:{})});
      if (!reply.ok) throw new WeChatTransportError('微信接口 HTTP '+reply.status,reply.status);
      const result = JSON.parse(await reply.text(),(key,value,source)=>
        key==='message_id'&&typeof value==='number' ? source.source : value);
      if (!result || typeof result!=='object' || Array.isArray(result)) throw new Error('Invalid iLink response');
      const code=[result.errcode,result.ret].find(value=>Number.isSafeInteger(value)&&value!==0);
      if (code!==undefined) throw new WeChatTransportError('微信接口返回 '+code,code);
      return result;
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof WeChatTransportError) throw error;
      if (deadline.aborted) throw new WeChatTransportError('微信连接超时','timeout');
      throw new WeChatTransportError('微信接口连接失败','network');
    }
  }

  const authenticated = (account,action,body,signal,timeout) => call(account.origin,action,{token:account.token,
    body:{...body,base_info:{channel_version:protocolVersion,bot_agent:'WTT'}},signal,timeout});

  return {
    async qr(signal) {
      const result=await call(wechatOrigin,'get_bot_qrcode',{query:{bot_type:'3'},body:{local_token_list:[]},signal});
      if (typeof result.qrcode!=='string'||!result.qrcode||result.qrcode.length>4096||
          typeof result.qrcode_img_content!=='string'||!result.qrcode_img_content||result.qrcode_img_content.length>1600)
        throw new Error('微信接口未返回可用的绑定二维码');
      return {key:result.qrcode,content:result.qrcode_img_content};
    },
    qrStatus(origin,key,pin,signal) {
      return call(origin,'get_qrcode_status',{query:{qrcode:key,...(pin?{verify_code:pin}:{})},signal,timeout:38000});
    },
    updates(account,cursor,signal) {
      return authenticated(account,'getupdates',{get_updates_buf:cursor},signal,42000);
    },
    send(account,contextToken,id,text,signal) {
      if (!contextToken) throw new WeChatTransportError('等待同一微信会话的新消息','missing-context');
      return authenticated(account,'sendmessage',{msg:{from_user_id:'',to_user_id:account.owner,
        client_id:id,message_type:2,message_state:2,context_token:contextToken,item_list:[{type:1,text_item:{text}}]}},signal,12000);
    },
  };
}
