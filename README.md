# DSH Workspace Manager

[![Release](https://img.shields.io/github/v/release/yxv1203-collab/dsh-conversation-archive?display_name=tag)](https://github.com/yxv1203-collab/dsh-conversation-archive/releases/latest)
![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078D4)
[![License](https://img.shields.io/badge/license-MIT-2ea44f)](LICENSE)

[English](README.md) · [简体中文](README.zh-CN.md)

Native archive control, protected file retention, and verified local backups for DeepSeek Harness.

DSH Workspace Manager completes the archive lifecycle without replacing DeepSeek Harness state or reorganizing its workspace. It adds a native settings page for archived chats and projects, protects valuable outputs before cleanup, and provides auditable local backups.

## Capabilities

| Area | What it provides |
| --- | --- |
| Archive control | Browse, search, filter, restore, and batch-manage chats and projects archived by DSH. |
| Safe deletion | Remove only the selected conversation's DSH-owned data through the Windows Recycle Bin. |
| Protected retention | Review candidate outputs with the active DSH model, preserve important files globally, deduplicate copies, and verify their hashes before cleanup. |
| Verified backup | Create manual, scheduled, or shutdown ZIP backups with manifests and checksums; restore them through validated paths. |

## Native by design

- DSH remains the only source of truth for archive state.
- **Metadata not registered** means that a native archived item has no plugin-managed file mapping, commonly because it predates the plugin or exists only in DSH state. It is informational, not an error; native restore and deletion remain available, but there is no additionally registered file scope to retain or clean.
- The plugin does not create projects, reorganize existing workspaces, or generate category folders for every conversation.
- No prerequisite directory needs to be created before installation.
- Cleanup is limited to data owned or explicitly registered by DSH; existing source projects are never deletion targets.

## Compatibility

| Component | Status |
| --- | --- |
| Windows 10 / 11 | Supported |
| DeepSeek Harness `0.1.1-rc.2` | Verified |
| Later DSH releases | Not yet verified |
| PowerShell | 5.1 or later |
| Node.js | 20 or later |

## Quick start

### Install from GitHub

```powershell
dsh plugin --profile web add github:yxv1203-collab/dsh-conversation-archive#v1.0.0
```

Restart DeepSeek Harness, open **Settings**, and select **Workspace Manager**.

### Install an offline package

1. Download `dsh-conversation-archive-1.0.0.tgz` and its `.sha256` file from the [v1.0.0 release](https://github.com/yxv1203-collab/dsh-conversation-archive/releases/tag/v1.0.0).
2. Verify the download:

   ```powershell
   Get-FileHash .\dsh-conversation-archive-1.0.0.tgz -Algorithm SHA256
   Get-Content .\dsh-conversation-archive-1.0.0.tgz.sha256
   ```

3. Confirm that the two hashes match, then install:

   ```powershell
   dsh plugin --profile web add .\dsh-conversation-archive-1.0.0.tgz
   ```

## Deletion safety model

Deletion is a guarded workflow rather than a direct filesystem operation:

1. Resolve the native archived item and its registered DSH ownership scope.
2. Scan that scope while excluding dependencies, temporary data, and disposable caches.
3. Ask the active DSH model to assess candidate documents, code, media, and other outputs by content.
4. Copy selected valuable outputs to the global retained-files library, deduplicate them, and verify their hashes.
5. Move the conversation and its DSH-owned data to the Windows Recycle Bin.
6. Stop the operation if review, copying, validation, or ownership checks fail.

## Retained files and backups

The retained-files library is shared across the complete DSH environment rather than tied to one project. Each entry records its source conversation, source project, original path, preservation time, and content hash. Files can be restored, selected in batches, or moved to the Recycle Bin. Review reminders are displayed inside DSH.

Backups are independent of retained files. They can target a local folder or UNC/network path and can run manually, at a configured interval, or before a clean DSH shutdown. Version retention is configurable; expired backup sets are moved to the Recycle Bin.

## Data ownership

- Original source repositories and user-managed project folders are never cleanup targets.
- Native DSH archive state always takes precedence over plugin metadata.
- The retained-files library and backups remain on storage selected by the user.
- Retained files are a local safeguard, not a cloud backup service.

## Update and remove

```powershell
dsh plugin --profile web update dsh-conversation-archive
dsh plugin --profile web remove dsh-conversation-archive
```

Removing the plugin does not silently delete retained files or backups.

## Current scope

- Windows only.
- Retained-file reminders are shown inside DSH; system notifications are not included.
- Cloud-provider accounts are not connected directly. A locally synchronized or network folder can be used as a backup target.
- On DSH builds without a public destructive API, confirmed deletion is queued and completed at the next clean application start.

## Feedback

Bug reports and focused improvement proposals are welcome. Contact **yxv1203@gmail.com** or open a GitHub issue with the DSH version, plugin version, reproduction steps, and relevant logs.

## License

Released under the [MIT License](LICENSE).
