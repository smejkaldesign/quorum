// Notion read tools with the person's own integration token: search what they shared with Quorum, and read one page as
// markdown (properties, then blocks, nested blocks to MAX_DEPTH levels, at most MAX_BLOCKS blocks).
import { ProviderError, readJson, request } from './http.js';

const API = 'https://api.notion.com/v1/';
const VERSION = '2022-06-28';
export const MAX_DEPTH = 3;
export const MAX_BLOCKS = 1000;
// a page stops reading its blocks after this long and says it is cut short
export const PAGE_BUDGET_MS = 25000;
const RECONNECT = 'Notion needs to be connected again. In Quorum, open Settings > Connectors > Notion, choose Disconnect, then Connect.';
const NOT_SHARED = 'Quorum cannot see that Notion page. In Notion, add Quorum to the page under its Connections menu, then try again.';

const clamp = (n, lo, hi, d) => (Number.isFinite(Number(n)) ? Math.min(hi, Math.max(lo, Math.round(Number(n)))) : d);
const text = (rich) => (rich ?? []).map((t) => t.plain_text ?? '').join('');
// rich text as markdown: bold, italic, code and links
function md(rich) {
  return (rich ?? []).map((t) => {
    let s = t.plain_text ?? '';
    if (!s) return '';
    const a = t.annotations ?? {};
    if (a.code) s = `\`${s}\``;
    if (a.bold) s = `**${s}**`;
    if (a.italic) s = `_${s}_`;
    const href = t.href ?? t.text?.link?.url;
    return href ? `[${s}](${href})` : s;
  }).join('');
}

export function pageId(ref) {
  const s = String(ref ?? '').trim().split(/[?#]/)[0];
  const hex = (s.match(/[0-9a-f]{32}$/i)?.[0] ?? s.replace(/-/g, '')).toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) throw new ProviderError('id must be a Notion page id or a page link.');
  return hex;
}

export function titleOf(obj) {
  if (obj?.object === 'database') return text(obj.title) || 'Untitled';
  const p = Object.values(obj?.properties ?? {}).find((x) => x?.type === 'title');
  return text(p?.title) || 'Untitled';
}

function propertyText(p) {
  switch (p?.type) {
    case 'title': case 'rich_text': return text(p[p.type]);
    case 'number': return p.number ?? '';
    case 'select': case 'status': return p[p.type]?.name ?? '';
    case 'multi_select': return (p.multi_select ?? []).map((o) => o.name).join(', ');
    case 'date': return p.date ? [p.date.start, p.date.end].filter(Boolean).join(' to ') : '';
    case 'people': return (p.people ?? []).map((u) => u.name ?? u.id).join(', ');
    case 'checkbox': return p.checkbox ? 'yes' : 'no';
    case 'url': case 'email': case 'phone_number': case 'created_time': case 'last_edited_time': return p[p.type] ?? '';
    case 'relation': return p.relation?.length ? `${p.relation.length} linked` : '';
    case 'formula': { const f = p.formula ?? {}; return f[f.type] ?? ''; }
    default: return '';
  }
}

function blockLine(b, depth, n) {
  const pad = '  '.repeat(depth);
  const v = b[b.type] ?? {};
  const t = md(v.rich_text);
  switch (b.type) {
    case 'paragraph': return `${pad}${t}`;
    case 'heading_1': return `${pad}# ${t}`;
    case 'heading_2': return `${pad}## ${t}`;
    case 'heading_3': return `${pad}### ${t}`;
    case 'bulleted_list_item': return `${pad}- ${t}`;
    case 'numbered_list_item': return `${pad}${n}. ${t}`;
    case 'to_do': return `${pad}- [${v.checked ? 'x' : ' '}] ${t}`;
    case 'toggle': return `${pad}- ${t}`;
    case 'quote': return `${pad}> ${t}`;
    case 'callout': return `${pad}> ${v.icon?.emoji ? `${v.icon.emoji} ` : ''}${t}`;
    case 'code': return `${pad}\`\`\`${v.language ?? ''}\n${text(v.rich_text)}\n${pad}\`\`\``;
    case 'equation': return `${pad}$$${v.expression ?? ''}$$`;
    case 'divider': return `${pad}---`;
    case 'child_page': return `${pad}Page: ${v.title ?? 'Untitled'} (id ${b.id})`;
    case 'child_database': return `${pad}Database: ${v.title ?? 'Untitled'} (id ${b.id})`;
    case 'table_row': return `${pad}| ${(v.cells ?? []).map((c) => md(c)).join(' | ')} |`;
    case 'image': case 'file': case 'pdf': case 'video': case 'audio': {
      const url = v.external?.url ?? v.file?.url ?? '';
      return `${pad}[${b.type}${v.caption?.length ? `: ${text(v.caption)}` : ''}](${url})`;
    }
    case 'bookmark': case 'embed': case 'link_preview': return `${pad}${v.url ?? ''}`;
    case 'table': case 'column_list': case 'column': case 'synced_block': return null;
    default: return `${pad}[${b.type}]`;
  }
}

export function createNotion({ token, fetchImpl, wait, now = Date.now, budgetMs = PAGE_BUDGET_MS }) {
  async function call(route, { method = 'GET', body } = {}) {
    const r = await request('Notion', new URL(route, API).toString(), {
      method, headers: { authorization: `Bearer ${token}`, 'notion-version': VERSION, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }, { fetchImpl, wait });
    const data = await readJson(r);
    if (r.status === 401) throw new ProviderError(RECONNECT, { code: 'reauth', status: 401 });
    if (r.status === 404 || data?.code === 'object_not_found') throw new ProviderError(NOT_SHARED, { code: 'not_found', status: 404 });
    if (!r.ok || !data) throw new ProviderError(`Notion refused the request (${data?.code ?? r.status}).`, { status: r.status });
    return data;
  }

  return {
    async search({ query, type, limit }) {
      const body = { page_size: clamp(limit, 1, 50, 10), ...(query ? { query: String(query) } : {}), ...(type === 'page' || type === 'database' ? { filter: { property: 'object', value: type } } : {}) };
      const d = await call('search', { method: 'POST', body });
      return { results: (d.results ?? []).map((o) => ({ id: o.id, type: o.object, title: titleOf(o), link: o.url ?? null, lastEdited: o.last_edited_time ?? null })), more: !!d.has_more };
    },
    async page({ id }) {
      const pid = pageId(id);
      const page = await call(`pages/${pid}`);
      const props = Object.entries(page.properties ?? {}).filter(([, p]) => p?.type !== 'title').map(([k, p]) => [k, propertyText(p)]).filter(([, v]) => v !== '' && v !== null);
      let count = 0, truncated = false;
      const started = now();
      const lines = [];
      async function walk(parent, depth) {
        let cursor;
        let n = 0;
        do {
          if (now() - started > budgetMs) { truncated = true; return; }
          const d = await call(`blocks/${parent}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`);
          for (const b of d.results ?? []) {
            if (count >= MAX_BLOCKS) { truncated = true; return; }
            count++;
            n = b.type === 'numbered_list_item' ? n + 1 : 0;
            const line = blockLine(b, depth, n);
            if (line !== null) lines.push(line);
            const nested = b.has_children && b.type !== 'child_page' && b.type !== 'child_database';
            // a block that renders nothing (a table, a column list) keeps its children at its own depth
            const next = line === null ? depth : depth + 1;
            if (nested && next < MAX_DEPTH) await walk(b.id, next);
            else if (nested) truncated = true;
          }
          cursor = d.has_more ? d.next_cursor : null;
        } while (cursor);
      }
      await walk(pid, 0);
      const title = titleOf(page);
      const markdown = [`# ${title}`, ...(props.length ? ['', ...props.map(([k, v]) => `- ${k}: ${v}`)] : []), '', ...lines].join('\n');
      return { id: page.id, title, link: page.url ?? null, lastEdited: page.last_edited_time ?? null, truncated, markdown };
    },
  };
}
