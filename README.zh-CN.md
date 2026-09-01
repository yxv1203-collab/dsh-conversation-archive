# DSH 工作区管理

[English](README.md) | [简体中文](README.zh-CN.md)

面向 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) 的原生工作区管理插件，直接集成到 **设置 → 工作区管理**。

插件在 DSH 原生归档能力之上补充归档检索、安全删除、重要产出保护和本地备份。对话与项目状态始终以 DSH 为准。

## 功能

- 查看、搜索、筛选、恢复和批量管理 DSH 原生已归档对话。
- 将对话及其 DSH 所属数据移入 Windows 回收站。
- 删除前调用当前 DSH 模型审核候选文件，并自动保留有价值的产出。
- 跨对话、跨项目管理保留文件，支持恢复、选择来源和批量移除。
- 支持手动、按天周期及关闭 DSH 前执行经过校验的 ZIP 备份。
- 可备份全部受管数据、指定对话、项目关联的对话数据或保留文件。
- 检查兼容的新版本，不静默下载或替换正在运行的插件。

插件沿用 DSH 已有的工作区结构，不创建项目、不重排源码，也不会为每条对话生成分类文件夹。

## 使用环境

- Windows 10 或 Windows 11
- DeepSeek Harness `0.1.1-rc.2` 或兼容的后续版本
- PowerShell 5.1 或更高版本

安装或首次使用前不需要提前建立任何文件夹。插件状态目录和保留文件库仅在需要时自动创建；备份目录由用户在设置页选择，并由插件检查和创建。

## 安装

将指定版本安装到 DSH 的 web profile：

```powershell
dsh plugin --profile web add github:yxv1203-collab/dsh-conversation-archive#v1.0.0
```

重启 DSH，然后打开 **设置 → 工作区管理**。

离线安装时，从 [GitHub Releases](https://github.com/yxv1203-collab/dsh-conversation-archive/releases) 下载 `.tgz` 文件并执行：

```powershell
dsh plugin --profile web add .\dsh-conversation-archive-1.0.0.tgz
```

## 更新与卸载

使用相同的 `dsh plugin --profile web add` 命令安装新版本标签，随后重启 DSH。

卸载插件：

```powershell
dsh plugin --profile web remove dsh-conversation-archive
```

默认卸载不会删除保留文件、备份和插件状态，避免因卸载误丢数据；这些数据可在确认后单独处理。

## 数据安全

- 原项目源码目录永远不会成为删除目标。
- 删除操作使用 Windows 回收站，并验证会话登记、所有权和物理路径边界。
- 重要文件审核和复制完成后才会回收对话数据；审核或复制失败会终止删除。
- 备份包含文件清单和哈希，恢复前会重新验证。
- 当 DSH 尚未提供公开的彻底删除接口时，插件会安全排队，并在下一次正常启动 DSH 时完成删除。

保留文件库是本地防误删区域，不等同于云存储。需要长期异地保存时，请使用备份或用户自行选择的同步服务。

## 反馈

欢迎通过 [GitHub Issues](https://github.com/yxv1203-collab/dsh-conversation-archive/issues) 提交问题与优化建议。如需直接交流，可联系 [yxv1203@gmail.com](mailto:yxv1203@gmail.com)。

## 许可

[MIT](LICENSE)——在遵守协议条款的前提下，可免费用于个人及商业用途，也允许修改和分发。
