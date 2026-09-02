# DSH Workspace Manager 1.0.0

## English

This revision replaces the previous 1.0.0 release with the user-validated build. The version number remains 1.0.0; existing installations should reinstall the current package and verify its SHA-256 checksum.

- Automatically register historical sessions from DSH metadata.
- Support registered workspace folders across Windows drives and independent project directories.
- Preserve the shared retained-files location across restarts and workspace changes.
- Prevent deleted-session mappings from being recreated during startup recovery.
- Retain archive management, AI-assisted file preservation, local backups, and path-safety checks.
- Revise English and Chinese documentation with installation, compatibility, and data-protection guidance.

Validated with DSH 0.1.1-rc.2 on Windows. The full automated test suite passed, and the user reported no issues in local acceptance testing. Other DSH versions are not yet verified.

## 中文

本次以用户验收通过的构建替换原 1.0.0 发布，版本号保持 1.0.0。已安装旧构建的用户应重新安装当前发布包，并核对 SHA-256 校验值。

- 从 DSH 元数据自动补登记历史会话。
- 支持不同 Windows 磁盘及独立项目目录中的已登记工作区。
- 保持共享保留文件库的位置稳定，不因重启或切换工作区而改变。
- 防止启动恢复时重新生成已删除会话的映射。
- 保留归档管理、AI 辅助文件保留、本地备份与路径安全检查。
- 更新中英文文档，明确安装方式、兼容范围与数据保护边界。

已在 Windows 和 DSH 0.1.1-rc.2 环境验证，完整自动化测试通过，用户本机验收未发现问题。其他 DSH 版本尚未验证。
