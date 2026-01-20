# 在 tttpob/vscode-r 中集成 Ark：Console / Plot / LSP 方案报告

本文基于 `tttpob/vscode-r`（本地目录：`vscode-r/`）与 `posit-dev/ark`（本地目录：`ark/`）的代码现状，给出一个“在 VSCode 里用 Ark 作为后端”的可落地设计：让 Ark 提供 **Jupyter Kernel** 承载 R 会话（执行/输出/plots/data），并在同一会话上通过 **Jupyter comm 启动 Ark LSP**，再让 VSCode 的 `vscode-languageclient` 连接该 LSP 端口实现语言服务。

按你后续的新约束补充：你希望 **REPL 直接用现成的 `jupyter console`**（不在 VSCode 里实现 console 前端），那么 VSCode 扩展应扮演“会话管理 + 旁路前端（第二个 Jupyter client）”的角色：同一个 kernel 上，一边 `jupyter console` 做交互，另一边 VSCode 负责 LSP/Plot/Data Viewer/（可选）Help。

> 重点结论：  
> - **Console**：若你接受用 `jupyter console` 当 REPL，VSCode 不必实现终端前端；但 VSCode 仍需要某种方式连接同一个 kernel（实现 Jupyter client），用来做 LSP/Plot/Data Viewer（可以在扩展里做，也可以用 sidecar）。  
> - **Plot**：Ark 在非 Positron 情况下会走 **Jupyter `display_data` / `update_display_data`** 输出图；但目前 Ark 发送的 `image/png` 值是**渲染文件路径字符串**（不是标准 base64），VSCode 侧需要“读取该路径文件再展示”。  
> - **Data Viewer**：Ark 已实现 Positron Data Explorer 后端（comm：`positron.dataExplorer`，协议类型由 `data_explorer.json` 生成）；VSCode 侧需要做前端 UI（webview 表格）并通过 comm 做分页/排序/过滤等 RPC。  
> - **LSP**：Ark 的 LSP 启动不是“通用 LSP stdio 启动”，而是通过 **Jupyter comm open `positron.lsp`** 启动并回传端口，然后 VSCode 才能连接。  
> - **多会话切换**：要在多个 `jupyter console + ark kernel` 会话间切换并复用你现有 help/LSP respawn，需要引入 Session Manager：按 session 维护 connection file、LSP client、以及 plot/data 的订阅路由。

---

## 1. vscode-r 现状梳理（你要改什么）

### 1.1 Console（R 终端）
当前 `vscode-r` 的交互执行是“向 VSCode Terminal 里的 R 进程 `sendText()`”：
- 创建终端：`vscode-r/src/rTerminal.ts`（`createRTerm()` / `makeTerminalOptions()`）
- 执行代码：`vscode-r/src/rTerminal.ts`（`runTextInTerm()` / `runSelectionInTerm()`）
- 终端 Profile：`vscode-r/src/extension.ts` 注册 `r.terminal-profile`

这意味着现在的 console backend = “真实的 R 可执行文件（rterm）+ stdin/stdout”。

### 1.2 Plot（两套机制）
`vscode-r` 现在有两条 plot 路线：
1) **Session watcher 生成 `plot.png` + lock 文件**（快速但简单）
   - VSCode 侧：`vscode-r/src/session.ts` 监听 `plot.lock`，变化时打开 `plot.png`
   - R 侧：`vscode-r/R/session/*`（尤其 `vsc.R`）在 R 进程里负责写文件
2) **httpgd plot viewer（Webview）**
   - VSCode 侧：`vscode-r/src/plotViewer/index.ts`（`HttpgdManager`/`HttpgdViewer`）
   - R 侧：依赖 R 包 `httpgd`，由 R 会话启动并给出 URL（session watcher 通过 request/response 协议把 URL 传回来）

### 1.3 LSP（languageserver 包）
`vscode-r` 的 LSP 现在是启动 R 进程运行 `languageserver::run()`：
- TS 侧：`vscode-r/src/languageService.ts`
  - 支持 stdio 或 TCP（`r.lsp.use_stdio`）
  - 支持 multi server（`r.lsp.multiServer`）
- R 侧脚本：`vscode-r/R/languageServer.R`

---

## 2. Ark 现状与可用的“接入点”（你能利用什么）

### 2.1 Ark 的 R 会话是“嵌入式”
Ark 不是 `spawn(R)` 再用 IPC 的模型；它在自身进程里通过 R 的 C API 初始化并进入主循环，并把 `ReadConsole/WriteConsole` 等回调重定向到 Ark：
- 初始化与主循环：`ark/crates/ark/src/sys/unix/interface.rs`（`Rf_initialize_R()` + `run_Rmainloop()`）
- Ark 进程中启动 R：`ark/crates/ark/src/interface.rs`（`RMain::start()` 调用 `setup_r()` / `run_r()`）

结论：VSCode 侧无法像现在一样用 `Terminal.sendText()` 驱动 Ark；你必须走 Ark 提供的协议入口（Jupyter）。

### 2.2 Ark 作为 Jupyter Kernel
Ark CLI 支持用 Jupyter connection file 启动：
- `ark --connection_file <FILE> --session-mode notebook|console|background`
见：`ark/crates/ark/src/main.rs`

因此，要把 Ark 当作“vscode-r 的 console backend”，核心就是：在扩展里启动 Ark，并实现一个最小 Jupyter 前端（连接 ZMQ 端口，发 `execute_request`，收 IOPub）。

### 2.3 Ark Plot：两条分支（Positron 动态 plot vs Jupyter display_data）
Ark 绘图事件在 Rust 侧有明确分支：
- 若 **UI comm 已连接且 session_mode=Console**，走 Positron 动态 plot（comm `positron.plot`）
- 否则走 **Jupyter `display_data`/`update_display_data`**
见：`ark/crates/ark/src/plots/graphics_device.rs`（`should_use_dynamic_plots()` / `process_*_jupyter_protocol()`）

关键细节（对你很重要）：  
Ark 在 Jupyter 模式下发送 `display_data` 时，`image/png` 的值来自 `.ps.graphics.render_plot_from_recording()` 的返回值，而它返回的是**文件路径**（`tempdir()/positron-plot-renderings/render-<id>.png`），不是标准的 base64 图片数据：
- R：`ark/crates/ark/src/modules/positron/graphics.R`（`.ps.graphics.render_plot_from_recording()` 返回 `path`）
- Rust：`ark/crates/ark/src/plots/graphics_device.rs`（`create_display_data_plot()` 把该字符串放进 `image/png`）

结论：如果你要在 VSCode 里显示图，你要在前端把这个路径当作“图片文件路径”读取并展示（或自己修 Ark 让它发 base64）。

### 2.4 Ark LSP：通过 Jupyter comm 启动 + 回传端口
Ark 的 LSP 不是“VSCode 直接 `command: ark-lsp --stdio`”。它是通过 **Jupyter comm open** 启动的：
- 前端发送 `comm_open`，target 为 `positron.lsp`，data 为 `{"ip_address":"127.0.0.1"}`（结构体：`ServerStartMessage`）
- Ark 启动 LSP 后，通过 comm 发回 `server_started`，content 带 `port`
核心实现点：
- ServerStart/Started 消息定义：`ark/crates/amalthea/src/comm/server_comm.rs`
- comm open 时识别并启动 LSP：`ark/crates/amalthea/src/socket/shell.rs`（`Comm::Lsp` 分支）
- LSP 监听 TCP：`ark/crates/ark/src/lsp/backend.rs`（`TcpListener::bind("{ip}:0")`，回传端口）

结论：要在 VSCode 里用 Ark LSP，你必须先“作为 Jupyter 前端”打开 `positron.lsp` 这个 comm，拿到端口后，才可以用 `vscode-languageclient` 连接。

---

## 3. 目标架构：在 vscode-r 中加入 “Ark backend”

### 3.1 新增一个 backend 抽象（强烈建议）
目前 `vscode-r` 把“console = terminal”写死了。要加入 Ark，你最好引入一个 backend 抽象，避免把 Ark 逻辑硬塞进 `rTerminal.ts`：

建议新增一个接口（概念）：
- `IRConsoleBackend`
  - `start()` / `stop()`
  - `run(code: string)`（对应现在 `runTextInTerm()`）
  - 事件：`onOutput`（stdout/stderr）、`onPlot`、`onState`（busy/idle）
- `IRLspBackend`
  - `startLsp()` -> `port`
  - 或者直接返回一个 `StreamInfo`（reader/writer）供 `LanguageClient`

然后保留现有 backend：`TerminalRBackend`（当前实现），再加一个：`ArkKernelBackend`。

### 3.2 ArkKernelBackend 的三件事

#### A) Console：实现最小 Jupyter client（ZMQ）
你需要在 VSCode 扩展里做这些事：
1. 生成 connection file（JSON，含 5 个端口、key、transport、signature_scheme 等）
2. `spawn(ark, ["--connection_file", file, "--session-mode", "notebook"])`
3. 用 Node ZMQ 连接：
   - shell（发 request、收 reply）
   - iopub（收输出：stream / execute_result / error / display_data）
   - control（中断/关闭；可选）
4. 实现 Jupyter message 的 HMAC 签名（`signature_scheme` 一般是 `hmac-sha256`）

VSCode UI 表现建议两种（选一种）：
- **PseudoTerminal**：在扩展里实现一个“伪终端”，让用户看到 prompt、输入与输出（接近 console 体验）
- **自建 Webview Console**：把输出结构化展示（更容易显示富输出/图）

对接现有命令：
把 `r.runSelection` / `r.runSource` 等命令在 Ark backend 下改为调用 `ArkKernelBackend.run(code)`。

---

## 3.3 你提出的“用 jupyter console 作为 Ark 前端”怎么落地（推荐路线）

你希望不在 VSCode 里实现 REPL 前端，而是直接用 `jupyter console`。这完全可行，但有一个前提：VSCode 必须能以“第二个前端”的身份连接到**同一个 kernel**，从而获得 plots/data/LSP 等能力。要做到这一点，关键在于 **connection file 的可控性**。

### 路线 A（推荐）：由 VSCode 扩展负责启动 Ark kernel，再启动 `jupyter console --existing`
1) VSCode 扩展生成一个 connection file（JSON），启动 Ark：  
   `ark --connection_file <file> --session-mode notebook`
2) VSCode 扩展启动 REPL 前端：  
   `jupyter console --existing <file>`
3) VSCode 扩展同时启动一个“旁路客户端”（最好是 sidecar）也连接 `<file>`，负责：
   - `positron.lsp`：open comm -> 拿 port -> 启动 VSCode `LanguageClient`
   - iopub：收 `display_data` / `update_display_data` 做 plot
   - comm：`positron.variables` / `positron.dataExplorer` 做 workspace & data viewer

优点：扩展永远知道 connection file，最稳定，也最适合做“多会话切换”。  

### 路线 B（不推荐）：用户自行 `jupyter console --kernel=ark`
这时 connection file 在 Jupyter runtime 目录里动态生成，VSCode 很难可靠判定“当前这个 console 对应哪个 kernel-*.json”。理论上可以扫 `jupyter --runtime-dir` 并让用户挑选，但边界问题很多（远程路径、多 kernel 并存、权限、容器/WSL）。  

结论：如果你的目标是“省时间且可长期用”，推荐路线 A（扩展做 session supervisor，jupyter console 只是 UI）。

---

## 3.3.1 你问的：为什么一定要 sidecar？

不一定“必须”用 sidecar；你**必须**要的是“一个能说 Jupyter 协议（ZMQ + HMAC + multipart frames + iopub/comm）的组件”，用来在同一个 Ark kernel 上做：
- open comm `positron.lsp`（拿到 LSP 端口）
- 订阅 iopub（plots、stdout/stderr、comm 事件）
- 跑 `positron.dataExplorer` / `positron.variables` 这类 comm（数据查看器、变量面板）

sidecar 只是这个组件的一种部署形式。之所以经常推荐 sidecar，主要不是“转格式”，而是工程与分发成本：
- **在 VSCode 扩展（TS/Node）里实现 Jupyter client**：通常需要 Node 的 ZMQ 原生依赖（例如 `zeromq`），跨平台打包/预编译/远程开发（SSH/容器/WSL）会更麻烦。  
- **用 sidecar（你偏好 Rust）**：把 ZMQ/Jupyter 复杂度放在 Rust 进程里，扩展只做 JSON-RPC/stdio 通信与 UI，整体更稳定、更容易调试，也更利于后续做多会话管理与复用。

所以：sidecar 是“为了把 Jupyter/ZMQ 这坨复杂依赖隔离出去”，不是为了把消息“翻译成 vscode-r 旧格式”。

#### B) Plot：从 IOPub `display_data`/`update_display_data` 驱动现有 viewer
你需要监听 iopub 的两类消息：
- `display_data`：新图
- `update_display_data`：同一 display_id 更新

识别图数据的建议逻辑：
1) 先看 `data["image/png"]` / `data["image/svg+xml"]` 是否存在  
2) 若值是 **看起来像文件路径**（绝对路径或能 `fs.existsSync()`），则读取文件：
   - png：读 bytes -> base64，或者直接 `vscode.open` 图片文件（更简单）
   - svg：读文本 -> 放进 webview / 或存文件再打开
3) 若值不是路径（未来 Ark 修成 base64 也兼容），就按 base64 处理

如何复用 vscode-r 现有 plot viewer：
- 最省事：把渲染文件复制/硬链接到 `homeExtDir()/ark-plots/`，然后执行 `vscode.open(Uri.file(...))`（沿用 `session.ts` 的打开图片逻辑风格）
- 更一致：做一个新的 `ArkPlotManager`，提供和 `HttpgdManager.showViewer()` 类似的“Plot 面板”，但数据源来自 iopub

#### C) LSP：在同一 kernel 上 open comm `positron.lsp`，再连 LanguageClient
流程（非常接近 Positron 的做法，只是你在 vscode-r 内实现）：
1) kernel ready 后，发送 `comm_open`：
   - target_name: `"positron.lsp"`
   - data: `{"ip_address":"127.0.0.1"}`
2) iopub 里会收到该 comm 的一条 `server_started` 消息（legacy 结构：含 `msg_type`/`content`）
3) 取 `content.port`
4) 用 `LanguageClient` 的 `StreamInfo` TCP 连接选项去连该端口（你已经在 `languageService.ts` 里有 tcpServerOptions 的模式）

建议实现方式：
- 新增 `ArkLanguageService`（独立于现有 `LanguageService`），或者在 `languageService.ts` 加一个 `r.lsp.backend = "languageserver" | "ark"` 分支
- Ark 模式下不再跑 `R/languageServer.R`，而是：
  - 依赖 `ArkKernelBackend` 提供 `getLspPort()`（或事件）
  - 直接创建 `new LanguageClient(..., tcpServerOptions, clientOptions)`

文档同步（didOpen/didChange）不需要你手写：`vscode-languageclient` 会自动做；你只要保证 documentSelector 覆盖你的目标（`file`/`untitled`/`vscode-notebook-cell`）。

---

## 3.4 Data Viewer：Positron 怎么做，Ark 已提供什么，你在 vscode-r 里要补什么

### 3.4.1 Positron 的做法（协议与 comm）
Positron 的 Data Viewer / Data Explorer 不是把整张表导出到文件再打开，而是走一个增量 RPC 协议：
- comm target：`positron.dataExplorer`
- 协议 schema：`positron/comms/data_explorer.json`（schema 名称为 `data_explorer`）
- RPC 类型生成物：Positron 会把该 schema 生成到各语言侧（例如 Python 的 `data_explorer_comm.py`、前端 TS 的 `positronDataExplorerComm.ts` 等）

这套协议支持（按需实现）：
- `GetState`：行列数/过滤排序状态/能力开关
- `GetSchema`：列 schema（名称、类型、display type、label 等）
- `GetDataValues`：按窗口取值（支持滚动/虚拟列表）
- `SetSortColumns` / `SetRowFilters`：交互式排序/过滤
- histogram/profile/export selection/convert-to-code 等（可后续补齐）

### 3.4.2 Ark 已实现“后端”（你可以直接用）
Ark 已经实现了 data explorer 后端逻辑，并以 backend-initiated comm 的方式工作：
- `RDataExplorer::start()` 会创建 comm：`positron.dataExplorer`（comm_id 为 UUID）并启动线程处理 RPC
- variables 面板中对可表格查看对象，会调用 `RDataExplorer::start()`（所以 Ark 已具备“从对象打开 data explorer”的能力）

因此你不需要在 Ark 里补“分页/排序/过滤”的后端实现；你需要补的是 VSCode 侧的“前端”。

### 3.4.3 vscode-r 落地建议：复用你已有的 Data Viewer UI（ag-grid）
如果你觉得现有 Data Viewer 体验不够好，一个更直接的路线是**借用 Positron 的 Data Explorer 前端**（在许可允许的前提下），把它作为 VSCode webview 前端，并直接对接同一套 `data_explorer` 协议。这能显著减少交互与功能的设计成本，但需要评估依赖体积、打包方式与许可边界。

`vscode-r` 现在的数据查看器多是 `session.ts -> showDataView()` 打开 webview，再从文件或临时数据源展示。要接 Ark 的 data explorer，建议演进为：
1) UI 层继续复用现有 webview（ag-grid、过滤 UI、导出按钮等）  
2) 数据源从“读文件”改成“webview <-> extension 消息”：
   - webview 请求：要某个窗口（rows x cols）的 cell 值 + schema
   - extension 转发：通过 dataExplorer comm 发 `GetSchema` / `GetDataValues`
   - extension 返回：把结果回传给 webview 渲染

最小可用集合（先只读浏览）：
- `GetState`、`GetSchema`、`GetDataValues`

下一步增强（交互）：
- `SetSortColumns`、`SetRowFilters`、`SearchSchema`

### 3.4.4 怎么触发打开 Data Viewer（两种选项）
选项 A（更像 Positron）：实现/复用 `positron.variables` comm 做 workspace tree，用户在 tree 上点 “View” 时触发 Ark 打开 `positron.dataExplorer` comm，然后 VSCode 打开对应 webview。  
选项 B（最省事）：提供命令 `r.ark.openDataExplorer`，让用户输入对象表达式/变量名；扩展在 kernel 内执行一段 R 来触发 data explorer（由 Ark 发起 comm），然后 VSCode 接管 comm 并打开 webview。

---

## 3.5 多个 `jupyter console + Ark kernel` 会话：如何切换（并复用你现有 respawn 机制）

你提到的 `tttpob/vscode-r` 现状里，help 和 language server 都有 “respawn on attach”：
- LSP：`vscode-r/src/session.ts` 在 attach 时根据 `lsp.respawnOnAttach` 调 `rLanguageService.restartWithSessionPaths(rHome, libPaths)`
- Help：同文件根据 `help.respawnOnAttach` 调 `helpProvider.restartWithSessionPaths(libPaths)`
- 这些路径来自 R 侧 session watcher：`vscode-r/R/session/vsc.R` 的 attach request（`rHome = R.home("bin/R")`，`libPaths = .libPaths()`）

如果你要在多个 Ark kernel（每个配一个 jupyter console）之间切换，建议把“attach”抽象成“选中某个 Ark session”为触发点：

### 3.5.1 Session Manager 要维护的状态（每个 session 一份）
- `sessionId`（扩展生成 UUID）
- `connectionFilePath`（关键：供 jupyter console 与旁路客户端共用）
- `arkPid`/启动参数（可选：用于 stop/restart/清理）
- `rHome`、`libPaths`（可选：用于继续复用现有 help/languageserver respawn）
- `arkLspPort`（由 `positron.lsp` comm 返回）
- `languageClient`（连接 `arkLspPort` 的 `LanguageClient` 实例）
- `plots`/`dataExplorer`/`variables` 的 comm 路由表（comm_id -> UI 实例）

### 3.5.2 切换会话时的动作建议
当从 session A 切到 session B：
1) 解绑 A 的旁路订阅（或保留但 UI 只显示 B；两者都行但要明确 UX）
2) 标记 B 为 active session
3) LSP：
   - 如果用 Ark LSP：确保 B 已 open `positron.lsp` 并拿到 port，然后 stop A client / start B client
   - 如果仍用 `languageserver`：用 B 的 `rHome/libPaths` 调用你现有 `restartWithSessionPaths()`
4) Help：若你继续用现有 help server，就用 B 的 `libPaths` 触发 `restartWithSessionPaths()`

### 3.5.3 关键问题：如何获取 `rHome/libPaths`（给 respawn 用）
在 Ark session 下，你没有 `vsc.R` 的 attach request 可以用。解决思路是：让旁路客户端对该 kernel 执行一次查询并缓存到 session：
- `R.home("bin/R")`
- `.libPaths()`

这也意味着：即便你用 `jupyter console` 作为 REPL，仍然需要一个旁路客户端能向 kernel 发 `execute_request`（建议放到 sidecar 里做）。

---

## 3.6 从正在运行的 `jupyter console` 里“取到 connection file”的机制（你偏好的方案 2）

你想要一个“像发 magic 命令那样，把当前 Ark kernel 的 connection file 找回来”的机制。对 R kernel 来说没有现成的 `%connect_info`，但可以**不改 Ark 源码**实现类似效果：

### 方案 2A（推荐）：VSCode 启动 Ark 时注入 `ARK_CONNECTION_FILE`
做法（不改 Ark 源码）：
- VSCode spawn Ark 时直接设置环境变量：`ARK_CONNECTION_FILE=<path>`
- 或者创建一个**临时 startup R 脚本**（例如写入 `Sys.setenv("ARK_CONNECTION_FILE", "<path>")`），再用 `--startup-file` 或 `R_PROFILE_USER` 让 Ark 在启动 R 时执行该脚本；启动后可删除该脚本

用户体验（在 `jupyter console` 里）：
- `Sys.getenv("ARK_CONNECTION_FILE")` 直接得到路径  
- `cat(readLines(Sys.getenv("ARK_CONNECTION_FILE")), sep = "\n")` 打印 JSON（必要时可复制到 VSCode 命令里）

VSCode 侧配合（建议）：
- 提供命令 `r.ark.attachByConnectionFile`：让用户粘贴路径（或从剪贴板读取）  
- 旁路客户端/sidecar 使用该路径连接 kernel，完成 LSP/Plot/Data 的 attach

优点：
- 不依赖 Jupyter runtime-dir 的扫描与猜测
- 多会话时也清晰（每个 tmux session 都有一个固定文件路径）

### 方案 2B（无 Ark 改动但更麻烦）：扫描 Jupyter runtime 目录
作为 fallback：sidecar 扫 `jupyter --runtime-dir` 的 `kernel-*.json` 并做探测（发 `kernel_info_request` + 尝试 open `positron.lsp`/`ark` comm）。  
缺点是多会话/远程环境下很容易产生歧义，因此仅建议当作“兜底发现机制”。

## 4. 在 vscode-r 里要改哪些文件（推荐落点）

下面是“最少改动且结构清晰”的落点建议（按你仓库结构）：

### 4.1 `vscode-r/package.json`
新增配置项（建议）：
- `r.backend`: `"terminal" | "ark"`（默认 terminal）
- `r.ark.path`: string（ark 可执行文件路径；空则要求用户在 PATH）
- `r.ark.sessionMode`: `"notebook" | "console"`（默认 notebook；避免触发 Positron 动态 plot 分支）
- `r.ark.ipAddress`: 默认 `"127.0.0.1"`（用于启动 LSP）
- `r.lsp.backend`: `"languageserver" | "ark"`（可与 `r.backend` 解耦，允许只用 Ark LSP）

新增命令（建议）：
- `r.createArkSession`（启动 Ark kernel backend）
- `r.ark.restart` / `r.ark.stop`
- `r.lsp.restart` 已有，可复用

### 4.2 `vscode-r/src/extension.ts`
根据 `r.backend` 决定：
- `r.createRTerm` 调用现有 `createRTerm()` 或新的 `createArkSession()`
- 初始化 `rLanguageService` 时根据 `r.lsp.backend` 选择 `LanguageService` 或 `ArkLanguageService`

### 4.3 `vscode-r/src/rTerminal.ts`
保持现状作为 `TerminalRBackend`，不要硬改成 Ark。
建议新增：
- `vscode-r/src/ark/` 目录
  - `kernelClient.ts`（ZMQ + Jupyter message）
  - `console.ts`（PseudoTerminal/Webview console）
  - `plots.ts`（iopub display_data -> viewer）
  - `lsp.ts`（comm open `positron.lsp` + 端口事件）

### 4.4 `vscode-r/src/languageService.ts`
两种实现路线：
- 路线 1（推荐）：保留现有 `LanguageService` 不动，新增 `ArkLanguageService` 文件，避免把两套逻辑搅在一起
- 路线 2：在 `createClient()` 增加分支：
  - languageserver：沿用
  - ark：从 `ArkKernelBackend` 拿到 port，走 tcpServerOptions

---

## 5. 关键实现细节（会踩坑的地方）

### 5.1 Node 端 ZMQ 依赖的现实问题
实现“直连 kernel 的 Jupyter ZMQ 协议”通常需要 Node 原生依赖（例如 `zeromq` 包）。
这会带来：
- 扩展打包/跨平台构建复杂
- 远程开发环境（SSH/容器）里也要可用

替代方案（降低 Node 原生依赖）：
- 用一个“小的 sidecar 进程”做 Jupyter/ZMQ（比如 Rust 或 Python），VSCode 扩展与 sidecar 用 stdio/JSON-RPC 通信  
  - 优点：Node 不碰 ZMQ 原生编译
  - 缺点：你要维护一个额外可执行文件的分发/更新

### 5.2 Plot 数据不是标准 base64（需要适配）
如第 2.3 节，Ark 目前在 `image/png` 里放的是路径字符串。你的 viewer 要能识别并读取该文件。
另外注意：
- 文件在 **Ark 进程所在机器** 的临时目录
- VSCode Remote 情况下扩展运行在远端，一般能读到；本地/远端分离时要谨慎

### 5.3 LSP 的安全性（绑定地址）
启动 `positron.lsp` 时传入的 `ip_address` 会被 Ark 用来 `bind("{ip}:0")`。  
建议强制默认 `127.0.0.1`，不要给 `0.0.0.0`，避免把 LSP 暴露到局域网。

### 5.4 Session watcher（现有机制）与 Ark 的关系
现有 session watcher 依赖 `R_PROFILE_USER` 注入 `R/session/*.R`，并让 R 写 `workspace.json/plot.png`。  
Ark 的 R 是嵌入式，并且它有自己的 startup 流程；你可以通过 `--startup-file` 注入 R 脚本，但那会让 Ark 侧承担 vscode-r 的 watcher 协议，耦合更深。

建议：Ark backend 直接用 Jupyter/iopub/comm 提供的数据，不要再走 `workspace.json/plot.png` 那套。

---

## 6. 分阶段交付建议（适合“没时间”的路线）

### 阶段 1：只做 Ark LSP（最快看到收益）
目标：不用改 console/plot，先让 VSCode 编辑器获得 Ark LSP 能力。
- 启动一个 Ark kernel（后台）
- open comm `positron.lsp` 拿 port
- `vscode-languageclient` 连接该 port

这阶段仍需要一个最小 Jupyter client（至少能发 `comm_open` 并收 iopub comm 消息），但比做完整 REPL 简单很多。**本仓库实现选择 Rust sidecar 来承担 Jupyter comm**，扩展只负责启动 Ark/sidecar 并用返回的端口连接 LSP。

### 阶段 2：Console（执行 + 输出）
目标：支持 `r.runSelection` 走 Ark kernel 执行，并在一个面板/伪终端显示输出（先不管 plot）。

### 阶段 3：Plot（display_data）
目标：识别 `display_data` 的 `image/png`（路径）并展示；先用 `vscode.open` 图片文件即可。

---

## 7. 验证/测试清单（你该怎么确认没坏）
- Console
  - 执行 `1+1`、`print("hi")`、`message("m")`、`stop("err")`，确认输出/错误都能显示
  - 中断：长循环 `while(TRUE){}` 能否用 VSCode 中断命令打断（需要 control channel）
- Plot
  - `plot(1:10)` 能否触发显示
  - 多次更新同一 plot（`plot(1:10); plot(1:20)`）能否更新/追加
- LSP
  - completion/diagnostics 是否正常
  - 断开/重连：关闭 Ark 后 VSCode 能否恢复（client stop/restart）

---

## 8. 你可以直接抄的“最关键协议点”摘要

### 8.1 启动 Ark kernel
命令形式（示例）：
- `ark --connection_file <path/to/conn.json> --session-mode notebook`

### 8.2 启动 Ark LSP 的 comm_open
- target_name：`positron.lsp`
- data：`{"ip_address":"127.0.0.1"}`
- iopub 收到 `server_started` 后读取 `content.port`

---

如果你愿意，我可以在下一步把这个报告进一步落到“具体到类/方法/消息结构”的伪代码骨架（仍不写大段代码），或者直接在 `vscode-r/` 里给你做一个“阶段 1：Ark LSP only”的最小 PoC 分支（需要你确认是否接受引入 `zeromq` 或 sidecar）。
