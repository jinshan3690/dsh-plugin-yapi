---
name: yapi-sync
description: Sync the yapi-doc and yapi-sync skills into every detected AI tool (Trae, WorkBuddy, Qoder CN, GitHub Copilot, CodeBuddy, Codex/Agent Skills, DSH, Claude Code, Cursor, Gemini CLI, Amp, OpenCode and more). Use when the user asks to install, update, or sync the YAPI skill across tools.
---

# YAPI Skill 同步

把 `yapi-doc` 和 `yapi-sync` 同步到本机已安装的 AI 工具。

## 命令

```bash
yapi-sync
yapi-sync --dry-run
yapi-sync --dir <skills根目录>
```

- 自动检测 Trae、WorkBuddy、Qoder CN、GitHub Copilot、CodeBuddy、Codex/Cline/Zed/通用 Agent Skills、DSH 等。
- 如果 `yapi-sync` 不在 PATH，用 `yapi-doc sync-skills`。
- 同步完完全重启对应工具，技能列表里会出现 `yapi-doc` 和 `yapi-sync`。
