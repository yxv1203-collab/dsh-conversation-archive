# DSH 工作区管理

[![Release](https://img.shields.io/github/v/release/yxv1203-collab/dsh-conversation-archive?display_name=tag)](https://github.com/yxv1203-collab/dsh-conversation-archive/releases/latest)
![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078D4)
[![License](https://img.shields.io/badge/license-MIT-2ea44f)](LICENSE)

[English](README.md) · [简体中文](README.zh-CN.md)

集成于 DeepSeek Harness（DSH）设置界面的归档管理、重要文件保留与本地备份插件。

## 主要功能

- **已归档对话管理：**支持搜索、筛选、取消归档、单项与批量删除，归档状态以 DSH 原生记录为准。
- **重要文件保留：**使用 DSH 配置的模型审核工作区候选产出，在删除前保留选中文件并校验内容哈希。共享文件库支持去重、恢复、批量移除及应用内提醒。
- **本地备份：**支持手动、定时及正常关闭前生成 ZIP 备份。备份包含文件清单与哈希，恢复到空目录，不覆盖已有文件。自动备份默认关闭，默认保留最近五份已验证备份。
- **跨盘工作区：**支持不同磁盘上的 DSH 已登记工作区和独立项目目录，并从 DSH 元数据自动补齐历史会话映射。

## 界面预览

![已归档对话与保留文件](docs/images/workspace-manager-overview.png)

![本地备份与插件设置](docs/images/backup-and-settings.png)

## 环境要求

| 组件 | 要求 |
| --- | --- |
| 操作系统 | Windows 10 或 11 |
| DSH | 已测试 `0.1.1-rc.2` 至 `0.1.2-rc.1`，其他版本尚未验证 |
| PowerShell | 5.1 或更高版本 |
| Node.js | 20 或更高版本，同时满足所安装 DSH 的要求 |
| 工作区 | 具有读写权限的文件夹，不直接使用盘符或网络共享根目录 |

## 安装

### 从 GitHub 安装

```powershell
dsh plugin --profile web add github:yxv1203-collab/dsh-conversation-archive#v1.0.1
```

重启 DSH，打开“设置 → 工作区管理”。

### 从发布包安装

从 [GitHub Releases](https://github.com/yxv1203-collab/dsh-conversation-archive/releases/tag/v1.0.1) 下载 `dsh-conversation-archive-1.0.1.tgz` 及其 `.sha256` 文件。

```powershell
Get-FileHash .\dsh-conversation-archive-1.0.1.tgz -Algorithm SHA256
Get-Content .\dsh-conversation-archive-1.0.1.tgz.sha256
```

确认哈希一致后安装：

```powershell
dsh plugin --profile web add .\dsh-conversation-archive-1.0.1.tgz
```

如果已安装同版本号的早期构建，请下载当前发布包并校验，卸载已安装插件后，再安装下载的包。仅凭版本号无法区分同版本修订包。

## 删除与数据保护

取消归档与删除是独立操作。删除流程先校验会话归属和路径，再扫描符合条件的产出，交由 DSH 配置的模型审核内容；保留副本通过校验后，才回收会话数据。候选文件内容可能发送给 DSH 配置的模型服务商。

原始项目目录和源码文件不属于删除目标。审核、复制、完整性或路径校验失败时，保护性删除流程会停止。AI 保留是选择性保护，不能替代完整项目备份。

在已支持的 DSH 版本中，会话数据回收后暂时保留归档标记；下次正常启动时解除工作区引用并完成删除，避免对话重新出现在活动列表。

## 工作区与元数据

**元数据未登记**表示原生归档会话尚无有效的插件工作区映射。插件在启动和归档同步时，从 DSH 会话元数据自动回填映射。若提示持续出现，请检查工作区是否可访问、会话元数据是否可读取；完整的工作区产出保护和备份需要有效映射。

原生会话路径不受共享存储根目录限制。插件首次使用时可从规范的日常工作区识别共享根目录，并记录该位置供后续启动使用。已有映射和保留文件不会自动迁移。显式设置的 `harnessRoot`、`DCA_HARNESS_ROOT` 或 `DSH_HARNESS_ROOT` 优先。

恢复保留文件到原位置时，目标须属于可识别的 DSH 工作区；否则请选择其他恢复目录。恢复不会覆盖已有文件，并拒绝通过 Junction 或符号链接越界的路径。

## 备份范围

备份包含已登记的 DSH 会话数据和保留文件，不包含完整源码仓库。目标可选本地文件夹或受支持的网络路径；最新备份验证通过后，才会回收超出保留数量的旧备份。网络可用性、目录权限及回收站支持取决于目标位置。

插件不直接连接云盘账号，可由外部同步软件同步备份文件夹。提醒仅在 DSH 内显示，不发送 Windows 系统通知。

## 卸载

```powershell
dsh plugin --profile web remove dsh-conversation-archive
```

卸载后重启 DSH。已有保留文件和备份不会被删除。

## 开发与测试

本机安装兼容版本的 DSH 后执行：

```powershell
npm test
npm pack --dry-run --json
npm pack
```

测试覆盖归档同步、历史元数据回填、跨盘路径规则、文件保留、备份、删除恢复及发布完整性。

## 反馈与协议

通过 [GitHub Issues](https://github.com/yxv1203-collab/dsh-conversation-archive/issues) 反馈问题，或联系 **yxv1203@gmail.com**。请提供 DSH 与插件版本、复现步骤和脱敏后的诊断信息。

本项目采用 [MIT 协议](LICENSE)。
