# Collis

English · [中文文档](#中文文档)

Collis is a lightweight card-note plugin for Obsidian. Jot down a thought without creating a file, naming it, or picking a folder — press `Ctrl+Enter` and it is saved. Need a line break mid-thought? Press `Enter`; the layout is kept exactly as you wrote it.

Everything is stored as plain Markdown inside your own vault. No database, no proprietary format, no account.

## Features

- **Quick capture** — a sidebar input box, or `Ctrl+Shift+K` for a floating capture window. `Enter` for a new line, `Ctrl+Enter` to save.
- **Multi-line cards** — continuation lines are stored as indented lines with Markdown hard breaks, so both the card view and reading view keep your original line breaks.
- **Tag autocomplete** — type `#` and pick from tags that already exist in your cards.
- **Nested tags** — `#parent/child` is supported; the tag bar groups children under their parent, and clicking the parent filters the whole group.
- **Search across everything** — the search box covers every monthly file, not just the current month. Type `#tag`, `2026-11`, `11-07`, `13:41` or `"a whole phrase"` to filter by that dimension; space-separated words must all match.
- **Edit, delete, undo** — inline editing with `Ctrl+Enter` to save and `Esc` to cancel; single or batch delete, a 9-second undo notice, and a "recently deleted" list holding the last 50 cards.
- **Copy card text or block reference** — copy the plain text of a card, or `![[2026-11#^a1b2c3]]` to embed it elsewhere.
- **Reference count** — each card shows how many notes actually link to it through `[[file#^id]]` or `![[file#^id]]`; several links from the same note count once, and links between cards of the same capture file are ignored. Click the number to filter the referenced cards, or use the "Refs" button to cycle all → referenced → unreferenced. Deleting a card that is referenced elsewhere warns you first.
- **Clickable URLs** — bare `https://…` links in card text open in your browser. `[[wikilinks]]` and Markdown syntax stay plain text on purpose.
- **Draft recovery** — close the window mid-sentence and the text is kept locally, then restored next time you open it (kept for 7 days).
- **Monthly archive** — one file per month, so a single file never grows without bound.

## Installation

### From the community plugin store

1. Open **Settings → Community plugins → Browse**.
2. Search for **Collis**.
3. Click **Install**, then **Enable**.

### Manual installation

1. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/R529/collis/releases).
2. Put them in `<your vault>/.obsidian/plugins/collis/`.
   The folder name must be `collis`, matching the plugin ID.
3. Reload Obsidian, then enable **Collis** under **Settings → Community plugins**.

### With BRAT

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat).
2. Run `BRAT: Add a beta plugin for testing`.
3. Enter `R529/collis` and enable the plugin.

## Usage

- Click the **Collis** ribbon icon to open the card view, or press `Ctrl+Shift+K` for the quick capture window.
- Type your note. `Enter` inserts a new line, `Ctrl+Enter` saves it under today's date.
- Add tags inline with `#tag`; start typing `#` and pick from the suggestions.
- Cards are written to `00-Inbox/速记/` as `YYYY-MM.md` by default. The folder is configurable in settings.

### Data format

```markdown
## 2026-11-06

- 09:15 Meeting notes: confirm next Wednesday's release plan #work ^a1b2c3
- 14:30 Buy milk and coffee beans #life ^d4e5f6
- 16:51 First line  
  Second line #example ^e7g8h9
```

- `- HH:mm text` is the first line of a card; continuation lines are indented by two spaces, ending with two spaces for a Markdown hard break.
- `^a1b2c3` is an Obsidian block ID, kept on the last line of the card so it can be linked and embedded.
- Cards are ordinary Markdown list items. Uninstall the plugin and your notes are untouched.

### Strict card detection

Since 1.7.0, only entries that carry a block ID are treated as cards. A line you type by hand in the editor — `- 12:30 standup` — stays plain text, so it never shows up in the card list and can never be deleted by mistake. To make such a line a card, append `^` plus a few letters. This rule can be turned off in settings.

## Compatibility

- Obsidian 1.4.0 or newer; works on desktop and mobile.
- Older single-line card formats are fully compatible — no migration needed.
- Cards live in standard `YYYY-MM.md` files and can be opened by any editor.

## Privacy

The plugin runs entirely offline. It makes no network requests, collects no data, and needs no account. Unfinished drafts are kept only in the plugin's own data file, never written into your notes.

## License

MIT — see [LICENSE](./LICENSE).

---

## 中文文档

Collis 是一个为 Obsidian 打造的轻量卡片笔记插件。随手即记，数据完全存在你自己的 Markdown 文件里。

不需要新建文件、不需要命名、不需要选文件夹——写完按 `Ctrl+Enter`，就存好了。写到一半想换行？直接按 `Enter`，保存后排版原样保留。

## 为什么做这个插件

Obsidian 原生的记录方式是「一条笔记 = 一个文件」。想记一句话，也要先建文件、起标题、选目录。次数多了，记录这件事本身就变成了负担。

这个插件把记录的粒度从「文件」降到「一张卡片」：

- 一条卡片就是 Markdown 里的一个列表项，可以是一行，也可以是多行
- 所有卡片按月存在 `YYYY-MM.md` 里
- 不想要这个插件了，直接删掉插件文件夹即可，笔记原样保留

## 功能

| 功能 | 说明 |
| --- | --- |
| 快速记录 | 侧边栏输入框，`Enter` 换行、`Ctrl+Enter` 保存，自动写入当天日期下 |
| 手稿不丢 | 写到一半关掉窗口、切走、或者保存失败，内容都留着；下次打开自动填回，停留 7 天 |
| 多行排版 | 换行写成缩进续行 + Markdown 硬换行；卡片视图和阅读视图都保留记录时的分行，旧的单行卡片格式不变 |
| 标签联想 | 输入 `#` 自动弹出已有标签，按使用频率排序；`Tab` 或 ↑↓ + `Enter` 确认、`Esc` 关闭；直接按 `Enter` 优先换行，不抢输入 |
| 父子标签 | 支持 `#父/子` 嵌套标签，标签栏自动把子标签聚合到父标签下，点击父标签一次即筛选整组 |
| 折叠标签栏 | 默认只显示前几个标签组，尾部「更多 / 收起」，不会把列表挤小 |
| 无标签筛选 | 一键筛出还没打标签的卡片，方便回头补标签 |
| 全量搜索 | 搜索框覆盖所有月份文件，不只是当月；空格分词，多个词需同时命中 |
| 智能搜索 | 直接输入 `#标签`、`2026-11`、`11-07`、`13:41` 或 `"整句短语"`，按对应维度筛选 |
| 标签筛选 | 点任意标签，筛出同标签的全部卡片，带数量统计 |
| 日期折叠 | 点击日期标题即可折叠当天卡片，折叠状态会被记住 |
| 内联编辑 | 点「编辑」原地修改，多行内容按行数自动展开，`Ctrl+Enter` 保存，`Esc` 取消 |
| 删除 | 二次确认后删除整张卡片（含所有续行）；当天卡片删空后，空的 `## 日期` 标题一并清理 |
| 批量删除 | 进入选择模式后勾选多条，一次删除，跨月份的会分别处理 |
| 撤销与最近删除 | 删除后提示条可点撤销；底部「最近删除」保留最近 50 条，可逐条恢复或清空 |
| 复制全文 | 一键复制卡片正文全部内容（含换行、标签），粘贴到任何笔记里直接就是文字，不依赖块 ID |
| 复制块引用 | 一键复制 `![[2026-11#^a1b2c3]]`，块 ID 自动保持在 Obsidian 可识别的位置，方便回链与嵌入 |
| 被引用次数 | 卡片右上角显示「被 N」——只统计仓库里真实的 `[[文件#^id]]` / `![[文件#^id]]`，同一篇笔记引多次只算一篇，速记内部互引不算；点数字直接筛出已引用的卡片，「引用」按钮在 全部 → 已引用 → 未引用 之间循环；删除被引用的卡片前会提示有多少篇笔记引用了它 |
| 网址可点 | 正文里的 `https://…` 点了直接开浏览器，长网址在原位折行 |
| 按月归档 | 每月一个文件，避免单文件无限膨胀 |

## 安装

### 方式一：手动安装（推荐）

1. 下载本仓库的 `main.js`、`manifest.json`、`styles.css` 三个文件
   - 或从 [Releases](https://github.com/R529/collis/releases) 页面下载最新版本
2. 在你的 Obsidian 库中，进入 `.obsidian/plugins/` 目录
3. 新建文件夹 `collis`
   > 文件夹名对应插件 ID `collis`，请勿改名，否则 Obsidian 无法识别插件。
4. 把三个文件放进这个文件夹
5. 重启 Obsidian
6. 设置 → 第三方插件 → 找到「Collis」→ 打开开关

如果你的库里看不到 `.obsidian` 文件夹，需要在系统里开启「显示隐藏文件」。

### 方式二：BRAT（可自动更新）

1. 安装 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 插件
2. 命令面板执行 `BRAT: Add a beta plugin for testing`
3. 输入 `R529/collis`
4. 启用「Collis」

## 使用

### 打开卡片视图

- 点击左侧边栏的「Collis」图标
- 或按 `Ctrl+P` 搜索「打开卡片视图」
- 或按 `Ctrl+Shift+K` 直接唤出快速记录弹窗

### 记录一下

在视图顶部输入框写内容，`Enter` 换行，`Ctrl+Enter` 保存。输入框会随内容自动长高。

想加标签就直接写 `#标签`，输入 `#` 时会弹出已有标签供选择，不用记全名，也不会重复造标签。候选弹出时按 `Enter` 仍然换行，要选标签请用 `Tab`，或先用 ↑↓ 选中再按 `Enter`。

### 数据存在哪

默认存放在 `00-Inbox/速记/`，每月一个文件：

```markdown
## 2026-11-06

- 09:15 会议记录：确认下周三的发布计划 #工作 ^a1b2c3
- 14:30 买牛奶和咖啡豆 #生活 ^d4e5f6
- 16:51 第一行内容  
  第二行内容 #示例 ^e7g8h9
```

- `- HH:mm 正文` 是卡片首行
- 换行写成缩进两空格的续行，行尾两个空格是 Markdown 硬换行（阅读视图里也分行）
- `#标签` 是 Obsidian 原生标签，全局搜索、标签面板都能识别
- `#父/子` 是嵌套标签，Obsidian 原生支持
- `^a1b2c3` 是块 ID，固定在卡片最后一行，让这张卡片可以被双链和嵌入

块 ID 同时也是插件区分「卡片」和「你随手写的时间行」的唯一依据。所以直接在正文里敲 `- 12:30 开会` 不会变成卡片；想让某一行成为卡片，在行尾补一个 `^` 加几个字母就行。这条规则可以在设置里关掉。

卡片正文在文件里永远是纯文本，插件只在显示上做两件事：`#标签` 高亮、`https://…` 变成可点。双链 `[[…]]`、`[文字](网址)`、加粗、代码块这些都不会被解析——它们该在 Obsidian 的编辑器和阅读视图里用。

### 把卡片用进文章里

卡片右下角有两个复制操作：

- **复制全文**（默认）：把卡片正文原样放进剪贴板，粘贴到任何 md 文件里直接显示内容，换行也保留。不依赖块 ID，即使原卡片后来被删掉，粘出去的文字也还在。
- **复制块引用**：得到 `![[2026-11#^a1b2c3]]`，粘贴后嵌入显示这张卡片，与原处实时同步。前面加 `!` 是嵌入，去掉 `!` 是链接。插件会自动把块 ID 放在 Obsidian 认得的卡片末行，历史卡片的 ID 位置也会自动修正。

## 设置项

| 设置 | 说明 |
| --- | --- |
| 卡片文件夹 | 卡片存放位置，默认 `00-Inbox/速记`，不存在会自动创建 |
| 常用标签 | 逗号分隔，仅用于把常用标签排在候选前面；卡片里不存在的标签不会出现 |
| 最多渲染条数 | 仅影响列表渲染性能，不影响搜索范围 |
| 自动清理空日期标题 | 默认开启。某天卡片全部删空后，连 `## 日期` 一起收走；在编辑器里手删同样生效，光标所在的日期段暂时不动 |
| 严格识别卡片 | 默认开启。只把带块 ID（`^abc123`）的时间条目当成卡片，正文里手写的 `- 12:30 开会` 只是普通文字 |
| 块引用使用嵌入形式 | 关闭时复制 `[[文件#^id]]`（点击跳转），打开后复制 `![[文件#^id]]`（直接展开内容） |

## 兼容性

- Obsidian 1.4.0 及以上
- 桌面端与移动端均可使用
- 旧版单行卡片格式完全兼容，升级后无需迁移
- 1.7.0 起默认只识别带块 ID 的条目；如库里有早期没写块 ID 的卡片，打开插件时会提示条数，在行尾补 `^id` 即可，或先在设置里关掉「严格识别卡片」
- 卡片就是标准 Markdown 列表项，按月存成 `YYYY-MM.md`，任何编辑器都能直接打开
- 不依赖私有格式或外部服务，停用插件后笔记原样保留，随时可以迁移

## 隐私

插件完全在本地运行，不联网、不采集数据、不需要账号。没写完的手稿只存在插件自己的配置文件里，不会写进任何笔记。

## 许可

MIT License，详见 [LICENSE](./LICENSE)。

## 反馈

有问题或建议，欢迎提 [Issue](https://github.com/R529/collis/issues)。
