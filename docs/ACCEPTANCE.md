# 1.0.0 验收记录

验证环境：Windows、Node.js 24、DeepSeek Harness `0.1.1-rc.2`。所有自动化均使用临时目录或注入服务，不修改真实 DSH 会话、配置、保留文件或备份。

## 已自动验证

- Host 全量单元与真实 Cordis loader 集成测试；Client 原生设置契约与语法检查。
- 原生已归档 ID 是唯一列表来源，普通对话不出现；恢复写回并复验 DSH 原生状态。
- 原生归档后无需隐藏同步调用：后台/写前事务准备登记缓存；有公开删除 API 时即时回收。DSH `0.1.1-rc.2` 无公开删除 API 时，删除进入持久化队列、立即从插件列表隐藏并保留原生归档，下一次干净启动先回收精确会话目录再清除归档标记，回归测试确认不会复活。
- AI 保留文件复制、SHA-256 与索引先于回收；强制 AI/复制失败时零删除。
- 超大文本首/中/尾有界抽样与流式哈希；模型和附件服务支持时发送真实图片块，否则明确限定为元数据审核。
- 单项和批量写操作顺序执行；部分失败不伪报成功，持久化意图可在重启后安全收敛。
- `operations.jsonl` 对恢复、删除、保留、备份和保留文件回收追加脱敏审计，畸形尾部触发只读保护。
- 每会话项目/日常缓存隔离；最后一条日常会话删除只剪除空日期目录。
- 配置、映射、提醒、备份截止时间重启后保持；损坏状态零写入并进入只读保护。
- ZIP 备份清单/哈希/Zip Slip 校验、空目录恢复、keep-five、源目录重叠拒绝、周期重排，以及关闭/按天/退出前尽力备份模式。
- 安装 dry-run 会先验证真实 DSH 包/版本；覆盖中文/空格路径、重复安装、故障回滚、默认卸载保留数据、仅凭配置不得认领用户目录和带所有权证据的显式数据回收。
- 真实已安装 `dsh` CLI 在隔离 `DSH_HOME` 中完成 profile 初始化、插件 patch 组合和 `--dump-config` loader 健康检查。
- 真实隔离 web profile 完整启动后，`/conversation-archive-api?action=diagnostics` 返回插件 `1.0.0`、DSH `0.1.1-rc.2`、原生归档/恢复/会话定位均可用且非只读；`/plugins/dsh-conversation-archive/client.js` 返回 200 并包含“工作区管理”。随后已终止进程并删除临时 DSH_HOME。
- 真实隔离 web profile 通过 Chrome Headless/CDP 完成浏览器启动：DSH 没有显示“Failed to load plugins”，设置左侧出现“工作区管理”；点击后已渲染“已归档对话、保留文件、本地备份、插件设置”四张卡片。该回归同时验证安装 wrapper 的包名与 `__ModuleLoader__.load()` 注册 id 均为 `dsh-conversation-archive`，避免 client bundle 加载后未注册同名图节点。
- 更新检查的禁用、未配置、可更新、已最新、离线、超时、限流、恶意页面 URL 和 DSH/平台兼容性均使用注入 fetch 验证；不访问外网。
- 发布清单、MIT LICENSE、Host/Client 同版本、生产文件 SHA-256、确定性 ZIP、相邻校验和与 LF checkout 规则。

最终命令及结果应在发布提交执行并记录：

```text
npm --prefix host test                         PASS
npm --prefix host run check                    PASS
npm --prefix client test                       PASS
npm --prefix client run check                  PASS
scripts/test-installer.ps1                     PASS
scripts/build-release.ps1 (连续两次同哈希)     PASS
node scripts/verify-release.mjs                PASS
git diff --check                               PASS
```

## 建议的安装后人工视觉检查

在真实 DSH GUI 重启后打开“设置 → 工作区管理”，分别切换浅色、深色、跟随系统，确认四张卡片、五行滚动区、弹窗焦点和系统缩放显示无溢出。自动源码契约已确认全部颜色来自 DSH CSS 变量且未强制白色背景；不同机器的字体与系统缩放仍建议安装后快速目检。
