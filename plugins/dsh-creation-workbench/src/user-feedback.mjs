export function userFacingError(error) {
  const detail = error?.message || error?.error?.message || String(error || '操作未完成');
  let summary;
  // An ambiguous send must never become a suggestion to send the same request again.
  if (/提交结果未知|结果待核对|发送结果.*(未知|不确定|未核实)|受理.*不确定/i.test(detail)) summary = '暂时无法确认是否提交成功。请先打开任务对话核对，不要重复发送。';
  else if (/PPT 渲染命令|Rendered text checks failed|MuPDF|页面检查未通过/.test(detail)) summary = '课件的本机转换预览未通过检查，编辑草稿已保留。可关闭编辑器，改用“编辑源文件”，或通过“打开 PPT”使用本机应用。';
  else if (/session[/-]not-found|会话不存在|会话.*属于其他项目/i.test(detail)) summary = '找不到这次任务的对话。请到任务列表核对任务和所属项目。';
  else if (/401|unauthorized|认证.*(失败|失效)|凭据.*失效/i.test(detail)) summary = '服务认证未通过。请检查对应服务的登录或连接设置。';
  else if (/429|quota|额度不足|余额不足|rate.?limit/i.test(detail)) summary = '模型服务暂时无法继续。请检查可用额度，或稍后再试。';
  else if (/外部修改|来源.*变化|hash.*(不|错)|已被其他操作修改|版本.*过期/i.test(detail)) summary = '内容版本已变化。请保留当前草稿，刷新后重新选择资料或版本。';
  else if (/EACCES|EPERM|403|forbidden|权限不足|没有权限/i.test(detail)) summary = '当前操作受到权限限制。请检查文件夹权限，或查看任务中的授权请求。';
  else if (/ENOENT|文件.*(不存在|缺失)|file not found/i.test(detail)) summary = '找不到需要的文件。请检查文件位置，或重新添加资料。';
  else if (/timeout|timed out|超时|Failed to fetch|网络.*(中断|失败)/i.test(detail)) summary = '连接暂时中断。请先核对任务进度或服务连接，再决定下一步。';
  else if (/[\u4e00-\u9fff]/.test(detail) && detail.length <= 150 && !/hash|投影|冻结|原生|Skill|stack|Error:|JSON|SQL|TypeError/.test(detail)) summary = detail;
  else summary = '暂时无法完成这项操作。请查看详细原因，核对当前任务或连接设置。';
  return { summary, detail, hasDetail: summary !== detail };
}
