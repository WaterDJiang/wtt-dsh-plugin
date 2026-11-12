import React, { useEffect, useRef, useState } from 'react';
import { UiButton, DialogFooter } from './ui/controls.jsx';
import { MEDIA_PROTOCOLS, MEDIA_PROVIDERS, mediaServiceName } from './media-api-catalog.mjs';
import { mediaCredentialRef } from './media-service-settings.mjs';

export function MediaServiceEditor({ editor, apiKey, setApiKey, onChange, onSave, onCancel, onClear, busy, writable, infos, refs, connections, operations }) {
  const { id, profile } = editor;
  const ownRef = mediaCredentialRef(id);
  const preset = MEDIA_PROTOCOLS[profile.protocol];
  const [mode, setMode] = useState(() => profile.connection || profile.baseURL !== preset.endpoint ? 'custom' : 'catalog');
  const drafts = useRef({});
  const dedicated = profile.apiKeyEnv === ownRef && !profile.connection;
  const [fetching, setFetching] = useState(false);
  const [candidates, setCandidates] = useState(null);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState('');
  const [failure, setFailure] = useState('');
  const request = useRef(null);
  const advanced = useRef(null);
  const scope = JSON.stringify([profile.baseURL, profile.protocol, profile.apiKeyEnv, profile.connection, apiKey]);
  const activeScope = useRef(scope);
  activeScope.current = scope;
  useEffect(() => {
    request.current?.abort(); setFetching(false); setCandidates(null); setFailure('');
    return () => request.current?.abort();
  }, [scope]);
  const change = patch => onChange({ ...profile, ...patch });
  function switchMode(next) {
    if (next === mode) return;
    request.current?.abort(); setCandidates(null); setFailure('');
    drafts.current[mode] = { profile, apiKey };
    const cached = drafts.current[next];
    const initial = MEDIA_PROTOCOLS['openai-image'];
    onChange(cached?.profile || { displayName: next === 'catalog' ? mediaServiceName('openai-image') : '', protocol: 'openai-image', type: 'image', baseURL: next === 'catalog' ? initial.endpoint : '', model: next === 'catalog' ? initial.models[0] : '', apiKeyEnv: ownRef });
    setApiKey(cached?.apiKey || ''); setMode(next);
  }
  function protocol(next) {
    const definition = MEDIA_PROTOCOLS[next];
    const autoName = [preset.label, mediaServiceName(profile.protocol)].includes(profile.displayName);
    change({ protocol: next, type: definition.type,
      ...(mode === 'catalog' ? { model: definition.models[0], ...(!profile.connection ? { baseURL: definition.endpoint } : {}), ...(autoName ? { displayName: mediaServiceName(next) } : {}) } : {}) });
  }
  async function discover() {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    const startedScope = activeScope.current;
    setFetching(true); setFailure('');
    try {
      const found = await operations.discover(id, profile, dedicated ? apiKey : '', controller.signal);
      if (controller.signal.aborted || startedScope !== activeScope.current) return;
      if (!found.length) { setCandidates(null); setFailure('接口未返回可用模型，可手动填写模型 ID'); return; }
      setCandidates(found); setQuery(''); setPicked('');
    } catch (cause) {
      if (!controller.signal.aborted && startedScope === activeScope.current) { setCandidates(null); setFailure(cause.message || '获取可用模型失败'); }
    } finally { if (request.current === controller) setFetching(false); }
  }
  const modelField = <div className="wtt-media-model-field">
    <div className="wtt-media-model-heading"><label htmlFor={`media-model-${id}`}>模型 ID</label><UiButton size="compact" variant="ghost" disabled={busy || fetching || !profile.baseURL} onClick={() => void discover()}>{fetching ? '获取中…' : '获取可用模型'}</UiButton></div>
    <input id={`media-model-${id}`} aria-label="模型 ID" value={profile.model} list={`media-models-${id}`} disabled={busy} onChange={event => change({ model: event.target.value })} required />
    <datalist id={`media-models-${id}`}>{preset.models.map(model => <option key={model} value={model} />)}</datalist>
    {failure && <p className="wtt-media-discovery-error" role="alert">{failure}</p>}
    <small>{mode === 'catalog' ? '内置列表仅供参考；' : ''}所选模型须支持当前媒体 API 协议。</small>
    {candidates && <div className="wtt-media-model-picker" role="group" aria-label="选择可用模型">
      <input aria-label="搜索模型" placeholder="搜索模型" value={query} onChange={event => setQuery(event.target.value)} />
      <div className="wtt-media-model-candidates">{candidates.filter(model => `${model.id} ${model.name || ''}`.toLowerCase().includes(query.toLowerCase())).map(model => <label className="wtt-media-model-candidate" key={model.id} title={model.name || model.id}><input type="radio" name={`candidate-${id}`} checked={picked === model.id} onChange={() => setPicked(model.id)} /><code>{model.id}</code></label>)}</div>
      {!candidates.some(model => `${model.id} ${model.name || ''}`.toLowerCase().includes(query.toLowerCase())) && <p>没有匹配的模型</p>}
      <div className="wtt-media-model-actions"><UiButton size="compact" onClick={() => setCandidates(null)}>取消</UiButton><UiButton size="compact" disabled={!picked} onClick={() => { change({ model: picked }); setCandidates(null); }}>使用所选模型</UiButton></div>
    </div>}
  </div>;
  const connectionField = <>
    <label>连接来源<select aria-label="连接来源" value={profile.connection ? JSON.stringify([profile.connection.namespace, profile.connection.path]) : ''} disabled={busy} onChange={event => {
      setApiKey(''); const source = connections.find(item => item.key === event.target.value);
      if (source) change({ connection: source.connection, apiKeyEnv: source.ref, baseURL: source.baseURL || preset.endpoint });
      else { const { connection, ...own } = profile; onChange({ ...own, apiKeyEnv: ownRef }); }
    }}><option value="">单独配置</option>{connections.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label>
    {!profile.connection && <label>凭据来源<select aria-label="凭据来源" value={dedicated ? '' : profile.apiKeyEnv} disabled={busy} onChange={event => { setApiKey(''); change({ apiKeyEnv: event.target.value || ownRef }); }}><option value="">此提供商的 API 密钥</option>{refs.filter(ref => ref !== ownRef).map(ref => <option key={ref} value={ref}>{ref}{infos[ref]?.configured ? ' · 已配置' : ''}</option>)}</select></label>}
  </>;
  const nameField = <label>显示名称<input aria-label="显示名称" value={profile.displayName} maxLength={80} disabled={busy} onChange={event => change({ displayName: event.target.value })} required /></label>;
  const addressField = <label>API 地址<input aria-label="API 地址" value={profile.baseURL} type="url" placeholder="https://gateway.example/v1" disabled={busy || Boolean(profile.connection)} onChange={event => change({ baseURL: event.target.value })} required /></label>;
  return <form className="wtt-media-service-form" onSubmit={onSave}>
    <div className="wtt-media-add-modes" role="tablist" aria-label="媒体模型接入方式">{[['catalog', '第三方模型提供商'], ['custom', '自定义模型 API']].map(([value, label]) => <UiButton key={value} role="tab" id={`media-tab-${id}-${value}`} aria-controls={`media-panel-${id}`} aria-selected={mode === value} disabled={busy || fetching} onClick={() => switchMode(value)}>{label}</UiButton>)}</div>
    <div className="wtt-media-add-panel" role="tabpanel" id={`media-panel-${id}`} aria-labelledby={`media-tab-${id}-${mode}`}>
      {mode === 'catalog' ? <div className="wtt-media-provider-fields"><label>提供商<select aria-label="提供商" value={preset.vendor} disabled={busy} onChange={event => protocol(Object.keys(MEDIA_PROTOCOLS).find(key => MEDIA_PROTOCOLS[key].vendor === event.target.value && MEDIA_PROTOCOLS[key].type === profile.type))}>{Object.entries(MEDIA_PROVIDERS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label>媒体类型<select aria-label="媒体类型" value={profile.type} disabled={busy} onChange={event => protocol(Object.keys(MEDIA_PROTOCOLS).find(key => MEDIA_PROTOCOLS[key].vendor === preset.vendor && MEDIA_PROTOCOLS[key].type === event.target.value))}><option value="image">图片</option><option value="video">视频</option></select></label></div> : <>{nameField}{addressField}<label>API 协议<select aria-label="API 协议" value={profile.protocol} disabled={busy} onChange={event => protocol(event.target.value)}>{Object.entries(MEDIA_PROTOCOLS).map(([value, definition]) => <option key={value} value={value}>{definition.label}</option>)}</select></label></>}
      {dedicated ? <label>API 密钥<input aria-label="API 密钥" type="password" autoComplete="new-password" value={apiKey} disabled={busy || infos[ownRef]?.writable === false} onChange={event => setApiKey(event.target.value)} onBlur={() => { if (apiKey && profile.baseURL) { if (mode === 'catalog' && advanced.current) advanced.current.open = true; void discover(); } }} placeholder={infos[ownRef]?.configured ? '已配置；留空保留' : '输入 API 密钥'} /></label> : <p>使用已有凭据：{profile.apiKeyEnv}</p>}
      {dedicated && infos[ownRef]?.configured && <UiButton size="compact" variant="ghost" className="wtt-media-clear-key" disabled={busy || !infos[ownRef]?.writable} onClick={onClear}>清除 API 密钥</UiButton>}
      {mode === 'custom' && modelField}
      <details ref={advanced} className="wtt-media-customized" onToggle={event => { if (event.currentTarget.open && mode === 'catalog' && !fetching && !candidates && !failure && (apiKey || infos[profile.apiKeyEnv]?.configured)) void discover(); }}><summary>自定义设置</summary><div className="wtt-media-customized-body">{mode === 'catalog' && <>{nameField}{addressField}{modelField}</>}{connectionField}</div></details>
    </div>
    <DialogFooter><UiButton disabled={busy} onClick={onCancel}>取消</UiButton><UiButton variant="primary" type="submit" disabled={busy || !writable}>{busy ? '保存中…' : '保存'}</UiButton></DialogFooter>
  </form>;
}
