// sitegen-solve: a drop-in faster replacement for makefun-site 1.0.0's build().
// Same input contract ({ site, templates, files }), same output tree (path -> text),
// byte for byte, but rebuilt for speed:
//   - markdown is lexed and rendered in one fused pass, and inline rendering
//     escapes whole runs of plain text instead of one character at a time;
//   - templates compile once per case into closures instead of being walked
//     as a tree on every render;
//   - slugify, longDate and tag slugging take fast paths / memoisation;
//   - the pipeline keeps the reference's exact plugin order and report strings.

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const ESC_BY_CODE = { 38: '&amp;', 60: '&lt;', 62: '&gt;', 34: '&quot;', 39: '&#39;' };
function escapeHtml(text) {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) return text.replace(ESC_RE, (x) => ESC_MAP[x]);
  }
  return text;
}

// code-unit order, never the locale's
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const SLUG_MAX = 64;

// The slug of text: NFKD, combining marks dropped, A-Z lowered, every run of
// characters other than a-z/0-9 one "-", trimmed, cut to 64, "untitled" if empty.
// ASCII-only input (the common case) skips the normalisation entirely.
function slugify(text) {
  let plain = text;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) {
      plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
      break;
    }
  }
  let out = '';
  let gap = false;
  if (plain === text) {
    for (let i = 0; i < plain.length; i++) {
      const c = plain.charCodeAt(i);
      let keep = -1;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep === -1) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(keep);
    }
  } else {
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  }
  if (out.length > SLUG_MAX) out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function longDate(date) {
  const y = date.slice(0, 4);
  const d = date.slice(8, 10);
  return `${Number(d)} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${y}`;
}

// ---------------------------------------------------------------- markdown

const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;

// The characters a backslash escapes, as a lookup table over char codes.
const ESCAPABLE = new Uint8Array(128);
for (const c of '\\`*_[\\]()#+-.!>') ESCAPABLE[c.charCodeAt(0)] = 1;

function isEscapedNext(s, i) {
  // s[i] === '\\' and the next char is escapable
  const n = s.charCodeAt(i + 1);
  return i + 1 < s.length && n < 128 && ESCAPABLE[n] === 1;
}

function findUnescaped(s, what, from) {
  const w0 = what.charCodeAt(0);
  for (let j = from; j <= s.length - what.length; j++) {
    if (s.charCodeAt(j) === 92 && isEscapedNext(s, j)) {
      j++;
      continue;
    }
    if (s.charCodeAt(j) === w0 && (what.length === 1 || s.startsWith(what, j))) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && isEscapedNext(s, j)) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

// Inline rendering. Plain runs are scanned natively (one /g regex over the
// text) and appended without re-escaping; escapes, code spans, strong,
// emphasis and links branch exactly as the reference does. Plain runs never
// hold an escapable character, so their slices append raw.
const INLINE_SPECIAL = /[\\`*[\]&<>"']/g;

function inline(s, link) {
  let out = '';
  let fs = 0; // start of the pending plain run
  let n = s.length;
  INLINE_SPECIAL.lastIndex = fs;
  let m;
  while ((m = INLINE_SPECIAL.exec(s)) !== null) {
    const i = m.index;
    const c = s.charCodeAt(i);
    switch (c) {
      case 92: {
        if (!isEscapedNext(s, i)) continue; // a lone backslash stays in the run
        out += s.slice(fs, i);
        out += escapeHtml(s[i + 1]);
        fs = i + 2;
        INLINE_SPECIAL.lastIndex = fs;
        break;
      }
      case 96: {
        const j = s.indexOf('`', i + 1);
        if (j > i + 1) {
          out += s.slice(fs, i);
          out += `<code>${escapeHtml(s.slice(i + 1, j))}</code>`;
          fs = j + 1;
          INLINE_SPECIAL.lastIndex = fs;
        }
        break;
      }
      case 42: {
        if (s.charCodeAt(i + 1) === 42) {
          const j = findUnescaped(s, '**', i + 2);
          if (j > i + 2) {
            out += s.slice(fs, i);
            const saved = INLINE_SPECIAL.lastIndex;
            out += `<strong>${inline(s.slice(i + 2, j), link)}</strong>`;
            INLINE_SPECIAL.lastIndex = saved;
            fs = j + 2;
            INLINE_SPECIAL.lastIndex = fs;
            break;
          }
          INLINE_SPECIAL.lastIndex = i + 2;
          break;
        }
        const j = findSingleStar(s, i + 1);
        if (j > i + 1) {
          out += s.slice(fs, i);
          const saved = INLINE_SPECIAL.lastIndex;
          out += `<em>${inline(s.slice(i + 1, j), link)}</em>`;
          INLINE_SPECIAL.lastIndex = saved;
          fs = j + 1;
          INLINE_SPECIAL.lastIndex = fs;
          break;
        }
        break; // a lone star stays in the run
      }
      case 91: {
        const k = findUnescaped(s, ']', i + 1);
        const e = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
        const target = e === -1 ? '' : s.slice(k + 2, e);
        if (target !== '' && !/\s/.test(target)) {
          out += s.slice(fs, i);
          const saved = INLINE_SPECIAL.lastIndex;
          out += `<a href="${escapeHtml(link(target))}">${inline(s.slice(i + 1, k), link)}</a>`;
          INLINE_SPECIAL.lastIndex = saved;
          fs = e + 1;
          INLINE_SPECIAL.lastIndex = fs;
        }
        break; // an unmatched [ stays in the run
      }
      case 93:
        break; // a ] on its own stays in the run
      default: {
        // &, <, >, " or ': the run before it is clean, escape it directly
        out += s.slice(fs, i);
        out += ESC_BY_CODE[c];
        fs = i + 1;
        INLINE_SPECIAL.lastIndex = fs;
      }
    }
  }
  out += s.slice(fs);
  return out;
}

// One fused lex+render pass. `lines` are the body's lines ("\n" line ends,
// already split by the front-matter reader). Returns { html, toc, excerpt }.
function renderMarkdown(lines, link) {
  const blocks = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (line === '' || /^[ \t]*$/.test(line)) {
      i++;
      continue;
    }
    const first = line.charCodeAt(0);
    const fence = first === 96 ? FENCE_OPEN.exec(line) : null;
    if (fence !== null) {
      const body = [];
      i++;
      while (i < n && !FENCE_CLOSE.test(lines[i])) body.push(lines[i++]);
      i++;
      const cls = fence[1] === '' ? '' : ` class="language-${escapeHtml(fence[1])}"`;
      let code = '';
      for (const l of body) code += `${escapeHtml(l)}\n`;
      blocks.push(`<pre><code${cls}>${code}</code></pre>`);
      continue;
    }
    if (first === 35) {
      const h = HEADING.exec(line);
      if (h !== null && h[2] !== '') {
        const id = uniqueSlug(slugify(h[2]), ids);
        const html = inline(h[2], link);
        blocks.push(`<h${h[1].length} id="${id}">${html}</h${h[1].length}>`);
        const depth = h[1].length;
        if (depth === 2 || depth === 3) toc.push({ level: depth, id, html });
        i++;
        continue;
      }
    }
    if ((first === 45 || first === 42) && HR.test(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (first === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) body.push(lines[i++].replace(/^> ?/, ''));
      const kept = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), link)}</p>\n</blockquote>`);
      continue;
    }
    const bullet = first === 45 || first === 42 ? BULLET.exec(line) : null;
    const ordered = bullet === null && first >= 48 && first <= 57 ? ORDERED.exec(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? ORDERED : BULLET;
      const items = [];
      while (i < n) {
        const m = marker.exec(lines[i]);
        if (m !== null) {
          items.push(isOrdered ? trimLine(m[2]) : trimLine(m[1]));
          i++;
        } else if (CONTINUED.test(lines[i])) {
          items[items.length - 1] += `\n${trimLine(lines[i])}`;
          i++;
        } else break;
      }
      const start = isOrdered ? Number(ordered[1]) : 1;
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : isOrdered ? '<ol>' : '<ul>';
      let lis = '';
      for (const item of items) lis += `<li>${inline(item, link)}</li>\n`;
      blocks.push(`${open}\n${lis}${isOrdered ? '</ol>' : '</ul>'}`);
      continue;
    }
    // paragraph: gather until blank, fence, heading or thematic break
    const parts = [trimLine(line)];
    i++;
    while (i < n) {
      const l2 = lines[i];
      const f2 = l2.charCodeAt(0);
      if (l2 === '' || /^[ \t]*$/.test(l2)) break;
      if (f2 === 96 && FENCE_OPEN.test(l2)) break;
      if (f2 === 35 && HEADING.test(l2)) break;
      if ((f2 === 45 || f2 === 42) && HR.test(l2)) break;
      parts.push(trimLine(l2));
      i++;
    }
    const html = inline(parts.join('\n'), link);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  let out = '';
  for (const b of blocks) out += `${b}\n`;
  return { html: out, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = { title: 1, date: 1, tags: 1, draft: 1, layout: 1, slug: 1, summary: 1 };
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function fmString(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmString(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) if (t === '' || !FM_TAG.test(t)) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

function parseFrontMatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (line === '' || /^[ \t]*$/.test(line) || line.startsWith('#')) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (FM_KEYS[key] === undefined) return { error: `unknown key "${key}"` };
    if (key in data) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!('title' in data)) return { error: 'no title' };
  return { data, bodyLines: lines.slice(close + 1) };
}

// ---------------------------------------------------------------- templates

const INCLUDE_DEPTH = 8;
const T_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const T_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const T_IF = /^if (not )?(\S+)$/;
const T_INCLUDE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!T_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

// Scope-chain lookup, specialised per path at compile time.
function lookup(scope, path) {
  let s = scope;
  const head = path[0];
  while (s !== null && !Object.hasOwn(s.vars, head)) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[head];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) {
    let s = '';
    for (let k = 0; k < v.length; k++) {
      if (k > 0) s += ', ';
      s += textOf(v[k]);
    }
    return s;
  }
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// parseTemplate: the reference's parser, node shapes unchanged.
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = T_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = T_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = T_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// Compile a parsed template into closures. Each node becomes a function
// (scope, depth) -> string, so rendering skips node-kind dispatch entirely.
function compileNodes(nodes, templates) {
  const fns = [];
  for (const nd of nodes) fns.push(compileNode(nd, templates));
  return fns;
}

function compileNode(n, templates) {
  switch (n.kind) {
    case 'text': {
      const t = n.text;
      return () => t;
    }
    case 'var': {
      const p = n.path;
      return (scope) => escapeHtml(textOf(lookup(scope, p)));
    }
    case 'raw': {
      const p = n.path;
      return (scope) => textOf(lookup(scope, p));
    }
    case 'if': {
      const p = n.path;
      const not = n.not;
      const thenFns = n.then.length ? compileNodes(n.then, templates) : null;
      const elseFns = n.else && n.else.length ? compileNodes(n.else, templates) : null;
      return (scope, depth) => {
        const v = truthy(lookup(scope, p)) !== not;
        const branch = v ? thenFns : elseFns;
        if (branch === null) return '';
        let out = '';
        for (const f of branch) out += f(scope, depth);
        return out;
      };
    }
    case 'for': {
      const p = n.path;
      const name = n.name;
      const bodyFns = compileNodes(n.body, templates);
      return (scope, depth) => {
        const xs = lookup(scope, p);
        if (!Array.isArray(xs)) return '';
        let out = '';
        const len = xs.length;
        for (let k = 0; k < len; k++) {
          const vars = { [name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === len - 1, length: len } };
          for (const f of bodyFns) out += f({ vars, parent: scope }, depth);
        }
        return out;
      };
    }
    case 'include': {
      const incName = n.name;
      return (scope, depth) => {
        const nodes2 = templates.get(incName);
        if (nodes2 === undefined || depth >= INCLUDE_DEPTH) return '';
        let out = '';
        for (const f of nodes2) out += f(scope, depth + 1);
        return out;
      };
    }
  }
}

// ---------------------------------------------------------------- the build

const RESERVED = ['posts', 'tags', 'page'];

function wordsOf(text) {
  const m = text.match(/\S+/g);
  return m === null ? 0 : m.length;
}

// \S is "not \s": the ASCII whitespace set plus the unicode spaces, one table.
const WSFULL = new Int8Array(65536);
for (const c of [9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279]) WSFULL[c] = 1;

const trimLine = (line) => {
  const len = line.length;
  let a = 0;
  let b = len;
  // the reference trims only spaces and tabs here, never other whitespace
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === len ? line : line.slice(a, b);
};

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** One site's output tree: path -> text. */
export function build(input) {
  // templates, in code-unit order of their names; a template that does not
  // parse is reported and absent
  const report = [];
  const templateNodes = new Map();
  const names = Object.keys(input.templates).sort(cmp);
  for (const name of names) {
    try {
      templateNodes.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const compiled = new Map();
  for (const [name, nodes] of templateNodes) compiled.set(name, compileNodes(nodes, compiled));
  // compile order matters: includes look names up at render time, so this is safe
  // (compileNodes captures the map itself, not snapshots)

  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. sources: .md sorted by path (code units), the rest static
  const sources = [];
  const statics = [];
  const files = [...input.files].sort((x, y) => cmp(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. front matter, refusals and drafts
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.bodyLines = fm.bodyLines;
    s.post = s.path.startsWith('posts/');
    const own = s.post ? undefined : RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !('date' in fm.data)) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templateNodes.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  sources.length = 0;
  sources.push(...kept);

  // 3. permalinks: unique slugs per directory, in source order
  const bySource = new Map();
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. markdown, links resolved against pages and statics
  const brokenLinks = new Set();
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of sources) {
    const dir = dirOf(s.path);
    const link = (target) => {
      const c0 = target.charCodeAt(0);
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || c0 === 47 || c0 === 35) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
      if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
      return null; // broken
    };
    // broken links are reported after all pages build; the reference marks them
    // on the build, we collect them per source and merge after the loop
    const broken = [];
    const linkWithReport = (target) => {
      const r = link(target);
      if (r === null) {
        broken.push(target);
        return target;
      }
      return r;
    };
    const md = renderMarkdown(s.bodyLines, linkWithReport);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    if (broken.length > 0) for (const t of broken) brokenLinks.add(`broken-link ${s.path} -> ${t}`);
  }

  // 5. posts: newest first, then slug; neighbours
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => cmp(y.data.date, x.data.date) || cmp(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. tags: grouped by slug, first name met wins, count then slug order
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    const seen = new Set();
    const own = [];
    for (const name of p.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        own.push([name, slug]);
      }
    }
    for (const [name, slug] of own) {
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (!s.post) {
      const seen = new Set();
      s.tagRefs = [];
      for (const name of s.data.tags ?? []) {
        const slug = slugify(name);
        if (seen.has(slug)) continue;
        seen.add(slug);
        s.tagRefs.push(bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
      }
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || cmp(x.slug, y.slug));

  // 7. layouts
  const linkOf = (s) =>
    s === null
      ? null
      : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) };
  const cards = new Map();
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(countWords(s.bodyLines) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const countWords = (ls) => {
    let w = 0;
    for (const l of ls) {
      let inWord = false;
      for (let j = 0; j < l.length; j++) {
        if (WSFULL[l.charCodeAt(j)]) inWord = false;
        else if (!inWord) {
          inWord = true;
          w++;
        }
      }
    }
    return w;
  };
  for (const p of posts) {
    cards.set(p, cardOf(p));
  }
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const fns = compiled.get(name);
    if (fns === undefined) return null;
    const scope = { vars: { site, tags: allTags, recent, ...vars }, parent: null };
    let out = '';
    for (const f of fns) out += f(scope, 0);
    return out;
  };
  for (const s of sources) {
    const page = {
      ...cardOf(s),
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    // the reference rebuilds toc entries as fresh {level,id,html} objects;
    // ours already hold exactly those keys, so they pass through as-is
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. report (broken links are a set in the reference: a link is named once)
  const lines = [...report, ...brokenLinks].sort(cmp);
  const pageCount = sources.reduce((acc, s) => acc + (s.post ? 0 : 1), 0);
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}

/** The harness entry: makefun-site's answer for one case's input. */
export function run(input) {
  return build(input);
}
