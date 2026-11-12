import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { UiButton, PanelToolbar, DialogHeader, DialogBody } from './ui/controls.jsx';
import { UserError } from './user-feedback.jsx';
import { MEDIA_PROTOCOLS } from './media-api-catalog.mjs';
import { mediaCredentialRef } from './media-service-settings.mjs';
import './media-service-settings.css';

export function MediaServiceSettings({ operations }) {
  const snapshot = useSyncExternalStore(listener => operations.form.subscribe(listener), () => operations.form.getSnapshot());
  const mirror = useSyncExternalStore(listener => operations.mirror.subscribe(listener), () => operations.mirror.getSnapshot());
  const [editor, setEditor] = useState(null);
  const [apiKey, setApiKey] = useState('');
  const [infos, setInfos] = useState({});
  const [credentialEpoch, setCredentialEpoch] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState(null);
  const mobileQuery = useMemo(() => window.matchMedia('(max-width: 640px)'), []);
  const compact = useSyncExternalStore(listener => { mobileQuery.addEventListener('change', listener); return () => mobileQuery.removeEventListener('change', listener); }, () => mobileQuery.matches, () => false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const dialog = useRef(null);
  useEffect(() => {
    if (compact && mobileOpen) { if (!dialog.current?.open) dialog.current?.showModal(); }
    else dialog.current?.close();
  }, [compact, mobileOpen]);
  const profiles = snapshot.value?.mediaServices || {};
  const refs = useMemo(() => [...operations.references().keys()], [operations, mirror.view]);
  const connections = useMemo(() => operations.connections(), [operations, mirror.view]);
  const refSignature = JSON.stringify([...new Set([...refs, ...(editor ? [editor.profile.apiKeyEnv] : [])])].sort());
  const writable = snapshot.status === 'ready' && snapshot.writable;
  useEffect(() => { void operations.ensure().catch(cause => setError(cause.message)); }, [operations]);
  useEffect(() => operations.watchCredentials(() => setCredentialEpoch(value => value + 1)), [operations]);
  useEffect(() => {
    let current = true;
    void operations.describe(JSON.parse(refSignature)).then(value => { if (current) setInfos(value); }).catch(cause => { if (current) setError(cause.message); });
    return () => { current = false; };
  }, [operations, refSignature, credentialEpoch]);
  async function act(work, message) {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try { await work(); setNotice(message); setCredentialEpoch(value => value + 1); return true; }
    catch (cause) { setError(cause.message || String(cause)); return false; }
    finally { setBusy(false); }
  }
  function edit(id, profile) {
    setApiKey(''); setConfirm(null); setError(''); setNotice('');
    setEditor({ id, profile: { ...profile }, revision: snapshot.revision });
  }
  function add() {
    const id = `media-${crypto.randomUUID().slice(0, 8)}`;
    const protocol = 'openai-image', preset = MEDIA_PROTOCOLS[protocol];
    edit(id, { displayName: preset.label, protocol, type: preset.type, baseURL: preset.endpoint, model: preset.models[0], apiKeyEnv: mediaCredentialRef(id) });
  }
  const change = patch => setEditor(value => ({ ...value, profile: { ...value.profile, ...patch } }));
  const profile = editor?.profile;
  const ownRef = editor && mediaCredentialRef(editor.id);
  const dedicated = profile?.apiKeyEnv === ownRef && !profile?.connection;
  const selectedConnection = profile?.connection && JSON.stringify([profile.connection.namespace, profile.connection.path]);
  async function save(event) {
    event.preventDefault();
    const saved = await act(() => operations.save(editor.id, profile, { apiKey, expectedRevision: editor.revision, onCredentialStored: () => setApiKey('') }), '媒体服务已保存');
    if (saved) { setEditor(null); setApiKey(''); }
  }
  const content = <>
    <PanelToolbar>{!compact && <h3>图片与视频服务</h3>}<UiButton disabled={!writable || busy || Boolean(editor)} onClick={add}>添加媒体服务</UiButton></PanelToolbar>
    {!writable && <p role="status">{snapshot.status === 'loading' ? '正在读取 DSH 设置…' : 'DSH 设置当前不可写'}</p>}
    <div className="wtt-media-service-list">{Object.entries(profiles).map(([id, entry]) => <div className="wtt-media-service-row" key={id}>
      <div><strong>{entry.displayName}</strong><span>{MEDIA_PROTOCOLS[entry.protocol]?.label || entry.protocol} · {entry.model}</span><small>{infos[entry.apiKeyEnv]?.configured ? `密钥已配置${infos[entry.apiKeyEnv].source === 'environment' ? ' · 环境来源' : ''}` : '尚未配置密钥'}</small></div>
      <UiButton variant="ghost" disabled={!writable || busy} onClick={() => edit(id, entry)}>编辑</UiButton>
      <UiButton variant="ghost" disabled={!writable || busy} onClick={() => setConfirm({ kind: 'remove', id, revision: snapshot.revision })}>移除</UiButton>
    </div>)}</div>
    {!Object.keys(profiles).length && !editor && <p>添加图片或视频服务，或引用 DSH 已有的提供商连接。</p>}
    {editor && <form className="wtt-media-service-form" onSubmit={save}>
      <label>服务名称<input aria-label="媒体服务名称" value={profile.displayName} maxLength={80} disabled={busy} onChange={event => change({ displayName: event.target.value })} required /></label>
      <label>生成服务<select aria-label="媒体生成服务" value={profile.protocol} disabled={busy} onChange={event => { const protocol = event.target.value, preset = MEDIA_PROTOCOLS[protocol]; change({ protocol, type: preset.type, model: preset.models[0], ...(!profile.connection ? { baseURL: preset.endpoint } : {}) }); }}>
        {Object.entries(MEDIA_PROTOCOLS).map(([id, preset]) => <option value={id} key={id}>{preset.label}</option>)}
      </select></label>
      <label>连接来源<select aria-label="媒体连接来源" value={selectedConnection || ''} disabled={busy} onChange={event => {
        setApiKey(''); const source = connections.find(item => item.key === event.target.value);
        if (source) change({ connection: source.connection, apiKeyEnv: source.ref, baseURL: source.baseURL || MEDIA_PROTOCOLS[profile.protocol].endpoint });
        else { const { connection, ...own } = profile; setEditor(value => ({ ...value, profile: { ...own, apiKeyEnv: mediaCredentialRef(editor.id) } })); }
      }}><option value="">单独配置媒体服务</option>{connections.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</select></label>
      <label>服务地址<input aria-label="媒体服务地址" value={profile.baseURL} type="url" disabled={busy || Boolean(profile.connection)} onChange={event => change({ baseURL: event.target.value })} required /></label>
      <label>模型<input aria-label="媒体模型" value={profile.model} list={`media-models-${editor.id}`} disabled={busy} onChange={event => change({ model: event.target.value })} required /><datalist id={`media-models-${editor.id}`}>{MEDIA_PROTOCOLS[profile.protocol].models.map(model => <option key={model} value={model} />)}</datalist></label>
      {!profile.connection && <label>密钥来源<select aria-label="媒体密钥来源" value={dedicated ? '' : profile.apiKeyEnv} disabled={busy} onChange={event => { setApiKey(''); change({ apiKeyEnv: event.target.value || ownRef }); }}><option value="">此服务专用 Key</option>{refs.filter(ref => ref !== ownRef).map(ref => <option key={ref} value={ref}>{ref}{infos[ref]?.configured ? ' · 已配置' : ' · 未配置'}</option>)}</select></label>}
      {dedicated ? <label>API Key<input aria-label="媒体 API Key" type="password" autoComplete="new-password" value={apiKey} disabled={busy || infos[ownRef]?.writable === false} onChange={event => setApiKey(event.target.value)} placeholder={infos[ownRef]?.configured ? '已配置；留空保留' : '填写 Key 后存入 DSH 凭据'} /></label> : <p>引用已有凭据，不复制密钥。所选地址须支持对应的媒体 API。</p>}
      {dedicated && infos[ownRef]?.configured && <UiButton variant="ghost" disabled={busy || !infos[ownRef]?.writable} onClick={() => setConfirm({ kind: 'clear', id: editor.id })}>清除已存 Key</UiButton>}
      <PanelToolbar><UiButton variant="primary" type="submit" disabled={busy || !writable}>{busy ? '保存中…' : '保存媒体服务'}</UiButton><UiButton disabled={busy} onClick={() => { setEditor(null); setApiKey(''); setConfirm(null); }}>取消</UiButton></PanelToolbar>
    </form>}
    {confirm && <div className="wtt-media-service-confirm" role="group" aria-label="确认媒体设置操作"><p>{confirm.kind === 'clear' ? '清除 DSH 中此服务的专用 Key？环境变量来源仍可能生效。' : '移除媒体服务配置？已存 Key 保留在 DSH。'}</p><UiButton disabled={busy} onClick={() => void act(() => confirm.kind === 'clear' ? operations.clearCredential(confirm.id) : operations.remove(confirm.id, confirm.revision), confirm.kind === 'clear' ? '已清除存储的 Key；凭据状态已刷新' : '已移除服务配置，密钥保留').then(ok => { if (ok) { setConfirm(null); if (confirm.kind === 'remove') { setEditor(null); setApiKey(''); } } })}>确认{confirm.kind === 'clear' ? '清除 Key' : '移除配置'}</UiButton><UiButton disabled={busy} onClick={() => setConfirm(null)}>取消</UiButton></div>}
    {error && <UserError error={error} />}{notice && <p role="status">{notice}</p>}
  </>;
  return <section className={`wtt-project-workbench wtt-media-service-settings${compact ? ' is-compact' : ''}`} aria-label="图片与视频服务" id="wtt-media-services" tabIndex={-1}>
    {compact ? <><UiButton data-media-settings-open onClick={() => setMobileOpen(true)}>图片与视频服务</UiButton><dialog ref={dialog} className="wtt-project-workbench wtt-media-service-settings wtt-media-service-dialog" aria-labelledby="wtt-media-dialog-title" onCancel={event => { event.preventDefault(); setMobileOpen(false); }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMobileOpen(false); } }}>
      <DialogHeader title="图片与视频服务" titleId="wtt-media-dialog-title" closeLabel="返回模型设置" onClose={() => setMobileOpen(false)} /><DialogBody className="wtt-media-service-dialog-body">{content}</DialogBody>
    </dialog></> : content}
  </section>;
}
