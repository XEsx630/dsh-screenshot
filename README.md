# dsh-screenshot — 对话框截图插件(微信 PC 式)

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(DSH)Web 对话框提供**微信 PC 客户端式截图**:点击截图按钮 → 遮罩框选(或先隐藏 DSH 窗口再截)→ 确认后**图片卡直接出现在输入框上方**,可直接发送;模型拿到图片路径后用本地 vision MCP(或其他读图工具)读取内容。

## 功能

- 📷 composer 工具栏新增「截图」按钮,点击弹出两种模式:
  - **截取屏幕任意区域**:不隐藏窗口,全屏遮罩 + 鼠标拖拽框选(显示选区像素尺寸),可「全选 / 取消 / 确定」
  - **隐藏当前窗口后截图**:截图瞬间自动隐藏 DSH 浏览器窗口,截取被遮挡内容后自动恢复
- 确认后由**服务端 PowerShell 裁剪**(不依赖浏览器 canvas),图片卡出现在输入区上方待发送栏(可删除)
- 发送时自动注入 `截图：<绝对路径>` 文本(编辑器内为隐藏引用),模型据此调用 vision 工具读图
- 发送失败自动还原图片卡与草稿;取消截图不留临时文件

## 安装

### 从 GitHub 安装

```bash
dsh plugin --profile web add github:XEsx630/dsh-screenshot
# 或指定版本标签
dsh plugin --profile web add "github:XEsx630/dsh-screenshot#v0.1.0"
```

`dsh.bundle` manifest 会自动把 `dsh-screenshot` 行挂进 profile。重启 `dsh web` 并刷新浏览器。

### 本地开发安装

源码位于 `D:\dsh-plugins\dsh-screenshot\`,以 `link:` 方式挂载到 web profile:

1. `~/.dsh/profiles/web/package.json`:
   - `dependencies` 增加 `"dsh-screenshot": "link:D:/dsh-plugins/dsh-screenshot"`
   - `dsh.profile.bundles` 增加 `"dsh-screenshot"`
2. 在 `~/.dsh/profiles/web/` 运行 `pnpm install`
3. 重启 `dsh web` 并刷新浏览器

## 依赖

- Windows(截图/裁剪脚本用 PowerShell 5.1 + System.Windows.Forms/System.Drawing)
- DSH 0.1.x web profile

## 使用

1. 点 composer「截图」→ 选「截取屏幕任意区域」或「隐藏当前窗口后截图」
2. 等遮罩中画面加载完成,按住鼠标拖拽框选区域(微信式暗色遮罩 + 白色选区),松手后确认尺寸
3. 点「确定」→ 图片卡出现在输入框上方;可继续输入文字,点发送
4. 模型收到 `截图：`C:\...\screenshot-xxx.png`` 后调用 `mcp__vision__describe_image` / `mcp__vision__ocr_image` 读取内容

## 架构

```
截图按钮 ──POST /capture──▶ PowerShell screenshot.ps1(全屏,可选隐藏窗口)
                               └─▶ 临时 PNG($DSH_HOME/uploads/.screenshot-<uuid>.png)
遮罩预览 ◀──GET /preview──────┘
拖拽框选(纯坐标,无 canvas)
   └─POST /crop {rect, stage}──▶ 服务端换算物理像素(PNG 真实尺寸比例)
                                   └─▶ PowerShell crop.ps1(System.Drawing Clone)
                                        └─▶ 正式 PNG(screenshot-<时间戳>.png)
图片卡进对话框 ──发送──▶ 注入「截图：<路径>」──▶ 模型调 vision MCP 读图
```

设计要点:

- **裁剪在服务端完成**,浏览器只负责显示与框选坐标,杜绝 canvas 解码时序(naturalWidth=0 → 1×1 空图)等浏览器图像处理问题
- 坐标换算用 PNG 真实尺寸 × 前端实际渲染尺寸的实时比例,不受 CSS/缩放影响
- 框选在图片加载完成后才允许;拖动过程使用坐标快照,布局变化不会偏移选区
- 隐藏引用(`source: 'screenshot'`)与 dsh-file-uploads 的引用通道平行共存,互不干扰

## 文件结构

```
dsh-screenshot/
├── package.json        # dsh.bundle + dsh.client 声明
├── cordis.patch.yml    # 插件挂载行
├── README.md
└── lib/
    ├── index.js        # Host: /api/screenshot 路由(capture/crop/preview/delete)
    ├── client.js       # Client: 按钮/菜单/遮罩框选/引用序列化/卡片栏
    ├── screenshot.ps1  # PowerShell 全屏截图(可选隐藏前台窗口、DPI 感知)
    └── crop.ps1        # PowerShell 服务端裁剪(System.Drawing Clone)
```

## HTTP API(Host)

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/screenshot/capture` | body `{hideWindow?, allScreens?}` → 全屏截图到临时文件,返回 `{id, width, height, url}` |
| POST | `/api/screenshot/crop` | body `{id, rect:{x,y,w,h}, stage:{w,h}}` → 服务端裁剪 → 返回 `{file:{name,path,size}}` 并清理临时文件 |
| GET | `/api/screenshot/preview?id=` | 返回临时 PNG(前端预览) |
| DELETE | `/api/screenshot/preview?id=` | 删除临时 PNG(取消时清理) |

## 安全

- 所有路由仅限 loopback + same-origin(参照 DSH 本地插件信任栅栏)
- 临时文件名 `.screenshot-<uuid>.png`,id 严格校验 UUID;超过 10 分钟的残留临时文件在下次启动时清扫
- 截图/裁剪脚本仅在本机执行,不上传任何数据;图片内容仅进入 `$DSH_HOME/uploads`(可用 `DSH_UPLOAD_DIR` 重定向到非 C 盘)

## License

MIT
