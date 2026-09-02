# DSH Workspace Manager

[English](README.md) · [简体中文](README.zh-CN.md) · [Releases](https://github.com/yxv1203-collab/dsh-conversation-archive/releases) · [Issues](https://github.com/yxv1203-collab/dsh-conversation-archive/issues)

Manage archived conversations, retain important files, and back up session data from the DeepSeek Harness settings interface.

## Features

| Area | Capabilities |
| --- | --- |
| Archive management | Search and filter by conversation type or project; unarchive or delete conversations individually or in batches. |
| File retention | Review candidate outputs with the DSH model before deletion; preserve verified copies in a shared library with deduplication, source tracking, restore, batch removal, and reminders. |
| Local backups | Manual, scheduled, and shutdown ZIP backups; local or network destinations; manifest and hash verification; configurable retention and restore to an empty folder. |
| Workspace support | Registered folders across Windows drives and independent projects; automatic registration of historical sessions; a stable shared file-library location across restarts. |
| Settings and diagnostics | Persistent preferences, in-app reminders, compatible-release notifications, and runtime diagnostics. Updates are not installed automatically. |

## Preview

![Archived conversations and retained files](docs/images/workspace-manager-overview.png)

<details>
<summary>Backup and settings</summary>

![Backup and settings](docs/images/backup-and-settings.png)

</details>

## Installation

Requires Windows 10 or 11, PowerShell 5.1+, and Node.js 20+ or the version required by DSH. Tested with DSH `0.1.1-rc.2`; other DSH versions are not yet verified.

```powershell
dsh plugin --profile web add github:yxv1203-collab/dsh-conversation-archive#v1.0.0
```

Restart DSH and open Settings → Workspace Manager. No workspace reorganization is required.

<details>
<summary>Offline installation and removal</summary>

Download the `.tgz` package and matching `.sha256` file from [Releases](https://github.com/yxv1203-collab/dsh-conversation-archive/releases/tag/v1.0.0). Compare the checksums before installing.

```powershell
Get-FileHash .\dsh-conversation-archive-1.0.0.tgz -Algorithm SHA256
Get-Content .\dsh-conversation-archive-1.0.0.tgz.sha256
dsh plugin --profile web add .\dsh-conversation-archive-1.0.0.tgz
```

To remove:

```powershell
dsh plugin --profile web remove dsh-conversation-archive
```

Restart DSH after installation or removal. Retained files and backups are preserved. To replace an earlier build with the same version number, remove it and install the current release package after verifying its checksum.

</details>

## Usage and data protection

- Archive state comes from DSH. The plugin manages already-archived conversations without creating a separate project structure.
- Deletion recycles the selected session's DSH data, not the original project folder or source files. File review and copy verification must succeed before protected deletion proceeds. On DSH `0.1.1-rc.2`, workspace-reference cleanup completes at the next normal startup.
- File review may send candidate content to the model provider configured in DSH. Retention is selective and does not replace a full project backup.
- Backups cover registered session data and retained files, not entire source repositories. Automatic backup is off by default; five verified backups are retained by default. Older backups are recycled only after a new backup is verified.
- Use accessible workspace subfolders, not drive or share roots. Restore never overwrites existing files. Network destinations require appropriate permissions and Recycle Bin support; cloud accounts are not connected directly.

<details>
<summary>Metadata not registered</summary>

The session does not yet have a valid workspace mapping. Startup and archive synchronization backfill mappings from DSH metadata. If the message persists, check workspace access and session metadata before relying on output protection or complete backups.

Restoring a retained file to its original location requires a recognized DSH workspace; otherwise, choose another destination.

</details>

## Contributing

Use [Issues](https://github.com/yxv1203-collab/dsh-conversation-archive/issues) for bug reports and feature requests, or contact [yxv1203@gmail.com](mailto:yxv1203@gmail.com). Include the DSH version, reproduction steps, and sanitized diagnostics. Run `npm test` with a compatible local DSH installation before submitting code changes.

## License

[MIT](LICENSE)
