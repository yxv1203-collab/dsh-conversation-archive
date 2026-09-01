# DeepSeek Harness 工作区管理

`dsh-conversation-archive` 是面向 DeepSeek Harness（DSH）的工作区管理插件，为原生归档会话补充集中管理、安全清理、重要文件保护和本地备份能力。插件集成于 DSH 原生设置页面，以平台真实会话状态为准，在不接管原项目源码的前提下统一管理会话缓存与相关产出。

当前稳定版本为 `1.0.0`，已在 Windows 与 DeepSeek Harness `0.1.1-rc.2` 环境完成自动化验证。

## 核心能力

### 归档会话管理

- 在 DSH“设置 → 工作区管理”中集中查看原生已归档会话。
- 支持搜索、聊天与项目筛选、单项恢复、批量恢复和批量删除。
- 恢复操作直接同步 DSH 原生归档状态，不维护独立的伪归档列表。
- 页面启动及刷新时重新校验平台状态，避免界面与真实会话状态不一致。

### 安全删除与缓存清理

- 删除归档会话时，仅处理该会话登记的缓存、工作文件和 DSH 会话记录。
- 原项目源码目录、工作区根目录及未登记文件不会作为删除目标。
- 文件通过 Windows 系统回收站处理，只有清空回收站后才不可恢复。
- 支持单项与批量操作，删除阶段和结果均写入脱敏审计记录。

DSH `0.1.1-rc.2` 尚未提供公开的会话删除接口。插件因此采用安全的分阶段删除流程：操作确认后立即隐藏并登记删除意图，在下次 DSH 干净启动时完成数据回收和归档标记清理；如果用户在此期间通过 DSH 恢复会话，删除意图会自动取消。

### 重要文件保护

- 删除前先通过本地规则排除依赖、临时文件和明显缓存，再由 DSH 当前模型审核候选内容。
- 被判定为重要产出的文件自动复制到跨项目、跨会话的全局保留库，并进行 SHA-256 完整性校验。
- 保留文件记录来源会话、来源项目、保存时间和原始位置，支持来源选择、恢复、全选及批量回收。
- 模型不可用、审核结果无效、复制失败或哈希不一致时，删除流程会安全中止，不继续清理原数据。

AI 审核会产生少量 Token 消耗。插件对候选数量、文件大小、文本抽样长度和审核时间设置了明确上限。

### 本地备份

- 支持备份全部受管数据、指定会话缓存、项目缓存或保留文件。
- 备份目标可选择本地目录或 Windows 可访问的网络磁盘。
- 自动备份支持关闭、按天周期以及关闭 DSH 前尽力执行三种模式。
- 备份 ZIP 包含文件清单和哈希，恢复前会重新验证完整性并拒绝覆盖非空目录。
- 默认保留最近 5 个有效版本，旧版本通过 Windows 回收站清理。

### 工作区组织

- 日常对话按日期建立一级目录，同一天的会话使用标题、时间和短标识区分。
- 项目会话在项目 `.cache` 下使用独立会话目录，避免不同会话共享缓存。
- 每个会话按文档、表格、演示、代码、脚本、配置、数据、图片、音视频、压缩包、日志和其他内容分类。
- 删除某日期下最后一个日常会话后，仅清理已经为空的日期目录。

## 兼容环境

| 项目 | 要求 |
| --- | --- |
| 操作系统 | Windows；依赖 PowerShell 与系统回收站 |
| DeepSeek Harness | 最低及已验证版本：`0.1.1-rc.2` |
| Node.js | `20` 或更高版本 |
| DSH Profile | `web` |

插件依赖当前 DSH 的 Cordis 插件加载机制。未经验证的 DSH 版本不会被自动声明为兼容。

## 安装

从 [GitHub Releases](https://github.com/yxv1203-collab/dsh-conversation-archive/releases) 下载 Windows ZIP 和对应的 SHA-256 文件，验证后解压。

安装前可先预览目标路径和配置变更：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -DryRun
```

确认信息正确后执行安装：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

安装器会解析实际 DSH 环境、备份已有插件代码与 profile patch，并执行 Node.js 语法检查和 DSH 配置加载验证；任一步骤失败都会自动回滚。安装完成后完全退出并重新启动 DSH，然后打开“设置 → 工作区管理”。

## 使用说明

### 管理归档会话

归档操作继续使用 DSH 原生入口。插件页面只负责查看、恢复和删除已归档会话，不重复提供主动归档功能。

删除会话时，插件会依次完成候选文件审核、重要文件保护、删除意图登记和安全回收。当前 DSH 版本需要在下一次干净启动时完成最终删除；页面会显示待处理数量。

### 管理保留文件

保留库用于降低误删风险，可从设置页查看来源、恢复文件或移入回收站。它不是云存储服务；需要长期保存的数据应通过本地备份或用户自己的同步工具复制到外部存储。

### 配置备份

在“本地备份”区域选择目标目录、备份范围、执行模式和版本保留数量。插件不会登录 OneDrive、百度网盘或其他云盘账号，但可以使用已经挂载到 Windows 的同步目录或网络磁盘。

## 数据位置

- 插件代码：`$DSH_HOME\profiles\web\node_modules\dsh-conversation-archive\versions\<版本>\`
- 配置、状态与审计：`$DSH_HOME\storages\conversation-archive\`
- 日常对话缓存：`<Harness 根目录>\daily_conversation\YYYY-MM-DD\<标题>-<时间>-<短标识>\`
- 项目会话缓存：`<项目>\.cache\<会话短标识>\`
- 全局保留库：`<Harness 根目录>\重要文件保护\`
- 本地备份：用户在设置中选择的目录
- 安装回滚副本：`$DSH_HOME\plugin-backups\dsh-conversation-archive\`

## 安全与隐私

- 所有删除目标必须同时通过会话登记、受管根目录和物理路径边界验证。
- Junction、路径穿越、兄弟目录前缀和 ZIP Slip 等越界情况会被拒绝。
- 状态损坏、未知版本、迁移失败或持久化异常会触发只读保护，阻止进一步写入和删除。
- 诊断与审计信息不记录本机绝对路径、模型凭据或其他密钥。
- AI 审核使用 DSH 当前模型能力；插件不单独建立外部模型账号，也不接入第三方云盘账号。

## 更新与卸载

插件会从本仓库的 GitHub Releases 检查兼容更新，只显示提示，不会静默下载或覆盖运行中的版本。更新时解压新版本并重新执行安装命令，用户配置、保留文件和备份不会随代码更新而删除。

默认卸载仅移除插件代码和所属 profile patch，保留用户数据：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1
```

如需同时回收插件状态、保留库和登记过的备份文件：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1 -RemoveUserData
```

卸载器不会删除原项目源码目录或未登记文件。

## 开发与验证

```powershell
npm --prefix host test
npm --prefix host run check
npm --prefix client test
npm --prefix client run check
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-installer.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-release.ps1
node .\scripts\verify-release.mjs
```

发布验收标准见 [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md)。

## 反馈与交流

如果你在使用过程中发现问题，或对插件的功能、交互体验和兼容性有改进建议，欢迎通过 [GitHub Issues](https://github.com/yxv1203-collab/dsh-conversation-archive/issues) 提交反馈，也可以发送邮件至 [yxv1203@gmail.com](mailto:yxv1203@gmail.com)。欢迎围绕实际使用场景与后续优化方向进行交流。

## 开源协议

本项目采用 [MIT License](LICENSE)，允许个人和企业免费使用、修改、分发及商用，但须保留原版权与许可声明。软件按原样提供，不附带任何担保。
