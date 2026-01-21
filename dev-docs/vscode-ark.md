# 在 vscode-r 中引入 Ark backend 的设计（重写版）

本文是对 `dev-docs/vscode-ark.md` 的**完整重写**，结合最新调研（Positron/Ark 会话模式、Positron R 扩展结构、会话持久策略）给出**可落地的架构方案**与**大规模重构计划**。并已按确认偏好更新：**Ark backend 作为可选后端**、**HTML/data explorer 使用 Positron webview**、**sidecar 使用 Rust**。

目标：
- 在现有 `vscode-r` 扩展中新增 **Ark backend**，并**借用 positron-r 扩展的关键实现**（LSP/comm/data explorer/htmlwidgets 等）
- 保留你现有的 **tmux + jupyter console** 工作流，确保会话持久能力
- 避免移植 Positron 的整套 runtime/supervisor 生态（成本高、与 vscode-r 重叠）
- **默认在受管 tmux 会话中创建 Ark session**（可配置），提供 `create ark session` 命令让用户输入名字

---

## 1. 结论摘要

1) **不做“完整移植 positron-r 新插件”**。Positron R 扩展依赖 Positron 自研 runtime/supervisor API，VSCode 中无等价层；完整移植意味着重建“Kernel Supervisor + Runtime API + Session 体系”，成本巨大且重复造轮子。  
2) **在现有 vscode-r 中新增 Ark backend（可选后端）**，局部借用 positron-r 代码。把 Positron/Ark 的“能力点”作为 backend 能力接入（LSP、data explorer、htmlwidgets、plot），而非移植框架。  
3) **会话持久性继续由 tmux + jupyter console 提供**。Positron 的持久机制是 “Supervisor 常驻 + session 复连”，与 tmux 习惯不同；我们选择保留 tmux，并让 VSCode 作为“第二前端”附加到同一 kernel。  
4) **统一使用 Ark Console 模式（`--session-mode console`）**，这是 Ark IDE 集成默认路径，必须处理 Console 模式的输出差异（ShowHtmlFile/中途 autoprint/动态 plot）。  
5) **Rust sidecar 作为验证过的实现路径**（已有部分基础），避免 Node ZMQ 依赖。  
6) **默认用受管 tmux 会话创建并托管 Ark 会话**，确保 VSCode 退出后仍可复连（可配置为外部 console 或非 tmux）。

---

## 2. 背景与现状

### 2.1 vscode-r 当前结构
- **Console**：依赖 VSCode Terminal + 原生 R 进程 (`rTerminal.ts`)。
- **Plot**：两条路径（session watcher 输出文件 / httpgd viewer）。
- **LSP**：运行 R `languageserver::run()`（stdio 或 TCP）。
- **Data Viewer**：基于 session watcher + 文件/临时数据渲染。

### 2.2 Ark/Positron 调研结论（关键影响点）
- Ark 会话模式：Console/Notebook/Background（详见 `dev-docs/ark-session-types.md`）。
- **Console 模式**特性：
  - UI comm 已连接时走动态 plot（`positron.plot`）
  - HTML 输出走 `ShowHtmlFile`
  - 允许“中途 autoprint”输出
  - 前端不应发送不完整输入
- Positron R 扩展通过 **Jupyter kernel + comm** 启动 Ark LSP (`positron.lsp`)。
- Positron 的会话持久化依赖 Kernel Supervisor（Kallichore）与 `kernelSupervisor.shutdownTimeout` / `attachOnStartup`，**并非 tmux 模式**。

---

## 3. 设计目标与非目标

### 3.1 目标
- 在 vscode-r 中新增 **Ark backend（可选后端）**：
  - 支持 LSP、plot、data explorer、HTML/widget 输出
  - 作为 `jupyter console` 的“旁路客户端”
- 保留 tmux + `jupyter console` 的**会话持久**
- 能在 Console 模式下稳定运行
- 尽量复用 / 借用 positron-r 的能力实现
- 使用 **Rust sidecar** 承担 Jupyter/ZMQ/comm 细节

### 3.2 非目标
- 不迁移 Positron 的 Kernel Supervisor 体系
- 不重写完整 Positron Runtime API
- 不替换现有 `vscode-r` 全部功能（尤其是终端驱动的 console）

---

## 4. 总体架构（新设计）

### 4.1 高层结构
```
┌──────────────────────────────────────────────────────────┐
│ VSCode (vscode-r)                                        │
│  - Ark backend (new)                                     │
│  - Rust sidecar (Jupyter client/comm)                    │
│  - LSP client (vscode-languageclient)                    │
│  - Plot/Data/HTML viewer (webview)                       │
└──────────────────────────────────────────────────────────┘
              │                         ▲
              │ (Jupyter ZMQ/comm)      │
              ▼                         │
┌──────────────────────────────────────────────────────────┐
│ Ark kernel (Console mode)                                │
└──────────────────────────────────────────────────────────┘
              ▲
              │ (same connection file)
              ▼
┌──────────────────────────────────────────────────────────┐
│ jupyter console (tmux)                                   │
└──────────────────────────────────────────────────────────┘
```

### 4.2 关键原则
- **Ark kernel 由 VSCode 启动或附加**（推荐由 VSCode 生成 connection file）。
- `jupyter console` 作为 REPL 前端，可运行于 tmux，**会话持久**。
- VSCode 作为“第二个 Jupyter client”，负责 LSP/plot/data/HTML 输出。
- **Ark backend 为可选后端**，默认仍保留 `terminal` backend。
- Jupyter/ZMQ 细节由 **Rust sidecar** 承担，扩展只与其做轻量 RPC。
- **会话持久由 tmux 托管**，扩展不承担 supervisor/daemon 管理。

---

## 5. Console 模式适配要求

来自 `ark-session-types` 的行为差异：
- **ShowHtmlFile**：HTML 输出不走 `display_data`，必须解析专用消息并落到 viewer/webview。
- **中途 autoprint**：多表达式执行时可能有多条输出，需按序显示。
- **动态 plot**：当 UI comm 建立时走 `positron.plot`，否则回落到 `display_data`。
- **不完整输入**：前端不要发送不完整代码片段，否则 Ark 会立即拒绝。
- **错误处理**：Console 模式不做 Notebook 的 evalue 插入，按标准 Jupyter 错误消息处理即可。

---

## 6. 关键能力与复用点（从 positron-r 借用）

### 6.1 LSP
- 复用：Positron 的 `positron.lsp` comm 协议与启动流程
- 实现：Ark backend 发 `comm_open` → 获取端口 → 启动 `vscode-languageclient`

### 6.2 Data Explorer
- 复用：`positron.dataExplorer` comm 协议（RPC）
- 实现：**移植 Positron Data Explorer webview 前端** + comm 代理，支持 `GetState/GetSchema/GetDataValues/SetSortColumns/SetRowFilters`

### 6.3 HTML / htmlwidgets
- 复用：**Positron webview 渲染逻辑**（htmlwidgets 消息结构与资源根管理）
- Console 模式：处理 `ShowHtmlFile` 消息，映射到 Positron webview

### 6.4 Plot
- 当 UI comm 不可用时：解析 `display_data` 的 `image/png` 路径字符串并读取文件
- 当 UI comm 可用时：优先支持 `positron.plot` 动态绘制

---

## 7. 重构计划（核心要求）

该改动是**结构性重构**，目标是将 `vscode-r` 的 “console/plot/lsp” 逻辑**解耦为可插拔 backend**。

### 7.1 阶段化重构路线

#### Phase 0：抽象 backend 框架（强制先做）
- 引入统一接口（示例）：
  - `IRBackend` / `IRConsoleBackend` / `IRLspBackend` / `IRPlotBackend` / `IRDataBackend`
- 将现有 Terminal + languageserver 逻辑封装为 `TerminalBackend`
- 将 Ark 相关逻辑隔离到 `ArkBackend`
- 定义 **Rust sidecar** 与扩展之间的 RPC/协议层（最小可用 API）

#### Phase 1：Ark LSP only（最低风险落地）
- Ark backend 只实现 `positron.lsp` comm
- VSCode 仍使用现有 console
- 目标：最早看到 LSP 效果

#### Phase 2：Plot & HTML
- 接入 `display_data` / `ShowHtmlFile`
- 对接 **Positron webview** 组件
- 仍不触碰 console

#### Phase 3：Data Explorer
- 引入 `positron.dataExplorer` comm 与 **Positron Data Explorer webview**

#### Phase 4：Console（可选）
- 仅在你希望 VSCode 内部也能执行时再实现
- 推荐保持 `jupyter console` 作为主要 REPL

### 7.2 重构清单（文件级）

#### 7.2.1 新增目录结构（建议）
```
src/ark/
  kernelClient.ts       # Jupyter client/comm（Rust sidecar 代理）
  lsp.ts                # positron.lsp 启动逻辑
  plots.ts              # display_data / positron.plot
  html.ts               # ShowHtmlFile / htmlwidgets（Positron webview）
  dataExplorer.ts       # data explorer comm（Positron webview）
  backend.ts            # ArkBackend 实现
src/backends/
  terminal.ts           # 现有 terminal backend 迁移
  types.ts              # backend 接口定义
```

#### 7.2.2 关键文件改动
- `src/extension.ts`：根据配置选择 backend
- `src/rTerminal.ts`：迁移为 `TerminalBackend`，保留原逻辑
- `src/languageService.ts`：支持 `ArkLspBackend` 分支
- `package.json`：新增配置项与命令

### 7.3 配置项建议
- `r.backend`: `terminal | ark`（默认 terminal）
- `r.ark.path`: Ark 可执行路径
- `r.ark.sessionMode`: `console | notebook`（默认 console）
- `r.ark.ipAddress`: 默认 `127.0.0.1`
- `r.ark.sessionsDir`: 会话元数据/connection file 根目录（默认扩展 globalStorage）
- `r.ark.console.driver`: `tmux | external`（默认 tmux）
- `r.ark.console.commandTemplate`: 默认 `jupyter console --existing {connectionFile}`
- `r.ark.kernel.commandTemplate`: 默认 `{arkPath} --connection_file {connectionFile} --session-mode {sessionMode}`
- `r.ark.tmux.path`: `tmux`（可配置为绝对路径）
- `r.ark.tmux.sessionNameTemplate`: 默认 `vscode-ark-{name}`
- `r.ark.tmux.manageKernel`: boolean，默认 true（在 tmux 内启动 Ark kernel）
- `r.ark.tmux.extraArgs`: 传给 tmux 的附加参数

### 7.4 命令设计（新增）
- `r.ark.createSession`：提示输入 session 名称，创建并启动 Ark 会话（默认在 tmux 中托管）
- `r.ark.attachSession`：从已知会话列表选择并附加（或粘贴 connection file 路径）
- `r.ark.stopSession`：停止 Ark 会话（可选：关闭 tmux session）
- `r.ark.openConsole`：打开/附加 tmux console（或外部 console）

---

## 8. 会话持久策略（与 tmux 对齐）

### 8.1 默认：受管 tmux 会话
默认流程（`r.ark.console.driver=tmux` 且 `r.ark.tmux.manageKernel=true`）：  
1) 用户执行 `r.ark.createSession`  
2) 扩展提示输入 session 名称（例如 `analysis`）  
3) 生成 connection file（写入 `r.ark.sessionsDir/<name>/connection.json`）  
4) 通过 tmux 创建会话（`vscode-ark-<name>`），并在 tmux 内启动：  
   - **Window 1**：`ark --connection_file <path> --session-mode console`  
   - **Window 2**：`jupyter console --existing <path>`  
5) 扩展/sidecar 通过 connection file 作为第二前端附加  

优势：  
- Ark kernel 与 console 都在 tmux 内，**VSCode 关闭也不会停止会话**  
- 无需引入 Supervisor/daemon  

可配置变体：  
- `r.ark.tmux.manageKernel=false`：Ark 由扩展/sidecar 启动，tmux 仅管理 console  
- `r.ark.console.driver=external`：不创建 tmux，用户自行启动 console（仍可通过 connection file 附加）  

### 8.2 会话元数据与复连
扩展维护会话注册表（存储在 `r.ark.sessionsDir` 或 globalStorage）：  
- `sessionName` / `tmuxSessionName`  
- `connectionFilePath`  
- `createdAt` / `lastAttachedAt`  
- `mode`（tmux/external）  

VSCode 重启后：  
- `r.ark.attachSession` 从注册表选择会话并附加  
- 或直接粘贴/选择 `connection.json`  

建议在 Ark 启动时设置环境变量：  
- `ARK_CONNECTION_FILE=<path>`（便于用户在 console 中查到）  

---

## 9. Console 选择评估：Positron console vs jupyter console

结论：**仍以 `jupyter console` 为首选 REPL**。原因：  
- Positron console 依赖 Positron 专用 API（如 `positron.window.getConsoleForLanguage`），VSCode 中没有等价 UI 层  
- 复用 Positron console 意味着移植/重写其 console UI 与 runtime 绑定逻辑，工作量与风险高  
- `jupyter console + tmux` 已满足“持久会话 + 可 attach/detach”的核心需求，并与 Ark kernel 原生兼容  

可选项（未来）：  
- 在 VSCode 内实现 PseudoTerminal 或 webview console，但作为**次要前端**  

---

## 10. 已确认的设计决策

1) **Ark backend 作为可选后端**（默认仍保留 vscode-r 终端 backend）。  
2) **HTML/htmlwidgets 使用 Positron webview 方案**。  
3) **Data Explorer 使用 Positron Data Explorer 前端**。  
4) **sidecar 使用 Rust 实现**（已有部分基础）。
5) **不引入 supervisor**，会话持久由 tmux 与 connection file 管理。

---

## 11. 验证清单（建议）

- LSP：completion/diagnostics/hover/definition
- Plot：`plot(1:10)` → display_data / dynamic plot
- HTML：`htmlwidgets::` 输出是否能显示
- Data Explorer：分页/排序/过滤
- 会话持久：tmux 中 console 不断开，VSCode 重启后可 attach

---

## 12. 下一步

- 进入 Phase 0：定义 backend 接口与 Rust sidecar API，拆分 `TerminalBackend` 与 `ArkBackend`。
