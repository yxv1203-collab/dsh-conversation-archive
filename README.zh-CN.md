# DSH 工作区管理

[![Release](https://img.shields.io/github/v/release/yxv1203-collab/dsh-conversation-archive?display_name=tag)](https://github.com/yxv1203-collab/dsh-conversation-archive/releases/latest)
![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078D4)
[![License](https://img.shields.io/badge/license-MIT-2ea44f)](LICENSE)

[English](README.md) · [简体中文](README.zh-CN.md)

为 DeepSeek Harness 提供原生归档管理、重要文件保护与可验证的本地备份。

DSH 工作区管理补全了对话归档后的管理流程，同时不替代 DeepSeek Harness 的状态、不改变其原有工作区结构。插件在 DSH 设置中提供统一管理页面，用于管理已归档对话与项目、在清理前保护重要产出，并建立可追溯的本地备份。

## 核心能力

| 功能 | 说明 |
| --- | --- |
| 归档管理 | 查看、搜索、筛选、恢复及批量管理由 DSH 原生归档的对话和项目。 |
| 安全删除 | 仅清理所选对话对应且归 DSH 管理的数据，并通过 Windows 回收站保留恢复机会。 |
| 重要文件保护 | 使用当前 DSH 模型按内容审核候选产出，在清理前统一保留重要文件、去重并校验文件哈希。 |
| 可验证备份 | 支持手动、定时和关闭前 ZIP 备份，生成清单与校验值，并通过安全路径恢复。 |

## 原生集成原则

- DSH 始终是归档状态的唯一事实来源。
- **元数据未登记**表示该原生归档项没有插件登记的文件映射，常见于安装插件前已归档或只存在于 DSH 原生状态中的对话。这不是故障；原生恢复和删除仍可使用，只是没有额外登记的文件范围需要保留或清理。
- 插件不创建项目、不重组已有工作区，也不会为每条对话生成一套分类目录。
- 安装前无需手动建立任何文件夹。
- 清理范围仅限 DSH 所有或明确登记的数据；用户已有的源码项目不会成为删除目标。

## 兼容环境

| 组件 | 状态 |
| --- | --- |
| Windows 10 / 11 | 支持 |
| DeepSeek Harness `0.1.1-rc.2` | 已验证 |
| 更高版本 DSH | 尚未验证 |
| PowerShell | 5.1 或更高版本 |
| Node.js | 20 或更高版本 |

## 快速开始

### 从 GitHub 安装

```powershell
dsh plugin --profile web add github:yxv1203-collab/dsh-conversation-archive#v1.0.0
```

重启 DeepSeek Harness，打开“设置”，选择“工作区管理”。

### 使用离线安装包

1. 从 [v1.0.0 Release](https://github.com/yxv1203-collab/dsh-conversation-archive/releases/tag/v1.0.0) 下载 `dsh-conversation-archive-1.0.0.tgz` 及其 `.sha256` 文件。
2. 校验下载文件：

   ```powershell
   Get-FileHash .\dsh-conversation-archive-1.0.0.tgz -Algorithm SHA256
   Get-Content .\dsh-conversation-archive-1.0.0.tgz.sha256
   ```

3. 确认两个哈希值一致后安装：

   ```powershell
   dsh plugin --profile web add .\dsh-conversation-archive-1.0.0.tgz
   ```

## 删除安全机制

删除是一套受保护的流程，而不是直接执行文件系统清理：

1. 解析原生归档项及其在 DSH 中登记的所有权范围。
2. 扫描该范围，并排除依赖、临时数据和可丢弃缓存。
3. 使用当前 DSH 模型按实际内容审核候选文档、代码、媒体及其他产出。
4. 将重要产出复制到全局“保留文件”库，完成去重与哈希校验。
5. 将对话及其归 DSH 管理的数据移入 Windows 回收站。
6. 若审核、复制、校验或所有权检查失败，立即停止删除。

## 保留文件与本地备份

“保留文件”是面向整个 DSH 环境的统一防误删文件库，不从属于单个项目。每项记录来源对话、来源项目、原始位置、保留时间及内容哈希；支持恢复、批量选择和移入回收站。检查提醒在 DSH 应用内显示。

本地备份与“保留文件”相互独立。备份目标可选择本地文件夹或 UNC/网络路径，并支持手动执行、按间隔自动执行或在 DSH 正常关闭前执行。用户可配置保留版本数量，过期备份将移入回收站。

## 数据边界

- 用户原有源码仓库和自行管理的项目目录永远不是自动清理目标。
- DSH 原生归档状态始终优先于插件元数据。
- 保留文件和备份仅写入用户选择或 DSH 管理的本地存储位置。
- “保留文件”用于降低误删风险，不等同于云端备份服务。

## 更新与卸载

```powershell
dsh plugin --profile web update dsh-conversation-archive
dsh plugin --profile web remove dsh-conversation-archive
```

卸载插件不会静默删除保留文件或备份。

## 当前范围

- 当前仅支持 Windows。
- 保留文件提醒仅在 DSH 应用内展示，不包含系统通知。
- 不直接连接云盘账号；可将本地同步目录或网络目录设为备份目标。
- 对于未提供公开删除接口的 DSH 版本，确认删除后会进入安全队列，并在下次正常启动时完成。

## 问题反馈

欢迎提交缺陷报告或明确的优化建议。可发送邮件至 **yxv1203@gmail.com**，或在 GitHub 提交 Issue，并附上 DSH 版本、插件版本、复现步骤和相关日志。

## 开源协议

本项目采用 [MIT License](LICENSE) 开源。
