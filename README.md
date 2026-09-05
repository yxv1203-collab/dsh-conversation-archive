# DSH Workspace Manager

[![Release](https://img.shields.io/github/v/release/yxv1203-collab/dsh-conversation-archive?display_name=tag)](https://github.com/yxv1203-collab/dsh-conversation-archive/releases/latest)
![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078D4)
[![License](https://img.shields.io/badge/license-MIT-2ea44f)](LICENSE)

[English](README.md) · [简体中文](README.zh-CN.md)

Native workspace governance for DeepSeek Harness (DSH), bringing archived-session management, pre-deletion protection for important outputs, and verifiable local backups into the Settings interface. The plugin keeps DSH as the source of truth for session state and uses strict path validation, content hashes, and fail-closed safeguards to reduce risk when cleaning up archived work.

## Features

- **Native archive management:** browse, search, and filter DSH-archived conversations, then restore or delete them individually or in batches. Archive state always comes from DSH rather than a parallel plugin index.
- **Protected output retention:** before deletion, the configured DSH model reviews eligible workspace outputs. Selected files are copied into a shared, deduplicated library and verified by content hash, with restore, batch removal, and in-app reminders built in.
- **Verified local backups:** create ZIP backups manually, on a schedule, or before a clean shutdown. Each backup carries a manifest and hashes, restores only into an empty destination, and never overwrites existing files. Automatic backup is off by default; five verified backups are retained by default.
- **Workspace and path safety:** support DSH-registered workspaces across drives and independent project directories, backfill historical mappings from native metadata, and reject traversal through junctions or symbolic links.

## Screenshots

![Archived conversations and retained files](docs/images/workspace-manager-overview.png)

![Local backup and plugin settings](docs/images/backup-and-settings.png)

## Requirements

| Component | Requirement |
| --- | --- |
| Operating system | Windows 10 or 11 |
| DSH | Tested with `0.1.1-rc.2` through `0.1.2-rc.1`; other versions are not yet verified |
| PowerShell | 5.1 or later |
| Node.js | 20 or later; also meet your DSH installation's requirements |
| Workspace | A readable and writable folder, not a drive or share root |

## Installation

### From GitHub

```powershell
dsh plugin --profile web add github:yxv1203-collab/dsh-conversation-archive#v1.1.0
```

Restart DSH, then open **Settings → Workspace Manager**.

### From a release package

Download `dsh-conversation-archive-1.1.0.tgz` and its `.sha256` file from [GitHub Releases](https://github.com/yxv1203-collab/dsh-conversation-archive/releases/tag/v1.1.0).

```powershell
Get-FileHash .\dsh-conversation-archive-1.1.0.tgz -Algorithm SHA256
Get-Content .\dsh-conversation-archive-1.1.0.tgz.sha256
```

Confirm the hashes match. For an offline installation, first copy the package to the profile's durable dependency directory, then install that retained copy:

```powershell
$profileDeps = Join-Path $env:DSH_HOME 'profiles\web\deps'
New-Item -ItemType Directory -Force $profileDeps | Out-Null
$profilePackage = Join-Path $profileDeps 'dsh-conversation-archive-1.1.0.tgz'
Copy-Item .\dsh-conversation-archive-1.1.0.tgz $profilePackage
dsh plugin --profile web add $profilePackage
```

Keep this retained `.tgz` for as long as the file-based installation remains in the profile. Deleting or moving it makes pnpm re-resolution fail during later plugin installs. Installing from the GitHub tag above avoids a disposable local-file dependency.

## Deletion and data protection

Unarchiving and deleting are separate operations. Deletion checks session ownership and paths, scans eligible outputs, asks the configured DSH model to assess their content, and verifies retained copies before recycling session data. Candidate file content may be sent to the model provider configured in DSH.

Original project folders and source files are not deletion targets. Review, copy, integrity, or path-validation failures stop the protected deletion workflow. AI retention is selective and does not replace a full project backup.

On supported DSH versions, session data is recycled while its archive marker remains in place. The next clean startup removes workspace references and finalizes deletion, preventing the conversation from reappearing in the active list.

## Workspaces and metadata

**Metadata not registered** means a native archived session has no valid plugin workspace mapping. Startup and archive synchronization backfill mappings from DSH session metadata. If the warning remains, check workspace access and session metadata; complete workspace-output protection and backups require a valid mapping.

Native session paths are independent of the shared storage root. The plugin can infer that root from a canonical daily workspace on first use and records it for subsequent starts. Existing mappings and retained files are not automatically relocated. Explicit `harnessRoot`, `DCA_HARNESS_ROOT`, or `DSH_HARNESS_ROOT` settings take precedence.

Restoring a retained file to its original location requires a recognized DSH workspace. Otherwise, select an alternate destination. Existing files are never overwritten, and paths that escape through junctions or symbolic links are rejected.

## Backup scope

Backups cover registered DSH session data and retained files, not entire source repositories. Targets may be local folders or supported network paths. Old backups are recycled only after the newest backup passes verification. Network availability, permissions, and Recycle Bin support depend on the destination.

Cloud accounts are not connected directly. External sync software may synchronize a backup folder. Reminders appear inside DSH, not as Windows notifications.

## Removal

```powershell
dsh plugin --profile web remove dsh-conversation-archive
```

Restart DSH after removal. Retained files and backups are preserved.

## Development

With a compatible DSH installation available locally:

```powershell
npm test
npm pack --dry-run --json
npm pack
```

Tests cover archive synchronization, historical metadata backfill, cross-drive path rules, retention, backups, deletion recovery, and release integrity.

## Support and license

Report issues through [GitHub Issues](https://github.com/yxv1203-collab/dsh-conversation-archive/issues) or contact **yxv1203@gmail.com**. Include DSH and plugin versions, reproduction steps, and sanitized diagnostics.

Licensed under [MIT](LICENSE).
