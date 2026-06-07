# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目简介

DWR (Dogeshit Weekreport) 是一个浏览器内的项目工作台，类 VS Code 的「文件树 + 编辑器 + 集成终端」三栏布局，本地启动一个 Node 服务后用浏览器打开使用。当前也作为「周报」工具使用。

## 周报工作流

`work/` 目录是周报相关的工作区，目录约定如下：

```
work/
  daily-record/                 # 按日期记录每日工作对话（YYYY-MM-DD.md）
  _past/                        # 历史上的周报样本（用户写过的发言版 / 表格版）
  _template/
    table.md                    # 表格周报版严格遵守的模板
    habbit.md                   # 学习到的用户写作 / 发言习惯（持续更新）
  report/                       # 生成的周报产出（按周归档）
```

### 1. 日常记录

当用户和 Claude Code 谈到工作相关的事情时，按以下规则把要点落到 `work/daily-record/`：

- 文件名固定为 `YYYY-MM-DD.md`（年-月-日，月份和日期补 0），按当前日期落盘。
- 内容用 markdown，结构自由但建议包含：**日期 / 当日工作要点 / 进度 / 遇到的问题 / 明日计划** 几个小节；如果对话里没提到某一节，可以省略。
- 一次会话内多次更新同一文件即可，不要拆成多个文件。

### 2. 周报生成

用户说「生成周报」「写本周周报」「出周报」之类指令时执行：

1. 读取 `work/daily-record/` 下本周（按文件名日期落在当周内）所有 `.md` 文件。
2. 同时读取 `work/_past/` 下所有历史周报作为风格参考。
3. 读取 `work/_template/habbit.md`，把里面记录的写作 / 发言习惯套用到产出上。
4. 输出**两个版本**，并按周落到 `work/report/YYYY-Www/`（如 `2026-W23/`）：
   - **发言版**（口语化周会发言稿）
     - 学习 `work/_past/` 里发言版样本的句式、节奏、过渡词、收尾方式。
     - 适合在周会上口述，不要写成正式书面语。
   - **表格周报版**（结构化表格）
     - 严格按 `work/_template/table.md` 的列名 / 行结构 / 标题层级来写，不要自己发明新表头。
     - 参考 `work/_past/` 里表格版的填写粒度和语言习惯（动词选择、单位表达、完成度描述等）。

5. 两个版本都要在文件开头注明生成日期、覆盖的日期范围、数据来源（`daily-record/` 里的哪些文件）。

### 3. 习惯学习

每次写完发言版 / 表格版后，对照 `work/_past/` 的样本和 `work/_template/table.md` 校准：

- 用户偏好的口头禅、句末助词、过渡词、段落长度。
- 表格版里固定使用的列、动词时态、单位、百分比/工时写法、完成度等级说法。
- 哪些表述是用户反复出现的「招牌写法」。

把观察到的规律追加（不是覆盖）到 `work/_template/habbit.md`，分「发言版习惯」和「表格版习惯」两节，让后续生成越来越贴合用户口吻。如果某次没有新发现就跳过，不要硬凑条目。

## 常用命令

```bash
npm install              # 安装依赖
npm run build            # 编译 TypeScript 到 dist/
npm run dev              # 用 tsx 跑 src/index.ts（开发模式）
npm start -- --cwd <path> --port <port>  # 跑 dist/index.js（已编译版本）
```

启动后控制台会打印 `http://127.0.0.1:<随机端口>` 形式的访问链接；不传 `--port` 时由 OS 自动分配。

> 任何代码修改后都需要重跑 `npm run build` 才会反映到 `npm start`；开发期用 `npm run dev` 即可。

## 项目结构

```
src/                      # 后端 TypeScript 源码（编译到 dist/）
  index.ts                # CLI 入口：解析 --cwd / --port，调用 startWorkspaceServer
  server.ts               # Express + ws 服务的总装，定义所有 /api/* 端点
  files.ts                # 文件系统操作 + 沙箱（路径越界保护、文件大小限制）
  shell.ts                # 跨平台默认 shell 检测（Windows / macOS / Linux）
public/                   # 前端静态资源，Express 静态托管
  index.html              # 三栏布局的 HTML 骨架
  app.js                  # 前端主逻辑：文件树、编辑器、终端 WS 客户端
  app.css                 # CSS 变量驱动的三套主题（dark/light/one-dark）
  file-icons.js           # Material 风格 SVG 文件图标映射
  fonts/                  # 随包分发的 Nerd Font + HarmonyOS Sans SC
```

## 后端架构（src/）

### REST API（`server.ts`）

| 方法 | 路径                  | 作用                                          |
| ---- | --------------------- | --------------------------------------------- |
| GET  | `/api/info`           | 返回 cwd / shell / platform                   |
| GET  | `/api/files?path=...` | 列出目录条目                                  |
| GET  | `/api/file?path=...`  | 读取文件内容（含 binary 标记）                |
| PUT  | `/api/file`           | 写入文件（`{path, content}`）                 |
| POST | `/api/create`         | 新建文件/文件夹（`{parentPath, name, type}`） |
| POST | `/api/delete`         | 删除文件/文件夹（`{path}`）                   |

请求体 `limit: 16kb`（Express 限制）；文件读取 / 写入最大 `1MB`（`files.ts` 的 `MAX_FILE_BYTES`）。

### WebSocket（`server.ts` 的 `/ws`）

每条连接 spawn 一个 `node-pty` PTY，cwd = 项目根，env 由 `shell.ts` 的 `buildShellEnv` 注入（`TERM=xterm-256color`、`COLORTERM=truecolor`、`PWD`）。
消息协议（`TerminalClientMessage` / 服务端推送）：

- 客户端 `{"type":"input","data":...}`
- 客户端 `{"type":"resize","cols":...,"rows":...}`
- 服务端 `{"type":"ready","cwd":...,"shell":...,"platform":...}`
- 服务端 `{"type":"output","data":...}`
- 服务端 `{"type":"exit","exitCode":...}`

### 沙箱（`files.ts`）

- 所有用户传入路径都走 `resolveProjectPath`：`relative(root, absolute)` 含 `..` 直接抛 `FileAccessError(403)`。
- 根目录级 `IGNORED_DIRS = {node_modules, .git, dist}` 列表隐藏。
- 新建条目名走 `validateEntryName`，拒绝 `\\ / : * ? " < > | \0` 和 `.` / `..`。
- 二进制识别：读取 buffer 后 `includes(0)` 即视为 binary，前端展示「无法预览」。

## 前端架构（public/）

`app.js` 是单文件、无打包的 vanilla JS，主要模块：

- **主题**：`applyTheme(name)` 写 `<html data-theme>`，并同步重设 xterm 配色；`Alt+T` 循环切换 `dark → light → one-dark`。
- **面板尺寸**：`PANEL_LIMITS` 定义侧栏/终端/编辑器最小最大宽度，拖拽结果持久化到 `localStorage` 键 `dwr-panel-widths`。
- **文件树**：DOM 结构 `tree-row > tree-children`，目录懒加载（首次展开时 `loadDirectory`）。行内操作按钮（新建文件/文件夹/删除）由 `appendTreeRowActions` 注入。
- **编辑器**：
  - 视图模式：代码文件用 `renderLineNumbers` + `<pre>`；`.md`/`.mdx`/`.markdown` 走 `marked` + `DOMPurify` 渲染。
  - 编辑模式：原生 `<textarea>`，避免任何编辑器依赖。
  - `Ctrl/Cmd+S` 保存；`Alt+V` 视图、`Alt+E` 编辑、`Alt+F` 全屏。
  - 脏状态：标签显示 `•`，关闭/切换未保存时 `window.confirm` 拦截。
- **终端**：`xterm.js` + `FitAddon` + `WebLinksAddon`，本地优先 `Cousine Nerd Font Mono` / `HarmonyOS Sans SC` 字体（见 `public/fonts/`）。
- **终端 WS**：`connectTerminal` 自带 1.5s 断线重连；`ResizeObserver` 监听容器变化触发 `fitAddon.fit()` 并发送 `resize`。

## 关键约定

- **模块系统**：ESM，`"type": "module"`，TS 配置 `module/moduleResolution: NodeNext`。互相引用必须带 `.js` 后缀（如 `from './server.js'`），即使源文件是 `.ts`。
- **跨平台 shell**：Windows 优先 `pwsh.exe`（ProgramFiles 探测），退化到 `System32\WindowsPowerShell\v1.0\powershell.exe`；Unix 读 `$SHELL`，macOS 默认 `/bin/zsh`，其他回退 `/bin/bash` → `/bin/sh`。
- **端口与主机**：默认 `host: 127.0.0.1`（仅本机访问），`port` 不传则 OS 分配。
- **关闭流程**：`handle.close()` 会清掉所有 PTY 再关 `wss` / `http server`；`SIGINT` / `SIGTERM` 都会触发。
- **HTTP 错误**：文件系统错误统一抛 `FileAccessError(status, message)`，`sendFileError` 转 JSON；前端 `fetchJson` 读到非 2xx 就抛 `data.error`。

## 开发提示

- 修改后端：改 `src/**` → `npm run build` → 重启 `npm start`；或直接 `npm run dev`。
- 修改前端：直接编辑 `public/**`，刷新浏览器即可，无需构建。
- 调整文件大小上限、忽略目录、允许的文件名字符集都集中在 `src/files.ts` 顶部。
- 新增 REST 端点：在 `src/server.ts` 注册新 `app.*` 路由；保持 16kb body 上限，文件操作仍走 `files.ts` 的 `resolveProjectPath` 沙箱。
- 新增终端消息类型：客户端 / 服务端 payload 形状需在 `server.ts` 的 `TerminalClientMessage` 和对应发送处保持一致。
- 新增主题：在 `public/app.css` 添加 `[data-theme="xxx"]` 块并覆盖所需 CSS 变量，同时在 `public/app.js` 的 `THEMES` 数组和 `applyTheme` switch 中加入。
