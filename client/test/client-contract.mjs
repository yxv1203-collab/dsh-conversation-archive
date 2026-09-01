import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')
const packageJson = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'))
const registration = source.match(/__ModuleLoader__\.load\(\{\s*[\s\S]*?\bid:\s*['"]([^'"]+)['"]/)

assert.ok(registration, 'registers a ModuleLoader id')
assert.equal(registration[1], packageJson.name, 'ModuleLoader id matches the installed client package name')

for (const label of ['工作区管理', '已归档对话', '保留文件', '本地备份', '插件设置']) {
  assert.match(source, new RegExp(label), `missing ${label}`)
}

assert.match(source, /slots\.inject\("settings\.section"|slots\.inject\('settings\.section'/, 'registers native settings section')
assert.match(source, /id:\s*['"]workspace-manager['"]/, 'uses stable settings section id')
assert.doesNotMatch(source, /window\.(?:confirm|alert|prompt)\s*\(/, 'uses an in-page modal')
assert.doesNotMatch(source, /X-Conversation-Archive['\"]?\s*:\s*['\"]dsh['\"]|Authorization\s*:/, 'does not use legacy fixed authentication')
assert.doesNotMatch(source, /fetch\([^)]*\?action=(?:restore|delete|restoreMany|deleteMany|retainedRestore|retainedDelete|backup|backupRestore|saveConfig)/, 'does not issue destructive GET')
assert.match(source, /function post\(/, 'centralizes JSON POST writes')
assert.match(source, /x-conversation-archive-csrf/i, 'uses bootstrapped CSRF token')
assert.match(source, /setInterval\(/, 'refreshes native truth only while the settings page is mounted')
assert.match(source, /max-height:\s*(?:2[67]\d|28[0-9])px/, 'limits list card to five scrolling rows')
assert.match(source, /overflow-y:\s*auto/, 'scrolls long lists internally')
assert.match(source, /var\(--/, 'uses DSH theme variables')
assert.doesNotMatch(source, /background:\s*(?:#fff|white)(?:;|\})/i, 'does not force a white shell')
assert.match(source, /role:\s*['"]dialog['"]/, 'marks the modal as a dialog')
assert.match(source, /['\"]aria-modal['\"]:\s*true/, 'marks the modal modal')
assert.match(source, /aria-label/, 'labels icon-only controls')
for (const action of ['status', 'archived', 'retained', 'backups', 'diagnostics', 'restore', 'delete', 'restoreMany', 'deleteMany', 'deletePreview', 'retainedRestore', 'retainedDelete', 'retentionReminderSeen', 'backup', 'backupRestore', 'saveConfig']) {
  assert.match(source, new RegExp(`['\"]${action}['\"]`), `uses API action ${action}`)
}
assert.match(source, /提醒间隔|查看保留文件/, 'groups reminder with retained files')
for (const label of ['全部对话', '日常对话', '项目对话', '所有项目', '无项目']) {
  assert.match(source, new RegExp(label), `offers archive filter ${label}`)
}
assert.match(source, /archiveKindFilter[\s\S]*archiveProjectFilter|archiveProjectFilter[\s\S]*archiveKindFilter/, 'combines chat-kind and project filters')
assert.match(source, /['"]aria-label['"]:\s*['"]取消归档['"][\s\S]{0,160}title:\s*['"]取消归档['"]|title:\s*['"]取消归档['"][\s\S]{0,160}['"]aria-label['"]:\s*['"]取消归档['"]/, 'uses an accessible icon-only unarchive control')
assert.match(source, /retainedSelectedIds/, 'tracks selected retained files independently')
assert.match(source, /toggleRetainedAll/, 'supports selecting all visible retained files')
assert.match(source, /批量移入回收站/, 'offers retained-file bulk deletion')
assert.match(source, /retainedDelete[\s\S]{0,180}wholeFile:\s*true/, 'bulk retained deletion uses the safe ID-only delete API')
assert.match(source, /dwm-reminder/, 'keeps the reminder interval compact in the retained-card header')
assert.match(source, /自动备份|备份目录|保留版本/, 'groups schedule with backups')
assert.match(source, /type:\s*['"]number['"][\s\S]{0,100}max:\s*365/, 'accepts arbitrary supported reminder and backup intervals')
assert.match(source, /workspaces|workspaceRuntime/, 'uses the native DSH workspace service')
assert.match(source, /pickDirectory/, 'uses the native DSH directory picker instead of free-text-only paths')
assert.match(source, /本地候选.*candidateCount|candidateCount.*本地候选/, 'delete confirmation reports scanned candidate counts and types')
for (const setting of ['重要文件 AI 保留', 'AI 审核候选上限', '单文件内容上限', '文本抽样字符', 'AI 超时']) {
  assert.match(source, new RegExp(setting), `shows configurable setting ${setting}`)
}
assert.doesNotMatch(source, /工作区根目录|请先.*文件夹|预先.*目录/, 'does not expose obsolete folder prerequisites or absolute workspace paths')
assert.match(source, /\.dwm-fields\{[^}]*display:grid/, 'uses a responsive grid for aligned settings fields')
assert.match(source, /dwm-row-actions/, 'groups row actions so long retained-file metadata cannot displace controls')
assert.doesNotMatch(source, /\[restoreTarget,\s*setRestoreTarget\]|恢复目录（空文件夹）/, 'asks for a restore destination only when the user starts restoring a backup')
assert.match(source, /backupRestore[\s\S]{0,900}pickDirectory|pickDirectory[\s\S]{0,900}backupRestore/, 'uses the native folder picker in the backup restore flow')
assert.match(source, /settings\?\.backup.*autoIntervalDays|settings\.backup\.autoIntervalDays/, 'hydrates backup controls from safe status settings')
assert.match(source, /settings\?\.updateCheck|settings\.updateCheck/, 'hydrates the update-check toggle from safe status settings')
assert.match(source, /updateCheck:\s*\{\s*enabled/, 'persists update-check preference through the config API')
assert.match(source, /版本状态/, 'shows update-check status')
assert.match(source, /noopener noreferrer/, 'opens only the server-validated release page safely')
assert.match(source, /\['session',\s*'单个对话数据'\]/, 'offers native DSH session-data backup scope')
assert.match(source, /\['project',\s*'单个项目会话数据'\]/, 'offers project-associated session-data backup scope')
assert.match(source, /\['retained',\s*'单个保留文件'\]/, 'offers a retained-file backup scope')
assert.match(source, /删除清单|系统会先自动保留重要产出/, 'discloses all deletion targets and automatic retention')
for (const mode of ['关闭', '按天周期', '关闭 DSH 前（尽力完成）']) assert.match(source, new RegExp(mode), 'offers backup mode ' + mode)
assert.match(source, /上次结果.*下次备份/, 'shows backup outcome and next run')
assert.match(source, /h\(['"]details['"]/, 'collapses advanced AI settings')
assert.match(source, /retainedSource[\s\S]*provenanceId/, 'lets users choose retained-file provenance for restore')
assert.match(source, /if\s*\(backupTarget\.trim\(\)\)[\s\S]*targetDir:\s*''/, 'does not clear a hidden backup path on blur and offers explicit clearing')
assert.match(source, /mode === ['"]periodic['"][\s\S]*backupDays \|\| 1[\s\S]*autoIntervalDays:\s*days/, 'persists a valid default interval when periodic mode is selected')
assert.match(source, /pendingDeletionCount/, 'surfaces queued deletion state')
assert.doesNotMatch(source, /恢复[^。；]*自动取消/, 'confirmed deletion is never described as a reversible unarchive action')
assert.match(source, /移除工作区引用/, 'explains the restart-only native index finalization')
assert.match(source, /projectLabel.*项目|项目.*projectLabel/, 'uses safe project labels in archived-session disclosure')
assert.doesNotMatch(source, /单个对话缓存|单个项目缓存|专属缓存移入/, 'does not describe native DSH data as plugin-created caches')
assert.match(source, /event\.key !== 'Tab'[\s\S]{0,240}preventDefault/, 'traps Tab focus inside confirmation dialogs')
assert.match(source, /triggerRef.*focus|trigger.*focus/, 'restores focus to the invoking control after a dialog closes')
assert.equal(packageJson.scripts?.test, 'node test/client-contract.mjs', 'exposes client contract test')

console.log('client contract checks passed')
