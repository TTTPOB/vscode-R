# Ark Jupyter Session Types 调查报告

## 概述

Ark 内核支持三种不同的会话类型（SessionMode），每种类型在行为上都有显著差异。本文档详细说明这些会话类型的区别及其影响。

## SessionType 定义

`SessionMode` 是一个 Rust 枚举类型，定义在 `ark/crates/ark/src/interface.rs:142-151`：

```rust
pub enum SessionMode {
    /// 一个具有交互式控制台（REPL）的会话，如 Positron
    Console,

    /// 一个 Jupyter 或类似 Jupyter 的笔记本会话
    Notebook,

    /// 一个后台会话，通常不连接任何 UI
    Background,
}
```

### 配置方式

SessionMode 可以通过命令行参数 `--session-mode` 配置（`main.rs:125-136`）：

```rust
"--session-mode" => {
    if let Some(mode) = argv.next() {
        session_mode = match mode.as_str() {
            "console" => SessionMode::Console,
            "notebook" => SessionMode::Notebook,
            "background" => SessionMode::Background,
            _ => {
                return Err(anyhow::anyhow!(
                    "Invalid session mode: '{mode}'. Expected `console`, `notebook`, or `background`."
                ));
            },
        };
    }
    // ...
}
```

## 三种 SessionMode 的详细差异

### 1. Console 模式

这是 Ark 在 Positron IDE 中使用的默认模式（`main.rs:91`）。

#### 特性

- **动态图表支持**：
  - 图表可以通过 CommSocket 与前端进行双向通信
  - 允许根据用户调整窗口大小等操作重新渲染图表
  - 通过 `should_use_dynamic_plots()` 检查（`graphics_device.rs:216-220`）

- **UI Comm 连接**：
  - 直接与 Positron 前端建立连接
  - 支持专门的 UI comm 通信

- **HTML 输出处理**：
  - 使用专门的 `ShowHtmlFile` 消息发送到 Positron
  - 支持不同的目的地设置（plot、editor、viewer）
  - 可以指定显示高度（`viewer.rs:79-114`）

- **Autoprint 输出**：
  - 支持发送多表达式中途结果的 autoprint 输出
  - 这专门针对 Positron 的某些版本，用户可以在一个请求中发送多个表达式
  - 代码位置：`interface.rs:2078-2086`

- **输入处理**：
  - Positron 不会发送不完整的输入给 Ark
  - Positron 自己处理 continuation prompts（`interface.rs:468-472`）

#### 使用场景

- Positron IDE 的集成 R 内核
- 需要丰富 UI 交互的 IDE 集成
- 需要动态图表更新的场景

---

### 2. Notebook 模式

用于标准的 Jupyter Notebook、JupyterLab 等前端。

#### 特性

- **静态图表渲染**：
  - 没有动态图表支持
  - 图表一旦渲染就无法更新
  - 在检测到更改时立即渲染图表并作为 `IOPubMessage::DisplayData` 或 `IOPubMessage::UpdateDisplayData` 发送
  - 参考文档：`graphics-devices.md:49`

- **HTML 输出处理**：
  - 作为 Jupyter `display_data` 消息发送
  - 不支持专门的 UI comm 通信（`viewer.rs:73-78`）

- **Autoprint 输出**：
  - **不发送多表达式中途结果的 autoprint 输出**
  - 这是因为其他 Jupyter 前端不希望看到这些中间表达式的输出（`interface.rs:2078-2081`）

- **错误处理差异**：
  - 在 Notebook 模式下，当存在 traceback 时，会将 `evalue`（错误值）插入到 traceback 的开头
  - 这是因为 Jupyter 客户端通常在存在 traceback 时丢弃 `evalue`
  - 代码位置：`interface.rs:1252-1254`

- **输入处理**：
  - Jupyter Notebooks 可能发送不完整的输入给 Ark
  - Ark 会**立即拒绝**这些不完整的输入（`interface.rs:353-354, 471-472`）
  - 这避免了 R 进入等待更多输入的状态

#### 使用场景

- 标准 Jupyter Notebook
- JupyterLab
- 其他兼容 Jupyter 协议的笔记本前端
- 需要标准 Jupyter 协议兼容性的场景

---

### 3. Background 模式

用于后台任务或不连接任何 UI 的场景。

#### 特性

- HTML 输出处理与 Notebook 模式相同
- 没有动态图表支持
- 没有直接的 UI 连接
- 没有前端特定的通信

#### 使用场景

- 后台 R 任务执行
- 无需用户交互的自动化任务
- 批处理作业

---

## 核心差异总结表

| 特性 | Console 模式 | Notebook 模式 | Background 模式 |
|------|-------------|---------------|-----------------|
| **动态图表** | ✅ 支持 | ❌ 不支持 | ❌ 不支持 |
| **UI Comm 连接** | ✅ 是 | ❌ 否 | ❌ 否 |
| **HTML 输出方式** | `ShowHtmlFile` 消息 | `display_data` 消息 | `display_data` 消息 |
| **中途 Autoprint** | ✅ 支持 | ❌ 不支持 | ❌ 不支持 |
| **不完整输入** | ❌ 前端不发送 | ✅ 前端可能发送 | ❌ 前端不发送 |
| **错误处理** | 标准 | 将 evalue 加入 traceback | 标准 |
| **主要用途** | Positron IDE | Jupyter Notebook | 后台任务 |

---

## 代码实现位置

### SessionMode 定义
- `ark/crates/ark/src/interface.rs:142-151`

### 命令行参数解析
- `ark/crates/ark/src/main.rs:125-136`

### Console 模式特有行为
- 动态图表检查：`ark/crates/ark/src/plots/graphics_device.rs:216-220`
- HTML 输出：`ark/crates/ark/src/viewer.rs:79-114`
- 中途 Autoprint：`ark/crates/ark/src/interface.rs:2083-2085`

### Notebook 模式特有行为
- HTML 输出：`ark/crates/ark/src/viewer.rs:73-78`
- 错误处理：`ark/crates/ark/src/interface.rs:1252-1254`
- 中途 Autoprint 过滤：`ark/crates/ark/src/interface.rs:2078-2081`

### 共同行为
- 不完整输入拒绝：`ark/crates/ark/src/interface.rs:353-363`

---

## 设计考虑

### 为什么 Notebook 模式不发送中途 Autoprint 输出？

Jupyter 前端期望每个执行单元产生一个清晰的输出。当用户在同一个执行单元中运行多个表达式（如 `a\nb\nc`）时，传统 Jupyter 前端只对最后一个表达式产生 autoprint 输出。发送中间表达式的输出会导致混乱和不一致的 UI 行为。

然而，Positron 的某些版本允许用户在一个请求中发送多个表达式（通过选择多行代码），这种情况下用户期望看到每个表达式的输出。因此，Console 模式特别支持这种功能。

### 为什么 Console 模式不支持动态图表的替代方案？

在 Console 模式下，Ark 与 Positron 建立了双向通信机制（通过 CommSocket）。当用户调整图表窗口大小时，Positron 会通知 Ark 重新渲染图表。这种机制需要：
1. 持久的 Comm 连接
2. 前端知道如何发起重新渲染请求
3. Ark 能够异步处理这些请求

标准的 Jupyter 前端没有这种双向通信机制，因此只能使用静态图表渲染方式。

---

## 相关文档

- 图形设备详细说明：`ark/doc/graphics-devices.md`
- Amalthea（Jupyter 协议实现）：`ark/crates/amalthea/`
- 测试示例：
  - `ark/crates/ark/tests/kernel-notebook.rs` - Notebook 模式测试
  - `ark/crates/ark/tests/fixtures/dummy_frontend.rs:38-46` - Notebook frontend 包装器

---

## 结论

三种 SessionMode 反映了 Ark 内核在不同环境中的灵活性和适应性：

- **Console 模式**：针对 Positron IDE 优化，提供最丰富的功能和交互性
- **Notebook 模式**：遵循标准 Jupyter 协议，确保与各种 Jupyter 前端的兼容性
- **Background 模式**：用于无 UI 的后台任务

这种设计使 Ark 既能支持现代 IDE 的丰富功能，又能保持与标准 Jupyter 协议的兼容性。
