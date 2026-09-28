// Hub provider plugin: a compatible upstream the person names the endpoint for.
// Not built into the hub — the hub imports this file from the plugin directory.
const error = (code, message) => Object.assign(new Error(message), { code });
const name = { en: 'Custom compatible service', 'zh-CN': '自定义兼容服务', 'zh-TW': '自訂相容服務', ja: 'カスタム互換サービス' };
const urlLabel = { en: 'Service URL', 'zh-CN': '服务地址', 'zh-TW': '服務位址', ja: 'サービスの URL' };
export default {
  apiVersion: 1,
  descriptor: {
    id: 'custom-compatible', version: 1, owner: 'hub', name,
    authMethods: ['api-key'],
    configuration: {
      modelDeclarations: true,
      fields: [
        { name: 'url', type: 'url', required: true, label: urlLabel },
        { name: 'api', type: 'enum', values: ['openai-completions', 'openai-responses', 'anthropic-messages'], default: 'openai-completions', label: { en: 'API protocol', 'zh-CN': 'API 协议', 'zh-TW': 'API 協定', ja: 'API プロトコル' } },
        { name: 'token', type: 'secret', label: { en: 'API key', 'zh-CN': 'API 密钥', 'zh-TW': 'API 金鑰', ja: 'API キー' } },
      ],
    },
    catalog: { refresh: true },
  },
  configure(input, previous) {
    const url = input.url === undefined ? previous?.url : input.url;
    const api = input.api === undefined ? previous?.api ?? null : input.api;
    if (typeof url !== 'string' || !url) throw error('validation_failed', 'url is required');
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw error('validation_failed', 'invalid provider endpoint');
    if (api !== null && (typeof api !== 'string' || !api)) throw error('validation_failed', 'invalid provider protocol');
    return { url, api };
  },
  async fetchCatalog({ endpoint, credential }) {
    let url;
    try {
      url = new URL(endpoint?.url || '');
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
      url.pathname = url.pathname.replace(/\/$/, '') + '/models';
      url.hash = '';
    } catch { throw error('validation_failed', 'invalid provider endpoint'); }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      let response;
      try { response = await fetch(url, { headers: { authorization: `Bearer ${credential}` }, redirect: 'error', signal: controller.signal }); }
      catch (e) {
        // Say WHICH url failed and WHY. Swallowing the cause left a person looking at
        // "catalog connection failed or timed out" with no way to tell a wrong port from a
        // machine that is off, a refused connection from a DNS failure.
        const why = e && e.name === 'AbortError' ? 'timed out after 15s' : (e && (e.cause?.message || e.message)) || 'connection failed';
        throw error('provider_catalog_failed', `catalog request to ${url.href} failed: ${why}`);
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw error('provider_catalog_failed', `catalog request returned HTTP ${response.status}`);
      }
      const reader = response.body.getReader();
      const chunks = []; let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 8 * 1024 * 1024) { controller.abort(); throw error('provider_catalog_failed', 'catalog response exceeds size limit'); }
          chunks.push(Buffer.from(value));
        }
      } catch (e) {
        if (e && e.code) throw e;      // the size-limit error above already says what happened
        const why = e && e.name === 'AbortError' ? 'timed out after 15s' : (e && e.message) || 'interrupted';
        throw error('provider_catalog_failed', `catalog response from ${url.href} was cut short: ${why}`);
      }
      finally { reader.releaseLock(); }
      let document;
      try { document = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { throw error('provider_catalog_failed', 'catalog response is not JSON'); }
      const list = Array.isArray(document?.data) ? document.data : Array.isArray(document?.models) ? document.models : null;
      if (!list) throw error('provider_catalog_failed', 'catalog response has no model array');
      const unique = new Map();
      for (const item of list) {
        const modelId = typeof item === 'string' ? item : item?.id;
        if (typeof modelId !== 'string' || !modelId.trim()) throw error('provider_catalog_failed', 'catalog contains an invalid model id');
        unique.set(modelId, { id: modelId, name: typeof item?.name === 'string' ? item.name : modelId });
      }
      return [...unique.values()];
    } finally { clearTimeout(timer); }
  },
};
