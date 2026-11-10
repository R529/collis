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

/** 卡片占用的行范围：返回最后一行下标（续行以空白缩进开头） */
function qmCardBlockEnd(lines, start) {
  let end = start;
  for (let i = start + 1; i < lines.length; i++) {
    if (!/^[ \t]/.test(lines[i])) break;
    end = i;
  }
  while (end > start && lines[end].trim() === '') end--;
  return end;
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

  // 找该日期段最后一张卡片的「块尾」，而不是首行，避免插进别人的续行里
  let lastCard = -1;
  for (let i = hi + 1; i < lines.length; i++) {
    if (/^##[ \t]/.test(lines[i])) break;
    if (QM_CARD_RE.test(lines[i])) {
      lastCard = qmCardBlockEnd(lines, i);
      i = lastCard;
    }
  }

  if (lastCard >= 0) {
    lines.splice(lastCard + 1, 0, ...entryLines);
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

    cards.push({
      date: curDate || '未分组',
      time: padTime(cm[1]),
      body,
      tags,
      lineIndex: i,
      lineEnd: end,
      id,
      idOnLastLine,
      raw: line,
      filePath,
      fileBase,
    });

    i = end; // 续行已归入本卡片，跳过
  }

  return cards;
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
    const openFile = footer.createSpan({ cls: 'qm-open-file', text: '打开本月文件' });
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
    return (card.filePath || '') + '|' + (card.id || card.date + '|' + card.time + '|' + card.body);
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
      .setDesc('卡片按月存成 YYYY-MM.md，放在这个文件夹里。文件夹不存在会自动创建。')
      .addText((t) =>
        t.setValue(this.plugin.settings.folderPath).onChange(async (v) => {
          const val = String(v || '').trim().replace(/^\/+|\/+$/g, '');
          if (!val) return;
          this.plugin.settings.folderPath = val;
          await this.plugin.saveSettings();
        })
      );

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
  }

  onunload() {
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
    if (!this.settings.folderPath) {
      this.settings.folderPath = DEFAULT_SETTINGS.folderPath;
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.notifyViews();
  }

  /* ---------------- 路径 ---------------- */

  monthPath(m) {
    const folder = String(this.settings.folderPath || '').replace(/^\/+|\/+$/g, '');
    const name = m.format('YYYY-MM') + '.md';
    return folder ? folder + '/' + name : name;
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
    const file = await this.ensureFileAt(path);
    await this.app.vault.process(file, (data) => {
      const res = fn(String(data || ''));
      return typeof res === 'string' ? res : data;
    });
    this.notifyViews();
  }

  notifyViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_QM)) {
      const v = leaf.view;
      if (v && v.refresh) v.refresh();
    }
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
    const entryLines = qmFormatEntry(time, bodyLines, genId());

    await this.mutateFile(path, (content) =>
      qmInsertCardLines(content, date, entryLines)
    );

    new Notice('已记下');
  }

  /* ---------------- 定位 ---------------- */

  /** 定位卡片首行：优先原始行，其次按块 ID 向上回溯，最后全文找原文 */
  cardStartLine(lines, card) {
    if (typeof card.lineIndex === 'number' && lines[card.lineIndex] === card.raw) {
      return card.lineIndex;
    }
    if (card.id) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].indexOf('^' + card.id) === -1) continue;
        for (let j = i; j >= 0; j--) {
          if (QM_CARD_RE.test(lines[j])) return j;
          if (j < i && !/^[ \t]/.test(lines[j])) break;
        }
      }
    }
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === card.raw) return i;
    }
    return -1;
  }

  /* ---------------- 补块 ID ---------------- */

  async ensureId(card) {
    // 卡片所在文件已经不在了：不要为了复制引用去重建一个空文件
    const file = this.app.vault.getAbstractFileByPath(card.filePath);
    if (!(file instanceof TFile)) return '';

    // 末行已有 ID：Obsidian 认得，无需改动文件
    if (card.id && card.idOnLastLine) return card.id;

    let result = '';

    await this.mutateFile(card.filePath, (content) => {
      const lines = String(content || '').replace(/\r\n?/g, '\n').split('\n');
      const start = this.cardStartLine(lines, card);
      if (start === -1) return content;
      const end = qmCardBlockEnd(lines, start);

      const onEnd = lines[end].match(/[ \t]\^([A-Za-z0-9-]+)[ \t]*$/);
      if (onEnd) {
        result = onEnd[1];
        return content;
      }

      // 旧 ID 落在首行/中间行时 Obsidian 找不到：搬到末行，ID 保持不变，
      // 这样之前贴出去的引用不会突然失效
      let oldId = '';
      for (let j = start; j < end; j++) {
        const m = lines[j].match(/[ \t]\^([A-Za-z0-9-]+)[ \t]*$/);
        if (!m) continue;
        if (!oldId) oldId = m[1];
        lines[j] = lines[j].replace(/[ \t]\^[A-Za-z0-9-]+[ \t]*$/, '');
      }

      const id = oldId || card.id || genId();
      lines[end] = lines[end].replace(/[ \t]+$/, '') + ' ^' + id;
      result = id;
      return lines.join('\n');
    });

    if (result) {
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
    const entryLines = qmFormatEntry(card.time, bodyLines, card.id);

    await this.mutateFile(card.filePath, (content) => {
      const lines = String(content || '').replace(/\r\n?/g, '\n').split('\n');
      const start = this.cardStartLine(lines, card);
      if (start === -1) return content;
      const end = qmCardBlockEnd(lines, start);
      lines.splice(start, end - start + 1, ...entryLines);
      return lines.join('\n');
    });

    new Notice('已更新');
  }

  /* ---------------- 删 ---------------- */

  async deleteCard(card) {
    let removed = false;

    await this.mutateFile(card.filePath, (content) => {
      const lines = String(content || '').replace(/\r\n?/g, '\n').split('\n');
      const start = this.cardStartLine(lines, card);
      if (start === -1) return content;
      const end = qmCardBlockEnd(lines, start);
      lines.splice(start, end - start + 1);
      removed = true;
      // 这一天的最后一条被删掉后，日期标题也一起收走
      return qmPruneEmptyDateSections(lines.join('\n'), card.date);
    });

    new Notice(removed ? '已删除' : '没有找到这条卡片');
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
