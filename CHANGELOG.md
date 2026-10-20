# Changelog

## 0.2.0 — 2026-10-20

适配 DSH 0.2（`createDrafts` / `inputActions.addAttachments` / `fileUpload`），把「写路径进草稿」换成 DSH 原生草稿附件。

### 变更

- **原生图片附件**：截图裁剪后作为图片附件进入输入框，模型直接收到图片；不再注入 `截图：<路径>`，不再依赖 vision MCP
- **发送方式开关**：菜单里可切到「以文件路径发送」，给纯文本模型用；超过 6 MB 自动降级为文件
- **新增「截取全部屏幕」**：启用此前未接线的 `allScreens`
- **临时目录迁移**：从 `$DSH_HOME/uploads` 移到 `$DSH_HOME/cache/dsh-screenshot`（`DSH_SCREENSHOT_DIR` 可覆盖），不再污染上传目录
- **崩溃恢复**：隐藏窗口前写 `.hwnd` 标记，Host 在超时/强杀后调用 `restore.ps1` 恢复窗口
- **错误可见**：截图失败、输入框忙、附件过大改为 toast，不再被卸载中的遮罩吞掉
- 路由改为按资源划分（`preview` / `file`），删除接口按资源删除；请求体上限 16 KB
- `Host` 侧坐标换算、PNG 解析、UUID 校验抽成纯函数，新增 `node:test` 测试与 `windows-latest` CI
- 信任栅栏加严：Host 头必须是裸 authority，拒绝 userinfo/路径/片段

### 移除

- 隐藏引用 codec、`__dsh_screenshot_hidden__` 标记与配套 CSS hack
- 每个会话的 pending/in-flight 状态机与发送失败还原逻辑（改由 DSH 附件通道负责）
- 对 npm 包 `@deepseek-ai/dsh-client-ui-input-trigger` 的依赖

## 0.1.0 — 2026-08-16

首个版本：服务端裁剪 + 隐藏引用注入路径。
