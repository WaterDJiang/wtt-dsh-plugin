import {marketSnapshotId, parseMarketSnapshotV1, type MarketField, type MarketBar} from './contracts';

async function json(url: URL, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(15000);
  const res = await fetch(url, {redirect:'error',signal:signal ? AbortSignal.any([signal,timeout]) : timeout});
  if (!res.ok) throw Object.assign(Error('历史数据源 HTTP '+res.status),{status:res.status});
  return res.json();
}

export async function stockDirectory(signal?: AbortSignal) {
  const raw = await json(new URL('https://www.cninfo.com.cn/new/data/szse_stock.json'), signal);
  if (!Array.isArray(raw.stockList)) throw Error('未取得全市场证券目录');
  const stocks = new Map<string,string>();
  for (const row of raw.stockList) {
    if (row.category !== 'A股' || !/^\d{6}$/.test(row.code) || !row.zwjc) continue;
    const market = /^6/.test(row.code) ? 'sh' : /^[03]/.test(row.code) ? 'sz' : /^[489]/.test(row.code) ? 'bj' : '';
    if (market) stocks.set(market+row.code, row.zwjc);
  }
  if (!stocks.size) throw Error('全市场证券目录为空');
  return [...stocks].map(([symbol,name])=>({symbol,name}));
}

const fields: MarketField[] = ['open','high','low','close','volume','amount','turnoverRate'];
const numeric = (value: unknown) => value === '' || value == null || !Number.isFinite(Number(value)) ? null : Number(value);

type Prior = ReturnType<typeof parseMarketSnapshotV1> | undefined;

function finishHistory(symbol:string,adjust:string,name:string,bars:MarketBar[],prior:Prior){
  const old=new Map(prior?.bars.map(b=>[b.date,b]));
  if(bars.some(b=>[b.open,b.high,b.low,b.close].some(x=>x===null)))throw Error('历史日线价格不完整');
  if(prior && prior.asOf>bars.at(-1)!.date)throw Error('历史源落后于本机行情');
  if(prior && prior.bars[0]!.date<bars[0]!.date){
    const overlap=bars.filter(b=>old.has(b.date));
    if(!overlap.length || overlap.some(b=>Math.abs(b.close!-old.get(b.date)!.close!)>0.011))throw Error('复权基准无法衔接，已保留原归档');
    bars=[...prior.bars.filter(b=>b.date<bars[0]!.date),...bars].slice(-2000);
  }
  const data={schemaVersion:1,dataSemanticVersion:'market-bars-v1',adjust,period:'daily',basePeriod:'daily',fields,symbol,market:symbol.slice(0,2),code:symbol.slice(2),name,asOf:bars.at(-1)!.date,fetchedAt:new Date().toISOString(),bars,quality:{status:'valid',missingFields:fields.filter(f=>bars.some(b=>b[f]===null))}} as const;
  return parseMarketSnapshotV1({...data,snapshotId:marketSnapshotId(data)});
}

async function eastmoneyWindow(symbol:string,prior:Prior,signal?:AbortSignal){
  const market=symbol.startsWith('sh')?1:0;
  const code=symbol.slice(2);
  const url=new URL('https://push2his.eastmoney.com/api/qt/stock/kline/get');
  url.search=new URLSearchParams({secid:market+'.'+code,klt:'101',fqt:'1',end:'20500101',lmt:'640',
    fields1:'f1,f2,f3,f4,f5,f6',fields2:'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61'}).toString();
  const {data}=await json(url,signal);
  if(data?.code!==code || data.market!==market || !data.name || !Array.isArray(data.klines) || !data.klines.length)
    throw Error('备用历史源未返回该证券');
  const old=new Map(prior?.bars.map(b=>[b.date,b]));
  const bars=data.klines.map((line:string)=>{
    const [date,open,close,high,low,volume,amount,,,,turnoverRate]=line.split(',');
    return {date,open:numeric(open),high:numeric(high),low:numeric(low),close:numeric(close),
      volume:numeric(volume),amount:numeric(amount)??old.get(date)?.amount??null,
      turnoverRate:numeric(turnoverRate)??old.get(date)?.turnoverRate??null};
  });
  return finishHistory(symbol,'qfq',data.name,bars,prior);
}

async function tencentWindow(symbol:string, adjust:string, prior:ReturnType<typeof parseMarketSnapshotV1>|undefined, signal?:AbortSignal) {
  async function history(endpoint:string){
    const url=new URL('https://web.ifzq.gtimg.cn/appstock/app/'+endpoint+'/get');
    url.searchParams.set('param',[symbol,'day','','','640',adjust].join(','));
    const stock=(await json(url,signal)).data?.[symbol];
    const quote=stock?.qt?.[symbol],rows=stock?.[adjust+'day'];
    if(!Array.isArray(rows)||!rows.length||quote?.[2]!==symbol.slice(2))throw Error('历史源未返回该股票日线');
    return {quote,rows};
  }
  const {quote,rows}=await history('newfqkline').catch(error=>{
    if(signal?.aborted||error.status===429)throw error;
    return history('fqkline');
  });
  const aux = new URL('https://q.stock.sohu.com/hisHq');
  aux.search = new URLSearchParams({code:'cn_'+symbol.slice(2),start:String(rows[0][0]).replaceAll('-',''),end:String(rows.at(-1)[0]).replaceAll('-',''),stat:'0',order:'A',period:'d',rt:'json'}).toString();
  const supplemental = await json(aux,signal).catch(error=>{
    if(signal?.aborted || error.status===429)throw error;
    return [];
  });
  const byDate = new Map<string,unknown[]>();
  if (supplemental[0]?.code==='cn_'+symbol.slice(2)) for(const row of supplemental[0].hq??[]) byDate.set(row[0],row);
  const old = new Map(prior?.bars.map(b=>[b.date,b]));
  const bars:MarketBar[] = rows.map((row:unknown[])=>{
    const [date,open,close,high,low,volume]=row;
    const lots=numeric(volume), previous=old.get(String(date)), extra=byDate.get(String(date));
    const amount=numeric(extra?.[8]),turnover=numeric(String(extra?.[9]??'').replace('%',''));
    return {date:String(date),open:numeric(open),high:numeric(high),low:numeric(low),close:numeric(close),volume:lots,amount:amount===null?previous?.amount??null:amount*10000,turnoverRate:turnover??previous?.turnoverRate??null};
  });
  return finishHistory(symbol,adjust,quote[1],bars,prior);
}

export async function historicalWindow(symbol:string,adjust:string,prior:Prior,signal?:AbortSignal){
  let errorMessage='';
  if(adjust==='qfq' && /^(sz|sh)/.test(symbol)){
    try {return await eastmoneyWindow(symbol,prior,signal)}
    catch(error){if(signal?.aborted || error.status===429)throw error;errorMessage=error.message}
  }
  try {return await tencentWindow(symbol,adjust,prior,signal)}
  catch(error){
    if(!errorMessage || signal?.aborted || error.status===429)throw error;
    throw Error('东方财富：'+errorMessage+'；腾讯历史：'+error.message);
  }
}
