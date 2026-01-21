# 在 vscode-r 中引入 Ark backend 的设计（重写版）

本文是对 `dev-docs/vscode-ark.md` 的**完整重写**，结合最新调研（Positron/Ark 会话模式、Positron R 扩展结构、会话持久策略）给出**可落地的架构方案**与**大规模重构计划**。

目标：
- 在现有 `vscode-r` 扩展中新增 **Ark backend**，并**借用 positron-r 扩展的关键实现**（LSP/comm/data explorer/htmlwidgets 等）
- 保留你现有的 **tmux + jupyter console** 工作流，确保会话持久能力
- 避免移植 Positron 的整套 runtime/supervisor 生态（成本高、与 vscode-r 重叠）

---

## 1. 结论摘要

1) **不做“完整移植 positron-r 新插件”**。Positron R 扩展依赖 Positron 自研 runtime/supervisor API，VSCode 中无等价层；完整移植意味着重建“Kernel Supervisor + Runtime API + Session 体系”，成本巨大且重复造轮子。  
2) **在现有 vscode-r 中新增 Ark backend，局部借用 positron-r 代码**。把 Positron/Ark 的“能力点”作为 backend 能力接入（LSP、data explorer、htmlwidgets、plot），而非移植框架。  
3) **会话持久性继续由 tmux + jupyter console 提供**。Positron 的持久机制是 “Supervisor 常驻 + session 复连”，与 tmux 习惯不同；我们选择保留 tmux，并让 VSCode 作为“第二前端”附加到同一 kernel。  
4) **统一使用 Ark Console 模式（`--session-mode console`）**，这是 Ark IDE 集成默认路径，必须处理 Console 模式的输出差异（ShowHtmlFile/中途 autoprint/动态 plot）。

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
- 在 vscode-r 中新增 **Ark backend**：
  - 支持 LSP、plot、data explorer、HTML/widget 输出
  - 作为 `jupyter console` 的“旁路客户端”
- 保留 tmux + `jupyter console` 的**会话持久**
- 能在 Console 模式下稳定运行
- 尽量复用 / 借用 positron-r 的能力实现

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
│  - sidecar / embedded Jupyter client                     │
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
- 实现：VSCode webview 前端 + comm 代理，支持 `GetState/GetSchema/GetDataValues/SetSortColumns/SetRowFilters`

### 6.3 HTML / htmlwidgets
- 复用：Positron 的 htmlwidgets 消息结构与资源根管理思路
- Console 模式：需处理 `ShowHtmlFile` 消息，映射到 Viewer

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

#### Phase 1：Ark LSP only（最低风险落地）
- Ark backend 只实现 `positron.lsp` comm
- VSCode 仍使用现有 console
- 目标：最早看到 LSP 效果

#### Phase 2：Plot & HTML
- 接入 `display_data` / `ShowHtmlFile`
- 新建 viewer/webview 管道
- 仍不触碰 console

#### Phase 3：Data Explorer
- 引入 `positron.dataExplorer` comm 与 webview UI

#### Phase 4：Console（可选）
- 仅在你希望 VSCode 内部也能执行时再实现
- 推荐保持 `jupyter console` 作为主要 REPL

### 7.2 重构清单（文件级）

#### 7.2.1 新增目录结构（建议）
```
src/ark/
  kernelClient.ts       # Jupyter client/comm（或 sidecar 代理）
  lsp.ts                # positron.lsp 启动逻辑
  plots.ts              # display_data / positron.plot
  html.ts               # ShowHtmlFile / htmlwidgets
  dataExplorer.ts       # data explorer comm
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
- `r.backend`: `terminal | ark`
- `r.ark.path`: Ark 可执行路径
- `r.ark.sessionMode`: `console | notebook`（默认 console）
- `r.ark.ipAddress`: 默认 `127.0.0.1`

---

## 8. 会话持久策略（与 tmux 对齐）

### 8.1 保留 tmux + jupyter console
- VSCode 启动 Ark kernel 并生成 connection file
- tmux 内运行 `jupyter console --existing <connection_file>`
- VSCode 作为旁路客户端连接同一 kernel

### 8.2 VSCode 与会话复连
- 如果 VSCode 重启，只需“重新 attach connection file”
- 通过环境变量或命令提供 connection file 路径（如 `ARK_CONNECTION_FILE`）

---

## 9. 风险与不确定点（需确认）

1) **你是否希望完全禁用 vscode-r 自带 console？**
   - 目前方案是假设 console 由 `jupyter console` 承担，VSCode 只旁路。

2) **htmlwidgets 的渲染方案**：
   - 是直接借用 Positron 的 webview 逻辑，还是用更轻量的自定义 viewer？

3) **data explorer UI**：
   - 是否考虑直接移植 Positron 前端（如果许可可行），还是复用现有 vscode-r data viewer？

4) **sidecar 形态**：
   - 你倾向 Rust sidecar（避免 Node ZMQ），还是直接 Node ZMQ？

---

## 10. 验证清单（建议）

- LSP：completion/diagnostics/hover/definition
- Plot：`plot(1:10)` → display_data / dynamic plot
- HTML：`htmlwidgets::` 输出是否能显示
- Data Explorer：分页/排序/过滤
- 会话持久：tmux 中 console 不断开，VSCode 重启后可 attach

---

## 11. 下一步

- 你确认第 9 节的不确定项后，我会把这个设计继续落地到具体模块级计划与接口草案（甚至直接开始 Phase 0 重构）。

