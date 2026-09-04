# DSH Workspace Manager 1.0.1

## English

This maintenance release fixes a cold-start dependency race and keeps the established feature set intact.

- Wait for DSH's `workspaces` service before applying the browser loader, fixing `cannot get property "workspaces" without inject` after a clean reboot.
- Add a real Cordis cold-start regression test and run it before the host integration suite.
- Remove two unused legacy helpers without changing runtime behavior or adding dependencies.
- Retain archive management, AI-assisted file preservation, local backups, update checks, and path-safety protections.

Validated with DSH 0.1.2-rc.1 on Windows. Compatibility remains declared from DSH 0.1.1-rc.2. Other DSH versions are not yet verified.

## 中文

本次维护版本修复冷启动依赖竞态，并完整保留原有功能。

- 浏览器端加载器在 DSH 的 `workspaces` 服务就绪后才启动，修复电脑重启后出现的 `cannot get property "workspaces" without inject`。
- 新增真实 Cordis 冷启动回归测试，并在宿主集成测试前执行。
- 删除两个无生产调用的旧辅助函数，不改变运行逻辑，也不增加依赖。
- 完整保留归档管理、AI 辅助文件保留、本地备份、更新检查与路径安全保护。

已在 Windows 和 DSH 0.1.2-rc.1 环境验证，兼容范围仍从 DSH 0.1.1-rc.2 起。其他 DSH 版本尚未验证。
