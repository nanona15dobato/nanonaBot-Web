'use strict';
const { pool } = require('../db');
const { TaskControlError } = require('./taskControls');
const { MediaWikiBotClient } = require('../bot/mwClient');
const config = require('../config');
const fail = (code, message) => { throw new TaskControlError(400, code, message); };
function createTargetSearch({ db = pool, request = null } = {}) {
  let reader;
  const query = request || (params => {
    reader ||= new MediaWikiBotClient({ apiUrl: config.wiki.apiUrl, userAgent: config.userAgent, anonymous: true });
    return reader.request(params);
  });
  let namespaceCache = null;
  async function namespaces() {
    if (namespaceCache && namespaceCache.until > Date.now()) return namespaceCache.rows;
    const data = await query({ action: 'query', meta: 'siteinfo', siprop: 'namespaces|namespacealiases' });
    const aliases = data.query?.namespacealiases || [];
    const rows = Object.values(data.query?.namespaces || {}).filter(n => Number.isInteger(n.id) && n.id >= 0).map(n => ({
      id: n.id, name: n.name ?? n['*'] ?? '', canonical: n.canonical || '',
      aliases: aliases.filter(a => a.id === n.id).map(a => a.alias ?? a['*']).filter(Boolean),
    })).sort((a,b) => a.id-b.id);
    if (!rows.length) throw new TaskControlError(502, 'namespace_lookup_failed', '名前空間を取得できませんでした。');
    namespaceCache = { rows, until: Date.now() + 600000 }; return rows;
  }
  async function search(body) {
    const method = body.method;
    const definitions = {
      prefix: ['prefixsearch','pssearch','psnamespace','pslimit','psoffset'],
      backlinks: ['backlinks','bltitle','blnamespace','bllimit','blcontinue'],
      embeddedin: ['embeddedin','eititle','einamespace','eilimit','eicontinue'],
      category: ['categorymembers','cmtitle','cmnamespace','cmlimit','cmcontinue'],
      search: ['search','srsearch','srnamespace','srlimit','sroffset'],
    };
    if (!Object.hasOwn(definitions, method)) fail('invalid_method', '検索方法を選んでください。');
    if (typeof body.query !== 'string' || !body.query.trim() || body.query.length > 512 || /[\u0000-\u001f]/.test(body.query) || method !== 'search' && body.query.includes('|')) fail('invalid_query', '検索語・ページ名を1〜512文字で入力してください。');
    const ns = body.namespaces;
    if (ns !== undefined && ns !== null && (!Array.isArray(ns) || ns.length > 100 || ns.some(n => !Number.isInteger(n) || n < 0 || n > 1000000))) fail('invalid_namespaces', '名前空間の指定が不正です。');
    if (Array.isArray(ns) && ns.length) {
      const known = new Set((await namespaces()).map(n => n.id));
      if (ns.some(n => !known.has(n))) fail('invalid_namespaces', '接続先に存在しない名前空間です。一覧を更新してください。');
    }
    const [list, textKey, nsKey, limitKey, continueKey] = definitions[method];
    let text = body.query.trim();
    if (method === 'embeddedin' || method === 'category') {
      const id = method === 'embeddedin' ? 10 : 14;
      const item = (await namespaces()).find(n => n.id === id);
      const names = [item?.name, item?.canonical, ...(item?.aliases || [])].filter(Boolean);
      if (!names.some(name => text.slice(0,name.length+1).toLowerCase() === name.toLowerCase()+':')) text = (item?.canonical || (id===10?'Template':'Category'))+':'+text;
    }
    const params = { action:'query', list, [textKey]:text, [limitKey]:100 };
    if (Array.isArray(ns) && ns.length) params[nsKey] = [...new Set(ns)].join('|');
    else if (method === 'prefix' || method === 'search') params[nsKey] = '*';
    if (method === 'search') { params.srprop = ''; params.srwhat = 'text'; }
    if (body.continue !== undefined && body.continue !== null) {
      const cont = body.continue;
      if (typeof cont !== 'object' || Array.isArray(cont) || Object.keys(cont).some(k => ![continueKey, 'continue'].includes(k))) fail('invalid_continue', '検索の継続情報が不正です。');
      for (const [key,value] of Object.entries(cont)) {
        if (!(typeof value === 'string' && value.length <= 2048 || Number.isSafeInteger(value) && value >= 0)) fail('invalid_continue', '検索の継続情報が不正です。');
        params[key] = value;
      }
    }
    const data = await query(params);
    const seen = new Set();
    const results = (data.query?.[list] || []).filter(p => typeof p.title === 'string' && Number.isInteger(p.ns) && p.ns >= 0 && !seen.has(p.title) && seen.add(p.title)).map(p => ({ title:p.title, namespace:p.ns }));
    const next = Object.fromEntries(Object.entries(data.continue || {}).filter(([k]) => [continueKey,'continue'].includes(k)));
    return { results, continue: Object.hasOwn(next, continueKey) ? next : null };
  }
  async function forTask(id, body) {
    const [tasks] = await db.query('SELECT id FROM tasks WHERE id = ?', [id]);
    if (!tasks.length) throw new TaskControlError(404,'not_found','タスクが見つかりません。');
    const result = await search(body);
    if (result.results.length) {
      const titles = result.results.map(p => p.title);
      const [edited] = await db.query("SELECT page_title FROM task_pages WHERE task_id = ? AND status = 'edited' AND page_title COLLATE utf8mb4_bin IN (?) UNION SELECT page_title FROM edit_log WHERE task_id = ? AND status = 'edited' AND page_title COLLATE utf8mb4_bin IN (?)", [id,titles,id,titles]);
      const done = new Set(edited.map(p => p.page_title));
      result.results = result.results.map(p => ({ ...p, alreadyEdited:done.has(p.title) }));
    }
    return result;
  }
  return { namespaces, search, forTask };
}
module.exports = { ...createTargetSearch(), createTargetSearch };
