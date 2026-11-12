import { MEDIA_PROTOCOLS } from './media-api-catalog.mjs';
import { normalizeMediaServiceAddress } from './media-service-address.mjs';
export const MEDIA_SETTINGS_NAMESPACE = 'wtt-creation-workbench';
export const MEDIA_SETTINGS_SECTION = 'models';
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REF = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FIELDS = ['displayName', 'baseURL', 'type', 'model', 'apiKeyEnv', 'protocol'];

export function mediaCredentialRef(id) {
  if (typeof id !== 'string' || !ID.test(id) || id.length > 80) throw new Error('媒体服务标识无效');
  return `WTT_MEDIA_${id.replaceAll('-', '_').toUpperCase()}_API_KEY`;
}

export function mediaServiceProfile(id, value) {
  mediaCredentialRef(id);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => ![...FIELDS, 'connection'].includes(key))) throw new Error('媒体配置只接受名称、地址、类型、模型和凭据引用；API Key 必须存入 DSH 凭据服务');
  const profile = {};
  for (const key of FIELDS) {
    if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > (key === 'baseURL' ? 2048 : 256) || /[\u0000-\u001f\u007f]/.test(value[key])) throw new Error(`媒体服务的${{ displayName: '名称', baseURL: '地址', type: '类型', model: '模型', apiKeyEnv: '凭据引用', protocol: '生成协议' }[key]}无效`);
    profile[key] = value[key].trim();
  }
  if (!MEDIA_PROTOCOLS[profile.protocol] || MEDIA_PROTOCOLS[profile.protocol].type !== profile.type) throw new Error('媒体类型与生成协议不匹配');
  if (!['image', 'video'].includes(profile.type)) throw new Error('媒体服务类型必须为图片或视频');
  if (!REF.test(profile.apiKeyEnv)) throw new Error('DSH 凭据引用名称无效');
  profile.baseURL = normalizeMediaServiceAddress(profile.baseURL, profile.protocol, profile.model);
  if (value.connection != null) {
    const connection = value.connection;
    if (!connection || typeof connection.namespace !== 'string' || !connection.namespace || !Array.isArray(connection.path)
      || connection.path.length > 16 || connection.path.some(key => typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key))) throw new Error('DSH 提供商引用无效');
    profile.connection = { namespace: connection.namespace, path: [...connection.path] };
  }
  return profile;
}

export function mediaServiceProfiles(value) {
  const profiles = typeof value?.get === 'function' ? value.get() : value || {};
  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles) || Object.keys(profiles).length > 64) throw new Error('媒体服务配置无效，最多 64 项');
  return Object.fromEntries(Object.entries(profiles).map(([id, profile]) => [id, mediaServiceProfile(id, profile)]));
}

// Credential references are discoverable from schemas; secret values are never read.
export function configuredCredentialReferences(namespaces, schema) {
  const found = new Map();
  for (const namespace of namespaces || []) {
    let root;
    try { root = schema.rehydrate(namespace.schema); } catch { continue; }
    let visited = 0;
    const visit = (value, path = []) => {
      if (++visited > 10000 || path.length > 16) return;
      if (typeof value === 'string' && REF.test(value) && schema.nodeAtPath(root, path)?.meta?.role === 'credential-ref') {
        const list = found.get(value) || [];
        list.push({ namespace: namespace.ns, path, label: `${namespace.ns} · ${value}` });
        found.set(value, list);
      } else if (value && typeof value === 'object') {
        for (const [key, entry] of Object.entries(value)) visit(entry, [...path, key]);
      }
    };
    visit(namespace.value);
  }
  return found;
}
