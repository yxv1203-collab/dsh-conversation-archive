# DSH Workspace Manager 1.1.0

## English

This maintenance release fixes the package-source workflow that could block later pnpm operations and keeps the established feature set intact.

- Publish a stable GitHub-tag install path for v1.1.0, with no runtime dependencies or lifecycle scripts.
- Require offline release packages to be retained under `$DSH_HOME\profiles\web\deps\`, preventing a deleted download from breaking later pnpm installs.
- Add release-contract coverage that rejects disposable local-package installation instructions.
- Retain archive management, AI-assisted file preservation, local backups, update checks, and path-safety protections.

Validated with DSH 0.1.2-rc.1 on Windows. Compatibility remains declared from DSH 0.1.1-rc.2. Other DSH versions are not yet verified.

## 中文

本次维护版本修复会阻断后续 pnpm 操作的安装来源问题，并完整保留原有功能。

- 发布稳定的 v1.1.0 GitHub 标签安装来源，不增加运行时依赖或生命周期脚本。
- 离线安装包须保留在 `$DSH_HOME\profiles\web\deps\`，避免下载文件被删除后阻断后续 pnpm 安装。
- 新增发布契约检查，防止文档再次引导用户从临时本地路径安装。
- 完整保留归档管理、AI 辅助文件保留、本地备份、更新检查与路径安全保护。

已在 Windows 和 DSH 0.1.2-rc.1 环境验证，兼容范围仍从 DSH 0.1.1-rc.2 起。其他 DSH 版本尚未验证。
