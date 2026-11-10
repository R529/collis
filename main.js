'use strict';

const {
  Plugin,
  ItemView,
  Modal,
  Notice,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  moment,
} = require('obsidian');

const VIEW_TYPE_QM = 'qm-cards-view';

const DEFAULT_SETTINGS = {
  folderPath: '00-Inbox/速记',
  quickTags: [],
  maxCards: 500,
  trash: [],
  autoPruneEmptyDates: true,
};

const MONTH_FILE_RE = /^\d{4}-\d{2}\.md$/;

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

function genId() {
  let s = '';
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function padTime(t) {
  const m = String(t).match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return String(t);
  return (m[1].length === 1 ? '0' + m[1] : m[1]) + ':' + m[2];
}

function baseOf(path) {
  const name = String(path || '').split('/').pop() || '';
  return name.replace(/\.md$/i, '');
}

/* ------------------------------------------------------------------ */
/* 多行卡片：存储格式与行处理                                          */
/*                                                                    */
/* 一张卡片 = 一个 Markdown 列表项，换行写成缩进两空格的续行：          */
/*   - 16:57 第一行␠␠      行尾两空格 = Markdown 硬换行                */
/*     第二行 ^abc123      块 ID 挂在最后一行                          */
/* 这样插件视图和 Obsidian 阅读视图都能还原记录时的排版，单行旧卡片不变。 */
/* ------------------------------------------------------------------ */

const QM_CARD_RE = /^[-*][ \t]+(\d{1,2}:\d{2})[ \t]+(.*)$/;
const QM_CONT_INDENT = '  ';

/** 输入文本 -> 行数组：统一换行、去行尾空白、去首尾空行，保留中间空行 */
function qmBodyLines(text) {
  const lines = String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''));
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines;
}

/** 行数组 -> 可写入 md 的列表项（可能多行），块 ID 挂在最后一行 */
function qmFormatEntry(time, bodyLines, id) {
  const src = bodyLines && bodyLines.length ? bodyLines : [''];
  const out = src.map((l, i) => {
    const prefix = i === 0 ? '- ' + time + ' ' : QM_CONT_INDENT;
    const hardBreak = i < src.length - 1 && l.trim() ? '  ' : '';
    return prefix + l + hardBreak;
  });
  const last = out.length - 1;
  if (id) out[last] = out[last].replace(/[ \t]+$/, '') + ' ^' + id;
  return out;
}

/**
 * 卡片占用的行范围：返回最后一行下标（续行以空白缩进开头）。
 *
 * 缩进续行本身是贪婪的，光看缩进无法区分「插件写的续行」和「用户手写的
 * 嵌套清单 / 缩进代码 / 缩进备注」。插件写入的卡片一律以 ` ^id` 收尾，
 * 所以这里以「范围内最后一条 ^id 结尾的行」为界，其后的缩进行不再算进来。
 * 没有块 ID 的旧卡片保持原行为，既有文件的解析结果不会变。
 */
function qmCardBlockEnd(lines, start) {
  let end = start;
  for (let i = start + 1; i < lines.length; i++) {
    if (!/^[ \t]/.test(lines[i])) break;
    end = i;
  }
  if (end > start) {
    for (let i = end; i >= start; i--) {
      if (/[ \t]\^[A-Za-z0-9-]{4,}[ \t]*$/.test(lines[i])) {
        end = i;
        break;
      }
    }
  }
  while (end > start && lines[end].trim() === '') end--;
  return end;
}

/** 文件里出现过的块 ID 集合（用于避免重复 ID） */
function qmCollectIds(content) {
  const ids = new Set();
  const re = /[ \t]\^([A-Za-z0-9-]+)[ \t]*$/gm;
  let m;
  while ((m = re.exec(String(content || ''))) !== null) ids.add(m[1]);
  return ids;
}

/**
 * 判断一个文件是否「长得像」卡片文件：只允许日期标题、卡片行、缩进续行。
 * 用于切换文件夹时体检，避免把日记、剪藏之类按年月命名的笔记当卡片接管。
 */
function qmLooksLikeCardFile(content) {
  const lines = String(content || '').replace(/\r\n?/g, '\n').split('\n');
  let inDate = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (/^##[ \t]+\d{4}-\d{2}-\d{2}[ \t]*$/.test(line)) { inDate = true; continue; }
    if (!inDate) return false;                 // 日期段之外的正文
    if (/^##?[ \t]/.test(line)) return false;  // 别的标题
    if (QM_CARD_RE.test(line)) continue;
    if (/^[ \t]/.test(line)) continue;         // 缩进续行
    return false;
  }
  return true;
}

/** 把新卡片的若干行插到指定日期段末尾（纯函数，便于验证） */
function qmInsertCardLines(content, date, entryLines) {
  const raw = String(content || '').replace(/\r\n?/g, '\n');
  const lines = raw.split('\n');
  const headerRe = new RegExp('^##[ \\t]+' + escapeRe(date) + '[ \\t]*$');

  let hi = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headerRe.test(lines[i])) { hi = i; break; }
  }

  if (hi === -1) {
    let body = raw.replace(/\s+$/, '');
    if (body) body += '\n\n';
    return body + '## ' + date + '\n\n' + entryLines.join('\n') + '\n';
  }

  // 插到当天段落的末尾（最后一行非空内容之后），而不是紧跟卡片 ID 行：
  // 卡片后面可能跟着用户手写的缩进待办，新卡片插在中间会把它们挂到新卡片下面
  let last = -1;
  for (let i = hi + 1; i < lines.length; i++) {
    if (/^##[ \t]/.test(lines[i])) break;
    if (lines[i].trim()) last = i;
  }

  if (last >= 0) {
    lines.splice(last + 1, 0, ...entryLines);
    return lines.join('\n');
  }

  const tail = lines[hi + 1];
  if (tail !== undefined && tail.trim() === '') {
    lines.splice(hi + 2, 0, ...entryLines);
  } else {
    lines.splice(hi + 1, 0, '', ...entryLines);
  }
  return lines.join('\n');
}

/**
 * 清理空日期段：某个 `## YYYY-MM-DD` 下面除了空行什么都没有时，连标题一起删掉。
 * 只在删卡片后调用，且只处理这一天（onlyDate），不会动用户手写的其他段落。
 * 段内有任何非空内容（哪怕不是卡片）就原样保留，避免误删备注。
 */
function qmPruneEmptyDateSections(content, onlyDate) {
  const lines = String(content || '').replace(/\r\n?/g, '\n').split('\n');
  const headerRe = /^##[ \t]+(\d{4}-\d{2}-\d{2})[ \t]*$/;
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    const hm = lines[i].match(headerRe);
    if (!hm) {
      out.push(lines[i]);
      continue;
    }

    // 向下扫到下一个日期标题或文件末尾，判断这段是否已经空了
    let j = i + 1;
    let hasContent = false;
    while (j < lines.length && !headerRe.test(lines[j])) {
      if (lines[j].trim()) {
        hasContent = true;
        break;
      }
      j++;
    }

    if (hasContent || (onlyDate && hm[1] !== onlyDate)) {
      out.push(lines[i]);
      continue;
    }

    // 整段只剩空行：跳过标题与这些空行，并合并多出来的空白
    i = j - 1;
    while (out.length && !out[out.length - 1].trim()) out.pop();
    if (out.length) out.push('');
  }

  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.length ? out.join('\n') + '\n' : '';
}

/**
 * 清理文件里所有「只剩空行」的日期段，返回清理结果与被移除的日期。
 * skipDates 里的日期整段跳过：用于保护光标正停着的那一段，
 * 免得刚敲完 `## 2026-11-11` 还没写字就被收走。
 * 段内只要有一行非空内容（备注、待办、任何手写行）就原样保留。
 */
function qmStripEmptyDateSections(content, skipDates) {
  const lines = String(content || '').replace(/\r\n?/g, '\n').split('\n');
  const headerRe = /^##[ \t]+(\d{4}-\d{2}-\d{2})[ \t]*$/;
  const skip = skipDates instanceof Set ? skipDates : new Set(skipDates || []);
  const out = [];
  const removed = [];

  for (let i = 0; i < lines.length; i++) {
    const hm = lines[i].match(headerRe);
    if (!hm || skip.has(hm[1])) {
      out.push(lines[i]);
      continue;
    }

    let j = i + 1;
    let hasContent = false;
    while (j < lines.length) {
      if (headerRe.test(lines[j])) break;
      if (lines[j].trim()) {
        hasContent = true;
        break;
      }
      j++;
    }

    if (hasContent) {
      out.push(lines[i]);
      continue;
    }

    // 整段只剩空行：标题与这些空行一起收走，顺带压掉多出来的空白
    removed.push(hm[1]);
    i = j - 1;
    while (out.length && !out[out.length - 1].trim()) out.pop();
    if (out.length) out.push('');
  }

  while (out.length && !out[out.length - 1].trim()) out.pop();
  return { text: out.length ? out.join('\n') + '\n' : '', removed };
}

/**
 * 把恢复的卡片插回文件：日期段不存在时按日期升序补出来，
 * 段内按时间顺序插到合适位置。只插入，不覆盖任何已有行。
 */
function qmInsertRestoredCard(content, date, time, entryLines) {
  const raw = String(content || '').replace(/\r\n?/g, '\n');
  const lines = raw.split('\n');

  const hRe = /^##[ \t]+(\d{4}-\d{2}-\d{2})[ \t]*$/;

  let hi = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(hRe);
    if (m && m[1] === date) { hi = i; break; }
  }

  if (hi === -1) {
    // 日期段不在了：按日期升序找到该插入的位置，整段补出来
    let at = lines.length;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(hRe);
      if (m && m[1] > date) { at = i; break; }
    }
    const head = lines.slice(0, at);
    const tail = lines.slice(at);
    while (head.length && !head[head.length - 1].trim()) head.pop();
    while (tail.length && !tail[0].trim()) tail.shift();

    const out = head.concat(head.length ? [''] : [], ['## ' + date, ''], entryLines);
    if (tail.length) out.push('', ...tail);
    return out.join('\n').replace(/\n+$/, '') + '\n';
  }

  // 已有该日期段：找到最后一张「时间不晚于它」的卡片，插在它后面
  let at = hi + 1;
  for (let i = hi + 1; i < lines.length; i++) {
    if (/^##[ \t]/.test(lines[i])) break;
    const cm = lines[i].match(QM_CARD_RE);
    if (!cm) continue;
    const end = qmCardBlockEnd(lines, i);
    if (padTime(cm[1]) <= time) at = end + 1;
    i = end;
  }

  if (at === hi + 1) {
    if (lines[at] !== undefined && !lines[at].trim()) lines.splice(at + 1, 0, ...entryLines);
    else lines.splice(at, 0, '', ...entryLines);
  } else {
    lines.splice(at, 0, ...entryLines);
  }
  return lines.join('\n');
}

/**
 * 卡片正文 -> 可直接粘贴进 md 的纯文本。
 * 多行时给非空行补两个尾随空格（Markdown 硬换行），阅读视图也能保留排版；
 * 单行卡片原样返回，不添任何多余字符。
 */
function qmPasteText(body) {
  const lines = String(body || '').replace(/\r\n?/g, '\n').split('\n');
  return lines
    .map((l, i) => (i < lines.length - 1 && l.trim() ? l + '  ' : l))
    .join('\n');
}

/**
 * 解析单个文件里的卡片。
 * 卡片首行： - HH:mm 正文 #标签 ^blockid
 * 卡片续行：   正文（缩进两空格）
 * 日期段：   ## YYYY-MM-DD
 */
function parseCards(content, filePath) {
  const lines = String(content || '').replace(/\r\n?/g, '\n').split('\n');
  const cards = [];
  let curDate = '';
  const fileBase = baseOf(filePath);
  // 同一文件、同一日期段里首行完全相同的卡片，按出现顺序编号，
  // 用于没有块 ID 的旧卡片在写入前重新定位
  const dupSeen = new Map();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const hm = line.match(/^##[ \t]+(\d{4}-\d{2}-\d{2})[ \t]*$/);
    if (hm) {
      curDate = hm[1];
      continue;
    }

    const cm = line.match(QM_CARD_RE);
    if (!cm) continue;

    // 首行 + 所有缩进续行 = 这张卡片的完整正文
    const end = qmCardBlockEnd(lines, i);
    const parts = [cm[2] || ''];
    for (let j = i + 1; j <= end; j++) {
      parts.push(lines[j].replace(/^ {2}|^\t/, ''));
    }

    // Obsidian 只认「块最后一行」的 ^id；先记下末行是否已有合法 ID
    const lastPart = String(parts[parts.length - 1] || '').replace(/[ \t]+$/, '');
    const endId = lastPart.match(/[ \t]\^([A-Za-z0-9-]+)[ \t]*$/);

    // 去掉硬换行标记（行尾空格）；保留中间的换行与空行
    let body = parts
      .map((p) => p.replace(/[ \t]+$/, ''))
      .join('\n')
      .replace(/^\n+|\n+$/g, '');

    // 块 ID 可能在任意行末尾，全部剔除，正文里不显示
    const ids = [];
    body = body.replace(/[ \t]\^([A-Za-z0-9-]+)[ \t]*(?=$|\n)/gm, (m, p1) => {
      ids.push(p1);
      return '';
    });
    body = body.replace(/[ \t]+$/gm, '');
    const id = endId ? endId[1] : (ids[ids.length - 1] || '');
    const idOnLastLine = !!endId;

    const tags = [];
    const tagRe = /#([^\s#\[\]()]+)/g;
    let tm;
    while ((tm = tagRe.exec(body)) !== null) tags.push(tm[1]);

    const dupKey = (curDate || '') + '\u0000' + line;
    const dupIndex = dupSeen.get(dupKey) || 0;
    dupSeen.set(dupKey, dupIndex + 1);

    cards.push({
      date: curDate || '未分组',
      time: padTime(cm[1]),
      body,
      tags,
      lineIndex: i,
      lineEnd: end,
      id,
      idOnLastLine,
      dupIndex,
      raw: line,
      filePath,
      fileBase,
    });

    i = end; // 续行已归入本卡片，跳过
  }

  return cards;
}

/**
 * 在「刚读到的文件内容」里重新定位卡片，写入前必须先过这一关。
 * 顺序：块 ID 精确 → 同日期段第 N 条同文 → 正文唯一匹配。
 * 只有唯一命中才返回，否则返回 null：宁可不写，也不动错对象。
 */
function qmLocateCard(content, card) {
  if (!card || !card.filePath) return null;
  const cards = parseCards(content, card.filePath);

  if (card.id) {
    const hits = cards.filter((c) => c.id === card.id);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      // 手工复制粘贴可能造出重复 ID：再按时间 + 正文挑唯一的一条
      const exact = hits.filter((c) => c.time === card.time && c.body === card.body);
      return exact.length === 1 ? exact[0] : null;
    }
    return null; // ID 找不到：文件已在别处被改过
  }

  // 旧卡片没有块 ID：同日期段 + 同首行 + 序号
  const same = cards.filter((c) => c.date === card.date && c.raw === card.raw);
  if (!same.length) return null;
  const i = typeof card.dupIndex === 'number' ? card.dupIndex : 0;
  if (same[i] && same[i].body === card.body) return same[i];
  const byBody = same.filter((c) => c.body === card.body);
  return byBody.length === 1 ? byBody[0] : null;
}

function sortCards(cards) {
  cards.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    if (a.time !== b.time) return a.time < b.time ? 1 : -1;
    if (a.filePath !== b.filePath) return a.filePath < b.filePath ? 1 : -1;
    return b.lineIndex - a.lineIndex;
  });
  return cards;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 汇总可用标签：只从现有卡片里收集，卡片里没有的标签不会出现。
 * 设置里的「常用标签」只用于把常用项排到前面，不会凭空造出标签。
 * 因此删掉所有带某标签的卡片后，该标签会自动从候选里消失。
 */
function collectAllTags(cards, quickTags) {
  const count = new Map();
  for (const c of cards || []) {
    for (const t of c.tags || []) {
      const tag = String(t || '').trim();
      if (!tag) continue;
      count.set(tag, (count.get(tag) || 0) + 1);
    }
  }

  // 常用标签仅作为排序权重，必须先在卡片里真实存在
  const prefer = new Map();
  for (const t of quickTags || []) {
    const tag = String(t || '').replace(/^#/, '').trim();
    if (tag && count.has(tag)) prefer.set(tag, 1);
  }

  return Array.from(count.entries())
    .sort((a, b) => {
      const pa = prefer.has(a[0]) ? 1 : 0;
      const pb = prefer.has(b[0]) ? 1 : 0;
      if (pa !== pb) return pb - pa;
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0] < b[0] ? -1 : 1;
    })
    .map((x) => x[0]);
}

/**
 * 输入 # 时弹出标签候选。
 * 支持键盘上下选择、Enter/Tab 确认、Esc 关闭、鼠标点击。
 * 没有匹配项时提供「新建」选项，直接沿用已输入的文本。
 */
class TagSuggest {
  constructor(textarea, container, getTags) {
    this.ta = textarea;
    this.container = container;
    this.getTags = getTags;
    this.el = null;
    this.items = [];
    this.index = 0;
    this.active = false;
    this.q = null;
    this.seq = 0;
    this.navigated = false; // 用户是否用方向键/鼠标主动挑过候选

    this._onInput = () => this.update();
    this._onKey = (e) => this.onKey(e);
    this._onBlur = () => window.setTimeout(() => this.hide(), 160);
    this._onClick = () => this.update();
    this._onKeyup = (e) => {
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].indexOf(e.key) !== -1) this.update();
    };

    textarea.addEventListener('input', this._onInput);
    textarea.addEventListener('keydown', this._onKey, true);
    textarea.addEventListener('blur', this._onBlur);
    textarea.addEventListener('click', this._onClick);
    textarea.addEventListener('keyup', this._onKeyup);
  }

  destroy() {
    this.hide();
    this.ta.removeEventListener('input', this._onInput);
    this.ta.removeEventListener('keydown', this._onKey, true);
    this.ta.removeEventListener('blur', this._onBlur);
    this.ta.removeEventListener('click', this._onClick);
    this.ta.removeEventListener('keyup', this._onKeyup);
  }

  /** 取光标前正在输入的 #片段 */
  query() {
    const pos = this.ta.selectionStart;
    if (pos === null || pos === undefined) return null;
    const before = String(this.ta.value || '').slice(0, pos);
    const m = before.match(/#([^\s#\[\]()]*)$/);
    if (!m) return null;
    const start = pos - m[0].length;
    if (start > 0 && !/[\s]/.test(before.charAt(start - 1))) return null;
    return { start, end: pos, partial: m[1] };
  }

  update() {
    const q = this.query();
    if (!q) {
      this.hide();
      return;
    }
    const mySeq = ++this.seq;
    Promise.resolve()
      .then(() => this.getTags())
      .then((all) => {
        if (mySeq !== this.seq) return;
        this.applyQuery(q, Array.isArray(all) ? all : []);
      })
      .catch(() => {});
  }

  applyQuery(q, all) {
    const p = String(q.partial || '').toLowerCase();
    const matched = all
      .filter((t) => String(t).toLowerCase().indexOf(p) !== -1)
      .slice(0, 20);
    const exact = all.some((t) => String(t).toLowerCase() === p);

    const items = matched.map((t) => ({ tag: t, create: false }));
    if (p && !exact) items.push({ tag: q.partial, create: true });
    if (!items.length) {
      this.hide();
      return;
    }

    this.q = q;
    this.items = items;
    this.index = 0;
    this.render();
  }

  render() {
    this.navigated = false;
    if (!this.el) {
      this.el = this.container.createDiv({ cls: 'qm-suggest' });
    }
    this.el.empty();

    this.items.forEach((it, i) => {
      const row = this.el.createDiv({
        cls:
          'qm-suggest-item' +
          (i === this.index ? ' is-active' : '') +
          (it.create ? ' is-create' : ''),
      });
      row.setText(it.create ? '新建 #' + it.tag : '#' + it.tag);
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.pick(i);
      });
      row.addEventListener('mouseenter', () => {
        this.index = i;
        this.navigated = true;
        this.highlight();
      });
    });

    const top = this.ta.offsetTop + this.ta.offsetHeight + 4;
    const left = this.ta.offsetLeft;
    const width = Math.max(140, Math.min(this.ta.offsetWidth || 200, 280));
    this.el.style.top = top + 'px';
    this.el.style.left = left + 'px';
    this.el.style.width = width + 'px';

    this.active = true;
  }

  highlight() {
    if (!this.el) return;
    Array.from(this.el.children).forEach((r, i) => {
      if (i === this.index) r.addClass('is-active');
      else r.removeClass('is-active');
    });
  }

  hide() {
    this.seq++;
    this.active = false;
    this.q = null;
    this.items = [];
    if (this.el) {
      this.el.remove();
      this.el = null;
    }
  }

  onKey(e) {
    if (!this.active || !this.items.length) return;
    const n = this.items.length;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      this.navigated = true;
      this.index = (this.index + 1) % n;
      this.highlight();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      this.navigated = true;
      this.index = (this.index - 1 + n) % n;
      this.highlight();
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') return; // 留给保存
      // 刚打出 # 就按回车：让位给换行，和「Enter 换行」的提示保持一致；
      // 用方向键/鼠标挑过候选后，Enter 仍可确认；Tab 任何时候都确认。
      if (e.key === 'Enter' && !this.navigated) {
        this.hide();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      this.pick(this.index);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.hide();
    }
  }

  pick(i) {
    const it = this.items[i];
    if (!it || !this.q) return;

    const v = String(this.ta.value || '');
    const q = this.q;
    const head = v.slice(0, q.start);
    const tail = v.slice(q.end);
    const insert = '#' + it.tag + (/^[\s]/.test(tail) ? '' : ' ');
    const next = head + insert + tail;

    this.ta.value = next;
    const caret = head.length + insert.length;
    try {
      this.ta.setSelectionRange(caret, caret);
    } catch (err) {
      /* 忽略 */
    }

    this.hide();
    this.ta.focus();
  }
}

/* ------------------------------------------------------------------ */
/* 确认弹窗                                                            */
/* ------------------------------------------------------------------ */

class ConfirmModal extends Modal {
  constructor(app, text, onConfirm) {
    super(app);
    this.text = text;
    this.onConfirm = onConfirm;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('div', { text: this.text, cls: 'qm-confirm-text' });

    const bar = contentEl.createDiv({ cls: 'qm-edit-bar' });

    const cancel = bar.createEl('button', { text: '取消', cls: 'qm-mini-btn' });
    cancel.onclick = () => this.close();

    const ok = bar.createEl('button', { text: '删除', cls: 'qm-mini-btn is-primary' });
    ok.onclick = () => {
      this.close();
      this.onConfirm();
    };
  }

  onClose() {
    this.contentEl.empty();
  }
}

/* ------------------------------------------------------------------ */
/* 最近删除                                                            */
/* ------------------------------------------------------------------ */

class TrashModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('div', { text: '最近删除', cls: 'qm-modal-title' });

    const list = Array.isArray(this.plugin.settings.trash) ? this.plugin.settings.trash : [];

    if (!list.length) {
      contentEl.createEl('div', { text: '还没有删除过卡片。', cls: 'qm-hint' });
    } else {
      contentEl.createEl('div', {
        text: '恢复会按日期和时间插回原文件，只做插入，不会覆盖其它内容。最多保留 20 条。',
        cls: 'qm-hint',
      });

      const wrap = contentEl.createDiv({ cls: 'qm-trash-list' });
      for (const it of list) {
        const row = wrap.createDiv({ cls: 'qm-trash-item' });
        row.createDiv({
          cls: 'qm-trash-meta',
          text: (it.date || '未分组') + ' ' + (it.time || ''),
        });
        const txt = String(it.body || '').replace(/\s*\n\s*/g, ' ⏎ ');
        row.createDiv({ cls: 'qm-trash-body', text: txt || '（空）' });

        const acts = row.createDiv({ cls: 'qm-trash-acts' });
        const undo = acts.createEl('button', { text: '恢复', cls: 'qm-mini-btn is-primary' });
        undo.onclick = async () => {
          await this.plugin.restoreTrash(it.uid);
          this.onOpen();
        };
        const drop = acts.createEl('button', { text: '丢弃', cls: 'qm-mini-btn' });
        drop.onclick = async () => {
          await this.plugin.dropTrash(it.uid);
          this.onOpen();
        };
      }
    }

    const bar = contentEl.createDiv({ cls: 'qm-edit-bar' });
    if (list.length) {
      const clear = bar.createEl('button', { text: '清空', cls: 'qm-mini-btn' });
      clear.onclick = async () => {
        await this.plugin.clearTrash();
        this.onOpen();
      };
    }
    const close = bar.createEl('button', { text: '关闭', cls: 'qm-mini-btn' });
    close.onclick = () => this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}

/* ------------------------------------------------------------------ */
/* 快速记录弹窗                                                        */
/* ------------------------------------------------------------------ */

class CaptureModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('div', { text: '记一条', cls: 'qm-modal-title' });

    const taWrap = contentEl.createDiv({ cls: 'qm-modal-wrap' });
    const ta = taWrap.createEl('textarea', { cls: 'qm-input qm-modal-input' });
    ta.setAttr('placeholder', '想到什么就写什么，不需要标题…（输入 # 选择标签）');
    ta.rows = 5;

    new TagSuggest(ta, taWrap, async () => {
      const cards = await this.plugin.readAllCards();
      return collectAllTags(cards, this.plugin.settings.quickTags);
    });

    // 快捷标签：只显示当前卡片里真实存在的标签（已清理的不会残留）
    (async () => {
      let live = [];
      try {
        const cards = await this.plugin.readAllCards();
        live = collectAllTags(cards, this.plugin.settings.quickTags).slice(0, 8);
      } catch (e) {
        live = [];
      }
      if (!live.length) return;
      const bar = contentEl.createDiv({ cls: 'qm-quick-tags' });
      for (const t of live) {
        const chip = bar.createSpan({ text: '#' + t, cls: 'qm-quick-tag' });
        chip.onclick = () => {
          const cur = ta.value;
          ta.value = cur.replace(/\s+$/, '') + (cur.trim() ? ' ' : '') + '#' + t + ' ';
          ta.focus();
        };
      }
    })();

    contentEl.createEl('div', {
      cls: 'qm-hint',
      text: 'Enter 换行 · Ctrl+Enter 保存 · Esc 取消',
    });

    ta.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        this.submit(ta.value);
      }
    });

    const bar2 = contentEl.createDiv({ cls: 'qm-edit-bar' });
    const cancel = bar2.createEl('button', { text: '取消', cls: 'qm-mini-btn' });
    cancel.onclick = () => this.close();
    const ok = bar2.createEl('button', { text: '保存', cls: 'qm-mini-btn is-primary' });
    ok.onclick = () => this.submit(ta.value);

    window.setTimeout(() => ta.focus(), 30);
  }

  async submit(value) {
    const text = String(value || '').trim();
    if (!text) {
      this.close();
      return;
    }
    this.close();
    await this.plugin.appendCard(text);
  }

  onClose() {
    this.contentEl.empty();
  }
}

/* -------------------------------------------------------------- */
/* 标签层级工具（纯函数，便于独立验证）                                */
/* -------------------------------------------------------------- */

const QM_TAG_SEP = '/';

/** 把 "#自我/情绪" 拆成 ['自我','情绪']；丢弃空段、空白、非字符串 */
function qmSegs(tag) {
  if (typeof tag !== 'string') return [];
  const out = [];
  for (const raw of tag.split(QM_TAG_SEP)) {
    const s = raw.trim();
    if (s) out.push(s);
  }
  return out;
}

/** 统一比较用的路径键（小写、去空段） */
function qmLowerPath(path) {
  return qmSegs(path).map((s) => s.toLowerCase()).join(QM_TAG_SEP);
}

/** 同一层级出现多种写法时，选出现次数最多的（并列取字典序最小，保证稳定） */
function qmPickLabel(freq) {
  let best = '';
  let bestN = -1;
  for (const [label, n] of freq) {
    if (n > bestN) { best = label; bestN = n; }
    else if (n === bestN && label < best) { best = label; }
  }
  return best;
}

/**
 * 一次遍历建立标签树（只有两层：顶层组 + 组内子路径）。
 * 计数单一真相源：节点 cards 集合 = 该前缀及其所有后代的卡片（按卡去重）。
 * 因此「显示的数字」永远等于「点进去的条数」。
 */
function qmBuildTagTree(cards) {
  const index = new Map();   // lowerPath -> { key, segs, labelFreq, cards:Set<cardIndex> }
  const list = cards || [];
  let untagged = 0;

  for (let i = 0; i < list.length; i++) {
    const card = list[i] || {};
    const seen = new Set();
    let hasTag = false;
    for (const t of card.tags || []) {
      const segs = qmSegs(t);
      if (!segs.length) continue;          // 脏标签（"/"、"//"、空白、null）不产生节点
      hasTag = true;
      for (let d = 1; d <= segs.length; d++) {
        const part = segs.slice(0, d);
        const key = part.map((x) => x.toLowerCase()).join(QM_TAG_SEP);
        let node = index.get(key);
        if (!node) {
          node = { key, segs: part, labelFreq: new Map(), cards: new Set() };
          index.set(key, node);
        }
        const label = part.join(QM_TAG_SEP);
        node.labelFreq.set(label, (node.labelFreq.get(label) || 0) + 1);
        if (!seen.has(key)) { node.cards.add(i); seen.add(key); }
      }
    }
    if (!hasTag) untagged++;
  }

  const groups = [];
  const byKey = new Map();
  for (const node of index.values()) {
    if (node.segs.length !== 1) continue;
    const label = qmPickLabel(node.labelFreq);
    const g = { key: node.key, path: label, label, count: node.cards.size, children: [] };
    byKey.set(node.key, g);
    groups.push(g);
  }
  for (const node of index.values()) {
    if (node.segs.length < 2) continue;
    const g = byKey.get(node.segs[0].toLowerCase());
    if (!g) continue;
    g.children.push({
      path: node.segs.join(QM_TAG_SEP),
      label: node.segs.slice(1).join(QM_TAG_SEP),
      count: node.cards.size,
    });
  }
  for (const g of groups) {
    g.children.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh'));
  }
  groups.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh'));

  return { untagged, groups };
}

/** 卡片是否命中某个路径（从根开始逐段前缀匹配，兼容嵌套标签） */
function qmCardHasPath(card, pathLower) {
  const want = qmSegs(pathLower).map((s) => s.toLowerCase());
  if (!want.length) return false;
  for (const t of (card && card.tags) || []) {
    const segs = qmSegs(t).map((x) => x.toLowerCase());
    if (segs.length < want.length) continue;
    let ok = true;
    for (let i = 0; i < want.length; i++) {
      if (segs[i] !== want[i]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

/** 卡片是否完全没有有效标签 */
function qmCardIsUntagged(card) {
  for (const t of (card && card.tags) || []) {
    if (qmSegs(t).length) return false;
  }
  return true;
}

/* -------------------------------------------------------------- */
/* 标签层级工具 end                                                 */
/* -------------------------------------------------------------- */

/* ------------------------------------------------------------------ */
/* 卡片视图                                                            */
/* ------------------------------------------------------------------ */

class CardsView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.state = {
      search: '',
      activeTag: '',
      editingKey: null,
      cards: [],
      tagbarExpanded: false,
    };
  }

  get NO_TAG() {
    return '__qm_none__';
  }

  getViewType() {
    return VIEW_TYPE_QM;
  }

  getDisplayText() {
    return 'Collis';
  }

  getIcon() {
    return 'message-square';
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('qm-view');

    const wrap = root.createDiv({ cls: 'qm-root' });

    /* ---- 输入区 ---- */
    const inputWrap = wrap.createDiv({ cls: 'qm-input-wrap' });
    this.inputEl = inputWrap.createEl('textarea', { cls: 'qm-input' });
    this.inputEl.setAttr('placeholder', '记录一下…（Enter 换行 · Ctrl+Enter 记下）');
    this.inputEl.rows = 2;

    // 多行输入时跟随内容长高（上限与 CSS 的 200px 一致）
    this.autoGrow = () => {
      this.inputEl.style.height = 'auto';
      this.inputEl.style.height = Math.min(200, this.inputEl.scrollHeight) + 'px';
    };
    this.inputEl.addEventListener('input', this.autoGrow);

    this.tagSuggest = new TagSuggest(this.inputEl, inputWrap, () =>
      collectAllTags(this.state ? this.state.cards : [], this.plugin.settings.quickTags)
    );

    const toolbar = inputWrap.createDiv({ cls: 'qm-toolbar' });
    const saveBtn = toolbar.createEl('button', { text: '记下', cls: 'qm-save' });
    saveBtn.onclick = () => this.saveInput();

    this.inputEl.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        this.saveInput();
      }
    });

    /* ---- 筛选区 ---- */
    const filter = wrap.createDiv({ cls: 'qm-filter' });
    const searchRow = filter.createDiv({ cls: 'qm-search-row' });

    this.searchEl = searchRow.createEl('input', { cls: 'qm-search' });
    this.searchEl.setAttr('type', 'text');
    this.searchEl.setAttr('placeholder', '搜索全部卡片…');
    this.searchEl.addEventListener('input', () => {
      this.state.search = this.searchEl.value.trim();
      this.renderList();
    });

    this.tagbarEl = filter.createDiv({ cls: 'qm-tagbar' });

    /* ---- 列表区 ---- */
    this.listEl = wrap.createDiv({ cls: 'qm-list' });

    /* ---- 底部栏 ---- */
    const footer = wrap.createDiv({ cls: 'qm-footer' });
    this.footerInfoEl = footer.createSpan({ cls: 'qm-footer-info', text: '' });
    const right = footer.createDiv({ cls: 'qm-footer-right' });
    this.trashEl = right.createSpan({ cls: 'qm-open-file qm-trash-open', text: '' });
    this.trashEl.onclick = () => new TrashModal(this.app, this.plugin).open();
    const openFile = right.createSpan({ cls: 'qm-open-file', text: '打开本月文件' });
    openFile.onclick = () => this.plugin.openCurrentMonthFile();

    const onChange = (f) => {
      if (!(f instanceof TFile)) return;
      const prefix = this.plugin.settings.folderPath;
      if (f.path.indexOf(prefix + '/') !== 0) return;
      if (!MONTH_FILE_RE.test(f.name)) return;
      this.refresh();
    };

    this.registerEvent(this.app.vault.on('modify', onChange));
    this.registerEvent(this.app.vault.on('create', onChange));
    this.registerEvent(this.app.vault.on('delete', onChange));

    await this.refresh();
  }

  async onClose() {
    if (this.tagSuggest) {
      this.tagSuggest.destroy();
      this.tagSuggest = null;
    }
    this.contentEl.empty();
  }

  insertTag(tag) {
    const cur = this.inputEl.value;
    const add = '#' + tag + ' ';
    const needsSpace = cur.length > 0 && !/\s$/.test(cur);
    this.inputEl.value = cur + (needsSpace ? ' ' : '') + add;
    this.inputEl.focus();
  }

  async saveInput() {
    const text = String(this.inputEl.value || '').trim();
    if (!text) {
      new Notice('写点什么再记下吧');
      return;
    }
    this.inputEl.value = '';
    if (this.autoGrow) this.autoGrow();
    await this.plugin.appendCard(text);
    this.inputEl.focus();
  }

  async refresh() {
    // 全量载入：搜索与标签筛选必须覆盖所有卡片
    const cards = await this.plugin.readAllCards();
    this.state.cards = cards;
    this.renderTagbar();
    this.renderList();
  }

  renderTagbar() {
    const el = this.tagbarEl;
    if (!el) return;
    el.empty();

    const NONE = this.NO_TAG;
    const tree = qmBuildTagTree(this.state.cards);
    const act = this.state.activeTag;
    const actLower = act && act !== NONE ? qmLowerPath(act) : '';
    const actGroupKey = actLower ? actLower.split(QM_TAG_SEP)[0] : '';

    el.toggleClass('is-expanded', !!this.state.tagbarExpanded);

    /* ---- 第一行：全部 / 无标签 / 顶层组 / 更多 ---- */
    const row1 = el.createDiv({ cls: 'qm-tagbar-row1' });

    const all = row1.createSpan({
      text: '全部 ' + this.state.cards.length,
      cls: 'qm-tagbar-item' + (act ? '' : ' is-active'),
    });
    all.onclick = () => {
      this.state.activeTag = '';
      this.renderTagbar();
      this.renderList();
    };

    const none = row1.createSpan({
      text: '无标签 ' + tree.untagged,
      cls: 'qm-tagbar-item qm-tagbar-none' + (act === NONE ? ' is-active' : ''),
    });
    none.onclick = () => {
      this.state.activeTag = act === NONE ? '' : NONE;
      this.renderTagbar();
      this.renderList();
    };

    const LIMIT = 4;
    const expanded = !!this.state.tagbarExpanded;
    const groups = tree.groups;
    let shown = expanded ? groups.slice() : groups.slice(0, LIMIT);

    // 当前选中的组始终可见（即使被折叠到「更多」里，也不改变它的位置）
    const activeGroup = actGroupKey ? groups.find((g) => g.key === actGroupKey) : null;
    if (activeGroup && !shown.some((g) => g.key === activeGroup.key)) {
      shown = [activeGroup].concat(shown);
    }

    const chips = row1.createDiv({ cls: 'qm-tagbar-chips' });
    for (const g of shown) {
      const inGroup = !!actGroupKey && actGroupKey === g.key;
      const isWhole = inGroup && actLower === g.key;
      let text = '#' + g.label + ' ' + g.count;
      if (g.children.length) text += inGroup ? ' \u25b4' : ' \u25be';
      const chip = chips.createSpan({
        text,
        cls: 'qm-tagbar-item' +
          (g.children.length ? ' qm-tagbar-group' : '') +
          (inGroup ? ' is-in-group' : '') +
          (isWhole ? ' is-active' : ''),
      });
      chip.onclick = () => {
        // 已在该组：再点一次回到「全部」；在子标签里：回到整组；其它：进入该组
        this.state.activeTag = isWhole ? '' : g.path;
        this.renderTagbar();
        this.renderList();
      };
    }

    if (groups.length > LIMIT || expanded) {
      const rest = Math.max(0, groups.length - LIMIT);
      const fold = row1.createSpan({
        cls: 'qm-tagbar-fold',
        text: expanded ? '收起 \u25b4' : '更多 ' + rest + ' \u25be',
      });
      fold.onclick = () => {
        this.state.tagbarExpanded = !this.state.tagbarExpanded;
        this.renderTagbar();
      };
    }

    /* ---- 第二行：仅当选中组有子标签时出现 ---- */
    if (activeGroup && activeGroup.children.length) {
      const row2 = el.createDiv({ cls: 'qm-tagbar-row2' });

      const whole = row2.createSpan({
        text: '整组 ' + activeGroup.count,
        cls: 'qm-tagbar-item qm-tagbar-whole' +
          (actLower === activeGroup.key ? ' is-active' : ''),
      });
      whole.onclick = () => {
        this.state.activeTag = activeGroup.path;
        this.renderTagbar();
        this.renderList();
      };

      for (const ch of activeGroup.children) {
        const chLower = qmLowerPath(ch.path);
        const chip = row2.createSpan({
          text: '#' + ch.path + ' ' + ch.count,
          cls: 'qm-tagbar-item' + (actLower === chLower ? ' is-active' : ''),
        });
        chip.onclick = () => {
          // 再点一次已选中的子标签，退回整组
          this.state.activeTag = actLower === chLower ? activeGroup.path : ch.path;
          this.renderTagbar();
          this.renderList();
        };
      }
    }
  }

  filtered() {
    const kw = this.state.search.toLowerCase();
    const tag = this.state.activeTag;
    return this.state.cards.filter((c) => {
      if (tag === this.NO_TAG) {
        if (!qmCardIsUntagged(c)) return false;
      } else if (tag) {
        if (!qmCardHasPath(c, tag)) return false;
      }
      if (kw && c.body.toLowerCase().indexOf(kw) === -1) return false;
      return true;
    });
  }

  renderList() {
    const el = this.listEl;
    if (!el) return;
    el.empty();

    // 命中范围始终是全量卡片，仅限制渲染条数以保证流畅
    const matched = this.filtered();
    const cap = this.plugin.settings.maxCards;
    const list = cap > 0 ? matched.slice(0, cap) : matched;

    if (this.footerInfoEl) {
      const total = this.state.cards.length;
      if (matched.length > 0 && list.length < matched.length) {
        this.footerInfoEl.setText('命中 ' + matched.length + ' 条 · 显示最近 ' + list.length + ' 条');
      } else {
        this.footerInfoEl.setText('共 ' + total + ' 条');
      }
    }

    if (this.trashEl) {
      const n = (this.plugin.settings.trash || []).length;
      this.trashEl.setText(n ? '最近删除 ' + n : '');
      this.trashEl.toggleClass('is-hidden', !n);
    }

    if (!list.length) {
      const empty = el.createDiv({ cls: 'qm-empty' });
      if (this.state.cards.length === 0) {
        empty.setText('还没有卡片。在上面写一句，Ctrl+Enter 记下。');
      } else {
        empty.setText('没有匹配的卡片。');
      }
      return;
    }

    let lastDate = '';
    for (const card of list) {
      if (card.date !== lastDate) {
        lastDate = card.date;
        el.createDiv({ cls: 'qm-day', text: card.date });
      }
      this.renderCard(el, card);
    }
  }

  cardKey(card) {
    if (card.id) return (card.filePath || '') + '|' + card.id;
    // 没有块 ID 时加上同文序号，避免两条一模一样的卡片共用同一个编辑态
    return (
      (card.filePath || '') +
      '|' +
      card.date +
      '|' +
      card.time +
      '|' +
      (typeof card.dupIndex === 'number' ? card.dupIndex : 0) +
      '|' +
      card.body
    );
  }

  renderCard(parent, card) {
    const key = this.cardKey(card);
    const box = parent.createDiv({ cls: 'qm-card' });

    const head = box.createDiv({ cls: 'qm-card-head' });
    head.createSpan({ cls: 'qm-time', text: card.time });

    /* ---- 编辑态 ---- */
    if (this.state.editingKey === key) {
      const ta = box.createEl('textarea', { cls: 'qm-edit' });
      ta.value = card.body;
      ta.rows = Math.min(12, Math.max(2, card.body.split('\n').length + 1));
      window.setTimeout(() => {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }, 20);

      const bar = box.createDiv({ cls: 'qm-edit-bar' });
      const cancel = bar.createEl('button', { text: '取消', cls: 'qm-mini-btn' });
      cancel.onclick = () => {
        this.state.editingKey = null;
        this.renderList();
      };
      const ok = bar.createEl('button', { text: '保存', cls: 'qm-mini-btn is-primary' });
      ok.onclick = async () => {
        const v = String(ta.value || '').trim();
        if (!v) {
          new Notice('内容不能为空');
          return;
        }
        this.state.editingKey = null;
        await this.plugin.updateCard(card, v);
      };

      ta.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          ok.onclick();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          this.state.editingKey = null;
          this.renderList();
        }
      });
      return;
    }

    /* ---- 正文本（标签高亮） ---- */
    const body = box.createDiv({ cls: 'qm-body' });
    const re = /#([^\s#\[\]()]+)/g;
    let last = 0;
    let m;
    while ((m = re.exec(card.body)) !== null) {
      if (m.index > last) {
        body.appendChild(document.createTextNode(card.body.slice(last, m.index)));
      }
      const tag = body.createSpan({ cls: 'qm-tag', text: m[0] });
      const tv = m[1];
      tag.onclick = (e) => {
        e.stopPropagation();
        this.state.activeTag = tv;
        this.renderTagbar();
        this.renderList();
      };
      last = m.index + m[0].length;
    }
    if (last < card.body.length) {
      body.appendChild(document.createTextNode(card.body.slice(last)));
    }

    /* ---- 操作 ---- */
    const acts = box.createDiv({ cls: 'qm-actions' });

    // 默认复制正文全文：粘贴即见内容，不依赖块 ID，卡片删掉也不影响
    const copyText = acts.createSpan({ cls: 'qm-act', text: '复制全文' });
    copyText.onclick = async (e) => {
      e.stopPropagation();
      await this.plugin.copy(qmPasteText(card.body));
      new Notice('已复制卡片全文');
    };

    // 需要回链时才用块引用：先确保 ID 落在 Obsidian 认得的块末行
    const copyRef = acts.createSpan({ cls: 'qm-act', text: '复制块引用' });
    copyRef.onclick = async (e) => {
      e.stopPropagation();
      const id = await this.plugin.ensureId(card);
      if (!id) {
        new Notice('没找到这张卡片，请改用「复制全文」');
        return;
      }
      const ref = `![[${card.fileBase}#^${id}]]`;
      await this.plugin.copy(ref);
      new Notice('已复制：' + ref);
    };

    const edit = acts.createSpan({ cls: 'qm-act', text: '编辑' });
    edit.onclick = () => {
      this.state.editingKey = key;
      this.renderList();
    };

    const del = acts.createSpan({ cls: 'qm-act is-danger', text: '删除' });
    del.onclick = () => {
      new ConfirmModal(this.app, '删除这条卡片？', async () => {
        await this.plugin.deleteCard(card);
      }).open();
    };
  }
}

/* ------------------------------------------------------------------ */
/* 设置面板                                                            */
/* ------------------------------------------------------------------ */

class QuickMemoSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h3', { text: 'Collis 设置' });

    new Setting(containerEl)
      .setName('卡片文件夹')
      .setDesc(
        '卡片按月存成 YYYY-MM.md。文件夹不存在会自动创建；切换时会先检查目标文件夹里已有的年月文件，' +
          '发现不像卡片文件（比如日记、剪藏）就拒绝切换，避免误改别的笔记。'
      )
      .addText((t) => {
        t.setValue(this.plugin.settings.folderPath);
        const apply = async () => {
          const val = String(t.getValue() || '').trim().replace(/^\/+|\/+$/g, '');
          if (!val || val === this.plugin.settings.folderPath) {
            t.setValue(this.plugin.settings.folderPath);
            return;
          }
          const check = await this.plugin.validateFolderTarget(val);
          if (!check.ok) {
            new Notice('未切换：' + check.reason, 8000);
            t.setValue(this.plugin.settings.folderPath);
            return;
          }
          this.plugin.settings.folderPath = val;
          await this.plugin.saveSettings();
          new Notice('卡片文件夹已切换到 ' + val);
        };
        t.inputEl.addEventListener('blur', () => {
          apply();
        });
        t.inputEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            apply();
            t.inputEl.blur();
          }
        });
      });

    new Setting(containerEl)
      .setName('常用标签')
      .setDesc('用逗号分隔，仅用于把常用标签排在候选前面；卡片里不存在的标签不会出现。')
      .addText((t) =>
        t
          .setValue(this.plugin.settings.quickTags.join(','))
          .onChange(async (v) => {
            this.plugin.settings.quickTags = String(v || '')
              .split(/[,，\s]+/)
              .map((s) => s.replace(/^#/, '').trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('最多渲染条数')
      .setDesc('为保证流畅，列表最多渲染多少条（0 表示不限制）。搜索和标签筛选始终覆盖全部卡片，不受此项影响。')
      .addText((t) =>
        t.setValue(String(this.plugin.settings.maxCards)).onChange(async (v) => {
          const n = parseInt(v, 10);
          this.plugin.settings.maxCards = isNaN(n) ? 500 : Math.max(0, n);
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('自动清理空日期标题')
      .setDesc(
        '某一天的卡片全部删掉后，把这个只剩空白的 ## 日期 标题也一并去掉。' +
          '在编辑器里手动删卡片同样会清理；光标停在哪个日期段里，哪一段就暂时不动。'
      )
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.autoPruneEmptyDates !== false).onChange(async (v) => {
          this.plugin.settings.autoPruneEmptyDates = v;
          await this.plugin.saveSettings();
        })
      );
  }
}

/* ------------------------------------------------------------------ */
/* 插件主体                                                            */
/* ------------------------------------------------------------------ */

class QuickMemoPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_QM, (leaf) => new CardsView(leaf, this));

    this.addRibbonIcon('message-square', 'Collis', async () => {
      await this.activateView();
    });

    this.addCommand({
      id: 'open-cards',
      name: '打开卡片视图',
      callback: async () => this.activateView(),
    });

    this.addCommand({
      id: 'quick-capture',
      name: '快速记一条',
      hotkeys: [{ modifiers: ['Ctrl', 'Shift'], key: 'K' }],
      callback: () => new CaptureModal(this.app, this).open(),
    });

    this.addSettingTab(new QuickMemoSettingTab(this.app, this));

    // 文件被改动后顺手收走空的日期标题：不论是插件删的，
    // 还是你在 Obsidian 编辑器里手动删掉的卡片
    this.registerEvent(this.app.vault.on('modify', (f) => this.pruneSoon(f)));
  }

  onunload() {
    if (this._pruneTimers) {
      for (const t of this._pruneTimers.values()) clearTimeout(t);
      this._pruneTimers.clear();
    }
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_QM);
  }

  async loadSettings() {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data || {});

    // 旧版本用单文件 filePath，这里迁移成文件夹
    if (data && data.filePath && !data.folderPath) {
      const old = String(data.filePath);
      const idx = old.lastIndexOf('/');
      this.settings.folderPath = idx > 0 ? old.slice(0, idx) : DEFAULT_SETTINGS.folderPath;
    }

    if (!Array.isArray(this.settings.quickTags)) {
      this.settings.quickTags = DEFAULT_SETTINGS.quickTags.slice();
    }
    if (!Array.isArray(this.settings.trash)) {
      this.settings.trash = [];
    }

    const folder = String(this.settings.folderPath || '').replace(/^\/+|\/+$/g, '');
    this.settings.folderPath = folder && folder !== '.' ? folder : DEFAULT_SETTINGS.folderPath;
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.notifyViews();
  }

  /* ---------------- 路径 ---------------- */

  folderPathSafe() {
    const raw = String(this.settings.folderPath || '').replace(/^\/+|\/+$/g, '');
    return raw === '.' ? '' : raw;
  }

  monthPath(m) {
    const folder = this.folderPathSafe();
    const name = m.format('YYYY-MM') + '.md';
    return folder ? folder + '/' + name : name;
  }

  /**
   * 写入前的路径断言：只允许改「当前文件夹下、按月命名」的文件，
   * 卡片日期所在月份还必须与文件名一致。跨月归档、目录被改指时直接拦下。
   */
  checkManagedFile(file, cardDate) {
    const folder = this.folderPathSafe();
    if (!folder) return { ok: false, reason: '还没有设置卡片文件夹' };
    if (!(file instanceof TFile)) return { ok: false, reason: '卡片文件已不存在' };
    if (!MONTH_FILE_RE.test(file.name)) return { ok: false, reason: '目标文件不是按月卡片文件' };
    const parent = String(file.path).split('/').slice(0, -1).join('/');
    if (parent !== folder) return { ok: false, reason: '卡片文件不在当前文件夹里' };
    if (cardDate && /^\d{4}-\d{2}-\d{2}$/.test(cardDate) && cardDate.slice(0, 7) !== baseOf(file.path)) {
      return { ok: false, reason: '卡片日期与文件月份不一致' };
    }
    return { ok: true };
  }

  /** 切换文件夹前的体检：不允许把不像卡片的年月文件接管过来 */
  async validateFolderTarget(path) {
    const val = String(path || '').trim().replace(/^\/+|\/+$/g, '');
    if (!val) return { ok: false, reason: '文件夹不能为空' };
    if (val.indexOf('..') !== -1) return { ok: false, reason: '路径里不能出现 ..' };
    if (val === '.obsidian' || val.indexOf('.obsidian/') === 0) {
      return { ok: false, reason: '不能放在 .obsidian 里' };
    }

    const af = this.app.vault.getAbstractFileByPath(val);
    if (af && !(af instanceof TFolder)) return { ok: false, reason: '这是一个文件，不是文件夹' };
    if (!(af instanceof TFolder)) return { ok: true }; // 不存在：首次写入时创建

    const months = af.children.filter((f) => f instanceof TFile && MONTH_FILE_RE.test(f.name));
    for (const f of months) {
      let content = '';
      try {
        content = await this.app.vault.cachedRead(f);
      } catch (e) {
        continue;
      }
      if (!qmLooksLikeCardFile(content)) {
        return { ok: false, reason: f.name + ' 里有卡片以外的内容，像是别的笔记' };
      }
    }
    return { ok: true };
  }

  async ensureFolder(dir) {
    const parts = String(dir || '').split('/').filter(Boolean);
    let cur = '';
    for (const p of parts) {
      cur = cur ? cur + '/' + p : p;
      if (!this.app.vault.getAbstractFileByPath(cur)) {
        try {
          await this.app.vault.createFolder(cur);
        } catch (e) {
          /* 已存在则忽略 */
        }
      }
    }
  }

  async ensureFileAt(path) {
    const exist = this.app.vault.getAbstractFileByPath(path);
    if (exist instanceof TFile) return exist;

    const idx = path.lastIndexOf('/');
    if (idx > 0) await this.ensureFolder(path.slice(0, idx));

    try {
      return await this.app.vault.create(path, '');
    } catch (e) {
      const again = this.app.vault.getAbstractFileByPath(path);
      if (again instanceof TFile) return again;
      throw e;
    }
  }

  /* ---------------- 读取 ---------------- */

  listCardFiles() {
    const folder = this.app.vault.getAbstractFileByPath(this.settings.folderPath);
    if (!(folder instanceof TFolder)) return [];
    return folder.children
      .filter((f) => f instanceof TFile && MONTH_FILE_RE.test(f.name))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  async readAllCards() {
    const files = this.listCardFiles();
    const all = [];
    for (const f of files) {
      let content = '';
      try {
        content = await this.app.vault.cachedRead(f);
      } catch (e) {
        content = await this.app.vault.read(f);
      }
      all.push(...parseCards(content, f.path));
    }
    return sortCards(all);
  }

  /* ---------------- 写入 ---------------- */

  async mutateFile(path, fn) {
    const folder = this.folderPathSafe();
    const name = String(path).split('/').pop();
    if (!folder || String(path).indexOf(folder + '/') !== 0 || !MONTH_FILE_RE.test(name)) {
      throw new Error('拒绝写入非卡片文件：' + path);
    }
    const file = await this.ensureFileAt(path);
    await this.app.vault.process(file, (data) => {
      const res = fn(String(data || ''));
      return typeof res === 'string' ? res : data;
    });
    this.notifyViews();
  }

  /**
   * 针对既有卡片的写入：先按当前文件内容重新定位，定位不到就不写。
   * 这样即使卡片在别处被改过（编辑器、同步、另一个窗口），也不会误删误改。
   */
  async mutateCardFile(card, fn) {
    const file = this.app.vault.getAbstractFileByPath(card.filePath);
    const guard = this.checkManagedFile(file, card.date);
    if (!guard.ok) return guard;

    let out = { ok: false, reason: '文件已在别处修改，已刷新' };
    await this.app.vault.process(file, (data) => {
      const content = String(data || '').replace(/\r\n?/g, '\n');
      const hit = qmLocateCard(content, card);
      if (!hit) {
        out = { ok: false, reason: '这条卡片已经不在原位了' };
        return data;
      }
      const res = fn(content.split('\n'), hit);
      if (typeof res !== 'string') {
        out = { ok: false, reason: '这条卡片已经不在原位了' };
        return data;
      }
      out = { ok: true, hit };
      return res;
    });
    this.notifyViews();
    return out;
  }

  uniqueIdIn(content) {
    const ids = qmCollectIds(content);
    let id = genId();
    let guard = 0;
    while (ids.has(id) && guard++ < 50) id = genId();
    return id;
  }

  notifyViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_QM)) {
      const v = leaf.view;
      if (v && v.refresh) v.refresh();
    }
  }

  /* ---------------- 空日期标题自动清理 ---------------- */

  /** 光标正停在哪个日期段里：这一段本轮不清理，避免打断正在写的内容 */
  cursorDatesIn(file) {
    const dates = new Set();
    const leaves = this.app.workspace.getLeavesOfType('markdown');
    for (const leaf of leaves) {
      const view = leaf.view;
      if (!view || !view.file || view.file.path !== file.path) continue;
      const editor = view.editor;
      if (!editor) continue;
      let lines = [];
      let line = 0;
      try {
        lines = String(editor.getValue() || '').split('\n');
        line = editor.getCursor('head').line;
      } catch (e) {
        continue;
      }
      for (let i = Math.min(line, lines.length - 1); i >= 0; i--) {
        const m = lines[i].match(/^##[ \t]+(\d{4}-\d{2}-\d{2})[ \t]*$/);
        if (m) {
          dates.add(m[1]);
          break;
        }
      }
    }
    return dates;
  }

  /**
   * 文件被改动后安排一次清理。不管是插件删的、还是你在编辑器里手动删的，
   * 只要某一天的卡片全没了，这个日期标题就会被收走。
   */
  pruneSoon(file) {
    if (!this.settings.autoPruneEmptyDates) return;
    if (!(file instanceof TFile)) return;
    if (!this.checkManagedFile(file).ok) return;

    if (!this._pruneTimers) this._pruneTimers = new Map();
    const old = this._pruneTimers.get(file.path);
    if (old) clearTimeout(old);

    const timer = setTimeout(() => {
      this._pruneTimers.delete(file.path);
      this.pruneEmptyDates(file);
    }, 1000);
    this._pruneTimers.set(file.path, timer);
  }

  async pruneEmptyDates(file) {
    if (!this.settings.autoPruneEmptyDates) return;

    const target = this.app.vault.getAbstractFileByPath(file.path);
    if (!(target instanceof TFile)) return;
    if (!this.checkManagedFile(target).ok) return;

    let content = '';
    try {
      content = await this.app.vault.read(target);
    } catch (e) {
      return;
    }
    if (!content || content.indexOf('##') === -1) return;

    const skip = this.cursorDatesIn(target);
    if (!qmStripEmptyDateSections(content, skip).removed.length) return;

    let changed = false;
    try {
      await this.app.vault.process(target, (data) => {
        const res = qmStripEmptyDateSections(String(data || ''), skip);
        if (!res.removed.length) return data;
        changed = true;
        return res.text;
      });
    } catch (e) {
      return;
    }
    if (changed) this.notifyViews();
  }

  /* ---------------- 增 ---------------- */

  async appendCard(text) {
    const now = moment();
    const date = now.format('YYYY-MM-DD');
    const time = now.format('HH:mm');
    const path = this.monthPath(now);

    const bodyLines = qmBodyLines(text);
    if (!bodyLines.length) {
      new Notice('写点什么再记下吧');
      return;
    }

    await this.mutateFile(path, (content) => {
      // ID 在文件内必须唯一，否则 Obsidian 的块引用会指错
      const id = this.uniqueIdIn(content);
      return qmInsertCardLines(content, date, qmFormatEntry(time, bodyLines, id));
    });

    new Notice('已记下');
  }

  /* ---------------- 补块 ID ---------------- */

  async ensureId(card) {
    // 卡片所在文件已经不在了：不要为了复制引用去重建一个空文件
    const file = this.app.vault.getAbstractFileByPath(card.filePath);
    if (!(file instanceof TFile)) return '';

    // 末行已有 ID：Obsidian 认得，无需改动文件
    if (card.id && card.idOnLastLine) return card.id;

    let result = '';

    const res = await this.mutateCardFile(card, (lines, hit) => {
      const onEnd = lines[hit.lineEnd].match(/[ \t]\^([A-Za-z0-9-]+)[ \t]*$/);
      if (onEnd) {
        result = onEnd[1];
        return lines.join('\n');
      }

      // 旧 ID 落在首行/中间行时 Obsidian 找不到：搬到末行，ID 保持不变，
      // 这样之前贴出去的引用不会突然失效
      let oldId = '';
      for (let j = hit.lineIndex; j < hit.lineEnd; j++) {
        const m = lines[j].match(/[ \t]\^([A-Za-z0-9-]+)[ \t]*$/);
        if (!m) continue;
        if (!oldId) oldId = m[1];
        lines[j] = lines[j].replace(/[ \t]\^[A-Za-z0-9-]+[ \t]*$/, '');
      }

      const id = oldId || card.id || this.uniqueIdIn(lines.join('\n'));
      lines[hit.lineEnd] = lines[hit.lineEnd].replace(/[ \t]+$/, '') + ' ^' + id;
      result = id;
      return lines.join('\n');
    });

    if (res.ok && result) {
      card.id = result;
      card.idOnLastLine = true;
    }
    return result;
  }

  /* ---------------- 改 ---------------- */

  async updateCard(card, newBody) {
    const bodyLines = qmBodyLines(newBody);
    if (!bodyLines.length) {
      new Notice('内容不能为空');
      return;
    }

    const res = await this.mutateCardFile(card, (lines, hit) => {
      // 没有块 ID 的旧卡片顺手补一个，之后就走稳定路径，不再依赖指纹
      const id = hit.id || card.id || this.uniqueIdIn(lines.join('\n'));
      const entryLines = qmFormatEntry(hit.time, bodyLines, id);
      lines.splice(hit.lineIndex, hit.lineEnd - hit.lineIndex + 1, ...entryLines);
      return lines.join('\n');
    });

    if (res.ok) new Notice('已更新');
    else new Notice('没有修改：' + res.reason);
  }

  /* ---------------- 删 ---------------- */

  async deleteCard(card) {
    let removed = null;

    const res = await this.mutateCardFile(card, (lines, hit) => {
      removed = lines.slice(hit.lineIndex, hit.lineEnd + 1);
      lines.splice(hit.lineIndex, hit.lineEnd - hit.lineIndex + 1);
      // 这一天的最后一条被删掉后，日期标题也一起收走
      return qmPruneEmptyDateSections(lines.join('\n'), hit.date);
    });

    if (!res.ok) {
      new Notice('没有删除：' + res.reason);
      return;
    }

    const entry = await this.pushTrash({
      date: res.hit.date,
      time: res.hit.time,
      body: res.hit.body,
      lines: removed,
      filePath: card.filePath,
    });

    const n = new Notice('已删除 · 点此撤销', 9000);
    try {
      if (n && n.noticeEl) {
        n.noticeEl.addClass('qm-undo-toast');
        n.noticeEl.addEventListener('click', () => {
          n.hide();
          this.restoreTrash(entry.uid);
        });
      }
    } catch (e) {
      /* 无法加点击时仍可从「最近删除」恢复 */
    }
  }

  /* ---------------- 回收站 ---------------- */

  async pushTrash(item) {
    const uid = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const entry = {
      uid,
      date: String(item.date || ''),
      time: String(item.time || ''),
      body: String(item.body || '').slice(0, 4000),
      lines: Array.isArray(item.lines) ? item.lines.slice() : [],
      filePath: String(item.filePath || ''),
      deletedAt: Date.now(),
    };
    this.settings.trash.unshift(entry);
    if (this.settings.trash.length > 20) this.settings.trash.length = 20;
    await this.saveSettings();
    return entry;
  }

  async dropTrash(uid) {
    const i = this.settings.trash.findIndex((t) => t.uid === uid);
    if (i === -1) return;
    this.settings.trash.splice(i, 1);
    await this.saveSettings();
  }

  async clearTrash() {
    this.settings.trash = [];
    await this.saveSettings();
  }

  async restoreTrash(uid) {
    const i = this.settings.trash.findIndex((t) => t.uid === uid);
    if (i === -1) {
      new Notice('这条记录已经不在「最近删除」里了');
      return;
    }
    const entry = this.settings.trash[i];
    if (!entry.filePath) {
      new Notice('无法恢复：这条记录里没有文件路径');
      return;
    }

    const file = await this.ensureFileAt(entry.filePath);
    const guard = this.checkManagedFile(file, entry.date);
    if (!guard.ok) {
      new Notice('无法恢复：' + guard.reason);
      return;
    }

    let done = false;
    await this.app.vault.process(file, (data) => {
      const content = String(data || '').replace(/\r\n?/g, '\n');
      const ids = qmCollectIds(content);

      let lines = (entry.lines || []).slice();
      if (!lines.length) {
        lines = qmFormatEntry(entry.time || '00:00', qmBodyLines(entry.body), '');
      }

      // 拉出来的内容里已经有人占了同一个块 ID：换一个，避免链接指错
      const last = lines.length - 1;
      const m = String(lines[last] || '').match(/[ \t]\^([A-Za-z0-9-]+)[ \t]*$/);
      if (m && ids.has(m[1])) {
        let nid = genId();
        let guardN = 0;
        while (ids.has(nid) && guardN++ < 50) nid = genId();
        lines[last] = lines[last].replace(/[ \t]\^[A-Za-z0-9-]+[ \t]*$/, '') + ' ^' + nid;
      }

      done = true;
      return qmInsertRestoredCard(content, entry.date, entry.time, lines);
    });

    if (!done) {
      new Notice('恢复失败：目标文件不可写');
      return;
    }

    this.settings.trash.splice(i, 1);
    await this.saveSettings();
    new Notice('已恢复');
  }

  /* ---------------- 其他 ---------------- */

  async copy(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
  }

  async openCurrentMonthFile() {
    const path = this.monthPath(moment());
    const file = await this.ensureFileAt(path);
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file);
  }

  async activateView() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_QM);
    if (existing.length) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) {
      new Notice('无法创建侧边栏视图');
      return;
    }
    await leaf.setViewState({ type: VIEW_TYPE_QM, active: true });
    this.app.workspace.revealLeaf(leaf);
  }
}

module.exports = QuickMemoPlugin;
