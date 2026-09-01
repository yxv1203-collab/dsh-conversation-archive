# DeepSeek Harness 工作区管理

`dsh-conversation-archive` 是适配 DeepSeek Harness（DSH）的 Windows Cordis 插件，不是 Codex 插件。它在 DSH 原生设置左侧注册“工作区管理”，全局管理原生已归档对话及其受管缓存，不会建立另一套归档状态，也不会提供主动归档入口。

当前交付版本为 `1.0.0`，已针对 Windows 与 DSH `0.1.1-rc.2` 自动验证。

## 开源协议

本项目采用 [MIT License](LICENSE)：允许个人和企业免费使用、修改、分发及商用，但须保留原版权与许可声明。软件按原样提供，不附带任何担保。

## 四个设置区

- **已归档对话**：只显示 DSH 原生已归档 ID；支持单项/批量恢复和移入 Windows 回收站。删除前自动完成产出捕获、分批 AI 内容审核、重要文件复制与 SHA-256 校验。DSH `0.1.1-rc.2` 没有公开删除 API，因此删除项会立即从管理列表隐藏，并在下次 DSH 干净启动时按“先回收数据、再清除归档标记”的顺序完成，避免误连到取消归档。
- **保留文件**：跨项目、跨对话的全局防误删库，记录来源会话、项目、保存时间和原位置，支持应用内提醒、恢复及显式回收。它不是云盘。
- **本地备份**：可备份全部受管数据、单个活动/归档会话缓存、项目缓存或保留文件到本地/网络磁盘；ZIP 带清单和哈希，恢复前复验。自动备份可关闭、按天周期或在 DSH 退出前尽力执行，默认保留最近 5 个版本。
- **插件设置**：实际工作区根目录、AI 保护开关、候选数量、单文件审核上限、文本抽样长度、审核超时、更新开关、当前兼容性和可复制的脱敏诊断。更新检查只提示，不下载、不覆盖运行中的插件。

## 安装、更新与卸载

解压发布 ZIP 后，在 PowerShell 中先预览，不会写入任何文件：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1 -DryRun
```

确认解析出的 DSH 命令、profile 和目标正确后安装：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

安装器通过 `Get-Command dsh` 和 `DSH_HOME`/用户目录解析实际环境，将 Host 与 Client 放入 web profile 的版本目录，只维护带标记的插件 patch 块；它会备份旧代码和 patch，执行 Node 语法检查及真实 `dsh --profile web --dump-config` loader 检查，失败自动回滚。路径可含空格和中文。

更新时解压新版本并再次运行同一安装命令。安装是幂等的，用户状态、保留文件和备份不随代码更新。插件内更新检查默认开启，从本仓库的 GitHub Releases 查询兼容版本；它只提示更新，不会静默下载或覆盖。兼容性未经验证时不会提示安装新版本。

默认卸载只移除插件代码和自己的 profile patch，保留全部用户数据：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1
```

只有明确需要同时清理插件数据时才使用：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\uninstall.ps1 -RemoveUserData
```

该选项会先列出精确目标，再把插件状态、保留库和登记过的备份 ZIP 移入 Windows 回收站。不会删除原项目源码目录或未登记文件。

## 文件与缓存位置

- 安装代码：`$DSH_HOME\profiles\web\node_modules\dsh-conversation-archive\versions\<版本>\`
- 配置与状态：`$DSH_HOME\storages\conversation-archive\`
- 日常对话缓存：`<Harness 根目录>\daily_conversation\YYYY-MM-DD\<短标题>-<时间>-<短标识>\`
- 项目会话缓存：`<项目>\.cache\<会话短标识>\`
- 全局保留库：`<Harness 根目录>\重要文件保护\`
- 备份：用户在设置中选择的本地或网络磁盘目录
- 安装/卸载恢复副本：`$DSH_HOME\plugin-backups\dsh-conversation-archive\`

每条会话缓存独立包含会话记录、文档、表格、演示、代码、脚本、配置、数据、图片、音视频、压缩包、日志和其他分类。删除同一天最后一条日常对话时，只清理已空的日期目录；绝不把 Harness 根目录或原项目目录作为删除目标。

## AI、隐私与 Token

删除归档对话前，本地规则先排除依赖、临时和明显缓存文件，再把候选的受限内容交给 DSH 当前默认模型判断。超大文本以首/中/尾代表片段审核，SHA-256 采用流式读取；当当前模型和 DSH 附件服务都明确支持图片输入时，少量受限大小图片以真实图片块发送，否则界面和审核提示只声明元数据限制，不声称查看了图片内容。数量、摘要长度、文件大小和超时都有上限。该步骤会产生少量 Token 消耗。模型不可用、返回不合规、复制失败或哈希不一致时，删除事务失败关闭，不会继续回收会话或缓存。

## 回收站、安全边界与恢复

插件删除受管会话缓存、DSH 会话记录、保留文件及过期备份时使用 Windows 回收站；清空系统回收站后才不可恢复。网络磁盘、文件系统策略、回收站容量或 Windows API 限制可能使回收失败，这种情况下插件返回错误并保留可重试状态，不会静默永久删除。保留文件只是防误删区；长期保存请将备份目录同步到你自己的 OneDrive、百度网盘、NAS 等位置，插件不会登录云盘账号。

备份恢复只接受插件登记的安全 ID，先验证 ZIP 路径、清单、每文件 SHA-256 与 Zip Slip，再恢复到已存在且为空的目标目录。不会覆盖非空目录。

## 迁移、只读保护与诊断

旧版 `0.3.1` 配置和映射会在备份后确定性迁移到带 `schemaVersion` 的状态。任一状态损坏、版本未知或迁移失败时，插件进入全局只读保护：设置页仍可查看诊断和 DSH 原生归档，但恢复缓存、删除、备份、提醒确认及配置写入会被禁用。不要删除旧文件；先复制 `$DSH_HOME\storages\conversation-archive\`，查看“插件设置 → 兼容性与诊断”中的 store/code，再从安装器备份或最近验证备份恢复。修复后重启 DSH。

恢复、删除阶段、AI 保留、备份和保留文件回收都会追加到状态目录中的 `operations.jsonl`。记录只包含版本、时间、操作 ID、安全会话/文件 ID、阶段、结果和脱敏摘要，不记录本机绝对路径或密钥；畸形日志会被诊断并使后续写入失败关闭。

## 验证与发布

开发者完整检查：

```powershell
npm --prefix host test
npm --prefix host run check
npm --prefix client test
npm --prefix client run check
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-installer.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-release.ps1
node .\scripts\verify-release.mjs
```

自动验收与剩余人工发布检查见 `docs/ACCEPTANCE.md`。
