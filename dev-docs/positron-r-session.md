# Positron R 会话能力与实现

## 概述

Positron 中的 R 语言支持通过 `positron-r` 扩展实现，位于 `extensions/positron-r/` 目录。该扩展提供了完整的 R 开发环境，包括运行时管理、语言服务器、测试支持、包开发工具等功能。

---

## 1. 语言支持

### 1.1 语言配置
- **语言 ID**: `r`
- **支持的文件扩展名**:
  - `.R`, `.r` - R 源文件
  - `.Rprofile`, `.rprofile` - R 配置文件
  - `NAMESPACE` - 包命名空间文件
- **相关语言**:
  - `debian-control-file` (`.Rproj`, `.dcf`, `DESCRIPTION`, `.lintr`) - R 包描述文件
  - `r-pkg-docs` (`.rd`, `.Rd`) - R 文档文件

### 1.2 编辑器配置
- Tab 大小: 2
- Format on type: 启用
- 特定单词分隔符: R 特定的分隔符
- Smart Select 行为: R 特定的代码选择

### 1.3 语法高亮
- 通过 Tree-sitter 语法文件: `syntaxes/r.tmGrammar.gen.json`
- 支持内联代码块

### 1.4 语句范围检测
- 位置: `statement-range.ts`
- 功能: 识别 R 语句的范围，用于代码执行和格式化
- 通过 LSP 扩展注册: `positron.languages.registerStatementRangeProvider('r')`

---

## 2. 运行时管理

### 2.1 运行时发现
**位置**: `provider.ts`

**支持的解释器来源**（按优先级）:
1. **用户覆盖**: `positron.r.interpreters.override` 设置
2. **当前 R**:
   - Windows: 注册表 (HKEY_CURRENT_USER/HKEY_LOCAL_MACHINE)
   - 所有平台: PATH 环境变量
   - 非Windows: R HQ 目录中的 `Current` 链接
3. **系统 R**:
   - macOS: `/Library/Frameworks/R.framework/Versions/`
   - Linux: `/opt/R/`
   - Windows: `Program Files\R\` 和 `Program Files\R-aarch64\`
4. **Conda R**: 从 conda 环境发现
   - 位置: `provider-conda.ts`
   - 启用配置: `positron.r.interpreters.condaDiscovery`
5. **Pixi R**: 从 pixi 环境发现
   - 位置: `provider-pixi.ts`
   - 启用配置: `positron.r.interpreters.pixiDiscovery`
6. **服务器 R**:
   - 标准服务器位置: `/usr/lib/R`, `/usr/local/lib/R`, `/opt/local/lib/R` 等
7. **用户指定**: `positron.r.customRootFolders` 和 `positron.r.customBinaries`
8. **Ad Hoc**: 预定义路径如 `/usr/bin/R`, `/usr/local/bin/R`

**运行时元数据** (`makeMetadata()`):
- Runtime ID: 基于路径和版本的 SHA256 哈希
- Runtime Name: `R {version} (packager info)`
- Runtime Short Name: `R {version} ({arch})` （如果需要区分架构）
- Runtime Path: R 二进制路径
- Runtime Version: 扩展版本
- Language Version: R 版本
- Runtime Source: System/User/Homebrew/Conda/Pixi
- Extra Data:
  - `homepath`: R_HOME 路径
  - `binpath`: R 二进制路径
  - `scriptpath`: Rscript 路径
  - `arch`: 架构 (x86_64, arm64)
  - `current`: 是否为当前版本
  - `default`: 是否为默认版本
  - `reasonDiscovered`: 发现原因
  - `packagerMetadata`: 包管理器元数据 (conda/pixi)

### 2.2 运行时管理器
**位置**: `runtime-manager.ts`

**功能**:
- 注册为 `r` 语言运行时管理器
- 实现语言运行时创建
- 管理运行时生命周期

### 2.3 内核规范
**位置**: `kernel-spec.ts`

**内核查找顺序**:
1. `positron.r.kernel.path` 设置
2. 嵌入内核（发布版本）
3. 本地构建内核（开发者构建）
4. 下载的本地内核（其他开发者）

**Windows 架构检测**:
- 从 PE 头检测: ARM64 (0xAA64), x64 (0x8664), x86 (0x14c)
- 路径启发式检测
- 搜索顺序: 优先架构 → 回退架构

---

## 3. 会话管理

### 3.1 会话接口实现
**位置**: `session.ts`

**核心组件**:
- **Jupyter Kernel**: 底层执行引擎
- **Ark LSP**: 语言服务器协议客户端
- **Ark Comm**: 直接内核通信
- **DAP Comm**: 调试适配器协议通信

**会话生命周期**:
1. **创建**: `RSession()` 构造函数
2. **启动**: `start()` - 创建并启动内核
3. **LSP 激活**: `activateLsp()` - 启动语言服务器
4. **就绪**: 等待 `RuntimeState.Ready`
5. **停止**: `shutdown()` 或 `forceQuit()`

### 3.2 会话能力

#### 3.2.1 代码执行
```typescript
execute(code: string, id: string, mode: RuntimeCodeExecutionMode, errorBehavior: RuntimeErrorBehavior)
```
- **执行模式**:
  - `Interactive`: 交互式执行（用户手动运行）
  - `NonInteractive`: 非交互式执行（自动运行，如任务）

#### 3.2.2 代码完整性检查
```typescript
isCodeFragmentComplete(code: string): Promise<RuntimeCodeFragmentStatus>
```
- 检查代码片段是否完整
- 返回状态: Complete/Incomplete/Error

#### 3.2.3 工作目录管理
```typescript
setWorkingDirectory(dir: string): Promise<void>
```
- 更改 R 会话的工作目录
- 转义路径中的特殊字符

#### 3.2.4 控制台宽度设置
```typescript
setConsoleWidth(width: number): Promise<void>
```
- 动态调整 R 控制台宽度
- 响应 Positron 窗口大小变化

#### 3.2.5 环境和语言环境
```typescript
getEnvVars(envVarNames: string[]): Promise<EnvVar[]>
getLocale(): Promise<Locale>
```
- 获取环境变量值
- 获取语言环境信息（LANG, LC_CTYPE 等）

#### 3.2.6 包管理
```typescript
packageVersion(pkgName: string, minimumVersion?: string, refresh?: boolean): Promise<RPackageInstallation | null>
checkInstalled(pkgName: string, minimumVersion?: string): Promise<boolean>
isPackageAttached(packageName: string): Promise<boolean>
```
- **包信息缓存**: 避免重复检查
- **自动安装提示**: 缺少或版本不足时提示用户
- **兼容性检查**: 验证包版本是否满足要求

#### 3.2.7 会话控制
```typescript
interrupt(): Promise<void>
restart(workingDirectory?: string): Promise<void>
shutdown(exitReason?: RuntimeExitReason): Promise<void>
forceQuit(): Promise<void>
```
- 中断执行
- 重启会话（可选保存工作目录）
- 关闭会话
- 强制退出

#### 3.2.8 客户端管理
```typescript
createClient(id: string, type: RuntimeClientType, params: any): Promise<void>
listClients(type?: RuntimeClientType): Promise<Record<string, string>>
removeClient(id: string): void
sendClientMessage(clientId: string, messageId: string, message: any): void
```
- 创建、列出和移除客户端
- 发送消息到特定客户端

#### 3.2.9 方法调用
```typescript
callMethod(method: string, ...args: any[]): Promise<any>
```
- 直接调用 R 内核方法
- 用于与 R 运行时交互（如获取帮助主题）

### 3.3 会话管理器
**位置**: `session-manager.ts`

**功能**:
- 单例模式管理所有 R 会话
- LSP 激活/停用协调（确保只有一个 LSP 活动）
- 跟踪前台和后台会话
- 管理最后使用的二进制路径

---

## 4. 语言服务器协议 (LSP)

### 4.1 Ark LSP 客户端
**位置**: `lsp.ts`

**LSP 状态**:
- `Uninitialized`: 未初始化
- `Starting`: 正在启动
- `Stopped`: 已停止
- `Running`: 运行中

**连接机制**:
- 通过 Jupyter Comm 协议连接到内核
- 内核选择端口并监听
- 客户端连接到选定端口

### 4.2 LSP 功能

#### 4.2.1 标准 LSP 功能
- **代码补全**: 自动完成 R 代码
- **诊断**: 实时错误和警告检测
- **悬停信息**: 显示函数/变量文档
- **转到定义**: 跳转到定义
- **查找引用**: 查找符号使用位置
- **符号搜索**: 工作区符号导航
- **文档格式**: 代码格式化

#### 4.2.2 Positron 扩展功能

**1. 语句范围提供者** (`statement-range.ts`)
```typescript
positron.languages.registerStatementRangeProvider('r', new RStatementRangeProvider(client))
```
- 识别 R 语句的范围
- 用于代码执行和交互式编辑

**2. 帮助主题提供者** (`help.ts`)
```typescript
positron.languages.registerHelpTopicProvider('r', new RHelpTopicProvider(client))
```
- 调用 LSP: `positron/textDocument/helpTopic`
- 返回光标位置的帮助主题
- 支持悬停时获取帮助

**3. 虚拟文档提供者** (`virtual-documents.ts`)
```typescript
vscode.workspace.registerTextDocumentContentProvider('ark', new VirtualDocumentProvider(client))
```
- 提供 Quarto 虚拟文档
- 用于在编辑器中显示嵌入的代码块

#### 4.2.3 诊断过滤
- 禁用 Assistant 代码确认小部件的诊断
- 禁用 Quarto 虚拟文档的诊断

### 4.3 LSP 队列管理
- 使用 `p-queue` 串行化 LSP 操作
- 防止并发启动/停止竞争
- 并发度: 1

---

## 5. 测试支持

### 5.1 testthat 集成
**位置**: `testing/testing.ts`

**测试探索器设置**:
```typescript
vscode.tests.createTestController('rPackageTests', 'R Package Test Explorer')
```

**功能**:
- 自动发现测试文件
- 测试文件监视器（自动重新加载）
- 测试运行配置
- 支持工作区测试

**测试文件发现** (`testing/loader.ts`):
- 扫描 `tests/` 目录
- 解析 `testthat` 测试文件
- 构建测试项层次结构

**测试运行** (`testing/runner.ts`):
- 通过 `devtools::test()` 运行
- 报告测试结果
- 支持单个和批量测试

**测试监视器** (`testing/watcher.ts`):
- 监视测试文件变化
- 自动更新测试树

**配置选项**:
- `positron.r.testing`: 启用/禁用测试探索器
- `TESTTHAT_MAX_FAILS`: 测试失败环境变量

### 5.2 usethis 集成
**命令**:
- `r.useTestthat`: 配置 testthat (`usethis::use_testthat()`)
- `r.useTest`: 创建新测试文件 (`usethis::use_test("rename-me")`)

---

## 6. 包开发工具

### 6.1 VS Code 任务
**位置**: `tasks.ts`

**任务提供者**:
```typescript
vscode.tasks.registerTaskProvider('rPackageTask', new RPackageTaskProvider())
```

**内置任务**:

| 任务名称 | 命令 | 包依赖 | 说明 |
|---------|--------|---------|------|
| `r.task.packageCheck` | `devtools::check()` | devtools | 检查包 |
| `r.task.packageInstall` | `pak::local_install(upgrade = FALSE)` | pak | 安装包 |
| `r.task.packageTest` | `devtools::test()` | devtools | 测试包 |
| `r.task.rmarkdownRender` | `rmarkdown::render("{path}")` | rmarkdown | 渲染 R Markdown |

**任务执行**:
- 使用 `Rscript` 而非交互式 R
- 自动处理环境变量
- Windows 上使用 `ProcessExecution` 避免 PowerShell 引用问题

### 6.2 包开发命令
**位置**: `commands.ts`

**可用命令**:
- `r.packageLoad`: `devtools::load_all()` - 加载所有包
- `r.packageBuild`: `devtools::build()` - 构建包
- `r.packageInstall`: 安装包（并重启会话）
- `r.packageTest`: 运行包测试
- `r.packageCheck`: `devtools::check()` - 检查包
- `r.packageDocument`: `devtools::document()` - 生成文档

### 6.3 R Markdown 支持
**命令**: `r.rmarkdownRender`
- 渲染当前 R Markdown 文件
- 自动检测文件扩展名 `.rmd` 或 `.Rmd`
- 使用 `rmarkdown::render()`

---

## 7. 帮助和文档

### 7.1 帮助系统
**位置**: `session.ts` (实现), `help.ts` (LSP 接口)

**帮助资源**:
- **URI Scheme**: `x-r-help:`
- **LSP 方法**: `positron/textDocument/helpTopic`
- **运行时方法**: `showHelpTopic(topic)`

**显示帮助主题**:
```typescript
showHelpTopic(topic: string): Promise<void>
```
- 显示特定主题的帮助
- 如果主题不存在显示警告

### 7.2 Vignette 支持
**位置**: `session.ts`

**Vignette 资源**:
- **URI Scheme**: `x-r-vignette:`
- **运行时方法**: `showVignetteTopic(topic)`

### 7.3 语言模型工具 (LLM)
**位置**: `llm-tools.ts`

**工具定义** (package.json):

1. **listPackageHelpTopics**
   - 输入: `sessionIdentifier`, `packageName`
   - 运行时方法: `list_package_help_topics()`
   - 用途: 列出包的帮助主题

2. **listAvailableVignettes**
   - 输入: `sessionIdentifier`, `packageName`
   - 运行时方法: `list_available_vignettes()`
   - 用途: 列出包的 vignettes

3. **getPackageVignette**
   - 输入: `sessionIdentifier`, `packageName`, `vignetteName`
   - 运行时方法: `get_package_vignette()`
   - 用途: 获取特定 vignette 的完整内容

4. **getHelpPage**
   - 输入: `sessionIdentifier`, `helpTopic`, `packageName?`
   - 运行时方法: `get_help_page()`
   - 用途: 获取特定帮助页面的完整内容

---

## 8. HTML 小部件支持

### 8.1 htmlwidgets 集成
**位置**: `htmlwidgets.ts`

**渲染器**:
- **MIME 类型**: `application/vnd.r.htmlwidget`
- **入口点**: `resources/js/htmlwidget.js`
- **文档选择器**: `positron.r.htmlwidget`

### 8.2 小部件数据结构
```typescript
interface RHtmlWidget {
  dependencies: RHtmlDependency[];     // 依赖项列表
  sizing_policy: HtmlWidgetSizingPolicy; // 大小调整策略
  tags: string;                         // HTML 内容
}

interface RHtmlDependency {
  name: string | null;
  version: string | null;
  head: string | null;
  script: string | string[] | null;
  stylesheet: string | string[] | null;
  meta: string | null;
  src: { file: string };
  all_files: boolean;
}
```

### 8.3 大小调整策略
**支持的环境**:
1. **Viewer**: 面板显示
   - `paneHeight`: 面板高度（像素）
   - `suppress`: 是否抑制显示

2. **Browser**: 外部浏览器
   - `external`: 是否在外部浏览器显示

3. **Knitr**: notebook/报告
   - `figure`: 是否为图表

**通用策略**:
- `defaultHeight`: 默认高度（CSS 单位）
- `defaultWidth`: 默认宽度（CSS 单位）
- `fill`: 是否填充视口
- `padding`: 额外内边距

### 8.4 资源根管理
```typescript
getResourceRoots(widget: RHtmlWidget): vscode.Uri[]
```
- 识别小部件依赖的所有本地资源
- 自动注册为资源根
- 允许小部件访问本地文件

---

## 9. 调试支持

### 9.1 调试适配器协议 (DAP)
**位置**: `session.ts`

**调试器配置** (package.json):
```json
{
  "type": "ark",
  "label": "R Debugger",
  "languages": ["r"],
  "supportsUiLaunch": false
}
```

**DAP 通信**:
- 通过 Jupyter Comm 协议
- Comm 名称: `ark_dap`
- 显示名称: "Ark Positron R"

**消息循环**:
- 无限异步消息处理循环
- 处理 DAP 请求和事件
- 未知请求错误处理

### 9.2 DAP 启动
```typescript
private async startDap(): Promise<void>
```
- 创建 DAP Comm
- 启动消息处理循环
- 在会话就绪时启动

---

## 10. 命令和快捷键

### 10.1 编辑命令
**位置**: `commands.ts`

| 命令 | 功能 | 快捷键 (Mac/Linux) |
|--------|------|-------------------|
| `r.createNewFile` | 创建新 R 文件 | - |
| `r.insertPipe` | 插入管道运算符 | Cmd/Ctrl+Shift+M |
| `r.insertLeftAssignment` | 插入左侧赋值运算符 | Alt+- |
| `r.insertSection` | 插入代码分区 | Cmd/Ctrl+K H |
| `r.sourceCurrentFile` | Source 当前文件 | - |
| `r.sourceCurrentFileWithEcho` | Source 当前文件（带 echo） | Cmd/Ctrl+Shift+Enter |

### 10.2 包开发命令
| 命令 | 功能 | 快捷键 |
|--------|------|--------|
| `r.packageLoad` | 加载包 | Cmd/Ctrl+Shift+L |
| `r.packageInstall` | 安装包 | Cmd/Ctrl+Shift+B |
| `r.packageTest` | 运行测试 | Cmd/Ctrl+Shift+T |
| `r.packageTestExplorer` | 打开测试探索器 | Cmd/Ctrl+Shift+T |
| `r.packageCheck` | 检查包 | Cmd/Ctrl+Shift+E |
| `r.packageDocument` | 文档化包 | Cmd/Ctrl+Shift+D |

### 10.3 管道运算符配置
**配置**: `positron.r.pipe`
**选项**:
- Native: `|>` (R 4.1+)
- Magrittr: `%>%`

### 10.4 其他命令
- `r.selectInterpreter`: 选择 R 解释器
- `r.interpreters.settingsInfo`: 显示解释器设置信息
- `r.getMinimumRVersion`: 获取最小支持的 R 版本
- `r.renvInit`: 初始化 renv 环境

---

## 11. 环境管理

### 11.1 renv 支持
**命令**: `r.renvInit`
- 检查 renv 安装
- 提示安装缺失的 renv
- 调用 `renv::init()`
- 最小版本要求: `1.0.9`

### 11.2 R 文件类型识别
**R 包检测**:
- 检查 `DESCRIPTION` 文件
- 检查 `NAMESPACE` 文件
- 文件扩展名匹配

**上下文设置**:
- `isRPackage`: 是否为 R 包
- `testthatIsConfigured`: 是否配置了 testthat
- `testthatHasTests`: 是否有测试文件

---

## 12. 文件关联

### 12.1 R 文件粘贴和拖放
**位置**: `languageFeatures/rFilePasteAndDropProvider.ts`

**功能**:
- 处理 R 文件的粘贴
- 处理 R 文件的拖放
- 自动引用粘贴的代码

### 12.2 文件关联注册
**URI 处理器** (`uri-handler.ts`):
- 处理自定义 URI schemes
- 支持 `x-r-help:` 和 `x-r-vignette:`

---

## 13. 配置选项

### 13.1 基本配置
| 配置键 | 类型 | 默认值 | 说明 |
|--------|------|---------|------|
| `positron.r.testing` | boolean | true | 启用包测试 |
| `positron.r.restoreWorkspace` | boolean | false | （已弃用）恢复工作区 |
| `positron.r.saveAndRestoreWorkspace` | boolean | false | 保存和恢复工作区 |
| `positron.r.quietMode` | boolean | false | 安静模式 |
| `positron.r.pipe` | enum | native (`|>`) | 管道运算符 |
| `positron.r.diagnostics.enable` | boolean | true | 启用诊断 |
| `positron.r.symbols.includeAssignmentsInBlocks` | boolean | false | 在块中包含赋值 |
| `positron.r.workspaceSymbols.includeCommentSections` | boolean | false | 在工作区符号中包含注释分区 |
| `positron.r.autoConvertFilePaths` | boolean | true | 自动转换文件路径 |

### 13.2 解释器配置
| 配置键 | 类型 | 默认值 | 说明 |
|--------|------|---------|------|
| `positron.r.customRootFolders` | array | [] | 自定义根目录 |
| `positron.r.customBinaries` | array | [] | 自定义二进制路径 |
| `positron.r.interpreters.exclude` | array | [] | 排除的解释器 |
| `positron.r.interpreters.override` | array | [] | 覆盖解释器 |
| `positron.r.interpreters.default` | string | null | 默认解释器 |
| `positron.r.interpreters.condaDiscovery` | boolean | false | Conda 发现（实验性） |
| `positron.r.interpreters.pixiDiscovery` | boolean | false | Pixi 发现（实验性） |

### 13.3 内核配置
| 配置键 | 类型 | 默认值 | 说明 |
|--------|------|---------|------|
| `positron.r.kernel.path` | string | "" | 内核路径 |
| `positron.r.kernel.logLevel` | enum | warn | 日志级别 |
| `positron.r.kernel.logLevelExternal` | string | warn | 外部日志级别 |
| `positron.r.kernel.profile` | string | null | 配置文件 |
| `positron.r.kernel.env` | object | {} | 环境变量 |
| `positron.r.extraArguments` | array | [] | 额外参数 |

### 13.4 仓库配置
| 配置键 | 类型 | 默认值 | 说明 |
|--------|------|---------|------|
| `positron.r.defaultRepositories` | enum | auto | 默认仓库（auto/rstudio/posit-ppm/none） |
| `positron.r.packageManagerRepository` | string | - | 包管理器仓库 |

### 13.5 追踪配置
| 配置键 | 类型 | 默认值 | 说明 |
|--------|------|---------|------|
| `positron.r.trace.server` | enum | off | 服务器追踪（off/messages/verbose） |

---

## 14. 系统要求

### 14.1 最小版本
- **R 版本**: 4.2.0+
- **renv 版本**: 1.0.9+
- **Ark 版本**: 0.1.223 (binaryDependencies)

### 14.2 平台支持
- **Linux**: x86_64, arm64
- **macOS**: x86_64, arm64 (Apple Silicon)
- **Windows**: x64, arm64

---

## 15. 迁移支持

### 15.1 RStudio 迁移
**位置**: `resources/walkthroughs/`

**迁移指南**:
1. **窗格和 UI**: 窗格布局映射
2. **快捷键**: RStudio 快捷键映射
3. **工作区**: .Rproj 文件支持
4. **格式化**: 代码格式化工具

**命令**:
- `r.walkthrough.updateRStudioKeybindings`: 打开 RStudio 快捷键设置
- `r.walkthrough.formatOnSave`: 打开格式化保存设置

### 15.2 RStudio 用户检测
```typescript
function isRStudioUser(): boolean
```
- 检查 RStudio 状态目录
- 检测最近 30 天内修改的文件
- 用于推荐 R 运行时

---

## 16. 超链接支持

### 16.1 代码超链接
**位置**: `hyperlink.ts`

**支持的 URI Schemes**:
- `x-r-run:`: 执行 R 代码
- `x-r-help:`: 显示帮助
- `x-r-vignette:`: 显示 vignette

**处理器**: `handleRCode()`
- 解析并执行代码
- 在控制台中执行

---

## 17. 扩展集成

### 17.1 依赖扩展
- `positron.positron-supervisor`: 内核和会话管理
- `positron-positron-assistant`: AI 助手集成

### 17.2 事件集成
- **DidChangeConfiguration**: 配置变化监听
- **DidChangeConsoleWidth**: 控制台宽度变化
- **DidChangePlotsRenderSettings**: 绘图设置变化
- **DidDiscoverTestFiles**: 测试文件发现完成

---

## 18. 输出通道

### 18.1 输出通道
- **R Language Pack**: 扩展日志
- **R Language Server**: LSP 日志
- **Jupyter**: 内核日志

### 18.2 日志级别
- Error, Warn, Info, Debug, Trace
- 配置: `positron.r.kernel.logLevel`

---

## 19. 资源管理

### 19.1 扩展资源
- 图标: `resources/branding/r-icon.svg`
- 语法文件: `syntaxes/`
- 语言配置: `language-configuration/`
- 内核二进制: `resources/ark/`

### 19.2 脚本
- `install-kernel.ts`: 内核安装
- `compile-syntax.ts`: 语法编译
- `post-install.ts`: 安装后任务

---

## 20. 会话持久化

### 20.1 会话位置
**选项**:
- **Workspace**: 工作区级别（默认）
- **Machine**: 机器级别（持久化）

**配置**: `kernelSupervisor.shutdownTimeout`
- `immediately`: 工作区会话
- 其他值: 机器会话

### 20.2 会话恢复
- 支持会话重新连接
- 恢复 LSP 连接
- 保持工作目录状态

---

## 附录 A: 常见问题

### Q1: 如何更改 R 解释器？
A: 使用命令 `r.selectInterpreter` 或设置 `positron.r.interpreters.default`。

### Q2: 如何启用测试探索器？
A: 设置 `positron.r.testing` 为 `true`。

### Q3: 如何调试 R 代码？
A: 当前 Positron 不支持通过 UI 启动 R 调试器（`supportsUiLaunch: false`），但 DAP 基础设施已就绪。

### Q4: 如何管理 R 包？
A: 使用包开发命令或 VS Code 任务面板中的任务。

### Q5: 如何获取帮助？
A: 将光标悬停在函数上，或使用 `x-r-help:` URI scheme。

---

## 附录 B: 文件位置

| 模块 | 文件 |
|------|------|
| 扩展入口 | `extension.ts` |
| 会话 | `session.ts` |
| 会话管理器 | `session-manager.ts` |
| 运行时管理器 | `runtime-manager.ts` |
| 运行时提供者 | `provider.ts` |
| LSP | `lsp.ts` |
| 命令 | `commands.ts` |
| 任务 | `tasks.ts` |
| 测试 | `testing/testing.ts` |
| 帮助 | `help.ts` |
| HTML 小部件 | `htmlwidgets.ts` |
| 内核 | `kernel.ts` |
| LLM 工具 | `llm-tools.ts` |

---

## 附录 C: 相关链接

- **Positron 文档**: https://positron.posit.co
- **R Discovery 文档**: https://positron.posit.co/r-installations
- **htmlwidgets 文档**: https://www.htmlwidgets.org
- **RStudio 迁移指南**: Positron Walkthroughs
- **Ark 仓库**: https://github.com/posit-dev/ark
- **Positron 仓库**: https://github.com/posit-dev/positron

---

*本文档基于 Positron 扩展版本 0.0.2 编写，涵盖截至 2026 年 1 月的所有已知功能。*
