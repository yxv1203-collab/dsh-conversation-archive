/** DSH-native settings section for the workspace manager. */
window.__ModuleLoader__.load({
  // The browser graph row is the installed wrapper package, not this source
  // directory.  DSH requires this id to be exactly that package name.
  id: 'dsh-conversation-archive',
  factory: (require) => {
    var module = { exports: {} }
    const React = require('react')
    const h = React.createElement
    const API = '/conversation-archive-api'
    let workspaceRuntime = null
    const css = [
      '.dwm{color:var(--dsh-fg,var(--foreground,inherit));font:inherit;line-height:1.45;max-width:980px;padding:2px 0 28px}',
      '.dwm-head,.dwm-actions,.dwm-row-actions,.dwm-status,.dwm-modal-actions{display:flex;gap:8px}.dwm-head{align-items:flex-start;justify-content:space-between;margin:0 0 20px}.dwm-title{font-size:20px;font-weight:650;margin:0}.dwm-sub,.dwm-note,.dwm-meta,.dwm-row-sub,.dwm-card-desc{color:var(--dsh-muted,var(--muted-foreground,rgba(127,127,127,.8)));font-size:13px}.dwm-sub{margin:4px 0 0}',
      '.dwm-card{background:var(--dsh-panel,var(--card,rgba(127,127,127,.035)));border:1px solid var(--dsh-border,var(--border,rgba(127,127,127,.18)));border-radius:16px;margin:0 0 14px;padding:17px}.dwm-card-h{align-items:start;display:grid;gap:12px;grid-template-columns:minmax(0,1fr) auto;margin-bottom:12px}.dwm-card-title{font-size:16px;font-weight:620}.dwm-card-desc{margin-top:2px}.dwm-actions,.dwm-row-actions{align-items:center;flex-wrap:wrap;justify-content:flex-end}.dwm-fields{align-items:end;display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(180px,1fr))}.dwm-toolbar{display:grid;gap:8px;grid-template-columns:minmax(220px,1fr) minmax(130px,auto) minmax(130px,auto);margin:2px 0 4px}',
      '.dwm-btn,.dwm-input,.dwm-select{background:transparent;border:1px solid var(--dsh-border,var(--border,rgba(127,127,127,.28)));border-radius:10px;box-sizing:border-box;color:inherit;font:inherit;font-size:13px;padding:7px 10px}.dwm-btn{cursor:pointer}.dwm-btn:hover{background:var(--dsh-hover,rgba(127,127,127,.1))}.dwm-btn:disabled{cursor:not-allowed;opacity:.5}.dwm-btn:focus-visible,.dwm-input:focus-visible,.dwm-select:focus-visible{outline:2px solid var(--dsh-focus,var(--primary,#5b8cff));outline-offset:2px}.dwm-primary{background:var(--dsh-primary,var(--primary,#5b8cff));border-color:var(--dsh-primary,var(--primary,#5b8cff));color:var(--dsh-primary-fg,#fff)}.dwm-danger{color:var(--dsh-danger,#c85252)}.dwm-danger-solid{background:var(--dsh-danger,#c85252);border-color:var(--dsh-danger,#c85252);color:#fff}.dwm-input,.dwm-select{max-width:100%;min-width:0;width:100%}.dwm-search{width:100%}.dwm-field{display:grid;gap:4px;min-width:0}.dwm-span-2{grid-column:span 2}.dwm-label{color:var(--dsh-muted,var(--muted-foreground,rgba(127,127,127,.8)));font-size:12px}.dwm-icon{align-items:center;display:inline-flex;height:34px;justify-content:center;padding:0;width:34px}.dwm-icon svg{height:17px;stroke:currentColor;width:17px}.dwm-reminder{align-items:center;display:flex;font-size:12px;gap:6px;white-space:nowrap}.dwm-reminder .dwm-input{padding:5px 7px;text-align:center;width:54px}.dwm-details{border-top:1px solid var(--dsh-border,var(--border,rgba(127,127,127,.16)));grid-column:1/-1;margin-top:2px;padding-top:10px}.dwm-details summary{cursor:pointer;font-size:13px}',
      '.dwm-list{border-top:1px solid var(--dsh-border,var(--border,rgba(127,127,127,.16)));margin-top:13px;max-height:275px;overflow-y:auto}.dwm-row{align-items:center;border-bottom:1px solid var(--dsh-border,var(--border,rgba(127,127,127,.13)));display:grid;gap:10px;grid-template-columns:auto minmax(0,1fr) auto;min-height:55px;padding:8px 1px}.dwm-row-main{min-width:0}.dwm-row-title{font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dwm-row-sub{margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dwm-row-source{margin-top:6px;max-width:360px}.dwm-badge{background:var(--dsh-hover,rgba(127,127,127,.12));border-radius:999px;font-size:11px;padding:2px 7px;white-space:nowrap}.dwm-check{height:16px;width:16px}.dwm-empty{color:var(--dsh-muted,var(--muted-foreground,rgba(127,127,127,.8)));font-size:13px;padding:8px 0}',
      '.dwm-alert{background:rgba(91,140,255,.1);border:1px solid rgba(91,140,255,.28);border-radius:10px;font-size:13px;margin:0 0 14px;padding:10px 12px}.dwm-message{font-size:13px;margin:0 0 14px}.dwm-error{color:var(--dsh-danger,#c85252)}.dwm-status{align-items:center}.dwm-dot{background:#50a26b;border-radius:50%;height:8px;width:8px}.dwm-dot.off{background:#d29a47}',
      '.dwm-modal-backdrop{align-items:center;background:rgba(0,0,0,.38);display:flex;inset:0;justify-content:center;padding:20px;position:fixed;z-index:1000}.dwm-modal{background:var(--dsh-dialog,var(--card,#202124));border:1px solid var(--dsh-border,var(--border,rgba(127,127,127,.3)));border-radius:16px;box-shadow:0 18px 54px rgba(0,0,0,.25);max-width:500px;padding:20px;width:100%}.dwm-modal h2{font-size:17px;margin:0 0 8px}.dwm-modal p{color:var(--dsh-muted,var(--muted-foreground,rgba(127,127,127,.8)));font-size:13px;margin:0 0 14px}.dwm-modal-actions{justify-content:flex-end;margin-top:16px}.dwm-modal-list{border:1px solid var(--dsh-border,var(--border,rgba(127,127,127,.2)));border-radius:9px;max-height:180px;overflow-y:auto}.dwm-modal-item{border-bottom:1px solid var(--dsh-border,var(--border,rgba(127,127,127,.13)));font-size:12px;padding:8px}.dwm-modal-item:last-child{border-bottom:0}@media(max-width:760px){.dwm-toolbar,.dwm-card-h,.dwm-fields{grid-template-columns:1fr}.dwm-card-h .dwm-actions{justify-content:flex-start}.dwm-row{align-items:start;grid-template-columns:auto minmax(0,1fr)}.dwm-row-actions{grid-column:2;justify-content:flex-start}.dwm-span-2{grid-column:auto}}',
    ].join('')

    function apiError(body) { return body?.error?.message || body?.error?.code || '请求失败' }
    function get(action) {
      return fetch(`${API}?action=${encodeURIComponent(action)}`, { credentials: 'same-origin' }).then(async (response) => {
        const body = await response.json().catch(() => null)
        if (!response.ok || !body?.ok) throw new Error(apiError(body))
        return body.result
      })
    }
    function post(action, payload, csrfToken) {
      return fetch(`${API}?action=${encodeURIComponent(action)}`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Conversation-Archive-Csrf': csrfToken },
        body: JSON.stringify(payload || {}),
      }).then(async (response) => {
        const body = await response.json().catch(() => null)
        if (!response.ok || !body?.ok) throw new Error(apiError(body))
        return body.result
      })
    }
    function formatDate(value) { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString() : '—' }
    function formatSize(bytes) { const size = Number(bytes) || 0; return size >= 1048576 ? `${(size / 1048576).toFixed(1)} MB` : size >= 1024 ? `${Math.ceil(size / 1024)} KB` : `${size} B` }
    function labels(item) { return `${item.projectLabel || (item.kind === 'project' ? '项目' : '日常对话')} · ${item.tag || item.id} · ${item.date || '日期未知'}` }
    function updateLabel(value) {
      const labels = { disabled: '已关闭', checking: '检查中', unconfigured: '未配置发布源', current: '已是最新版本', available: `发现 ${value?.latestVersion || '新版本'}`, 'rate-limited': 'GitHub 限流，稍后重试', timeout: '检查超时', offline: '当前离线', 'http-error': '发布服务暂不可用', 'invalid-response': '发布信息无效', 'compatibility-unknown': '新版本兼容性未验证', 'incompatible-release': '新版本与当前 DSH 不兼容', 'incompatible-platform': '当前系统不受支持', 'incompatible-dsh': '当前 DSH 版本不受支持' }
      return labels[value?.state] || '状态未知'
    }

    function ConfirmDialog({ dialog, busy, onCancel, onConfirm }) {
      const cancelRef = React.useRef(null), confirmRef = React.useRef(null)
      React.useEffect(() => { if (dialog) cancelRef.current?.focus() }, [dialog])
      if (!dialog) return null
      const trap = (event) => {
        if (event.key === 'Escape' && !busy) { event.preventDefault(); onCancel(); return }
        if (event.key !== 'Tab') return
        const first = cancelRef.current, last = confirmRef.current
        if (event.shiftKey && event.target === first) { event.preventDefault(); last?.focus() }
        if (!event.shiftKey && event.target === last) { event.preventDefault(); first?.focus() }
      }
      const targetList = dialog.targets ? h('div', null,
        h('div', { className: 'dwm-label' }, `删除清单（${dialog.targets.length} 项）`),
        h('div', { className: 'dwm-modal-list' }, dialog.targets.map((item) => h('div', { className: 'dwm-modal-item', key: item.id },
          h('div', null, item.targetLabel || item.tag || item.id),
          h('div', { className: 'dwm-meta' }, item.targetMeta || `${labels(item)} · ${item.mappingError ? '本地元数据未登记' : item.cachePhase || '仅原生归档'}`),
        ))),
      ) : null
      return h('div', { className: 'dwm-modal-backdrop', onMouseDown: (event) => { if (event.target === event.currentTarget && !busy) onCancel() } },
        h('div', { className: 'dwm-modal', role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'dwm-dialog-title', onKeyDown: trap },
          h('h2', { id: 'dwm-dialog-title' }, dialog.title), h('p', null, dialog.description),
          dialog.summary ? h('div', { className: 'dwm-alert' }, dialog.summary) : null,
          targetList,
          h('div', { className: 'dwm-modal-actions' }, h('button', { ref: cancelRef, type: 'button', className: 'dwm-btn', disabled: busy, onClick: onCancel }, '取消'), h('button', { ref: confirmRef, type: 'button', className: `dwm-btn ${dialog.danger ? 'dwm-danger-solid' : 'dwm-primary'}`, disabled: busy, onClick: onConfirm }, busy ? '处理中…' : dialog.confirm)),
        ),
      )
    }
    function Card({ title, description, actions, children }) {
      return h('section', { className: 'dwm-card', 'aria-label': title }, h('div', { className: 'dwm-card-h' }, h('div', null, h('div', { className: 'dwm-card-title' }, title), description ? h('div', { className: 'dwm-card-desc' }, description) : null), actions ? h('div', { className: 'dwm-actions' }, actions) : null), children)
    }

    function WorkspaceSettings() {
      const [state, setState] = React.useState({ loading: true, error: '', status: null, archived: [], retained: [], backups: [], diagnostics: null })
      const [selected, setSelected] = React.useState({}), [selectedRetained, setSelectedRetained] = React.useState({}), [retainedSource, setRetainedSource] = React.useState({}), [query, setQuery] = React.useState(''), [archiveKindFilter, setArchiveKindFilter] = React.useState('all'), [archiveProjectFilter, setArchiveProjectFilter] = React.useState('all'), [busy, setBusy] = React.useState(false), [message, setMessage] = React.useState(''), [dialog, setDialog] = React.useState(null)
      const [backupTarget, setBackupTarget] = React.useState(''), [backupMode, setBackupMode] = React.useState('off'), [backupDays, setBackupDays] = React.useState(0), [backupKeep, setBackupKeep] = React.useState(5), [reminderDays, setReminderDays] = React.useState(1), [auditCount, setAuditCount] = React.useState(40), [retentionEnabled, setRetentionEnabled] = React.useState(true), [candidateBytes, setCandidateBytes] = React.useState(8388608), [excerptChars, setExcerptChars] = React.useState(3000), [retentionTimeout, setRetentionTimeout] = React.useState(20000), [updateCheckEnabled, setUpdateCheckEnabled] = React.useState(true)
      const [backupScope, setBackupScope] = React.useState('all'), [backupScopeId, setBackupScopeId] = React.useState('')
      const retainedRef = React.useRef(null), triggerRef = React.useRef(null)
      const applySettings = (settings = {}) => {
        setReminderDays(Number(settings.remindIntervalDays ?? settings.remind?.intervalDays) || 1)
        setBackupDays(settings.backup?.enabled ? Number(settings.backup.autoIntervalDays) || 0 : 0)
        setBackupMode(settings.backup?.mode || 'off')
        setBackupKeep(Number(settings.backup?.keepCount) || 5)
        setAuditCount(Number(settings.retention?.maxCandidates) || 40)
        setRetentionEnabled(settings.retention?.enabled !== false)
        setCandidateBytes(Number(settings.retention?.maxCandidateBytes) || 8388608)
        setExcerptChars(Number(settings.retention?.maxExcerptChars) || 3000)
        setRetentionTimeout(Number(settings.retention?.timeoutMs) || 20000)
        setUpdateCheckEnabled(settings.updateCheck?.enabled !== false)
      }
      const refresh = React.useCallback(async () => {
        setState((current) => ({ ...current, loading: !current.status, error: '' }))
        try {
          const status = await get('status')
          const [archived, retained, backups, diagnostics] = await Promise.all(['archived', 'retained', 'backups', 'diagnostics'].map(get))
          setState({ loading: false, error: '', status, archived, retained, backups, diagnostics })
          applySettings(status.settings)
        } catch (error) { setState((current) => ({ ...current, loading: false, error: error.message || '加载失败' })) }
      }, [])
      React.useEffect(() => { void refresh(); const poll = setInterval(() => { void refresh() }, 30_000); return () => clearInterval(poll) }, [refresh])
      const mutate = async (action, payload, { refreshAfter = true, clearSelection = false } = {}) => {
        if (!state.status?.csrfToken || busy) return null
        setBusy(true); setMessage('')
        try {
          const result = await post(action, payload, state.status.csrfToken)
          if (Array.isArray(result)) {
            const failed = result.filter((item) => !item.ok)
            const pendingRestart = result.filter((item) => item.ok && item.result?.pendingRestart).length
            setMessage(failed.length ? `已完成 ${result.length - failed.length} 项；失败：${failed.map((item) => `${item.id}（${item.result?.reason || 'operation-failed'}）`).join('、')}` : pendingRestart ? `${pendingRestart} 项已加入安全删除队列；重启 DSH 后完成回收。` : `已完成 ${result.length} 项操作。`)
            if (clearSelection && !failed.length) setSelected({})
          } else if (!result?.ok) setMessage(`操作未完成（${result?.reason || 'operation-failed'}）`)
          else {
            if (action === 'saveConfig' && result.config) applySettings(result.config)
            setMessage(result.pendingRestart ? '已加入安全删除队列；重启 DSH 后完成回收，不会重新出现在归档列表。' : '操作完成。'); if (clearSelection) setSelected({})
          }
          if (refreshAfter) await refresh()
          return result
        } catch (error) { setMessage(`操作失败：${error.message || '未知错误'}`); return null } finally { setBusy(false) }
      }
      const disabled = busy || !state.status?.csrfToken || state.status.writesDisabled
      const projectOptions = [...new Set(state.archived.filter((item) => item.kind === 'project').map((item) => item.projectLabel || '项目'))].sort((a, b) => a.localeCompare(b, 'zh-CN'))
      const archived = state.archived.filter((item) => {
        const matchesQuery = `${item.tag || ''} ${item.id} ${item.projectLabel || ''} ${item.date || ''}`.toLowerCase().includes(query.trim().toLowerCase())
        const matchesKind = archiveKindFilter === 'all' || item.kind === archiveKindFilter
        const project = item.kind === 'project' ? item.projectLabel || '项目' : ''
        const matchesProject = archiveProjectFilter === 'all' || (archiveProjectFilter === 'none' ? !project : project === archiveProjectFilter)
        return matchesQuery && matchesKind && matchesProject
      })
      const selectedIds = archived.filter((item) => selected[item.id]).map((item) => item.id)
      const retainedSelectedIds = state.retained.filter((item) => selectedRetained[item.id]).map((item) => item.id)
      const backupChoices = backupScope === 'retained' ? state.retained : [...(state.status?.managed || []), ...state.archived].filter((item, index, rows) => rows.findIndex((row) => row.id === item.id) === index && (backupScope !== 'project' || item.kind === 'project'))
      const openDialog = (value, event) => { triggerRef.current = event?.currentTarget || null; setDialog(value) }
      const closeDialog = () => { setDialog(null); setTimeout(() => triggerRef.current?.focus(), 0) }
      const toggle = (id) => setSelected((current) => ({ ...current, [id]: !current[id] }))
      const toggleAll = () => setSelected((current) => archived.reduce((next, item) => ({ ...next, [item.id]: !archived.every((row) => current[row.id]) }), {}))
      const toggleRetained = (id) => setSelectedRetained((current) => ({ ...current, [id]: !current[id] }))
      const toggleRetainedAll = () => setSelectedRetained((current) => state.retained.reduce((next, item) => ({ ...next, [item.id]: !state.retained.every((row) => current[row.id]) }), {}))
      const showDelete = async (ids, event) => {
        const targets = ids.map((id) => state.archived.find((item) => item.id === id) || { id, tag: id, mappingError: '当前列表已变化' })
        if (!state.status?.csrfToken || busy) return
        setBusy(true); setMessage('')
        let preview
        try { preview = await post('deletePreview', { ids }, state.status.csrfToken) }
        catch (error) { setMessage(`无法生成删除预览：${error.message || '未知错误'}`); return }
        finally { setBusy(false) }
        const types = preview.candidateTypes?.length ? preview.candidateTypes.join('、') : '无'
        openDialog({ title: ids.length > 1 ? `删除 ${ids.length} 段已归档对话？` : '删除这段已归档对话？', description: '系统会先从原生工作区自动保留重要产出，再将 DSH 对话数据移入 Windows 回收站；旧版本已登记的缓存会一并安全清理。当前 DSH 版本可能在下次启动时完成最终回收。', summary: `本地候选 ${preview.candidateCount} 个（${types}）`, confirm: '确认删除', danger: true, targets, run: () => mutate(ids.length > 1 ? 'deleteMany' : 'delete', ids.length > 1 ? { ids } : { id: ids[0] }, { clearSelection: ids.length > 1 }) }, event)
      }
      const commitDialog = async () => { const active = dialog; if (!active) return; await active.run(); closeDialog() }
      const deleteRetainedMany = async (ids) => {
        if (!state.status?.csrfToken || busy) return
        setBusy(true); setMessage('')
        const results = []
        try {
          for (const id of ids) {
            try { const result = await post('retainedDelete', { id, wholeFile: true }, state.status.csrfToken); results.push({ id, ok: !!result?.ok }) }
            catch (error) { results.push({ id, ok: false, reason: error.message || 'operation-failed' }) }
          }
          const failed = results.filter((item) => !item.ok)
          setMessage(failed.length ? `已删除 ${results.length - failed.length} 项；${failed.length} 项失败。` : `已将 ${results.length} 个保留文件移入回收站。`)
          setSelectedRetained((current) => Object.fromEntries(Object.entries(current).filter(([id]) => failed.some((item) => item.id === id))))
          await refresh()
        } finally { setBusy(false) }
      }
      const showRetainedDelete = (ids, event) => openDialog({ title: ids.length > 1 ? `移除 ${ids.length} 个保留文件？` : '移除保留文件？', description: '所选文件及来源记录将移入 Windows 回收站，不影响 DSH 原生会话或工作区文件。', confirm: ids.length > 1 ? '批量移入回收站' : '移入回收站', danger: true, targets: ids.map((id) => { const item = state.retained.find((row) => row.id === id); return { id, targetLabel: item?.displayName || id, targetMeta: item ? `${formatSize(item.size)} · ${item.sources?.length || 0} 个来源` : '当前列表已变化' } }), run: () => deleteRetainedMany(ids) }, event)
      const save = (payload) => mutate('saveConfig', payload)
      const runBackup = () => {
        const selection = backupScope === 'all' ? { type: 'all' } : { type: backupScope, ids: backupScopeId ? [backupScopeId] : [] }
        if (selection.type !== 'all' && !selection.ids.length) { setMessage('请选择需要备份的受管项目、会话或保留文件。'); return }
        void mutate('backup', { selection })
      }

      const archiveRows = archived.map((item) => h('div', { className: 'dwm-row', key: item.id },
        h('input', { className: 'dwm-check', type: 'checkbox', checked: !!selected[item.id], disabled, 'aria-label': `选择 ${item.tag || item.id}`, onChange: () => toggle(item.id) }),
        h('div', { className: 'dwm-row-main' }, h('div', { className: 'dwm-row-title' }, item.tag || item.id), h('div', { className: 'dwm-row-sub' }, `${labels(item)} · ${item.cachePhase || '仅原生归档'}`)),
        h('div', { className: 'dwm-row-actions' },
          item.mappingError ? h('span', { className: 'dwm-badge', title: item.mappingError }, '元数据未登记') : null,
          h('button', { type: 'button', className: 'dwm-btn dwm-icon', disabled, 'aria-label': '取消归档', title: '取消归档', onClick: () => void mutate('restore', { id: item.id }) }, h('svg', { viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true }, h('path', { d: 'M9 14 4 9l5-5M4 9h10a6 6 0 0 1 6 6v1', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }))),
          h('button', { type: 'button', className: 'dwm-btn dwm-danger', disabled, onClick: (event) => void showDelete([item.id], event) }, '删除'),
        ),
      ))
      const retainedRows = state.retained.map((item) => {
        const provenanceId = retainedSource[item.id] || item.sources?.[0]?.id || ''
        return h('div', { className: 'dwm-row', key: item.id },
        h('input', { className: 'dwm-check', type: 'checkbox', checked: !!selectedRetained[item.id], disabled, 'aria-label': `选择保留文件 ${item.displayName}`, onChange: () => toggleRetained(item.id) }),
        h('div', { className: 'dwm-row-main' }, h('div', { className: 'dwm-row-title' }, item.displayName), h('div', { className: 'dwm-row-sub' }, `${formatSize(item.size)} · ${item.aiReason || 'AI 建议保留'}`),
          item.sources?.length ? h('select', { className: 'dwm-select dwm-row-source', value: provenanceId, disabled, 'aria-label': `选择 ${item.displayName} 的恢复来源`, onChange: (event) => setRetainedSource((current) => ({ ...current, [item.id]: event.target.value })) }, item.sources.map((source) => h('option', { key: source.id, value: source.id }, `${source.projectLabel || '日常对话'} · ${source.conversationLabel || '来源未知'} · ${source.originalLocation || '原位置未知'}`))) : null),
        h('div', { className: 'dwm-row-actions' },
          h('span', { className: 'dwm-badge' }, `${item.sources?.length || 0} 个来源`),
          h('button', { type: 'button', className: 'dwm-btn', disabled, onClick: () => void mutate('retainedRestore', { id: item.id, provenanceId }) }, '恢复原位'),
          h('button', { type: 'button', className: 'dwm-btn', disabled: disabled || typeof workspaceRuntime?.pickDirectory !== 'function', onClick: async () => { const targetDir = await workspaceRuntime.pickDirectory(); if (targetDir) void mutate('retainedRestore', { id: item.id, provenanceId, targetDir }) } }, '恢复到…'),
          h('button', { type: 'button', className: 'dwm-btn dwm-danger', disabled, onClick: (event) => showRetainedDelete([item.id], event) }, '删除'),
        ),
      ) })
      const backupRows = state.backups.map((item) => h('div', { className: 'dwm-row', key: item.id },
        h('div', { className: 'dwm-row-main' }, h('div', { className: 'dwm-row-title' }, formatDate(item.createdAt)), h('div', { className: 'dwm-row-sub' }, `${item.fileCount || 0} 个文件 · ${formatSize(item.byteSize)}`)),
        h('div', { className: 'dwm-row-actions' }, h('button', { type: 'button', className: 'dwm-btn', disabled: disabled || typeof workspaceRuntime?.pickDirectory !== 'function', onClick: async (event) => { const targetDir = await workspaceRuntime.pickDirectory(); if (targetDir) openDialog({ title: '恢复此备份', description: '恢复前会验证备份完整性，并仅写入选定的空文件夹。', confirm: '开始恢复', run: () => mutate('backupRestore', { id: item.id, targetDir }) }, event) } }, '恢复')),
      ))

      return h('div', { className: 'dwm' },
        h('style', null, css),
        h('div', { className: 'dwm-head' }, h('div', null, h('h1', { className: 'dwm-title' }, '工作区管理'), h('p', { className: 'dwm-sub' }, '统一管理 DSH 原生归档对话、重要文件保留和本地备份。')), h('button', { type: 'button', className: 'dwm-btn', disabled: busy, onClick: () => void refresh(), 'aria-label': '刷新工作区管理状态' }, state.loading ? '加载中…' : '刷新')),
        state.error ? h('div', { className: 'dwm-message dwm-error', role: 'status' }, `无法加载工作区状态：${state.error}`) : null,
        message ? h('div', { className: 'dwm-message', role: 'status' }, message) : null,
        state.status?.reminder?.due ? h('div', { className: 'dwm-alert' }, `${state.status.reminder.count} 个保留文件等待检查。`, h('button', { type: 'button', className: 'dwm-btn', disabled, onClick: () => { retainedRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); void mutate('retentionReminderSeen', {}) } }, '查看保留文件')) : null,
        state.status?.pendingDeletionCount ? h('div', { className: 'dwm-alert' }, `${state.status.pendingDeletionCount} 项安全删除将在下次 DSH 启动时继续；若已在 DSH 中恢复，对应删除意图会自动取消。`) : null,
        h(Card, { title: '已归档对话', description: '管理 DSH 原生已归档对话。', actions: h('div', { className: 'dwm-actions' }, h('button', { type: 'button', className: 'dwm-btn', disabled: disabled || !archived.length, onClick: toggleAll }, archived.length && archived.every((item) => selected[item.id]) ? '取消全选' : '全选'), h('button', { type: 'button', className: 'dwm-btn', disabled: disabled || !selectedIds.length, onClick: () => void mutate('restoreMany', { ids: selectedIds }, { clearSelection: true }) }, `批量恢复${selectedIds.length ? ` (${selectedIds.length})` : ''}`), h('button', { type: 'button', className: 'dwm-btn dwm-danger', disabled: disabled || !selectedIds.length, onClick: (event) => void showDelete(selectedIds, event) }, `批量删除${selectedIds.length ? ` (${selectedIds.length})` : ''}`)) },
          h('div', { className: 'dwm-toolbar' },
            h('input', { className: 'dwm-input dwm-search', value: query, placeholder: '搜索已归档对话', 'aria-label': '搜索归档对话', onChange: (event) => setQuery(event.target.value) }),
            h('select', { className: 'dwm-select', value: archiveKindFilter, 'aria-label': '对话类型', onChange: (event) => setArchiveKindFilter(event.target.value) }, [['all', '全部对话'], ['daily', '日常对话'], ['project', '项目对话']].map(([value, label]) => h('option', { key: value, value }, label))),
            h('select', { className: 'dwm-select', value: archiveProjectFilter, 'aria-label': '项目筛选', onChange: (event) => setArchiveProjectFilter(event.target.value) }, h('option', { value: 'all' }, '所有项目'), h('option', { value: 'none' }, '无项目'), projectOptions.map((project) => h('option', { key: project, value: project }, project))),
          ), archived.length ? h('div', { className: 'dwm-list' }, archiveRows) : h('div', { className: 'dwm-empty' }, state.loading ? '正在读取 DSH 原生归档…' : '没有符合条件的已归档对话。')),
        h('div', { ref: retainedRef }, h(Card, { title: '保留文件', description: '自动保存删除对话前识别的重要产出。', actions: h('div', { className: 'dwm-actions' }, h('label', { className: 'dwm-reminder', title: '保留文件检查提醒间隔（1–365 天）' }, h('span', null, '提醒'), h('input', { className: 'dwm-input', type: 'number', min: 1, max: 365, value: reminderDays, disabled, 'aria-label': '提醒间隔天数', onChange: (event) => setReminderDays(Number(event.target.value)), onBlur: () => { if (Number.isInteger(reminderDays) && reminderDays >= 1 && reminderDays <= 365) void save({ remind: { intervalDays: reminderDays } }) } }), h('span', null, '天')), h('span', { className: 'dwm-badge' }, `${state.retained.length} 项`), h('button', { type: 'button', className: 'dwm-btn', disabled: disabled || !state.retained.length, onClick: toggleRetainedAll }, state.retained.length && state.retained.every((item) => selectedRetained[item.id]) ? '取消全选' : '全选'), h('button', { type: 'button', className: 'dwm-btn dwm-danger', disabled: disabled || !retainedSelectedIds.length, onClick: (event) => showRetainedDelete(retainedSelectedIds, event) }, `批量移入回收站${retainedSelectedIds.length ? ` (${retainedSelectedIds.length})` : ''}`)) }, state.retained.length ? h('div', { className: 'dwm-list' }, retainedRows) : h('div', { className: 'dwm-empty' }, '暂无保留文件。'))),
        h(Card, { title: '本地备份', description: '备份受管数据到本地或网络目录。', actions: h('button', { type: 'button', className: 'dwm-btn dwm-primary', disabled: disabled || !state.status?.settings?.backup?.configured || (backupScope !== 'all' && !backupScopeId), onClick: runBackup }, '立即备份') },
          h('div', { className: 'dwm-fields' },
            h('label', { className: 'dwm-field dwm-span-2' },
              h('span', { className: 'dwm-label' }, `备份目录${state.status?.settings?.backup?.targetLabel ? `（${state.status.settings.backup.targetLabel}）` : ''}`),
              h('div', { className: 'dwm-actions' },
                h('input', { className: 'dwm-input', value: backupTarget, placeholder: state.status?.settings?.backup?.configured ? '已配置；选择新目录可更换' : '例如 D:\\DSH Backups 或网络磁盘目录', disabled, onChange: (event) => setBackupTarget(event.target.value), onBlur: () => { if (backupTarget.trim()) void save({ backup: { targetDir: backupTarget.trim() } }) } }),
                h('button', { type: 'button', className: 'dwm-btn', disabled: disabled || typeof workspaceRuntime?.pickDirectory !== 'function', onClick: async () => { const targetDir = await workspaceRuntime.pickDirectory(); if (targetDir) { setBackupTarget(targetDir); void save({ backup: { targetDir } }) } } }, '选择…'),
                state.status?.settings?.backup?.configured ? h('button', { type: 'button', className: 'dwm-btn dwm-danger', disabled, onClick: () => { setBackupTarget(''); void save({ backup: { targetDir: '', mode: 'off', enabled: false } }) } }, '清除') : null,
              ),
            ),
            h('label', { className: 'dwm-field' }, h('span', { className: 'dwm-label' }, '备份范围'), h('select', { className: 'dwm-select', value: backupScope, disabled, onChange: (event) => { setBackupScope(event.target.value); setBackupScopeId('') } }, [['all', '全部受管数据'], ['session', '单个对话数据'], ['project', '单个项目会话数据'], ['retained', '单个保留文件']].map(([type, label]) => h('option', { key: type, value: type }, label)))),
            backupScope !== 'all' ? h('label', { className: 'dwm-field' }, h('span', { className: 'dwm-label' }, '备份对象'), h('select', { className: 'dwm-select', value: backupScopeId, disabled, onChange: (event) => setBackupScopeId(event.target.value) }, h('option', { value: '' }, '请选择…'), backupChoices.map((item) => h('option', { key: item.id, value: item.id }, item.displayName || item.tag || item.id)))) : null,
            h('label', { className: 'dwm-field' }, h('span', { className: 'dwm-label' }, '自动备份'), h('select', { className: 'dwm-select', value: backupMode, disabled, onChange: (event) => { const mode = event.target.value; const days = mode === 'periodic' ? (backupDays || 1) : backupDays; setBackupMode(mode); if (mode === 'periodic') setBackupDays(days); void save({ backup: { mode, enabled: mode !== 'off', autoIntervalDays: days } }) } }, h('option', { value: 'off' }, '关闭'), h('option', { value: 'periodic' }, '按天周期'), h('option', { value: 'shutdown' }, '关闭 DSH 前（尽力完成）'))),
            backupMode === 'periodic' ? h('label', { className: 'dwm-field' }, h('span', { className: 'dwm-label' }, '间隔（1–365 天）'), h('input', { className: 'dwm-input', type: 'number', min: 1, max: 365, value: backupDays, disabled, onChange: (event) => setBackupDays(Number(event.target.value)), onBlur: () => { if (Number.isInteger(backupDays) && backupDays >= 1 && backupDays <= 365) void save({ backup: { mode: 'periodic', enabled: true, autoIntervalDays: backupDays } }) } })) : null,
            h('label', { className: 'dwm-field' }, h('span', { className: 'dwm-label' }, '保留版本'), h('select', { className: 'dwm-select', value: backupKeep, disabled, onChange: (event) => { const keepCount = Number(event.target.value); setBackupKeep(keepCount); void save({ backup: { keepCount } }) } }, [3, 5, 10, 20].map((count) => h('option', { key: count, value: count }, `${count} 个`)))),
          ), h('div', { className: 'dwm-note' }, `上次结果：${state.status?.settings?.backup?.lastResult ? (state.status.settings.backup.lastResult.ok ? '成功' : `失败（${state.status.settings.backup.lastResult.reason || '未知原因'}）`) : '暂无'} · 下次备份：${state.status?.settings?.backup?.nextBackupAt ? formatDate(state.status.settings.backup.nextBackupAt) : '未安排'}`), state.backups.length ? h('div', { className: 'dwm-list' }, backupRows) : h('div', { className: 'dwm-empty' }, '暂无已验证备份。先设置备份目录后即可创建。')),
        h(Card, { title: '插件设置' }, h('div', { className: 'dwm-fields' },
          h('label', { className: 'dwm-field' }, h('span', { className: 'dwm-label' }, '重要文件 AI 保留'), h('select', { className: 'dwm-select', value: retentionEnabled ? 'on' : 'off', disabled, onChange: (event) => { const enabled = event.target.value === 'on'; setRetentionEnabled(enabled); void save({ retention: { enabled } }) } }, h('option', { value: 'on' }, '启用'), h('option', { value: 'off' }, '关闭'))),
          h('label', { className: 'dwm-field' }, h('span', { className: 'dwm-label' }, '更新检查'), h('select', { className: 'dwm-select', value: updateCheckEnabled ? 'on' : 'off', disabled, onChange: (event) => { const enabled = event.target.value === 'on'; setUpdateCheckEnabled(enabled); void save({ updateCheck: { enabled } }) } }, h('option', { value: 'on' }, '检查并提示发布版更新'), h('option', { value: 'off' }, '关闭检查'))),
          h('div', { className: 'dwm-field' }, h('span', { className: 'dwm-label' }, '版本状态'), h('span', { className: 'dwm-note' }, updateLabel(state.status?.updateCheck)), state.status?.updateCheck?.state === 'available' && state.status.updateCheck.pageUrl ? h('a', { className: 'dwm-btn', href: state.status.updateCheck.pageUrl, target: '_blank', rel: 'noopener noreferrer' }, '查看发布页') : null),
          h('div', { className: 'dwm-field' }, h('span', { className: 'dwm-label' }, '兼容性与诊断'), h('div', { className: 'dwm-status' }, h('span', { className: `dwm-dot ${state.diagnostics?.writesDisabled ? 'off' : ''}` }), h('span', { className: 'dwm-meta' }, state.diagnostics ? `DSH ${state.diagnostics.dshVersion || '未知'} · ${state.diagnostics.adapter?.restoreMode || 'compatibility'} · ${state.diagnostics.writesDisabled ? '只读保护中' : '可写入'} · 最近操作 ${state.diagnostics.operations?.records?.length || 0} 条` : '正在读取诊断状态…'), h('button', { type: 'button', className: 'dwm-btn', disabled: !state.diagnostics || !navigator.clipboard?.writeText, onClick: async () => { await navigator.clipboard.writeText(JSON.stringify(state.diagnostics, null, 2)); setMessage('诊断信息已复制。') } }, '复制诊断'))),
          h('details', { className: 'dwm-details' }, h('summary', null, '高级 AI 审核参数'), h('div', { className: 'dwm-fields' },
            h('label', { className: 'dwm-field' }, h('span', { className: 'dwm-label' }, 'AI 审核候选上限（每批 1–100）'), h('input', { className: 'dwm-input', type: 'number', min: 1, max: 100, value: auditCount, disabled, onChange: (event) => setAuditCount(Number(event.target.value)), onBlur: () => { if (Number.isInteger(auditCount) && auditCount >= 1 && auditCount <= 100) void save({ retention: { maxCandidates: auditCount } }) } })),
            h('label', { className: 'dwm-field' }, h('span', { className: 'dwm-label' }, '单文件内容上限'), h('input', { className: 'dwm-input', type: 'number', min: 1, max: 67108864, value: candidateBytes, disabled, onChange: (event) => setCandidateBytes(Number(event.target.value)), onBlur: () => { if (Number.isInteger(candidateBytes) && candidateBytes >= 1 && candidateBytes <= 67108864) void save({ retention: { maxCandidateBytes: candidateBytes } }) } })),
            h('label', { className: 'dwm-field' }, h('span', { className: 'dwm-label' }, '文本抽样字符'), h('input', { className: 'dwm-input', type: 'number', min: 100, max: 10000, value: excerptChars, disabled, onChange: (event) => setExcerptChars(Number(event.target.value)), onBlur: () => { if (Number.isInteger(excerptChars) && excerptChars >= 100 && excerptChars <= 10000) void save({ retention: { maxExcerptChars: excerptChars } }) } })),
            h('label', { className: 'dwm-field' }, h('span', { className: 'dwm-label' }, 'AI 超时（毫秒）'), h('input', { className: 'dwm-input', type: 'number', min: 1000, max: 120000, value: retentionTimeout, disabled, onChange: (event) => setRetentionTimeout(Number(event.target.value)), onBlur: () => { if (Number.isInteger(retentionTimeout) && retentionTimeout >= 1000 && retentionTimeout <= 120000) void save({ retention: { timeoutMs: retentionTimeout } }) } }))
          )))),
        h(ConfirmDialog, { dialog, busy, onCancel: closeDialog, onConfirm: () => void commitDialog() }),
      )
    }
    function apply(ctx) {
      const slots = ctx.get('slots')
      if (!slots) return
      workspaceRuntime = ctx.get('workspaces') || ctx.workspaces || null
      slots.inject('settings.section', () => slots.register({ name: 'settings.section', id: 'workspace-manager', order: 90, label: () => '工作区管理' }, WorkspaceSettings))
    }
    module.exports = { name: 'conversation-archive-client', inject: ['slots'], apply }
    return module.exports
  },
})
