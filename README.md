# DSH Workspace Manager

[English](README.md) | [简体中文](README.zh-CN.md)

Workspace management for [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness), integrated directly into **Settings → Workspace Manager**.

The plugin extends DSH's native archive workflow with a searchable archive view, safe deletion, automatic protection of valuable outputs, and verified local backups. DSH remains the source of truth for conversation and project state.

## Features

- Browse, search, filter, restore, and batch-manage natively archived conversations.
- Move conversations and their DSH-owned data to the Windows Recycle Bin.
- Review deletion candidates with the active DSH model and automatically retain valuable outputs before cleanup.
- Manage retained files across conversations and projects, including restore and batch removal.
- Create verified ZIP backups manually, periodically, or when DSH closes.
- Back up all managed data, selected conversations, project-associated conversation data, or retained files.
- Check for compatible releases without silent installation or background replacement.

The plugin follows DSH's existing workspace layout. It does not create projects, reorganize source trees, or generate per-conversation category folders.

## Requirements

- Windows 10 or Windows 11
- DeepSeek Harness `0.1.1-rc.2` or a compatible later release
- PowerShell 5.1 or later

No folder needs to be created before installation or first use. Plugin state and the retained-file library are created only when needed. A backup destination is selected from the settings page and validated by the plugin.

## Install

Install the tagged release into the DSH web profile:

```powershell
dsh plugin --profile web add github:yxv1203-collab/dsh-conversation-archive#v1.0.0
```

Restart DSH, then open **Settings → Workspace Manager**.

For offline installation, download the `.tgz` asset from [GitHub Releases](https://github.com/yxv1203-collab/dsh-conversation-archive/releases) and run:

```powershell
dsh plugin --profile web add .\dsh-conversation-archive-1.0.0.tgz
```

## Update and remove

Install a newer release tag with the same `dsh plugin --profile web add` command, then restart DSH.

Remove the plugin with:

```powershell
dsh plugin --profile web remove dsh-conversation-archive
```

Removal keeps retained files, backups, and plugin state so they are not lost accidentally. They can be reviewed and removed separately.

## Data safety

- Original project source directories are never deletion targets.
- Destructive operations use the Windows Recycle Bin and validate registered ownership and physical path boundaries.
- Important-file retention completes before conversation data is recycled; a failed review or copy stops deletion.
- Backup archives contain a manifest and hashes and are verified before restoration.
- On DSH versions without a public destructive conversation API, deletion is safely queued and completed on the next clean DSH start.

The retained-file library is a local protection area, not cloud storage. Use backups or your preferred sync service for long-term off-device storage.

## Feedback

Bug reports and improvement proposals are welcome through [GitHub Issues](https://github.com/yxv1203-collab/dsh-conversation-archive/issues). For direct discussion, contact [yxv1203@gmail.com](mailto:yxv1203@gmail.com).

## License

[MIT](LICENSE) — free for personal and commercial use, modification, and distribution subject to the license terms.
