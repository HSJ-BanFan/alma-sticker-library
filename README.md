# Sticker Library（Alma 插件）

本地表情包库存：导入 AstrBot 格式的表情包、按语境检索、手动维护分类与描述。
插件只负责「有哪些图、各自表达什么」；发不发、发哪张、怎么发，交给 Alma 和各渠道工具。

## 使用

- 数据目录：`~/.config/alma/stickers/`
  - `packs/<pack-id>/manifest.json` + `memes/<分类>/<图片>`
  - `packs/<pack-id>/semantic_metadata.json`：图片描述、标签、分类审核状态
  - `packs/<pack-id>/semantic_index.json` + `semantic_vectors.f32`：本地向量索引，激活时后台增量构建
  - `_models/transformers/`：bge-small-zh 模型缓存（约 23 MB，首次构建时下载）
  - `settings.json` / `rules.json`：设置中心与使用规则
- 打开管理页面：在 Alma 里执行 `/stickers`，或直接访问 `http://127.0.0.1:8899`
  - 表情包管理 `/app/a_manage/`
  - 资源广场 `/app/catalog/`
  - 语义化 `/app/semantic/`
  - 设置中心 `/app/settings/`
- 语义检索需要视觉模型：在「设置中心 → 标签与匹配」里选择模型后，到「语义化」页面生成描述。
  Alma 版用本地 bge-small-zh 向量索引检索，描述词项匹配作为兜底。

## 给只能调用 Bash 的 Agent

如果模型只能运行命令，可以直接选图，不必遍历图包或读取 `semantic_metadata.json`。

```bash
node "C:/Users/33308/.config/alma/plugins/alma-sticker-library/scripts/pick.mjs" --query "想表达的态度" --top 3
```

命令返回 `{found, query, mode, index, picks}`，每张图带绝对路径 `file` 和描述。加 `--file-only` 只输出第一张图的路径。

Alma 正在运行时，命令优先请求本地服务；服务不可用时会降级为关键词检索。能调用工具时优先使用 `sticker_pick` / `sticker_search`，这比走 Bash 更直接。

本地聊天里 `sticker_pick` 会调用 `POST /api/threads/:threadId/send-photo`，把选中的图直接注入当前助手回复，返回 `delivered: true`。外部渠道拿不到线程到 chat 的映射，工具改为返回 `file` 和 `next`，由模型执行一次 `alma send photo "<file>"`。

## 让 Alma 主动用表情包

分工：工具给能力，记忆只写“有什么、怎么找到”，其余交给 Alma。

- 能力：`sticker_pick` 一次调用选图并投递；`sticker_search` 只给候选。
- 用法：新会话里先用 `ToolSearch` 搜 "sticker" 才会看到这两个工具。可选执行 `/stickers-skill` 安装 `sticker-etiquette`，正文按需加载，只讲调用方式，不规定频率或图文比例。
- 触发：在 `MEMORY.md` 写能力说明，不写频率规则：

  > 本地表情包库已通过 `alma-sticker-library` 接入。工具是 `sticker_search` / `sticker_pick`；新会话里先用 `ToolSearch` 搜 "sticker" 才会出现。表情包也是你表达情绪的一种方式，想用的时候就用。发不发、发什么、发多少、怎么发，由你判断。

不要写“每次都发”“一轮最多一张”或“必须带文字”。这些会把表达变成配额；插件也不拦只发图。

如果想让这种表达成为人格而不是记忆，可以在 `SOUL.md` 加一节：

```
## 表达方式

表情包也是我表达情绪的一种方式，想用的时候就用。
```

创建 `SOUL.md` 会同时启用 Alma 的每日人格演化（她可能往 “Evolved Traits” 里追加条目），默认人格还会从 SOUL 的 “My Appearance” 一节读取自拍外观。不用自拍可以忽略；用自拍的话要补上外观。

## 已实现 / 未实现

- 已实现：包导入导出、分类与图片增删改移、社区索引安装（含进度与取消）、
  语义描述生成、本地向量索引（bge-small-zh）与检索、使用规则、设置中心、全量备份与恢复。
- 未实现：自动收集（从聊天里收图）、图床 / 云同步。相关界面保留并标注为暂不可用，
  配置可以保存，但不会实际生效。

## 开发：改动后必须让 Alma 重新加载模块

Alma 的插件宿主这样加载入口：

```js
await import(`${entryUrl}?t=${Date.now()}`)
```

入口 `main.js` 每次启用都会重新求值，但入口里的**静态 import 没有缓存参数**，
Electron 主进程会按文件路径永久缓存子模块。直接改 `gallery.js` / `lib/*.js` 后
disable/enable 插件，运行的仍是第一次加载的旧代码。

改完代码后执行：

```bash
node scripts/bump-cache.mjs            # 自动生成新版本号，重写所有相对 import 的 ?v=
# 或指定版本
node scripts/bump-cache.mjs 0.2.1-1
```

然后重载插件：

```bash
curl -X POST http://127.0.0.1:23001/api/plugins/alma-sticker-library/disable
curl -X POST http://127.0.0.1:23001/api/plugins/alma-sticker-library/enable
```

验证是否真的换了代码（运行时与磁盘一致）：

```bash
curl -s http://127.0.0.1:8899/api/catalog | head -c 80      # 新 API 返回 {"packs":[...]}
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8899/app/catalog/   # 200
```

`webui/` 下的页面由 HTTP 服务按请求读盘，不走模块缓存；改完刷新浏览器即可
（响应带 `cache-control: no-cache`）。

## 目录结构

```
main.js                插件入口：工具、命令、事件
gallery.js             本地 HTTP 服务与 API 路由
webui/                 源项目页面（按原样使用），bridge.js 适配 Alma 本地服务
lib/
  util.js              路径、JSON、哈希、zip（流式读写）
  store.js             包/分类/图片/注册表
  settings.js          设置 schema、校验、使用规则
  semantic.js          视觉标注任务、描述索引检索、单图编辑
  community.js         社区索引与后台安装任务
  packsio.js           导入导出与全量备份
  search.js            关键词/分类兜底检索
scripts/bump-cache.mjs 重写 import 版本号，绕过 Alma 的模块缓存
```
