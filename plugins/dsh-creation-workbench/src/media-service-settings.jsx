import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { UiButton, PanelToolbar, DialogHeader, DialogBody } from './ui/controls.jsx';
import { UserError } from './user-feedback.jsx';
import { MEDIA_PROTOCOLS, mediaServiceName } from './media-api-catalog.mjs';
import { mediaCredentialRef } from './media-service-settings.mjs';
import { MediaServiceEditor } from './media-service-editor.jsx';
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
  const [errorField, setErrorField] = useState('');
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
    setBusy(true); setError(''); setErrorField(''); setNotice('');
    try { await work(); setNotice(message); setCredentialEpoch(value => value + 1); return true; }
    catch (cause) { setError(cause.message || String(cause)); setErrorField(cause.field || ''); return false; }
    finally { setBusy(false); }
  }
  function edit(id, profile) {
    setApiKey(''); setConfirm(null); setError(''); setErrorField(''); setNotice('');
    setEditor({ id, profile: { ...profile }, revision: snapshot.revision });
  }
  function add() {
    const id = `media-${crypto.randomUUID().slice(0, 8)}`;
    const protocol = 'openai-image', preset = MEDIA_PROTOCOLS[protocol];
    edit(id, { displayName: mediaServiceName(protocol), protocol, type: preset.type, baseURL: preset.endpoint, model: preset.models[0], apiKeyEnv: mediaCredentialRef(id) });
  }
  const profile = editor?.profile;
  async function save(event) {
    event.preventDefault();
    const saved = await act(() => operations.save(editor.id, profile, { apiKey, expectedRevision: editor.revision, onCredentialStored: () => setApiKey('') }), '模型提供商已保存');
    if (saved) { setEditor(null); setApiKey(''); }
  }
  const content = <>
    {(!compact || !editor) && <PanelToolbar>{!compact && <h3>图片与视频服务</h3>}{!editor && <UiButton disabled={!writable || busy} onClick={add}>添加模型提供商</UiButton>}</PanelToolbar>}
    {!writable && <p role="status">{snapshot.status === 'loading' ? '正在读取 DSH 设置…' : 'DSH 设置当前不可写'}</p>}
    <div className="wtt-media-service-list">{Object.entries(profiles).map(([id, entry]) => <div className="wtt-media-service-row" key={id}>
      <div><strong>{entry.displayName}</strong><span>{MEDIA_PROTOCOLS[entry.protocol]?.label || entry.protocol} · {entry.model}</span><small>{infos[entry.apiKeyEnv]?.configured ? `API 密钥已配置${infos[entry.apiKeyEnv].source === 'environment' ? ' · 环境来源' : ''}` : '尚未配置 API 密钥'}</small></div>
      <UiButton variant="ghost" disabled={!writable || busy} onClick={() => edit(id, entry)}>编辑</UiButton>
      <UiButton variant="ghost" disabled={!writable || busy} onClick={() => setConfirm({ kind: 'remove', id, revision: snapshot.revision })}>移除</UiButton>
    </div>)}</div>
    {!Object.keys(profiles).length && !editor && <p>添加图片或视频服务，或引用 DSH 已有的提供商连接。</p>}
    {editor && <MediaServiceEditor key={editor.id} editor={editor} apiKey={apiKey} setApiKey={setApiKey}
      onChange={profile => { setEditor(value => ({ ...value, profile })); setError(''); setErrorField(''); }} onSave={save}
      onCancel={() => { setEditor(null); setApiKey(''); setConfirm(null); }} onClear={() => setConfirm({ kind: 'clear', id: editor.id })}
      busy={busy} writable={writable} infos={infos} refs={refs} connections={connections} operations={operations} addressError={errorField === 'baseURL' ? error : ''} />}
    {confirm && <div className="wtt-media-service-confirm" role="group" aria-label="确认媒体设置操作"><p>{confirm.kind === 'clear' ? '清除此提供商的 API 密钥？环境变量来源仍可能生效。' : '移除此提供商配置？已存 API 密钥保留在 DSH。'}</p><UiButton disabled={busy} onClick={() => void act(() => confirm.kind === 'clear' ? operations.clearCredential(confirm.id) : operations.remove(confirm.id, confirm.revision), confirm.kind === 'clear' ? '已清除 API 密钥；凭据状态已刷新' : '已移除服务配置，密钥保留').then(ok => { if (ok) { setConfirm(null); if (confirm.kind === 'remove') { setEditor(null); setApiKey(''); } } })}>确认{confirm.kind === 'clear' ? '清除 API 密钥' : '移除配置'}</UiButton><UiButton disabled={busy} onClick={() => setConfirm(null)}>取消</UiButton></div>}
    {error && errorField !== 'baseURL' && <UserError error={error} />}{notice && <p role="status">{notice}</p>}
  </>;
  return <section className={`wtt-project-workbench wtt-media-service-settings${compact ? ' is-compact' : ''}`} aria-label="图片与视频服务" id="wtt-media-services" tabIndex={-1}>
    {compact ? <><UiButton data-media-settings-open onClick={() => setMobileOpen(true)}>图片与视频服务</UiButton><dialog ref={dialog} className="wtt-project-workbench wtt-media-service-settings wtt-media-service-dialog" aria-labelledby="wtt-media-dialog-title" onCancel={event => { event.preventDefault(); setMobileOpen(false); }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMobileOpen(false); } }}>
      <DialogHeader title="图片与视频服务" titleId="wtt-media-dialog-title" closeLabel="返回模型设置" onClose={() => setMobileOpen(false)} /><DialogBody className="wtt-media-service-dialog-body">{content}</DialogBody>
    </dialog></> : content}
  </section>;
}
