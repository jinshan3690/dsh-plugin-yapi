# dsh-plugin-yapi

给 DeepSeek Harness（DSH）左侧加一个 **YAPI** 面板：按文档 ID / 链接打开接口、按路径或标题搜索、多标签切换、字段树、勾选复制。附带一个 `yapi-doc` skill 和零依赖 CLI，AI 或终端可以直接读取 YAPI 文档。

> 仓库不包含任何 YAPI 地址、账号或密码；安装后在面板「账号设置」里配置。

## 功能

- **打开文档**：输入文档 ID（如 `10001`）或完整链接。
- **搜索**：按接口路径 / 标题模糊搜索，支持子序列（如 `whlist` 命中 `warehouse/list`）。
- **多标签**：同时打开多个接口，切换、关闭、全部关闭，刷新后恢复。
- **字段树**：请求字段 / 返回字段，对象和数组可展开，支持筛选。
- **复制**：标题栏「复制」→ 勾选要包含的内容 → 一次性复制；Body 可选纯 JSON / 带备注。
- **账号设置**：面板内填写 YAPI 地址、账号、密码，保存前会真实登录验证。
- **Skill / CLI**：`yapi-doc` 供 DSH 或任意 shell 工具直接读取文档。

## 安装

要求：DSH 桌面端（或 `dsh web` 使用的 profile）、Node 20+、能访问你的 YAPI 服务。

```bash
git clone <your-repo-url> dsh-plugin-yapi
cd dsh-plugin-yapi
./install.sh          # 默认 desktop profile
# 或
./install.sh web
```

安装脚本会：

1. 复制插件到 `~/.dsh/local-plugins/dsh-plugin-yapi`；
2. 在 profile 的 `node_modules` 建软链，并把依赖和 bundle 写进 `package.json`（自动备份）；
3. 把 `yapi-doc` skill 装到 `~/.dsh/skills/yapi-doc`。

然后**重启 DSH**，点击左侧 **YAPI** → 右上角 **账号设置**，填写：

- YAPI 地址（如 `https://yapi.example.com`，需要带 `http://` 或 `https://`）
- 账号 / 密码

点「测试并保存」，验证通过后即可使用。

可选：安装时预置账号（三项必须同时提供）：

```bash
YAPI_BASE_URL='https://your-yapi.example.com' \
YAPI_EMAIL='you@example.com' \
YAPI_PASSWORD='your-password' \
./install.sh
```

Windows 请用 Git Bash / WSL 执行 `install.sh`，或参考下面的「手动安装」。

## 配置

- 账号保存在 `~/.dsh/dsh-plugin-yapi.json`（权限 `0600`），不会进入仓库。
- 也支持环境变量 `YAPI_BASE_URL` / `YAPI_EMAIL` / `YAPI_PASSWORD`。
- 搜索需要项目 ID；打开一个文档后会自动跟随该文档所属项目。
- 插件**没有内置任何 YAPI 地址**，必须自己配置。

## 使用

- 输入文档 ID 或完整链接 → 直接打开；输入关键字 → 搜索接口，点结果进入新标签。
- 标签栏可切换、单个关闭、全部关闭；刷新页面后恢复上次的标签。
- 接口详情里看「请求参数 / 请求字段 / 返回字段 / 说明」；字段树支持搜索和展开。
- 标题栏 **复制** → 勾选内容 → 复制；「带备注」会在 JSON 字段后追加 `// 字段备注`。
- 接口路径和完整请求地址只做展示；服务地址可在详情里改（用于不同环境）。

## Skill / CLI

安装脚本会把 skill 装到 `~/.dsh/skills/yapi-doc/`，DSH 自动发现。也可以直接在终端运行：

```bash
node "$HOME/.dsh/skills/yapi-doc/yapi-doc.mjs" <doc-id>
node "$HOME/.dsh/skills/yapi-doc/yapi-doc.mjs" https://your-yapi.example.com/project/1/interface/api/10001
node "$HOME/.dsh/skills/yapi-doc/yapi-doc.mjs" --search <keyword> --project <project-id>
```

- 默认输出 Markdown：标题、方法、路径、项目、请求地址、请求头、参数、请求 Body、请求/返回字段说明。
- `--no-fields`：不输出字段说明，输出最小。
- `--full`：额外输出返回体示例（可能很大）。
- `--json`：输出 `{ ok, data }` 结构化 JSON。
- `--project <id>`：`--search` 必填。
- 账号读取 `~/.dsh/dsh-plugin-yapi.json` 或上述环境变量。

**DSH**：在会话里说「读一下 YAPI 10001」或「找一下 warehouse 相关接口」即可触发。

**任意工具**：`yapi-doc.mjs` 是零依赖 Node 脚本，Codex、Claude Code、CI、普通终端都能直接运行。其他支持相同 `SKILL.md` / `.agents/skills` 约定的 agent 也可以复用这个 skill 目录。

## 手动安装（可选）

不使用 `install.sh` 时：

```bash
# 1. 插件
mkdir -p ~/.dsh/local-plugins
cp -R dsh-plugin-yapi ~/.dsh/local-plugins/dsh-plugin-yapi

# 2. profile 依赖（以 desktop 为例）
#    编辑 ~/.dsh/profiles/desktop/package.json：
#      dependencies 加 "dsh-plugin-yapi": "file:/Users/<you>/.dsh/local-plugins/dsh-plugin-yapi"
#      dsh.profile.bundles 加 "dsh-plugin-yapi"
ln -sfn ~/.dsh/local-plugins/dsh-plugin-yapi \
  ~/.dsh/profiles/desktop/node_modules/dsh-plugin-yapi

# 3. skill
mkdir -p ~/.dsh/skills/yapi-doc
cp skills/yapi-doc/SKILL.md skills/yapi-doc/yapi-doc.mjs ~/.dsh/skills/yapi-doc/
```

## 更新 / 卸载

```bash
./install.sh          # 重新执行即可覆盖更新
./uninstall.sh        # 移除 profile 配置和 skill
```

- 账号文件 `~/.dsh/dsh-plugin-yapi.json` 和插件目录会保留，按需手动删除。
- 更新前端代码通常只需刷新页面；Host 代码变化需重启 DSH。

## 开发

```bash
node --test test/*.test.mjs
./package.sh          # 生成 dist/*.tar.gz
```

## 目录

```
index.js              Host 半：登录、文档、搜索、设置路由
client.js             客户端半：面板、标签、字段树、复制弹窗
lib/core.js           解析、URL、Body、搜索排序
bin/yapi-doc.mjs      CLI 启动器
skills/yapi-doc/      SKILL.md + 零依赖 CLI
install.sh            安装脚本
test/*.test.mjs       单元测试
```

## License

MIT
