const shortcuts = {
  帮助: 'home', 项目: 'project', 切换项目: 'project', 画布: 'canvas', 切换画布: 'canvas',
  新建项目: 'new-project', 新建画布: 'new-canvas', 进度: 'progress', 确认: 'code',
};

export function wechatOptionNumber(text) {
  const match = text.normalize('NFKC').trim().match(/^(?:就)?(?:选)?(?:第)?([一二两三四五六七八九十]|\d{1,2})(?:个|项|号)?(?:吧|好了)?[。！!]?$/u);
  if (!match) return null;
  const values = {一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10};
  return values[match[1]] ?? Number(match[1]);
}

function name(text) {
  return text.trim().replace(/^[:：，,]\s*/u,'').replace(/^(?:「(.+)」|『(.+)』|“(.+)”|"(.+)")$/u,
    (_match,...groups)=>groups.slice(0,4).find(Boolean) || '');
}

export function wechatGivenName(text) {
  const value = text.trim().replace(/[。！？!?]$/u,'');
  const called = value.match(/^(?:就叫|叫作|叫做|叫|名字是|名字叫|命名为)\s*(.+)$/u);
  if (called || /^(?:「|『|“|")/u.test(value)) return name(called?.[1] ?? value);
  if (value.length <= 36 && /^[^\n。！？?，,；;：:]+$/u.test(value) &&
      !/^(?:请|帮我|给我|把|先|想|能不能|你|继续|整理|生成|写|做|修改|检查)/u.test(value)) return value;
  return '';
}

export function wechatIntent(text) {
  const value = text.trim().replace(/[。！？?!，,\s]+$/u,'')
    .replace(/^(?:\s*(?:请(?:你)?|帮我|给我|麻烦(?:你)?|能不能|我想(?:要)?|我要))+\s*/u,'');
  const legacy = value.match(/^\/?(帮助|新建项目|新建画布|切换项目|切换画布|项目|画布|进度|确认)(?:\s+|[：:]\s*|$)([\s\S]*)$/u);
  if (legacy) return {kind:shortcuts[legacy[1]],value:name(legacy[2])};
  if (/^(?:你好|您好|嗨|哈喽|在吗|hi|hello|怎么用|我现在在哪(?:个(?:项目|画布)|里|儿)?|现在在哪(?:个(?:项目|画布)|里|儿)?|当前(?:项目|画布))$/iu.test(value))
    return {kind:'home'};
  if (/^(?:可以(?:的|了)?|好(?:的|呀|啊)?|没问题)$/u.test(value)) return {kind:'agree',brief:true};
  if (/^(?:可以(?:开始(?:了|吧)?|做(?:了|吧)?|开工)|开始(?:做)?吧|同意|确认(?:执行|开始|吧)?|(?:就)?按(?:这个|这个计划|计划|刚才的计划)(?:做|执行|开始)(?:吧)?|就这么做(?:吧)?)$/u.test(value))
    return {kind:'agree'};
  if (/^(?:算了|不建了|先不建了|先不换了|取消(?:这次|选择|新建)?)$/u.test(value)) return {kind:'cancel'};
  if (/^(?:看看|看下|看一下|查一下|查查|问下)?(?:刚才(?:那个|的任务|的计划)?|这个任务|之前那个|现在)?\s*(?:进度|进展(?:怎么样|如何)|做到哪(?:儿|里|了)?了?|什么时候好|做好了(?:吗)?|做完了(?:吗)?|完成了吗|好了吗|怎么样了)$/u.test(value) ||
      /^(?:把)?刚才的计划(?:发我(?:看看)?|再发(?:给)?我|发一下)?$/u.test(value)) return {kind:'recent'};
  const view = value.match(/^(?:(?:看看|看下|看一下)(?:有(?:哪些|什么))?|有哪些|列出|显示|换(?:个|一个|张|一张|另一个|另一张)?|切换(?:个|一个|张|一张)?)(?:我?的|其他|别的)?(项目|画布)(?:列表|吧)?$/u);
  if (view) return {kind:view[1]==='项目'?'project':'canvas'};
  const create = value.match(/^(?:新建|创建|建|开)(?:(?:一)?[个张])?(?:(?:叫(?:作|做)?|名为)\s*(.{1,120}?)的(项目|画布)|(项目|画布)(.*))$/u);
  if (create) {
    const raw = create[1] || create[4].replace(/^[，,：:\s]*(?:就叫|名字叫|名字是|名为|叫(?:作|做)?)?\s*/u,'');
    const purpose = !create[1]&&/^(?:来(?:写|做|放|整理|$)|用于|用来|然后|吧$)/u.test(raw);
    return {kind:(create[2]||create[3])==='项目'?'new-project':'new-canvas',value:purpose?'':name(raw)};
  }
  const target = value.match(/^(?:切换到|切到|换到|换成|打开|回到|去|带我去)\s*(.{1,120}?)(?:这个|那个)?(项目|画布)(?:吧)?$/u);
  if (target) return {kind:target[2]==='项目'?'project':'canvas',value:name(target[1])};
  const choose = value.match(/^(?:切换?|换|打开|选择)(项目|画布)(?:到|成|为)?\s*[:：]?\s*(.{1,120})$/u);
  if (choose) return {kind:choose[1]==='项目'?'project':'canvas',value:name(choose[2])};
  return null;
}
