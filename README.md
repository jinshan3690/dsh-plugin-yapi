# dsh-plugin-yapi

[![npm](https://img.shields.io/npm/v/dsh-plugin-yapi.svg)](https://www.npmjs.com/package/dsh-plugin-yapi)

给 DeepSeek Harness（DSH）左侧加一个 **YAPI** 面板：按文档 ID / 链接打开接口、按路径或标题搜索、多标签切换、字段树、勾选复制。附带一个 `yapi-doc` skill 和零依赖 CLI，AI 或终端可以直接读取 YAPI 文档。

> 仓库不包含任何真实 YAPI 地址、账号或密码；安装后在面板或环境变量里配置。

## 功能

- **打开文档**：输入文档 ID（如 `10001`）或完整链接。
- **搜索**：统一走 YAPI 的 `/api/project/search`（接口路径 / 标题模糊），**默认全部项目**，结果带所属项目；项目结果可直接打开 YAPI 项目页。
- **同目录**：文档标题「同目录」或搜索面板「同目录」，按当前接口的 catid 列出同目录其他接口。
- **多标签**：同时打开多个接口，切换、关闭、全部关闭，刷新后恢复。
- **字段树**：请求字段 / 返回字段，对象和数组可展开；层级用不同颜色的竖线区分，对象/数组带底色；筛选只高亮命中文本，不过滤行，支持 ↑/↓ 在命中处切换并显示 `当前 / 总数`；悬停行显示字段路径。
- **复制**：标题栏「复制」→ 勾选要包含的内容 → 一次性复制；Body 可选纯 JSON / 带备注。
- **账号设置**：面板内填写 YAPI 地址、账号、密码，保存前会真实登录验证。
- **Skill / CLI**：`yapi-doc` 随插件自动注册，DSH 会话或任意 shell 工具都能直接读文档。

## 安装（DSH）

要求：DSH 0.2.2+（桌面端或 web profile）、Node 20+、能访问你的 YAPI 服务。

先**完全退出 DSH**（桌面端要关闭应用，不是最小化），然后：

```bash
dsh plugin --profile desktop add dsh-plugin-yapi
```

- 如果 `dsh` 不在 PATH，macOS 桌面端可以用自带 CLI：

  ```bash
  "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
    plugin --profile desktop add github:jinshan3690/dsh-plugin-yapi
  ```

- web profile 把 `--profile desktop` 换成 `--profile web`。
- 命令会自动把插件加进 profile 的 bundle，并注册插件自带的 `yapi-doc` skill，不需要再复制文件。
- 安装完成后重新打开 DSH。
- 如果 npm 暂时不可用，也可以把包名换成 `github:jinshan3690/dsh-plugin-yapi`。

## 配置

打开 DSH → 左侧 **YAPI** → 右上角 **账号设置**，填写：

- YAPI 地址（如 `https://yapi.example.com`，带 `http://` 或 `https://`）
- 登录方式：**普通登录** / **LDAP**（选 LDAP 前确认 YAPI 服务端已开启 LDAP）
- 账号 / 密码

点「测试并保存」，验证通过后生效。普通登录走 `/api/user/login`，LDAP 走 `/api/user/login_by_ldap`。

- 账号保存在 `~/.dsh/dsh-plugin-yapi.json`（权限 `0600`），不会进入仓库；`authType` 为 `normal` 或 `ldap`。
- 也支持环境变量 `YAPI_BASE_URL` / `YAPI_EMAIL` / `YAPI_PASSWORD` / `YAPI_AUTH_TYPE`（`ldap` 时用 LDAP 登录）。
- 搜索需要项目 ID；打开一个文档后会自动跟随该文档所属项目。
- 插件**没有内置任何 YAPI 地址**，必须自己配置。

## 使用

- 输入文档 ID 或完整链接 → 直接打开；输入关键字 → 搜索接口，点结果进入新标签。
- 文档标题旁显示**接口 ID**，项目名后显示**项目 ID**；搜索结果也带 `#ID`。
- 搜索统一走 YAPI 全局搜索，不需要先选项目；结果里的接口可直接打开，项目结果会打开 YAPI 项目页。面板「刷新」会重新搜索。
- 标签栏可切换、单个关闭、全部关闭；刷新页面后恢复上次的标签。
- 接口详情里看「请求参数 / 请求字段 / 返回字段 / 说明」；字段树支持搜索和展开。
- 标题栏 **复制** → 勾选内容 → 复制；「带备注」会在 JSON 字段后追加 `// 字段备注`。
- 接口路径和完整请求地址只做展示；服务地址可在详情里改（用于不同环境）。

## 非 DSH 工具（CLI / Skill）

CLI 是零依赖 Node 脚本，不需要 DSH。直接命令行安装：

```bash
npm install -g dsh-plugin-yapi
yapi-sync
yapi-doc <doc-id>
```

- `yapi-sync` 和 `yapi-doc` 一样是独立命令：一次把 **`yapi-doc` 和 `yapi-sync` 两个 skill**同步到所有检测到的工具。
- 自动检测 Trae、WorkBuddy、Qoder CN、GitHub Copilot、CodeBuddy、Claude Code、Cursor、Gemini CLI、Amp、OpenCode、Codex/通用 Agent Skills、DSH 等目录；`--dir` 可追加自定义 skills 根目录。
- 同步完重启对应应用，技能列表里会出现 `yapi-doc` 和 `yapi-sync`。

```bash
yapi-sync
yapi-sync --dry-run                 # 只显示会写到哪些目录
yapi-sync --dir <skills根目录>      # 追加自定义目录
```

- `yapi-doc sync-skills` 是 `yapi-sync` 的别名，仍然可用。
- 如果 npm 暂时不可用，也可以 `npm install -g github:jinshan3690/dsh-plugin-yapi`。
- 只装 `yapi-doc`（不装 `yapi-sync`）时用：

  ```bash
  yapi-doc install-skill
  ```

- 也可以单独指定目录：

  ```bash
  # Trae
  yapi-doc install-skill --dir ~/.trae/skills/yapi-doc
  # WorkBuddy
  yapi-doc install-skill --dir ~/.workbuddy/skills/yapi-doc
  # Qoder / 其他 Agent Skills
  yapi-doc install-skill                  # ~/.agents/skills/yapi-doc
  ```

  > 装完请**完全重启**对应工具。不同工具对 skill 的展示方式不同，可能出现在技能列表里，不一定有 `/yapi-doc` 斜杠命令；没有的话直接运行 `yapi-doc <doc-id>`。

- 不想全局安装时：

  ```bash
  npx -y -p github:jinshan3690/dsh-plugin-yapi yapi-doc install-skill
  node "$HOME/.agents/skills/yapi-doc/yapi-doc.mjs" <doc-id>
  ```

- 账号读取 `~/.dsh/dsh-plugin-yapi.json`，或设置环境变量：

  ```bash
  export YAPI_BASE_URL='https://yapi.example.com'
  export YAPI_EMAIL='you@example.com'
  export YAPI_PASSWORD='your-password'
  export YAPI_AUTH_TYPE='normal'   # 或 ldap
  ```

常用参数：

```bash
yapi-doc --search <keyword>                # 全部项目（默认）
yapi-doc --search <keyword> --project <id> # 只看当前项目
yapi-doc <doc-id> --no-fields     # 不输出字段说明，输出最小
yapi-doc <doc-id> --full          # 额外输出返回体示例
yapi-doc <doc-id> --json          # 结构化输出
```

- 默认输出 Markdown：标题、方法、路径、项目、请求地址、请求头、参数、请求 Body、请求/返回字段说明。
- `--no-fields`：不输出字段说明，输出最小。
- `--full`：额外输出返回体示例（可能很大）。
- `--json`：输出 `{ ok, data }` 结构化 JSON。
- `--project <id>`：`--search` 必填。

**DSH 用户**不需要上面的 npm 安装：插件会自动注册 `yapi-doc` 和 `yapi-sync` 两个 skill；CLI 在
`~/.dsh/profiles/desktop/node_modules/.bin/yapi-doc` 和 `.../.bin/yapi-sync`。

## 更新 / 卸载

DSH（先退出）：

```bash
dsh plugin --profile desktop remove dsh-plugin-yapi
```

非 DSH：

```bash
npm uninstall -g dsh-plugin-yapi
rm -rf ~/.agents/skills/yapi-doc   # 按实际安装目录删除
```

更新：`npm update -g dsh-plugin-yapi`，DSH 重新执行 `dsh plugin ... add dsh-plugin-yapi` 即可。账号文件 `~/.dsh/dsh-plugin-yapi.json` 会保留，按需手动删除。

## 开发

```bash
node --test test/*.test.mjs
./package.sh          # 生成 dist/*.tar.gz
```

## 目录

```
index.js              Host 半：登录、文档、搜索、设置、内置 skill 注册
client.js             客户端半：面板、标签、字段树、复制弹窗
lib/core.js           解析、URL、Body、搜索排序
bin/yapi-doc.mjs      CLI 启动器
skills/yapi-doc/      SKILL.md + 零依赖 CLI（含 install-skill）
test/*.test.mjs       单元测试
```

## License

MIT
