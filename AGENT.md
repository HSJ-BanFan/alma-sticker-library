# 给 Agent：一次调用选图

```bash
node "C:/Users/33308/.config/alma/plugins/alma-sticker-library/scripts/pick.mjs" --query "想表达的态度" --top 3
```

返回：

```json
{
  "found": true,
  "query": "想表达的态度",
  "mode": "vector",
  "index": {
    "state": "fresh",
    "model": "bge-small-zh",
    "dims": 512,
    "rows": 120,
    "captioned_total": 120,
    "built_at": "2026-10-22T10:00:00.000Z",
    "progress": null,
    "error": "",
    "reason": ""
  },
  "picks": [
    {
      "id": "pack-id:category/file.gif",
      "pack": "pack-id",
      "file": "C:/Users/33308/.config/alma/stickers/packs/pack-id/memes/category/file.gif",
      "caption": "画面描述",
      "visible_text": "图中文字",
      "categories": ["category"],
      "score": 0.83,
      "retrieval": "vector"
    }
  ]
}
```

`--file-only` 只输出第一张图的绝对路径。Alma 正在运行时走本地服务；未运行时自动降级为关键词检索，字段不变。不带 `--pack` 时先按使用规则选包，规则里的包没有图片描述时会自动并入有描述的包，不用挨个试。

能调用工具时，`sticker_pick` 在本地聊天里会直接把图投递到当前回复，返回 `delivered: true`；这时不要再发一次，也不要打印路径。`delivered: false` 时才用返回的 `next` 命令发一次。

不要遍历 packs/、不要直接读 semantic_metadata.json、不要为了选一张图跑几十条命令。
