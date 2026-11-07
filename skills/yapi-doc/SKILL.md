---
name: yapi-doc
description: Read a YAPI interface document by ID, full URL, or path keyword. Use when a task needs an API method, path, headers, parameters, request body, response fields, or response example. The bundled CLI reads the local YAPI account and prints Markdown in one command.
whenToUse: The user mentions YAPI, an interface document ID (for example 10001), an API path, or asks for the request or response fields of an API.
---

# YAPI 文档读取

优先用随包 CLI 读取，不要打开 YAPI 页面逐个翻，也不要让用户反复贴文档。

## 命令

```bash
# 按文档 ID 或完整链接读取（默认输出 Markdown）
node "$HOME/.dsh/skills/yapi-doc/yapi-doc.mjs" 10001
node "$HOME/.dsh/skills/yapi-doc/yapi-doc.mjs" https://your-yapi.example.com/project/1/interface/api/10001

# 不知道 ID 时，先按路径 / 标题关键字搜索
node "$HOME/.dsh/skills/yapi-doc/yapi-doc.mjs" --search warehouse --project 1

# 结构化输出，方便自己过滤
node "$HOME/.dsh/skills/yapi-doc/yapi-doc.mjs" 10001 --json
```

Windows 下把 `$HOME` 换成 `%USERPROFILE%`，路径为
`%USERPROFILE%\.dsh\skills\yapi-doc\yapi-doc.mjs`。

## 选项

- `--no-fields`：不输出字段说明，输出最小（方法、路径、请求头、参数、请求 Body）。只关心请求怎么发时用它。
- `--full`：额外输出返回体示例，可能很大；只有确实需要完整响应 JSON 时才用。
- `--json`：输出 `{ ok, data }` 结构化 JSON。
- `--project <id>`：`--search` 使用的项目 ID（必填）。
- `-h, --help`：帮助。

## 建议的读取顺序

1. 不知道 ID：先 `--search <关键字> --project <项目ID>`，从结果里拿 ID。
2. 只需要请求信息：`--no-fields`，输出最小。
3. 需要响应字段 / 备注：不加 `--no-fields`，默认包含请求字段和返回字段说明。
4. 需要精确响应 JSON：再加 `--full`。
5. 要程序化处理：`--json`。

## 账号

CLI 读取 `~/.dsh/dsh-plugin-yapi.json`（YAPI 面板 → 账号设置维护），也支持
`YAPI_BASE_URL` / `YAPI_EMAIL` / `YAPI_PASSWORD` 环境变量。不需要额外配置。

## 可移植性

`yapi-doc.mjs` 是**零依赖的 Node 脚本**，任何能执行 shell 的工具（Codex、Claude Code、
CI、普通终端）都可以直接运行。`SKILL.md` 本身是给支持 skill 目录约定的 agent 读的；
DSH 会从 `~/.dsh/skills`、`.dsh/skills`、`.agents/skills` 等目录发现它。
