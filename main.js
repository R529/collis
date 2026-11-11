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
  Menu,
  addIcon,
  setIcon,
  moment,
} = require('obsidian');

const VIEW_TYPE_QM = 'qm-cards-view';

/* ------------------------------------------------------------------ */
/* 侧栏 / 标签页图标：一颗四芒星加一条拖尾（流星）                     */
/* ------------------------------------------------------------------ */
/* 为什么不用内置图标：内置 message-square 全市场有 13 个插件在引用；
   内置 sparkle（单颗四芒星）正被同类速记插件 Spark Memo 挂在侧栏上。
   这颗带拖尾的星在内置图标表里没有对应项，市场内也无同形（核查于
   1,129 个插件，见 v1.8.4 发布说明）。                                */

const ICON_ID = 'collis-meteor';

const ICON_METEOR = (() => {
  /** 四芒星：四条边向内凹，r 为外接半径 */
  const star = (cx, cy, r) => {
    const d = r * 0.16;
    const a = r * 0.34;
    return (
      `M${cx} ${cy - r}` +
      `C${cx + d} ${cy - a} ${cx + a} ${cy - d} ${cx + r} ${cy}` +
      `C${cx + a} ${cy + d} ${cx + d} ${cy + a} ${cx} ${cy + r}` +
      `C${cx - d} ${cy + a} ${cx - a} ${cy + d} ${cx - r} ${cy}` +
      `C${cx - a} ${cy - d} ${cx - d} ${cy - a} ${cx} ${cy - r} Z`
    );
  };
  // 注意：addIcon 的第二个参数是 <svg> 的**内部内容**，外壳由 Obsidian 自己
  // 包（固定 viewBox="0 0 100 100"），所以这里不写 <svg> 标签。
  // 自定义图标不带默认描边，fill / stroke 都要写全；颜色一律 currentColor。
  return (
    `<path d="${star(40, 40, 31)}" fill="currentColor" stroke="none"/>` +
    '<path d="M62 62 L88 88" fill="none" stroke="currentColor"' +
    ' stroke-width="10" stroke-linecap="round"/>'
  );
})();

const DEFAULT_SETTINGS = {
  folderPath: '00-Inbox/速记',
  quickTags: [],
  maxCards: 500,
  trash: [],
  autoPruneEmptyDates: true,
  blockRefEmbed: false,
  collapsedDates: [],
  strictCardId: true,
  // 没提交完的手稿：{ text, at }。只存本机，不写进任何笔记文件
  draft: { text: '', at: 0 },
};

/** 草稿保留多久（毫秒）。超过就当过期，不再自动填回输入框 */
const DRAFT_TTL = 7 * 24 * 60 * 60 * 1000;
/** 草稿最多存多少字符，防止误粘一整篇文章把配置撑大 */
const DRAFT_MAX = 5000;

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

  // 不在任何日期段里的卡片（date 不是 YYYY-MM-DD）：直接补到文件末尾，
  // 不能凭空造一个「## 未分组」的标题出来
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    const out = lines.concat(lines.length ? [''] : [], entryLines);
    return out.join('\n').replace(/\n+$/, '') + '\n';
  }

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
 * 卡片正文的摘要：取第一行，压缩空白，超长截断。
 * 用在「另一条还没保存」的提示里，让用户一眼认出是哪条。
 */
function qmFirstLine(body, max) {
  const limit = typeof max === 'number' ? max : 18;
  const line = String(body || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)[0] || '';
  const flat = line.replace(/\s+/g, ' ');
  return flat.length > limit ? flat.slice(0, limit) + '…' : flat;
}

/** 取文件名（不含目录和 .md），统一小写便于比对 */
function qmBaseName(p) {
  return String(p || '')
    .split('/')
    .pop()
    .replace(/\.md$/i, '')
    .toLowerCase();
}

/**
 * 从一条链接记录里取出「目标文件」和「块 ID」。
 * 认得 [[2026-11#^abc]]、![[2026-11#^abc]]、[[2026-11#^abc|别名]]、
 * [[#^abc]]（同文件，target 为空，由调用方忽略）。
 * 不是块链接就返回 null。
 */
function qmParseBlockRef(raw) {
  const s = String(raw || '');
  const at = s.indexOf('#^');
  if (at < 0) return null;
  let target = s
    .slice(0, at)
    .replace(/^!?\[\[/, '')
    .replace(/\]\]$/, '')
    .trim();
  let id = s.slice(at + 2);
  const cut = id.search(/[|\]\s]/);
  if (cut >= 0) id = id.slice(0, cut);
  id = id.trim().toLowerCase();
  if (!id) return null;
  return { target, id };
}

/**
 * 汇总引用：同一张卡被同一篇笔记引用多次只算「1 篇」，但「处数」照实累加。
 * items: [{ sourcePath, destPath, id, ambiguous }]
 * 返回 Map：destPath + '#^' + id -> { notes:Set<来源笔记>, places:number, ambiguous:boolean }
 */
function qmAggregateRefs(items) {
  const out = new Map();
  for (const it of items || []) {
    if (!it || !it.destPath || !it.id) continue;
    const key = it.destPath + '#^' + String(it.id).toLowerCase();
    let e = out.get(key);
    if (!e) out.set(key, (e = { notes: new Set(), places: 0, ambiguous: false }));
    e.places += 1;
    if (it.sourcePath) e.notes.add(it.sourcePath);
    if (it.ambiguous) e.ambiguous = true;
  }
  return out;
}

/**
 * 把卡片正文拆成「纯文本 / 标签 / 网址」三类片段，交给渲染层决定怎么画。
 * 只认裸网址（http/https 开头，长什么样就显示什么样）；
 * 不认双链 [[...]]、不认 [文字](网址)、不认加粗代码——正文在文件里始终是纯文本，
 * 这里只影响显示，不改一个字符。
 */
function qmBodySegments(body) {
  const text = String(body == null ? '' : body);
  const out = [];
  if (!text) return out;

  // 一次扫完：要么是 #标签，要么是 http(s) 开头的裸网址
  // 网址里可能带 #（锚点），所以两个分支放在同一个正则里，交给引擎从左往右取
  const re = /#([^\s#\[\]()]+)|\bhttps?:\/\/[^\s<>"'，。；：！？、（）【】《》]+/g;
  const pushText = (s) => {
    if (s) out.push({ kind: 'text', text: s });
  };

  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    const at = m.index;
    if (at > last) pushText(text.slice(last, at));

    if (raw.charAt(0) === '#') {
      out.push({ kind: 'tag', text: raw, value: m[1] });
      last = at + raw.length;
      continue;
    }

    // 网址后面常跟着句号、逗号、右括号，这些不属于链接本身
    const trimmed = raw.replace(/[.,;:!?)\]}]+$/, '');
    out.push({ kind: 'url', text: trimmed });
    last = at + trimmed.length;
    // 被剪掉的标点要从这里重新扫，否则会整段丢掉
    re.lastIndex = last;
  }

  if (last < text.length) pushText(text.slice(last));
  return out;
}

/**
 * 解析单个文件里的卡片。
 * 卡片首行： - HH:mm 正文 #标签 ^blockid
 * 卡片续行：   正文（缩进两空格）
 * 日期段：   ## YYYY-MM-DD
 */
function parseCards(content, filePath, opts) {
  const strict = !!(opts && opts.strict);
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

    // 严格模式：块内必须有块 ID 才算卡片。手写的「- 12:30 开会」没有块 ID，
    // 就只是普通文字，不进面板、也不会被删。
    // 注意不能只认「末行的 ID」：旧版卡片可能把 ID 写在首行或中间行，
    // 那些卡片 Obsidian 虽然跳不过去，但仍然要留在面板里，否则等于把它们藏起来。
    if (strict && !endId) {
      let hasAnyId = false;
      for (let j = i; j <= end; j++) {
        if (/[ \t]\^[A-Za-z0-9-]{4,}[ \t]*$/.test(lines[j])) {
          hasAnyId = true;
          break;
        }
      }
      if (!hasAnyId) {
        i = end;
        continue;
      }
    }

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
      // 搜索时每次都 toLowerCase() 会产生大量临时字符串，这里预存一份
      bodyLower: body.toLowerCase(),
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
function qmLocateCard(content, card, opts) {
  if (!card || !card.filePath) return null;
  const cards = parseCards(content, card.filePath, opts);

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

/* ---------------- 搜索 ---------------- */

/**
 * 解析搜索框内容为一组条件，可以混用：
 *   #标签        → 标签路径匹配（与标签树同语义，父标签含子标签）
 *   2026-11-07   → 指定日期
 *   2026-11      → 指定月份
 *   11-07        → 任意年份的同月日
 *   13:41        → 指定时间
 *   "整段话"      → 原文短语
 *   其它          → 正文子串，忽略大小写
 * 空格分隔多个条件，需全部满足。
 */
function qmParseQuery(input) {
  const raw = String(input || '').trim();
  if (!raw) return [];

  const out = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const phrase = m[1];
    const tok = phrase !== undefined ? phrase : m[2];
    if (!tok) continue;

    if (phrase !== undefined) {
      out.push({ kind: 'text', value: tok.toLowerCase() });
      continue;
    }
    if (tok.charAt(0) === '#' && tok.length > 1) {
      out.push({ kind: 'tag', value: tok.slice(1) });
      continue;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(tok)) {
      out.push({ kind: 'date', value: tok });
      continue;
    }
    if (/^\d{4}-\d{2}$/.test(tok)) {
      out.push({ kind: 'month', value: tok });
      continue;
    }
    if (/^\d{2}-\d{2}$/.test(tok)) {
      out.push({ kind: 'md', value: tok });
      continue;
    }
    if (/^\d{1,2}:\d{2}$/.test(tok)) {
      out.push({ kind: 'time', value: padTime(tok) });
      continue;
    }
    out.push({ kind: 'text', value: tok.toLowerCase() });
  }
  return out;
}

/** 卡片是否满足全部搜索条件（标签、日期、时间、正文） */
function qmCardMatches(card, conds) {
  if (!conds || !conds.length) return true;

  const date = String((card && card.date) || '');
  const time = String((card && card.time) || '');
  const text =
    card && typeof card.bodyLower === 'string'
      ? card.bodyLower
      : String((card && card.body) || '').toLowerCase();

  for (const c of conds) {
    if (c.kind === 'tag') {
      if (!qmCardHasPath(card, c.value)) return false;
    } else if (c.kind === 'date') {
      if (date !== c.value) return false;
    } else if (c.kind === 'month') {
      if (date.slice(0, 7) !== c.value) return false;
    } else if (c.kind === 'md') {
      if (date.slice(5) !== c.value) return false;
    } else if (c.kind === 'time') {
      if (time !== c.value) return false;
    } else if (text.indexOf(c.value) === -1) {
      return false;
    }
  }
  return true;
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
  constructor(app, text, onConfirm, detail) {
    super(app);
    this.text = text;
    this.onConfirm = onConfirm;
    // 可选：补充说明（比如「这张卡还被 2 篇笔记引用」）
    this.detail = detail || '';
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('div', { text: this.text, cls: 'qm-confirm-text' });
    if (this.detail) {
      contentEl.createEl('div', { text: this.detail, cls: 'qm-confirm-detail' });
    }

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

/**
 * 「另一条还在编辑」的岔路口。
 * 三个出口都由用户点：留在这条（默认，等同 Esc）/ 放弃修改 / 保存并继续。
 * 不做「自动保存」——自动写盘会在内容为空或定位失败时留下烂摊子。
 */
class DraftSwitchModal extends Modal {
  constructor(app, opts) {
    super(app);
    this.opts = opts || {};
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('div', { text: '另一条卡片还没保存', cls: 'qm-confirm-text' });
    contentEl.createEl('div', {
      text:
        '「' + String(this.opts.preview || '') + '」改过但没保存。' +
        '要先存下来，再编辑这条吗？',
      cls: 'qm-confirm-detail',
    });

    const bar = contentEl.createDiv({ cls: 'qm-edit-bar' });

    // 顺序：越靠右越「继续」，与保存/取消的既有习惯一致
    const stay = bar.createEl('button', { text: '留在这条', cls: 'qm-mini-btn' });
    stay.onclick = () => this.close();

    const drop = bar.createEl('button', { text: '放弃修改', cls: 'qm-mini-btn' });
    drop.onclick = () => {
      this.close();
      if (typeof this.opts.onDiscard === 'function') this.opts.onDiscard();
    };

    const save = bar.createEl('button', { text: '保存并继续', cls: 'qm-mini-btn is-primary' });
    save.onclick = async () => {
      if (typeof this.opts.onSave !== 'function') {
        this.close();
        return;
      }
      const okSaved = await this.opts.onSave();
      if (okSaved !== false) this.close();
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
        text: '恢复会按日期和时间插回原文件，只做插入，不会覆盖其它内容。最多保留 50 条（批量删除时一次可能进来多条）。',
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
    this._ta = ta;
    this._closingBySubmit = false;

    // 上次没记完的内容填回来，下面留一行说明。想清空直接删字，不给「丢弃」按钮。
    // 提示只在「还没动过」的时候显示，你一敲字就收掉，免得一直挂在窗口里。
    this._draftHintEl = null;
    this._draftRestored = false;
    const draft = this.plugin.draftAlive();
    if (draft) {
      ta.value = draft;
      this._draftRestored = true;
      this._draftHintEl = taWrap.createDiv({
        cls: 'qm-draft-hint',
        text: '已恢复上次没记完的内容',
      });
    }
    ta.addEventListener('input', () => {
      this.dismissDraftHint();
      this.plugin.queueDraft(ta.value);
    });

    // 标签候选只在打开弹窗时取一次：打字过程中查的是这份快照，不再每次按键读盘
    const tagList = [];
    const suggest = new TagSuggest(ta, taWrap, () => tagList);
    this._suggest = suggest;

    (async () => {
      let tags = [];
      try {
        const cards = await this.plugin.cardsForSuggest();
        tags = collectAllTags(cards, this.plugin.settings.quickTags);
      } catch (e) {
        tags = [];
      }
      if (!tags.length) return;

      // 同一个数组给联想和快捷标签共用，只有一份数据
      tagList.push(...tags);
      suggest.update();

      const bar = contentEl.createDiv({ cls: 'qm-quick-tags' });
      for (const t of tags.slice(0, 8)) {
        const chip = bar.createSpan({ text: '#' + t, cls: 'qm-quick-tag' });
        chip.onclick = () => {
          const cur = ta.value;
          ta.value = cur.replace(/\s+$/, '') + (cur.trim() ? ' ' : '') + '#' + t + ' ';
          this.dismissDraftHint();
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

  /** 开始改动就把「已恢复上次没记完的内容」收掉，不再一直显示 */
  dismissDraftHint() {
    if (!this._draftHintEl) return;
    this._draftHintEl.remove();
    this._draftHintEl = null;
  }

  async submit(value) {
    const text = String(value || '').trim();
    // 草稿由这里统一处理，告诉 onClose 别再抢着写一遍
    this._closingBySubmit = true;
    if (!text) {
      this.close();
      await this.plugin.clearDraft();
      return;
    }
    this.close();
    if (await this.plugin.appendCard(text)) {
      this._draftRestored = false;
      await this.plugin.clearDraft();
    } else {
      // 没记下：把内容留成草稿，下次打开还能捡回来
      await this.plugin.saveDraft(text);
    }
  }

  onClose() {
    // 直接关掉（Esc / 点外面）时不丢内容
    if (!this._closingBySubmit && this._ta) {
      const v = String(this._ta.value || '');
      if (v.trim()) void this.plugin.saveDraft(v);
      // 从草稿恢复、又被你删空了：说明不要了。提示可能已经收掉，
      // 所以看状态标记而不是看界面上还有没有那行字
      else if (this._draftRestored) void this.plugin.clearDraft();
    }
    this._draftHintEl = null;
    if (this._suggest) {
      this._suggest.destroy();
      this._suggest = null;
    }
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
      // 引用筛选：'' 全部 / 'has' 只看已引用 / 'none' 只看未引用
      refFilter: '',
      editingKey: null,
      // 正在编辑但还没保存的文本：列表被重画时用它恢复，避免白打一遍
      editingDraft: null,
      cards: [],
      tagbarExpanded: false,
      // 折叠的日期（只影响渲染，不改文件）
      collapsed: new Set((plugin.settings && plugin.settings.collapsedDates) || []),
      // 多选删除
      selectMode: false,
      selected: new Set(),
    };

    // 拖拽与双击的判定状态（不参与渲染，只在一张卡的交互里用）
    this._lastDown = 0; // 上一次按下卡片的时刻
    this._dblRisk = false; // 这一次按下是否紧跟着上一次（视为双击的第二下）
    this._noIdHint = false; // 「没有块 ID，拖的是全文」只提示一次
    this._refBadges = new Map();
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
    return ICON_ID;
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

    // 上次没记完的内容：填回来，下面留一行说明。不设「丢弃」按钮——
    // 想清空直接删字，跟平时编辑一样，免得手滑一下内容就没了。
    // 提示只在「还没动过」的时候显示，你一敲字就收掉。
    this.draftHintEl = null;
    this._draftRestored = false;
    const draft = this.plugin.draftAlive();
    if (draft) {
      this.inputEl.value = draft;
      this._draftRestored = true;
      this.autoGrow();
      this.draftHintEl = inputWrap.createDiv({
        cls: 'qm-draft-hint',
        text: '已恢复上次没记完的内容',
      });
    }

    this.inputEl.addEventListener('input', () => {
      this.autoGrow();
      this.dismissDraftHint();
      this.plugin.queueDraft(this.inputEl.value);
    });

    this.tagSuggest = new TagSuggest(this.inputEl, inputWrap, () => this.tagPool());

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
    this.searchEl.setAttr('placeholder', '搜索全文 · #标签 · 2026-11-07 · 13:41');
    this.searchEl.addEventListener('input', () => {
      // 每敲一个字都全量重算是主要的卡顿来源，这里合并成一次
      if (this._searchTimer) clearTimeout(this._searchTimer);
      this._searchTimer = setTimeout(() => {
        this._searchTimer = null;
        this.state.search = this.searchEl.value.trim();
        // 换了搜索条件，旧勾选可能已经不在结果里，清掉更安全
        if (this.state.selectMode) this.state.selected.clear();
        this.renderList();
      }, 120);
    });

    this.selectBtnEl = searchRow.createEl('button', {
      cls: 'qm-select-toggle',
      text: '选择',
    });
    this.selectBtnEl.onclick = () => this.toggleSelectMode();

    // 引用筛选：全部 → 已引用 → 未引用，循环切换
    this.refBtnEl = searchRow.createEl('button', {
      cls: 'qm-select-toggle qm-ref-toggle',
      text: '引用',
    });
    this.refBtnEl.setAttr('aria-label', '按引用情况筛选：全部 / 已引用 / 未引用');
    this.refBtnEl.onclick = () => this.cycleRefFilter();

    // 搜索与标签筛选同时生效时，把「作用域」写在明面上，避免以为卡片丢了
    this.scopeEl = filter.createDiv({ cls: 'qm-scope is-hidden' });

    this.tagbarEl = filter.createDiv({ cls: 'qm-tagbar' });

    /* ---- 列表区 ---- */
    this.listEl = wrap.createDiv({ cls: 'qm-list' });

    /* ---- 多选操作条 ---- */
    this.selectBarEl = wrap.createDiv({ cls: 'qm-selectbar is-hidden' });
    this.delSelBtnEl = this.selectBarEl.createEl('button', {
      cls: 'qm-mini-btn is-danger',
      text: '删除所选',
    });
    this.delSelBtnEl.onclick = () => this.deleteSelected();

    /* ---- 底部栏 ---- */
    const footer = wrap.createDiv({ cls: 'qm-footer' });
    this.footerInfoEl = footer.createSpan({ cls: 'qm-footer-info', text: '' });
    const right = footer.createDiv({ cls: 'qm-footer-right' });
    this.trashEl = right.createSpan({ cls: 'qm-open-file qm-trash-open', text: '' });
    this.trashEl.onclick = () => new TrashModal(this.app, this.plugin).open();
    const openFile = right.createSpan({ cls: 'qm-open-file', text: '打开本月文件' });
    openFile.onclick = () => this.plugin.openCurrentMonthFile();

    const onChange = async (f, oldPath) => {
      if (!(f instanceof TFile)) return;
      // 改名/移动也要管：从卡片文件夹移出去时，路径已经是新的了，得看旧路径
      const inFolder =
        this.plugin.isCardFilePath(f.path) || (oldPath && this.plugin.isCardFilePath(oldPath));
      if (!inFolder) return;
      // 自己刚写完引起的那次「文件变了」不用重读：内存里已经是新内容了
      if (await this.plugin.isOwnWrite(f)) return;
      this.scheduleRefresh();
    };

    this.registerEvent(this.app.vault.on('modify', onChange));
    this.registerEvent(this.app.vault.on('create', onChange));
    this.registerEvent(this.app.vault.on('delete', onChange));
    this.registerEvent(this.app.vault.on('rename', onChange));

    await this.refresh();
  }

  async onClose() {
    // 没提交的内容存下来，重开面板还在。
    // 如果这次是从草稿恢复的、又被删空了，说明不要了，顺手清掉；
    // 否则空输入框不动草稿（别把快捷弹窗里正在写的内容误删）。
    if (this.inputEl) {
      const v = String(this.inputEl.value || '');
      if (v.trim()) void this.plugin.saveDraft(v);
      // 提示行可能已经被收掉了，所以看状态标记而不是看界面上还有没有那行字
      else if (this._draftRestored) void this.plugin.clearDraft();
    }
    if (this._searchTimer) {
      clearTimeout(this._searchTimer);
      this._searchTimer = null;
    }
    if (this._reloadTimer) {
      clearTimeout(this._reloadTimer);
      this._reloadTimer = null;
    }
    if (this.tagSuggest) {
      this.tagSuggest.destroy();
      this.tagSuggest = null;
    }
    this.contentEl.empty();
  }

  /** 标签候选池：卡片数据没换就直接复用，避免每敲一个字重算一遍 */
  tagPool() {
    const cards = this.state ? this.state.cards : [];
    if (!this._tagCache || this._tagCache.ref !== cards) {
      this._tagCache = {
        ref: cards,
        list: collectAllTags(cards, this.plugin.settings.quickTags),
      };
    }
    return this._tagCache.list;
  }

  /**
   * 外部改动（编辑器手改、同步、别处写入）触发的重读。
   * 编辑器里连续敲字会连发很多次 modify，合并成一次，别每敲一下重建整个列表。
   */
  scheduleRefresh() {
    if (this._reloadTimer) clearTimeout(this._reloadTimer);
    this._reloadTimer = setTimeout(() => {
      this._reloadTimer = null;
      this.refresh();
    }, 150);
  }

  /** 开始改动就把「已恢复上次没记完的内容」收掉，不再一直显示 */
  dismissDraftHint() {
    if (!this.draftHintEl) return;
    this.draftHintEl.remove();
    this.draftHintEl = null;
  }

  insertTag(tag) {
    const cur = this.inputEl.value;
    const add = '#' + tag + ' ';
    const needsSpace = cur.length > 0 && !/\s$/.test(cur);
    this.inputEl.value = cur + (needsSpace ? ' ' : '') + add;
    this.dismissDraftHint();
    this.inputEl.focus();
  }

  async saveInput() {
    const text = String(this.inputEl.value || '').trim();
    if (!text) {
      new Notice('写点什么再记下吧');
      return;
    }
    // 先写文件，成功了才清空。写失败就留在框里，不许「两边都丢」
    const ok = await this.plugin.appendCard(text);
    if (!ok) return;
    this.inputEl.value = '';
    if (this.autoGrow) this.autoGrow();
    this.dismissDraftHint();
    this._draftRestored = false;
    await this.plugin.clearDraft();
    this.inputEl.focus();
  }

  async refresh() {
    // 正在读的时候又被要求刷新：记一笔，读完补一次，别叠着读几遍
    if (this._refreshing) {
      this._dirty = true;
      return;
    }
    this._refreshing = true;
    try {
      // 全量载入：搜索与标签筛选必须覆盖所有卡片
      const cards = await this.plugin.readAllCards();
      if (!this.state) return;
      this.state.cards = cards;
      this._loadedOnce = true;
      // 顺手重算引用（只读内存索引，几毫秒）
      this.plugin.refreshRefs();
      this.renderTagbar();
      this.renderList();
    } finally {
      this._refreshing = false;
      if (this._dirty) {
        this._dirty = false;
        this.refresh();
      }
    }
  }

  /**
   * 插件自己写完一个文件后的定向更新：只重解析这一个文件，
   * 换掉它在列表里的那部分，其它月份不重读。省掉一次整文件夹重读。
   */
  applyFileCards(path, content) {
    if (!this.state) return;
    // 面板还没完整加载过：这时候只替换一个文件会显得卡片变少了，直接走全量
    if (!this._loadedOnce) {
      this.refresh();
      return;
    }
    const next = parseCards(content, path, {
      strict: this.plugin.settings.strictCardId !== false,
    });
    const rest = this.state.cards.filter((c) => c.filePath !== path);
    this.state.cards = sortCards(rest.concat(next));

    // 选中集合里已经不存在（被删掉）的条目剔掉，免得批量删除带上幽灵条目
    if (this.state.selected && this.state.selected.size) {
      const alive = new Set(this.state.cards.map((c) => this.cardKey(c)));
      for (const k of Array.from(this.state.selected)) {
        if (!alive.has(k)) this.state.selected.delete(k);
      }
    }

    this.renderTagbar();
    this.renderList({ keepScroll: true });

    // 读的途中被替换过，可能又落后了，补一次全量收尾
    if (this._refreshing) this._dirty = true;
  }

  /** 数据没变、只是要更新一下界面文字（比如「最近删除」条数） */
  rerender() {
    if (!this.state || !this._loadedOnce) return;
    this.renderTagbar();
    this.renderList();
  }

  /** 引用筛选的实际生效值：索引没建好时一律按「全部」，免得把卡片全判成未引用 */
  effectiveRefFilter() {
    const v = this.state.refFilter;
    if (!v) return '';
    if (!this.plugin.refsReady()) return '';
    return v;
  }

  setRefFilter(v) {
    this.state.refFilter = v || '';
    // 换了筛选条件，旧勾选可能已经不在结果里，清掉更安全
    if (this.state.selectMode) this.state.selected.clear();
    this.renderRefBtn();
    this.renderList();
  }

  cycleRefFilter() {
    if (!this.plugin.refsReady()) {
      new Notice('引用统计还在准备，稍等一下再试');
      return;
    }
    const order = ['', 'has', 'none'];
    const cur = this.state.refFilter || '';
    const next = order[(order.indexOf(cur) + 1) % order.length];
    this.setRefFilter(next);
  }

  renderRefBtn() {
    if (!this.refBtnEl) return;
    const v = this.state.refFilter || '';
    this.refBtnEl.setText(v === 'has' ? '引用·有' : v === 'none' ? '引用·无' : '引用');
    this.refBtnEl.toggleClass('is-active', !!v);
  }

  /** 统一设置标签筛选：换视角时清掉旧的勾选，避免批量删掉看不见的卡片 */
  setTag(tag) {
    this.state.activeTag = tag || '';
    if (this.state.selectMode) this.state.selected.clear();
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
      this.setTag('');
    };

    const none = row1.createSpan({
      text: '无标签 ' + tree.untagged,
      cls: 'qm-tagbar-item qm-tagbar-none' + (act === NONE ? ' is-active' : ''),
    });
    none.onclick = () => {
      this.setTag(act === NONE ? '' : NONE);
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
        this.setTag(isWhole ? '' : g.path);
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
        this.setTag(activeGroup.path);
      };

      for (const ch of activeGroup.children) {
        const chLower = qmLowerPath(ch.path);
        const chip = row2.createSpan({
          text: '#' + ch.path + ' ' + ch.count,
          cls: 'qm-tagbar-item' + (actLower === chLower ? ' is-active' : ''),
        });
        chip.onclick = () => {
          // 再点一次已选中的子标签，退回整组
          this.setTag(actLower === chLower ? activeGroup.path : ch.path);
        };
      }
    }
  }

  /* ---------------- 搜索作用域 ---------------- */

  renderScope() {
    const el = this.scopeEl;
    if (!el) return;

    const tag = this.state.activeTag;
    const hasSearch = !!String(this.state.search || '').trim();
    const rf = this.effectiveRefFilter();

    const parts = [];
    if (rf === 'has') parts.push('只看已引用');
    if (rf === 'none') parts.push('只看未引用');
    // 标签筛选只在「同时有关键词」时提示，平时不占地方
    if (tag && hasSearch) {
      parts.push('只在 ' + (tag === this.NO_TAG ? '无标签' : '#' + tag) + ' 里搜索');
    }
    // 有筛选时永远说清楚，避免「卡片怎么少了」的错觉
    if (!parts.length) {
      el.toggleClass('is-hidden', true);
      el.empty();
      return;
    }

    el.empty();
    el.toggleClass('is-hidden', false);
    el.createSpan({ cls: 'qm-scope-text', text: parts.join(' · ') });
    const x = el.createSpan({ cls: 'qm-scope-x', text: '\u00d7' });
    x.setAttr('aria-label', '清除筛选');
    x.onclick = () => {
      this.state.refFilter = '';
      this.renderRefBtn();
      this.setTag('');
    };
  }

  /* ---------------- 多选删除 ---------------- */

  toggleSelectMode(force) {
    const next = typeof force === 'boolean' ? force : !this.state.selectMode;
    if (next && this.state.editingKey) {
      new Notice('先保存或取消正在编辑的卡片');
      return;
    }
    this.state.selectMode = next;
    this.state.selected.clear();
    this.renderList();
  }

  toggleSelected(card) {
    const key = this.cardKey(card);
    if (this.state.selected.has(key)) this.state.selected.delete(key);
    else this.state.selected.add(key);
    this.renderList();
  }

  deleteSelected() {
    const picked = this.state.cards.filter((c) => this.state.selected.has(this.cardKey(c)));
    if (!picked.length) {
      new Notice('还没有选中卡片');
      return;
    }

    const detail = this.refDeleteDetail(picked);
    new ConfirmModal(this.app, '删除选中的 ' + picked.length + ' 条卡片？', async () => {
      const res = await this.plugin.deleteCards(picked);
      this.state.selectMode = false;
      this.state.selected.clear();
      this.renderList();

      if (res.deleted && res.failed) {
        new Notice('已删除 ' + res.deleted + ' 条，' + res.failed + ' 条没找到已跳过', 9000);
      } else if (res.deleted) {
        new Notice('已删除 ' + res.deleted + ' 条，可在「最近删除」恢复', 9000);
      } else {
        new Notice('没有删除：卡片位置已变化，请刷新后重试', 9000);
      }
    }, detail).open();
  }

  /* ---------------- 日期折叠 ---------------- */

  toggleDay(date) {
    if (String(this.state.search || '').trim()) {
      new Notice('搜索时日期会自动展开');
      return;
    }
    if (this.state.collapsed.has(date)) this.state.collapsed.delete(date);
    else this.state.collapsed.add(date);
    this.saveCollapsed();
    this.renderList();
  }

  saveCollapsed() {
    if (!this.state.collapsed) return;
    // 只留最近 60 个，避免配置无限增长
    this.plugin.settings.collapsedDates = Array.from(this.state.collapsed).slice(-60);
    // 这里不调用 saveSettings：那会触发整个视图重载，折叠一下没必要
    this.plugin.saveData(this.plugin.settings);
  }

  filtered() {
    const conds = qmParseQuery(this.state.search);
    const tag = this.state.activeTag;
    const rf = this.effectiveRefFilter();
    return this.state.cards.filter((c) => {
      if (tag === this.NO_TAG) {
        if (!qmCardIsUntagged(c)) return false;
      } else if (tag) {
        if (!qmCardHasPath(c, tag)) return false;
      }
      if (rf === 'has' && this.plugin.refCount(c) === 0) return false;
      if (rf === 'none' && this.plugin.refCount(c) > 0) return false;
      return qmCardMatches(c, conds);
    });
  }

  renderList(opts) {
    const el = this.listEl;
    if (!el) return;
    // 外部改动（同步、别处保存）引起的重画不该把滚动位置弹回顶部
    const keepScroll = opts && opts.keepScroll ? el.scrollTop || 0 : 0;
    el.empty();
    // 每次重画重新登记数字元素，updateRefs 只改文字、不重画整列
    this._refBadges = new Map();

    // 命中范围始终是全量卡片，仅限制渲染条数以保证流畅
    const matched = this.filtered();
    const cap = this.plugin.settings.maxCards;
    const list = cap > 0 ? matched.slice(0, cap) : matched;

    if (this.footerInfoEl) {
      if (this.state.selectMode) {
        this.footerInfoEl.setText('已选 ' + this.state.selected.size + ' 条');
      } else {
        const total = this.state.cards.length;
        if (matched.length > 0 && list.length < matched.length) {
          this.footerInfoEl.setText('命中 ' + matched.length + ' 条 · 显示最近 ' + list.length + ' 条');
        } else {
          this.footerInfoEl.setText('共 ' + total + ' 条');
        }
      }
    }

    if (this.trashEl) {
      const n = (this.plugin.settings.trash || []).length;
      this.trashEl.setText(n ? '最近删除 ' + n : '');
      this.trashEl.toggleClass('is-hidden', !n);
    }

    if (this.selectBtnEl) {
      this.selectBtnEl.setText(this.state.selectMode ? '取消' : '选择');
      this.selectBtnEl.toggleClass('is-active', this.state.selectMode);
    }

    this.renderRefBtn();

    if (this.selectBarEl) {
      this.selectBarEl.toggleClass('is-hidden', !this.state.selectMode);
      if (this.delSelBtnEl) {
        const n = this.state.selected.size;
        this.delSelBtnEl.setText(n ? '删除所选 ' + n : '删除所选');
        this.delSelBtnEl.toggleClass('is-disabled', !n);
      }
    }

    this.renderScope();

    if (!list.length) {
      const empty = el.createDiv({ cls: 'qm-empty' });
      if (this.state.cards.length === 0) {
        empty.setText('还没有卡片。在上面写一句，Ctrl+Enter 记下。');
      } else {
        empty.setText('没有匹配的卡片。');
      }
      el.scrollTop = keepScroll;
      return;
    }

    // 按日期分组：组头可折叠，折叠状态记在设置里
    const searching = !!String(this.state.search || '').trim();
    const groups = [];
    for (const card of list) {
      const last = groups[groups.length - 1];
      if (last && last.date === card.date) last.cards.push(card);
      else groups.push({ date: card.date, cards: [card] });
    }

    for (const g of groups) {
      const collapsed = !searching && this.state.collapsed.has(g.date);
      const editingHere = g.cards.some((c) => this.cardKey(c) === this.state.editingKey);

      const day = el.createDiv({
        cls: 'qm-day' + (collapsed ? ' is-collapsed' : '') + (editingHere ? ' is-locked' : ''),
      });
      day.createSpan({ cls: 'qm-day-arrow', text: collapsed ? '\u25b8' : '\u25be' });
      day.createSpan({ cls: 'qm-day-text', text: g.date });
      day.createSpan({ cls: 'qm-day-count', text: String(g.cards.length) });
      day.onclick = () => {
        if (editingHere) {
          new Notice('这一天有卡片正在编辑，先保存或取消');
          return;
        }
        this.toggleDay(g.date);
      };

      if (collapsed) continue;
      for (const card of g.cards) this.renderCard(el, card);
    }

    el.scrollTop = keepScroll;
  }

  /**
   * 时间后面的小圆点：只表示「这张卡被笔记引用过」，不显示次数、不响应点击。
   * 次数与来源都在「···」菜单里看。0 次时元素存在但不显示，方便就地更新。
   */
  mountRefDot(parent, card, key) {
    const el = parent.createSpan({ cls: 'qm-ref' });
    if (this._refBadges) this._refBadges.set(key, { el, card });
    this.paintRefDot(el, card);
    return el;
  }

  paintRefDot(el, card) {
    if (!el) return;
    const info = this.plugin.refSummary(card);
    const n = info ? info.notes : 0;
    if (!n) {
      el.addClass('is-hidden');
      el.setAttr('title', '');
      return;
    }
    el.removeClass('is-hidden');
    const more = info.places > n ? '，共 ' + info.places + ' 处' : '';
    const names = info.names.slice(0, 3).join('、') + (info.names.length > 3 ? ' 等' : '');
    el.setAttr(
      'title',
      '被 ' + n + ' 篇笔记引用' + more + ' · ' + names +
        (info.ambiguous ? '（有同名文件，链接可能指错，注意）' : '')
    );
  }

  /**
   * 引用数字变了。默认只改文字，不重画整列（否则你正在写文章时侧栏会一直跳）。
   * 只有「只看已引用 / 只看未引用」开着时结果集会变，才重画一次并保留滚动位置。
   */
  updateRefs() {
    if (!this.state) return;
    if (this.effectiveRefFilter()) {
      this.renderList({ keepScroll: true });
      return;
    }
    if (!this._refBadges || !this._refBadges.size) return;
    for (const { el, card } of this._refBadges.values()) this.paintRefDot(el, card);
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

  /** 删除前的提醒：这些卡片还被哪些笔记引用着（没被引用就返回空串） */
  refDeleteDetail(cards) {
    const list = Array.isArray(cards) ? cards : [cards];
    const hits = list.filter((c) => this.plugin.refCount(c) > 0);
    if (!hits.length) return '';
    const names = [];
    for (const c of hits) {
      const info = this.plugin.refSummary(c);
      if (!info) continue;
      for (const n of info.names) {
        if (names.indexOf(n) === -1) names.push(n);
      }
    }
    if (!names.length) return '';
    const shown = names.slice(0, 3).join('、') + (names.length > 3 ? ' 等' : '');
    const head =
      list.length === 1
        ? '这张卡片被 ' + this.plugin.refCount(hits[0]) + ' 篇笔记引用着'
        : '其中 ' + hits.length + ' 条被笔记引用，涉及 ' + names.length + ' 篇笔记';
    return head + '：' + shown + '。删除后这些地方的链接会失效（显示为「找不到该块」）。';
  }

  renderCard(parent, card) {
    const key = this.cardKey(card);
    const picked = this.state.selectMode && this.state.selected.has(key);
    const box = parent.createDiv({ cls: 'qm-card' + (picked ? ' is-picked' : '') });

    if (this.state.selectMode) {
      box.addClass('is-selectable');
      box.createSpan({ cls: 'qm-tick', text: picked ? '\u2713' : '' });
      box.onclick = (e) => {
        e.stopPropagation();
        this.toggleSelected(card);
      };
    }

    const head = box.createDiv({ cls: 'qm-card-head' });
    head.createSpan({ cls: 'qm-time', text: card.time });
    this.mountRefDot(head, card, key);

    /* ---- 编辑态 ---- */
    if (this.state.editingKey === key) {
      const ta = box.createEl('textarea', { cls: 'qm-edit' });
      const draft = this.state.editingDraft;
      ta.value = draft && draft.key === key ? draft.text : card.body;
      ta.rows = Math.min(12, Math.max(2, String(ta.value).split('\n').length + 1));
      // 边打边留一份草稿：列表被搜索/同步重画时能原样恢复
      ta.addEventListener('input', () => {
        this.state.editingDraft = { key, text: String(ta.value) };
      });
      window.setTimeout(() => {
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }, 20);

      const bar = box.createDiv({ cls: 'qm-edit-bar' });
      const cancel = bar.createEl('button', { text: '取消', cls: 'qm-mini-btn' });
      cancel.onclick = () => {
        this.state.editingKey = null;
        this.state.editingDraft = null;
        this.renderList();
      };
      const ok = bar.createEl('button', { text: '保存', cls: 'qm-mini-btn is-primary' });
      ok.onclick = async () => {
        const v = String(ta.value || '').trim();
        if (!v) {
          new Notice('内容不能为空');
          return;
        }
        // 先写盘，写成功才退出编辑态：失败时草稿留在原处，不白打一遍
        const saved = await this.plugin.updateCard(card, v);
        if (!saved) return;
        this.state.editingKey = null;
        this.state.editingDraft = null;
        this.renderList();
      };

      ta.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          ok.onclick();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          this.state.editingKey = null;
          this.state.editingDraft = null;
          this.renderList();
        }
      });
      return;
    }

    /* ---- 正文本（标签高亮、裸网址可点） ---- */
    const body = box.createDiv({ cls: 'qm-body' });
    for (const seg of qmBodySegments(card.body)) {
      if (seg.kind === 'text') {
        body.appendChild(document.createTextNode(seg.text));
        continue;
      }
      if (seg.kind === 'tag') {
        const tag = body.createSpan({ cls: 'qm-tag', text: seg.text });
        tag.onclick = (e) => {
          e.stopPropagation();
          // 多选模式下点标签等同于点这张卡片，避免误触发筛选
          if (this.state.selectMode) {
            this.toggleSelected(card);
            return;
          }
          this.setTag(seg.value);
        };
        continue;
      }
      // 网址：点了用系统浏览器打开。多选模式下仍然算「选中这张卡片」
      const link = body.createEl('a', { cls: 'qm-url', text: seg.text });
      link.setAttr('href', seg.text);
      link.setAttr('rel', 'noopener');
      link.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (this.state.selectMode) {
          this.toggleSelected(card);
          return;
        }
        try {
          window.open(seg.text, '_blank');
        } catch (err) {
          new Notice('打不开这个链接');
        }
      };
    }

    /* ---- 多选模式下：点整块即选中，不放「···」、不拖 ---- */
    if (this.state.selectMode) return;

    /* ---- 右上「···」：复制 / 编辑 / 引用信息 / 定位 / 删除 ---- */
    this.mountCardMenuButton(head, card);

    /* ---- 双击空白处进编辑；整张卡可拖进笔记 ---- */
    this.bindCardEdit(box, card);
    this.bindCardDrag(box, card);
  }

  /* ---------------- 卡片上的交互 ---------------- */

  mountCardMenuButton(head, card) {
    const more = head.createEl('button', { cls: 'qm-more' });
    more.setAttr('type', 'button');
    more.setAttr('aria-label', '更多操作');
    more.setAttr('title', '更多操作');
    setIcon(more, 'more-horizontal');
    // 按下这一下不要被当成「开始拖卡片」，否则菜单还没弹出就先起拖
    more.addEventListener('mousedown', (e) => e.stopPropagation());
    more.onclick = (e) => {
      e.stopPropagation();
      this.openCardMenu(card, e);
    };
    return more;
  }

  openCardMenu(card, evt) {
    const menu = new Menu();
    const info = this.plugin.refSummary(card);
    const n = info ? info.notes : 0;

    menu.addItem((i) =>
      i
        .setTitle('复制全文')
        .setIcon('copy')
        .onClick(async () => {
          await this.plugin.copy(qmPasteText(card.body));
          new Notice('已复制卡片全文');
        })
    );
    menu.addItem((i) => i.setTitle('复制链接').setIcon('link').onClick(() => this.copyRef(card)));
    menu.addItem((i) => i.setTitle('编辑').setIcon('pencil').onClick(() => this.requestEdit(card)));

    menu.addSeparator();

    if (!this.plugin.refsReady()) {
      // 索引还没建好时说清楚，别让人误以为「没被引用过」
      menu.addItem((i) =>
        i.setTitle('引用统计准备中…').setIcon('corner-down-right').setDisabled(true)
      );
    } else if (n) {
      const names = info.names.slice(0, 3).join('、') + (info.names.length > 3 ? ' 等' : '');
      menu.addItem((i) =>
        i
          .setTitle('被 ' + n + ' 篇笔记引用 · ' + names)
          .setIcon('corner-down-right')
          .setDisabled(true)
      );
      menu.addItem((i) =>
        i
          .setTitle(this.state.refFilter === 'has' ? '取消「只看已引用」' : '只看被引用的卡片')
          .setIcon('filter')
          .onClick(() => this.setRefFilter(this.state.refFilter === 'has' ? '' : 'has'))
      );
    } else {
      menu.addItem((i) =>
        i.setTitle('还没有笔记引用这张卡片').setIcon('corner-down-right').setDisabled(true)
      );
    }

    menu.addItem((i) =>
      i.setTitle('在文件中定位').setIcon('file-search').onClick(() => this.locateCard(card))
    );

    menu.addSeparator();
    menu.addItem((i) => i.setTitle('删除').setIcon('trash-2').onClick(() => this.confirmDelete(card)));

    // 鼠标点：跟着指针；键盘触发：退回到按钮位置
    if (evt && (evt.clientX || evt.clientY)) {
      menu.showAtMouseEvent(evt);
    } else {
      const el = evt && evt.currentTarget;
      const r = el && typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
      menu.showAtPosition(r ? { x: r.left - 160, y: r.bottom + 4 } : { x: 120, y: 120 });
    }
    return menu;
  }

  /** 复制块链接：与 1.6 以来一致，跟随「嵌入」开关 */
  async copyRef(card) {
    const hadId = !!card.id && card.idOnLastLine;
    const id = await this.plugin.ensureId(card);
    if (!id) {
      new Notice('没找到这张卡片，请改用「复制全文」');
      return;
    }
    const bang = this.plugin.settings.blockRefEmbed ? '!' : '';
    const ref = bang + '[[' + this.plugin.linkTarget(card) + '#^' + id + ']]';
    await this.plugin.copy(ref);
    new Notice((hadId ? '已复制：' : '已为这条卡片补上块 ID，已复制：') + ref, 7000);
  }

  confirmDelete(card) {
    new ConfirmModal(
      this.app,
      '删除这条卡片？',
      async () => {
        await this.plugin.deleteCard(card);
      },
      this.refDeleteDetail(card)
    ).open();
  }

  /**
   * 在月份文件里打开这张卡所在的那一行。
   * 写入前先按块 ID 重新定位，定位不到就不跳（宁可不跳，也别跳到错的地方）。
   */
  async locateCard(card) {
    const file = this.app.vault.getAbstractFileByPath(card.filePath);
    if (!(file instanceof TFile)) {
      new Notice('这张卡片所在的文件找不到了');
      return;
    }

    let hit = null;
    try {
      const text = String((await this.app.vault.read(file)) || '').replace(/\r\n?/g, '\n');
      hit = qmLocateCard(text, card, { strict: this.plugin.settings.strictCardId !== false });
    } catch (e) {
      hit = null;
    }
    if (!hit) {
      new Notice('卡片位置已变化，刷新后再试');
      return;
    }

    const leaf = this.app.workspace.getLeaf(false);
    if (!leaf || typeof leaf.openFile !== 'function') {
      new Notice('打不开这个文件');
      return;
    }
    await leaf.openFile(file, { eState: { line: hit.lineIndex } });

    const view = leaf.view;
    if (view && view.editor) {
      const from = { line: hit.lineIndex, ch: 0 };
      const to = { line: hit.lineEnd, ch: 0 };
      view.editor.setCursor(from);
      view.editor.scrollIntoView({ from, to }, true);
    }
  }

  /**
   * 进入编辑态的唯一入口（双击与菜单都走这里）。
   * 同时只允许一处编辑：另一条有未保存的改动时，让用户自己选怎么处理。
   */
  requestEdit(card) {
    const key = this.cardKey(card);
    const cur = this.state.editingKey;
    if (cur === key) return;
    if (!cur) {
      this.beginEdit(key);
      return;
    }

    const prev = this.state.cards.find((c) => this.cardKey(c) === cur);
    const draft = this.state.editingDraft;
    const dirty =
      !!prev && !!draft && draft.key === cur && String(draft.text) !== String(prev.body);

    // 没改动就静默切过去：绝大多数情况只是点错了
    if (!dirty) {
      this.beginEdit(key);
      return;
    }

    new DraftSwitchModal(this.app, {
      preview: prev.time + ' ' + qmFirstLine(prev.body),
      onDiscard: () => this.beginEdit(key),
      onSave: async () => {
        if (!String(draft.text || '').trim()) {
          new Notice('内容不能为空');
          return false;
        }
        this.state.editingKey = null;
        this.state.editingDraft = null;
        const saved = await this.plugin.updateCard(prev, draft.text);
        if (!saved) {
          // 没写成功就回到原来那条，草稿原样留着
          this.state.editingKey = cur;
          this.state.editingDraft = draft;
          this.renderList();
          return false;
        }
        this.beginEdit(key);
        return true;
      },
    }).open();
  }

  beginEdit(key) {
    this.state.editingKey = key;
    this.state.editingDraft = null;
    this.renderList();
  }

  bindCardEdit(box, card) {
    box.addEventListener('dblclick', (e) => {
      if (this.state.selectMode) return;
      const t = e.target;
      // 链接、标签、「···」保持各自的原生点击语义，不抢双击
      if (t && typeof t.closest === 'function' && t.closest('a, .qm-tag, .qm-more, .qm-ref, button')) {
        return;
      }
      if (e.preventDefault) e.preventDefault();
      this.requestEdit(card);
    });
  }

  /**
   * 整张卡可拖：拖出去的是「指向这张卡的引用」，与复制链接同一份文本。
   * 只有一处例外——从卡片里的裸网址起手的拖拽交给浏览器，那不是拖卡片。
   */
  bindCardDrag(box, card) {
    box.setAttr('draggable', 'true');

    box.addEventListener('mousedown', () => {
      const now = Date.now();
      // 距上一次按下很近：这多半是双击的第二下，那一刻不发起拖拽
      this._dblRisk = now - (this._lastDown || 0) < 420;
      this._lastDown = now;
    });

    box.addEventListener('dragstart', (e) => {
      if (this._dblRisk || this.state.selectMode || this.state.editingKey) {
        if (e.preventDefault) e.preventDefault();
        return;
      }
      const t = e.target;
      if (t && typeof t.closest === 'function' && t.closest('a')) return;
      if (e.stopPropagation) e.stopPropagation();

      const text = this.dragPayload(card);
      if (e.dataTransfer) {
        try {
          e.dataTransfer.setData('text/plain', text);
          e.dataTransfer.effectAllowed = 'copy';
        } catch (err) {
          /* 极端情况下 setData 会抛（非用户手势），静默即可 */
        }
      }
      box.addClass('is-dragging');
    });

    box.addEventListener('dragend', () => box.removeClass('is-dragging'));
  }

  /**
   * 拖出去的内容。有块 ID 就是引用（跟随「嵌入」开关，与复制链接完全一致）；
   * 1.5 时代的老卡片没有块 ID，只能退化成正文全文，并提示一次。
   */
  dragPayload(card) {
    if (card.id) {
      const bang = this.plugin.settings.blockRefEmbed ? '!' : '';
      return bang + '[[' + this.plugin.linkTarget(card) + '#^' + card.id + ']]';
    }
    if (!this._noIdHint) {
      this._noIdHint = true;
      new Notice('这条卡片还没有块 ID，这次拖出去的是正文全文');
    }
    return qmPasteText(card.body);
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

    new Setting(containerEl)
      .setName('严格识别卡片（推荐开启）')
      .setDesc(
        '只把带块 ID（形如 ^abc123）的时间条目当成卡片。插件记录的卡片一定带块 ID；' +
          '你在速记文件正文里手写的「- 12:30 开会」只是普通文字，不会出现在面板里，也不会被误删。' +
          '关掉后，任何「- 时间 内容」的行都会被当成卡片。'
      )
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.strictCardId !== false).onChange(async (v) => {
          this.plugin.settings.strictCardId = v;
          await this.plugin.saveSettings();
          // 刚打开严格识别时，提醒一下有没有因此不显示的条目
          if (v) this.plugin.checkUnmanagedEntries();
        })
      );

    new Setting(containerEl)
      .setName('块引用使用嵌入形式')
      .setDesc(
        '关闭时「复制链接」给出 [[文件#^id]]，点一下跳到那条卡片；' +
          '打开后给出 ![[文件#^id]]，粘贴的位置会直接展开卡片内容。'
      )
      .addToggle((tg) =>
        tg.setValue(!!this.plugin.settings.blockRefEmbed).onChange(async (v) => {
          this.plugin.settings.blockRefEmbed = v;
          await this.plugin.saveSettings();
        })
      );
  }
}

/* ------------------------------------------------------------------ */
/* 插件主体                                                            */
/* ------------------------------------------------------------------ */

class QuickMemoPlugin extends Plugin {
  /* ---------------- 引用统计（只读 Obsidian 内存索引，不写任何文件） ---------------- */

  refsReady() {
    return !!this._refReady;
  }

  /**
   * 重建「哪张卡被哪些笔记引用」的索引。
   * 数据全部来自 Obsidian 自己的链接索引（metadataCache），不打开文件、不写入。
   * 口径：按「篇」统计（同一篇笔记引多次只算 1 篇），同时记下总处数。
   */
  buildRefIndex() {
    const items = [];
    if (!this.app || !this.app.metadataCache) return new Map();

    let files = [];
    try {
      files = this.app.vault.getMarkdownFiles() || [];
    } catch (e) {
      return new Map();
    }

    // 同名文件会让 [[2026-11#^id]] 指错地方，先数一下重名
    const nameCount = new Map();
    for (const f of files) {
      const b = qmBaseName(f.path);
      nameCount.set(b, (nameCount.get(b) || 0) + 1);
    }

    for (const f of files) {
      // 速记文件夹内部互相引用不算：那不代表「用进了长文」
      if (this.isCardFilePath(f.path)) continue;
      let cache = null;
      try {
        cache = this.app.metadataCache.getFileCache(f);
      } catch (e) {
        cache = null;
      }
      if (!cache) continue;

      const lists = [cache.links, cache.embeds, cache.frontmatterLinks];
      for (const arr of lists) {
        if (!arr || !arr.length) continue;
        for (const l of arr) {
          const ref = qmParseBlockRef((l && (l.link || l.original)) || '');
          if (!ref || !ref.target) continue;

          let dest = null;
          try {
            dest = this.app.metadataCache.getFirstLinkpathDest(ref.target, f.path);
          } catch (e) {
            dest = null;
          }
          if (!dest || !dest.path) continue;
          if (!this.isCardFilePath(dest.path)) continue;

          const base = qmBaseName(dest.path);
          items.push({
            sourcePath: f.path,
            destPath: dest.path,
            id: ref.id,
            ambiguous: (nameCount.get(base) || 0) > 1,
          });
        }
      }
    }

    return qmAggregateRefs(items);
  }

  /** 立刻重算（同步、只读内存，几毫秒） */
  refreshRefs() {
    let idx;
    try {
      idx = this.buildRefIndex();
    } catch (e) {
      idx = this._refIndex || new Map();
    }
    this._refIndex = idx;
    this._refReady = true;
    return idx;
  }

  /** 别处改了文件后合并重算，避免连续敲字触发多次 */
  queueRefs(delay) {
    if (this._refTimer) clearTimeout(this._refTimer);
    this._refTimer = setTimeout(() => {
      this._refTimer = null;
      this.refreshRefs();
      this.notifyRefs();
    }, typeof delay === 'number' ? delay : 800);
  }

  refEntry(card) {
    if (!card || !card.id) return null;
    if (!this._refIndex) return null;
    return this._refIndex.get(card.filePath + '#^' + String(card.id).toLowerCase()) || null;
  }

  /** 被几篇笔记引用 */
  refCount(card) {
    const e = this.refEntry(card);
    return e ? e.notes.size : 0;
  }

  /** 被引用的总数 / 来源笔记名，供提示文字用 */
  refSummary(card) {
    const e = this.refEntry(card);
    if (!e) return null;
    const names = Array.from(e.notes).map((p) => String(p).split('/').pop().replace(/\.md$/i, ''));
    return { notes: e.notes.size, places: e.places, names, ambiguous: e.ambiguous };
  }

  /** 通知已打开的面板：只刷新引用数字，不重读文件 */
  notifyRefs() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_QM)) {
      const v = leaf.view;
      if (v && typeof v.updateRefs === 'function') v.updateRefs();
    }
  }

  async onload() {
    await this.loadSettings();

    // 过期的草稿顺手清掉，别一直躺在配置里占地方
    // （草稿只在本机配置里，永远不进笔记文件）
    if (this.settings.draft && this.settings.draft.text && !this.draftAlive()) {
      this.settings.draft = { text: '', at: 0 };
      try {
        await this.saveData(this.settings);
      } catch (e) {
        /* 存不进去不影响启动 */
      }
    }

    this.registerView(VIEW_TYPE_QM, (leaf) => new CardsView(leaf, this));

    // 图标必须先注册，addRibbonIcon 才认得这个名字
    addIcon(ICON_ID, ICON_METEOR);

    this.addRibbonIcon(ICON_ID, 'Collis', async () => {
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
      // 'Mod' 由 Obsidian 按平台解析：macOS 是 Cmd，Windows/Linux 是 Ctrl。
      // 用 J 而不是 K：Mod+K 是核心命令「插入 Markdown 链接」的默认键，
      // 在编辑器里会同时插入 []() 并弹出速记窗，属于硬冲突。
      hotkeys: [{ modifiers: ['Mod'], key: 'J' }],
      callback: () => new CaptureModal(this.app, this).open(),
    });

    this.addSettingTab(new QuickMemoSettingTab(this.app, this));

    // 文件被改动后顺手收走空的日期标题：不论是插件删的，
    // 还是你在 Obsidian 编辑器里手动删掉的卡片
    this.registerEvent(this.app.vault.on('modify', (f) => this.pruneSoon(f)));

    // 引用统计：别的笔记里增删块链接后跟着更新。只读索引，不写任何文件。
    // 「resolved」是 Obsidian 建完索引的那一下，用来纠正启动初期的空数字
    if (this.app.metadataCache) {
      this.registerEvent(
        this.app.metadataCache.on('resolved', () => {
          this.refreshRefs();
          this.notifyRefs();
        })
      );
      this.registerEvent(this.app.metadataCache.on('changed', () => this.queueRefs()));
    }

    // 工作区就绪后体检一次：有没有「没有块 ID」的时间条目（严格模式下它们不显示）
    const check = () => this.checkUnmanagedEntries();
    if (this.app.workspace.onLayoutReady) this.app.workspace.onLayoutReady(check);
    else check();
  }

  onunload() {
    if (this._pruneTimers) {
      for (const t of this._pruneTimers.values()) clearTimeout(t);
      this._pruneTimers.clear();
    }
    if (this._refTimer) {
      clearTimeout(this._refTimer);
      this._refTimer = null;
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
    if (!Array.isArray(this.settings.collapsedDates)) {
      this.settings.collapsedDates = [];
    }
    if (typeof this.settings.blockRefEmbed !== 'boolean') {
      this.settings.blockRefEmbed = false;
    }
    if (typeof this.settings.strictCardId !== 'boolean') {
      this.settings.strictCardId = true;
    }
    const d = this.settings.draft;
    if (!d || typeof d !== 'object' || typeof d.text !== 'string' || typeof d.at !== 'number') {
      this.settings.draft = { text: '', at: 0 };
    }

    const folder = String(this.settings.folderPath || '').replace(/^\/+|\/+$/g, '');
    this.settings.folderPath = folder && folder !== '.' ? folder : DEFAULT_SETTINGS.folderPath;
  }

  /**
   * 保存设置。reload=true 时让面板重读一遍文件（改文件夹这类必须重读）；
   * 回收站的增删恢复只需要更新一下条数，用 reload=false 走轻量重绘，不读盘。
   */
  async saveSettings(reload = true) {
    await this.saveData(this.settings);
    this.notifyViews(reload ? null : { light: true });
  }

  /* ---------------- 没提交完的手稿 ----------------
   * 只存在插件配置里（data.json），不写进任何笔记文件，
   * 也不会自己变成卡片：它只是把字填回输入框，还得你自己按保存。
   */

  /** 还有效的草稿内容；没有、为空白或超过 7 天都返回空串 */
  draftAlive() {
    const d = this.settings.draft;
    if (!d || typeof d.text !== 'string') return '';
    if (!d.text.trim()) return '';
    if (!d.at || Date.now() - d.at > DRAFT_TTL) return '';
    return d.text;
  }

  /** 打字时用这个：停顿 1.5 秒才写盘，不打断输入 */
  queueDraft(text) {
    if (this._draftTimer) clearTimeout(this._draftTimer);
    this._draftTimer = setTimeout(() => {
      this._draftTimer = null;
      this.saveDraft(text);
    }, 1500);
  }

  /** 立即落盘（关掉输入框时用；会把防抖里那次一并落地） */
  async saveDraft(text) {
    if (this._draftTimer) {
      clearTimeout(this._draftTimer);
      this._draftTimer = null;
    }
    const raw = String(text == null ? '' : text).slice(0, DRAFT_MAX);
    if (!raw.trim()) {
      await this.clearDraft();
      return;
    }
    this.settings.draft = { text: raw, at: Date.now() };
    try {
      await this.saveData(this.settings);
    } catch (e) {
      /* 配置写不进去也不该影响书写 */
    }
  }

  /** 保存成功后清掉 */
  async clearDraft() {
    if (this._draftTimer) {
      clearTimeout(this._draftTimer);
      this._draftTimer = null;
    }
    const d = this.settings.draft;
    if (!d || (!d.text && !d.at)) return;
    this.settings.draft = { text: '', at: 0 };
    try {
      await this.saveData(this.settings);
    } catch (e) {
      /* 忽略 */
    }
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

  isCardFilePath(path) {
    const folder = this.folderPathSafe();
    if (!folder) return false;
    const p = String(path || '');
    if (p.indexOf(folder + '/') !== 0) return false;
    return MONTH_FILE_RE.test(p.split('/').pop() || '');
  }

  async readAllCards() {
    const files = this.listCardFiles();
    const opts = { strict: this.settings.strictCardId !== false };
    // 各文件互不依赖，并行读；串行 N 个文件在月份多时白等
    const chunks = await Promise.all(
      files.map(async (f) => {
        let content = '';
        try {
          content = await this.app.vault.cachedRead(f);
        } catch (e) {
          try {
            content = await this.app.vault.read(f);
          } catch (e2) {
            content = '';
          }
        }
        return content ? parseCards(content, f.path, opts) : [];
      })
    );
    const all = [];
    for (const c of chunks) all.push(...c);
    return sortCards(all);
  }

  /** 快速记录弹窗用：面板已加载就直接用内存里的，避免每次开弹窗都读盘 */
  async cardsForSuggest() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_QM)) {
      const v = leaf.view;
      if (v && v._loadedOnce && v.state && Array.isArray(v.state.cards)) return v.state.cards;
    }
    return await this.readAllCards();
  }

  /* ---------------- 写入 ---------------- */

  async mutateFile(path, fn) {
    const folder = this.folderPathSafe();
    const name = String(path).split('/').pop();
    if (!folder || String(path).indexOf(folder + '/') !== 0 || !MONTH_FILE_RE.test(name)) {
      throw new Error('拒绝写入非卡片文件：' + path);
    }
    const file = await this.ensureFileAt(path);
    let written = null;
    await this.app.vault.process(file, (data) => {
      const res = fn(String(data || ''));
      const next = typeof res === 'string' ? res : data;
      if (next !== data) written = next;
      return next;
    });

    // 写入后只更新这一个文件；modify 事件那遍由 isOwnWrite 认出来挡掉
    if (written !== null) {
      this.rememberWrite(path, written);
      this.notifyViews({ path, content: written });
    } else {
      this.notifyViews({ light: true });
    }
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
    let written = null;
    const opts = { strict: this.settings.strictCardId !== false };
    await this.app.vault.process(file, (data) => {
      const content = String(data || '').replace(/\r\n?/g, '\n');
      const hit = qmLocateCard(content, card, opts);
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
      if (res !== data) written = res;
      return res;
    });

    if (written !== null) {
      this.rememberWrite(card.filePath, written);
      this.notifyViews({ path: card.filePath, content: written });
    } else {
      this.notifyViews({ light: true });
    }
    return out;
  }

  uniqueIdIn(content) {
    const ids = qmCollectIds(content);
    let id = genId();
    let guard = 0;
    while (ids.has(id) && guard++ < 50) id = genId();
    return id;
  }

  /**
   * 通知面板更新。带 {path, content} 的只重解析这一个文件；
   * {light:true} 只重画界面文字；什么都不带才是老老实实重读全部。
   */
  notifyViews(info) {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_QM)) {
      const v = leaf.view;
      if (!v) continue;
      if (info && info.path && typeof v.applyFileCards === 'function') {
        v.applyFileCards(info.path, info.content);
      } else if (info && info.light && typeof v.rerender === 'function') {
        v.rerender();
      } else if (v.refresh) {
        v.refresh();
      }
    }
  }

  /* ---------------- 认出「这是我自己刚写的」 ---------------- */

  rememberWrite(path, content) {
    if (!this._ownWrites) this._ownWrites = new Map();
    this._ownWrites.set(path, { content, at: Date.now() });
    // 只留最近 8 个文件，避免无限增长
    while (this._ownWrites.size > 8) {
      const first = this._ownWrites.keys().next().value;
      this._ownWrites.delete(first);
    }
  }

  /**
   * 刚写完触发的 modify 事件，如果磁盘内容和插件刚写的一字不差，
   * 说明就是自己那次写入，不用再重读一遍。内容变了就当作外部改动。
   */
  async isOwnWrite(file) {
    if (!this._ownWrites || !file) return false;
    const rec = this._ownWrites.get(file.path);
    if (!rec) return false;
    if (Date.now() - rec.at > 3000) {
      this._ownWrites.delete(file.path);
      return false;
    }
    let data = '';
    try {
      data = await this.app.vault.cachedRead(file);
    } catch (e) {
      return false;
    }
    if (data === rec.content) return true;
    this._ownWrites.delete(file.path);
    return false;
  }

  /* ---------------- 无块 ID 条目的体检 ---------------- */

  /**
   * 严格识别开着时，没有块 ID 的时间条目不会显示成卡片。
   * 这里只做一次提示（不改任何文件），防止旧卡片「悄悄消失」却不知道为什么。
   */
  async checkUnmanagedEntries() {
    if (this.settings.strictCardId === false) return;

    let total = 0;
    for (const f of this.listCardFiles()) {
      let content = '';
      try {
        content = await this.app.vault.cachedRead(f);
      } catch (e) {
        continue;
      }
      for (const c of parseCards(content, f.path, { strict: false })) {
        if (!c.id) total++;
      }
    }

    // 同一批条目只提醒一次，别每次启动都弹一遍
    if (!total) {
      if (this.settings.strictNoticeCount) {
        this.settings.strictNoticeCount = 0;
        try {
          await this.saveData(this.settings);
        } catch (e) {
          /* 存不进去也不影响使用 */
        }
      }
      return;
    }
    if (total === this.settings.strictNoticeCount) return;
    this.settings.strictNoticeCount = total;
    try {
      await this.saveData(this.settings);
    } catch (e) {
      /* 存不进去也不影响使用 */
    }

    new Notice(
      'Collis：有 ' + total + ' 条时间条目没有块 ID（^xxxx），不会显示成卡片。' +
        '如果是以前的卡片，在行尾补一个 ^id 就能纳入；也可以在设置里关掉「严格识别卡片」。',
      15000
    );
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
    // 自己刚写完的那次不用再查：插件写入时已经顺手清过了
    if (await this.isOwnWrite(target)) return;

    let content = '';
    try {
      content = await this.app.vault.read(target);
    } catch (e) {
      return;
    }
    if (!content || content.indexOf('##') === -1) return;

    const skip = this.cursorDatesIn(target);
    if (!qmStripEmptyDateSections(content, skip).removed.length) return;

    let changed = null;
    try {
      await this.app.vault.process(target, (data) => {
        const res = qmStripEmptyDateSections(String(data || ''), skip);
        if (!res.removed.length) return data;
        changed = res.text;
        return res.text;
      });
    } catch (e) {
      return;
    }
    if (changed !== null) {
      this.rememberWrite(target.path, changed);
      this.notifyViews({ path: target.path, content: changed });
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
      return false;
    }

    try {
      await this.mutateFile(path, (content) => {
        // ID 在文件内必须唯一，否则 Obsidian 的块引用会指错
        const id = this.uniqueIdIn(content);
        return qmInsertCardLines(content, date, qmFormatEntry(time, bodyLines, id));
      });
    } catch (e) {
      new Notice('没记下来：' + (e && e.message ? e.message : '未知原因'), 8000);
      return false;
    }

    new Notice('已记下');
    return true;
  }

  /* ---------------- 补块 ID ---------------- */

  /**
   * 块引用的目标名：默认用文件名（移动文件夹不会断）。
   * 只有 vault 里存在同名文件时才补全路径，避免链接指到另一个同名文件。
   */
  linkTarget(card) {
    const name = String((card && card.fileBase) || '') + '.md';
    let files = [];
    try {
      files = this.app.vault.getMarkdownFiles ? this.app.vault.getMarkdownFiles() : [];
    } catch (e) {
      files = [];
    }
    const same = files.filter((f) => f && f.name === name);
    if (same.length > 1) return String(card.filePath || '').replace(/\.md$/, '');
    return String((card && card.fileBase) || '');
  }

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

  /** 返回是否真的写盘成功：调用方靠它决定要不要退出编辑态（失败时草稿要留着） */
  async updateCard(card, newBody) {
    const bodyLines = qmBodyLines(newBody);
    if (!bodyLines.length) {
      new Notice('内容不能为空');
      return false;
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
    return !!res.ok;
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

  /**
   * 批量删除：按文件分组，同一文件里的多条合并成一次读写。
   * 每条仍然走 qmLocateCard 的正文校验，定位不到的跳过（不写坏文件），
   * 删下来的原始行进回收站，可以逐条恢复。
   */
  async deleteCards(cards) {
    const list = Array.isArray(cards) ? cards.slice() : [];
    const saved = [];
    const failed = [];

    const byFile = new Map();
    for (const c of list) {
      const p = String((c && c.filePath) || '');
      if (!p) {
        failed.push(c);
        continue;
      }
      if (!byFile.has(p)) byFile.set(p, []);
      byFile.get(p).push(c);
    }

    const writes = [];
    for (const [path, group] of byFile) {
      const file = this.app.vault.getAbstractFileByPath(path);
      const guard = this.checkManagedFile(file, group[0].date);
      if (!guard.ok) {
        failed.push(...group);
        continue;
      }

      const removed = [];
      const opts = { strict: this.settings.strictCardId !== false };
      try {
        await this.app.vault.process(file, (data) => {
          const text = String(data || '');
          const ranges = [];
          // 两条卡片若指向同一处（比如手工复制出重复块 ID），只删一次
          const used = new Set();
          for (const c of group) {
            const hit = qmLocateCard(text, c, opts);
            if (!hit || used.has(hit.lineIndex)) {
              failed.push(c);
              continue;
            }
            used.add(hit.lineIndex);
            ranges.push(hit);
          }
          if (!ranges.length) return data;

          const lines = text.replace(/\r\n?/g, '\n').split('\n');
          // 从后往前删，前面的行号才不会错位
          ranges.sort((a, b) => b.lineIndex - a.lineIndex);
          for (const hit of ranges) {
            removed.push({
              date: hit.date,
              time: hit.time,
              body: hit.body,
              lines: lines.slice(hit.lineIndex, hit.lineEnd + 1),
              filePath: path,
            });
            lines.splice(hit.lineIndex, hit.lineEnd - hit.lineIndex + 1);
          }

          let out = lines.join('\n');
          for (const d of new Set(removed.map((x) => x.date))) {
            out = qmPruneEmptyDateSections(out, d);
          }
          if (out !== data) {
            this.rememberWrite(path, out);
            writes.push({ path, content: out });
          }
          return out;
        });
      } catch (e) {
        failed.push(...group);
        continue;
      }

      saved.push(...removed);
    }

    if (saved.length) await this.pushTrashMany(saved);

    // 只动了一个文件就定向更新；跨月批量删（少见）才退回全量重读
    if (writes.length === 1) this.notifyViews({ path: writes[0].path, content: writes[0].content });
    else if (writes.length > 1) this.notifyViews();
    else this.notifyViews({ light: true });

    return { deleted: saved.length, failed: failed.length };
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
    if (this.settings.trash.length > 50) this.settings.trash.length = 50;
    await this.saveSettings(false);
    return entry;
  }

  /** 批量入回收站：一次写完，避免 N 次读写配置与刷新视图 */
  async pushTrashMany(items) {
    if (!items || !items.length) return;
    const now = Date.now();
    for (let i = 0; i < items.length; i++) {
      const it = items[i] || {};
      this.settings.trash.unshift({
        uid: 't' + (now + i).toString(36) + Math.random().toString(36).slice(2, 6),
        date: String(it.date || ''),
        time: String(it.time || ''),
        body: String(it.body || '').slice(0, 4000),
        lines: Array.isArray(it.lines) ? it.lines.slice() : [],
        filePath: String(it.filePath || ''),
        deletedAt: now,
      });
    }
    // 批量删除一次可能超过单条上限，这里放宽到 50 条
    if (this.settings.trash.length > 50) this.settings.trash.length = 50;
    await this.saveData(this.settings);
  }

  async dropTrash(uid) {
    const i = this.settings.trash.findIndex((t) => t.uid === uid);
    if (i === -1) return;
    this.settings.trash.splice(i, 1);
    await this.saveSettings(false);
  }

  async clearTrash() {
    this.settings.trash = [];
    await this.saveSettings(false);
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
    let written = null;
    await this.app.vault.process(file, (data) => {
      const content = String(data || '').replace(/\r\n?/g, '\n');
      const ids = qmCollectIds(content);

      let lines = (entry.lines || []).slice();
      if (!lines.length) {
        lines = qmFormatEntry(entry.time || '00:00', qmBodyLines(entry.body), '');
      }

      // 块 ID 处理：冲突就换一个；旧记录里压根没有 ID 的，补一个，
      // 否则「严格识别」开着时恢复出来的卡片会看不见
      const last = lines.length - 1;
      const m = String(lines[last] || '').match(/[ \t]\^([A-Za-z0-9-]+)[ \t]*$/);
      const needId = !m || ids.has(m[1]);
      if (needId) {
        let nid = genId();
        let guardN = 0;
        while (ids.has(nid) && guardN++ < 50) nid = genId();
        const bare = String(lines[last] || '').replace(/[ \t]\^[A-Za-z0-9-]+[ \t]*$/, '');
        lines[last] = bare.replace(/[ \t]+$/, '') + ' ^' + nid;
      }

      done = true;
      const out = qmInsertRestoredCard(content, entry.date, entry.time, lines);
      if (out !== data) written = out;
      return out;
    });

    if (!done) {
      new Notice('恢复失败：目标文件不可写');
      return;
    }

    this.settings.trash.splice(i, 1);
    await this.saveSettings(false);
    if (written !== null) {
      this.rememberWrite(entry.filePath, written);
      this.notifyViews({ path: entry.filePath, content: written });
    }
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
// 便于本地测试直接构造弹窗；Obsidian 只关心 module.exports 本身
module.exports.CaptureModal = CaptureModal;
