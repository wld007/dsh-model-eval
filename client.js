window.__ModuleLoader__.load({
  id: 'dsh-model-eval',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef } = React
    const CHANNEL = '/model-eval'
    const PANEL_ID = 'model-eval'
    const services = { ctx: null }

    const ZH = {
      panel: '模型评测',
      intro: '在数据集上评测一个或多个已配置的模型，自动打分并生成排行榜与报告。也可以在聊天里对 Agent 说「评测某个数据集」，或使用 /eval 命令。',
      'models.title': '已配置模型',
      'models.empty': '还没有配置模型。请在 profile 的 cordis.patch.yml 中给 model-eval 的 config.models 添加模型（id / baseURL / model / apiKeyEnv），然后在插件页停用再启用。',
      'models.check': '检测连通',
      'models.checking': '检测中…',
      'models.local': '本地/内网',
      'models.remote': '外部',
      'models.ok': '连通',
      'models.notServed': '连通，但端点未列出该模型',
      'models.fail': '不可用',
      'models.localOnly': '已开启 localOnly：只允许本地/内网端点。',
      'new.title': '新建评测',
      'new.dataset': '数据集路径（jsonl / json / csv / tsv）',
      'new.example': '使用示例数据集',
      'new.models': '模型',
      'new.scorer': '评分器',
      'new.limit': '只评测前 N 条（可选）',
      'new.sensitive': '敏感数据（只用本地/内网模型，报告不含原文）',
      'new.start': '开始评测',
      'new.started': '已启动批次 {id}',
      'runs.title': '评测批次',
      'runs.empty': '还没有评测批次。',
      'runs.refresh': '刷新',
      'col.time': '时间',
      'col.dataset': '数据集',
      'col.status': '状态',
      'col.progress': '进度',
      'col.best': '排行榜',
      'detail.back': '返回列表',
      'detail.cancel': '取消',
      'detail.resume': '续跑',
      'detail.leaderboard': '排行榜',
      'detail.model': '模型',
      'detail.mean': '平均分',
      'detail.acc': '准确率',
      'detail.done': '完成',
      'detail.errors': '错误',
      'detail.p50': 'p50 延迟',
      'detail.tokens': 'Token',
      'detail.report': '报告',
      'detail.reportPending': '批次完成或取消后生成报告。',
      'detail.dir': '输出目录',
      'status.running': '运行中',
      'status.completed': '已完成',
      'status.cancelled': '已取消',
      'status.failed': '失败',
    }
    const EN = {
      panel: 'Model Eval',
      intro: 'Evaluate one or more configured models on a dataset, score automatically, and get a leaderboard and report. You can also ask the agent or use the /eval command.',
      'models.title': 'Configured models',
      'models.empty': 'No models configured. Add models to config.models of model-eval in the profile cordis.patch.yml (id / baseURL / model / apiKeyEnv), then disable and re-enable the plugin.',
      'models.check': 'Check connectivity',
      'models.checking': 'Checking…',
      'models.local': 'local/intranet',
      'models.remote': 'external',
      'models.ok': 'reachable',
      'models.notServed': 'reachable, model not listed',
      'models.fail': 'unavailable',
      'models.localOnly': 'localOnly is on: only local/intranet endpoints are allowed.',
      'new.title': 'New evaluation',
      'new.dataset': 'Dataset path (jsonl / json / csv / tsv)',
      'new.example': 'Use example dataset',
      'new.models': 'Models',
      'new.scorer': 'Scorer',
      'new.limit': 'First N samples only (optional)',
      'new.sensitive': 'Sensitive data (local/intranet models only, no sample text in reports)',
      'new.start': 'Start',
      'new.started': 'Started run {id}',
      'runs.title': 'Runs',
      'runs.empty': 'No runs yet.',
      'runs.refresh': 'Refresh',
      'col.time': 'Time',
      'col.dataset': 'Dataset',
      'col.status': 'Status',
      'col.progress': 'Progress',
      'col.best': 'Leaderboard',
      'detail.back': 'Back to runs',
      'detail.cancel': 'Cancel',
      'detail.resume': 'Resume',
      'detail.leaderboard': 'Leaderboard',
      'detail.model': 'Model',
      'detail.mean': 'Mean score',
      'detail.acc': 'Accuracy',
      'detail.done': 'Done',
      'detail.errors': 'Errors',
      'detail.p50': 'p50 latency',
      'detail.tokens': 'Tokens',
      'detail.report': 'Report',
      'detail.reportPending': 'The report is written when the run completes or is cancelled.',
      'detail.dir': 'Output directory',
      'status.running': 'Running',
      'status.completed': 'Completed',
      'status.cancelled': 'Cancelled',
      'status.failed': 'Failed',
    }

    function t(key, vars) {
      const dict = services.ctx?.locale?.getLocale?.().active === 'zh' ? ZH : EN
      const template = dict[key] ?? EN[key] ?? key
      if (!vars) return template
      return template.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ''))
    }

    function call(endpoint, payload) {
      const connection = services.ctx?.get('connection')
      if (!connection?.rpc) return Promise.reject(new Error('connection unavailable'))
      return connection.rpc.call(CHANNEL, endpoint, payload ?? {}).then((response) => {
        if (!response || response.ok !== true) throw new Error(response?.error?.message ?? 'RPC failed')
        return response.value
      })
    }

    const errText = (cause) => String(cause?.message ?? cause)
    const pct = (v) => `${((v ?? 0) * 100).toFixed(1)}%`
    const fmtTime = (v) => { if (!v) return '—'; try { return new Date(v).toLocaleString() } catch { return String(v) } }
    const statusLabel = (s) => t(`status.${s}`) === `status.${s}` ? String(s ?? '') : t(`status.${s}`)
    const chipClass = (s) => `me-chip ${s === 'completed' ? 'me-ok' : s === 'running' ? 'me-run' : 'me-bad'}`

    const CSS = `
      .me-page{height:100%;overflow:auto;box-sizing:border-box;padding:28px 32px 40px;color:var(--dsw-alias-label-primary)}
      .me-inner{max-width:980px;margin:0 auto;display:flex;flex-direction:column;gap:14px}
      .me-h1{margin:0;font-size:20px;line-height:28px;font-weight:600;display:flex;align-items:center;gap:8px}
      .me-intro{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
      .me-card{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:14px 16px;display:flex;flex-direction:column;gap:10px;background:var(--dsw-alias-bg-layer-1)}
      .me-card-head{display:flex;align-items:center;gap:10px;justify-content:space-between}
      .me-h2{margin:0;font-size:14px;font-weight:600}
      .me-row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end}
      .me-field{display:flex;flex-direction:column;gap:5px;font-size:12px;color:var(--dsw-alias-label-secondary);min-width:0}
      .me-grow{flex:1 1 320px}
      .me-input,.me-select{height:30px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);padding:0 9px;font:inherit;font-size:13px;min-width:0;box-sizing:border-box}
      .me-input:focus-visible,.me-select:focus-visible,.me-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-alias-brand-primary);outline-offset:1px}
      .me-check{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:var(--dsw-alias-label-primary);cursor:pointer}
      .me-btn{height:30px;padding:0 12px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}
      .me-btn:hover{background:var(--dsw-alias-bg-overlay)}
      .me-btn:disabled{opacity:.5;cursor:default}
      .me-btn.me-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
      .me-link{background:none;border:0;padding:0;font:inherit;font-size:12px;color:var(--dsw-alias-brand-primary);cursor:pointer}
      .me-hint{font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary)}
      .me-error{color:var(--dsw-alias-state-error-primary)}
      .me-success{color:var(--dsw-alias-state-success-primary)}
      .me-warn{color:var(--dsw-alias-state-warn-primary)}
      .me-table{width:100%;border-collapse:collapse;font-size:13px}
      .me-table th{text-align:left;font-weight:500;font-size:12px;color:var(--dsw-alias-label-secondary);padding:5px 8px;border-bottom:1px solid var(--dsw-alias-border-l2)}
      .me-table td{padding:7px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:middle}
      .me-table tr.me-click{cursor:pointer}
      .me-table tr.me-click:hover td{background:var(--dsw-alias-bg-layer-2)}
      .me-num{text-align:right;font-variant-numeric:tabular-nums}
      .me-chip{display:inline-block;font-size:11px;line-height:18px;padding:0 7px;border-radius:9px;border:1px solid currentColor}
      .me-chip.me-ok{color:var(--dsw-alias-state-success-primary)}
      .me-chip.me-run{color:var(--dsw-alias-brand-primary)}
      .me-chip.me-bad{color:var(--dsw-alias-state-error-primary)}
      .me-models{display:flex;flex-direction:column;gap:6px}
      .me-model{display:flex;align-items:center;gap:8px;font-size:13px;flex-wrap:wrap}
      .me-mono{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;color:var(--dsw-alias-label-secondary);word-break:break-all}
      .me-bar{position:relative;height:8px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);min-width:120px;overflow:hidden}
      .me-bar>span{position:absolute;inset:0 auto 0 0;border-radius:4px;background:var(--dsw-alias-brand-primary)}
      .me-progress{height:4px;border-radius:2px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
      .me-progress>span{display:block;height:100%;background:var(--dsw-alias-brand-primary);transition:width .3s}
      .me-report{margin:0;white-space:pre-wrap;word-break:break-word;font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:18px;max-height:560px;overflow:auto;padding:12px;border-radius:8px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l1)}
    `

    function EvalIcon({ size = 16 }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
      },
      h('path', { d: 'M4 20h16' }),
      h('rect', { x: 5.5, y: 11, width: 3.2, height: 6.5, rx: 0.8 }),
      h('rect', { x: 10.4, y: 6.5, width: 3.2, height: 11, rx: 0.8 }),
      h('rect', { x: 15.3, y: 9, width: 3.2, height: 8.5, rx: 0.8 }),
      h('path', { d: 'M10.6 3.6l1.4 1.4 2.6-2.6' }))
    }

    function ModelsCard({ info, onReload }) {
      const [ping, setPing] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const check = async () => {
        setBusy(true); setError('')
        try { setPing(new Map((await call('ping')).results.map((r) => [r.id, r]))) } catch (cause) { setError(errText(cause)) }
        setBusy(false)
      }
      const models = info?.models ?? []
      return h('section', { className: 'me-card' },
        h('div', { className: 'me-card-head' },
          h('h2', { className: 'me-h2' }, t('models.title')),
          h('div', { className: 'me-row' },
            h('button', { type: 'button', className: 'me-btn', onClick: onReload }, t('runs.refresh')),
            models.length > 0 && h('button', { type: 'button', className: 'me-btn', disabled: busy, onClick: check }, busy ? t('models.checking') : t('models.check')))),
        models.length === 0
          ? h('div', { className: 'me-hint' }, t('models.empty'))
          : h('div', { className: 'me-models' }, models.map((m) => {
            const p = ping?.get(m.id)
            return h('div', { key: m.id, className: 'me-model' },
              h('b', {}, m.id),
              h('span', { className: 'me-mono' }, `${m.model} @ ${m.baseURL}`),
              h('span', { className: 'me-chip me-run' }, m.local ? t('models.local') : t('models.remote')),
              p && h('span', { className: p.ok ? (p.served ? 'me-hint me-success' : 'me-hint me-warn') : 'me-hint me-error' },
                p.ok ? (p.served ? t('models.ok') : t('models.notServed')) : `${t('models.fail')}: ${p.error}`))
          })),
        info?.localOnly && h('div', { className: 'me-hint me-warn' }, t('models.localOnly')),
        (info?.warnings ?? []).map((w, i) => h('div', { key: i, className: 'me-hint me-warn' }, w)),
        error && h('div', { className: 'me-hint me-error' }, error))
    }

    function NewRunCard({ info, onStarted }) {
      const models = info?.models ?? []
      const [dataset, setDataset] = useState('')
      const [selected, setSelected] = useState(null)
      const [scorer, setScorer] = useState('auto')
      const [limit, setLimit] = useState('')
      const [sensitive, setSensitive] = useState(false)
      const [busy, setBusy] = useState(false)
      const [msg, setMsg] = useState(null)
      const chosen = selected ?? new Set(info?.defaultModels?.length ? info.defaultModels : models.map((m) => m.id))
      const toggle = (id) => {
        const next = new Set(chosen)
        if (next.has(id)) next.delete(id); else next.add(id)
        setSelected(next)
      }
      const start = async () => {
        setBusy(true); setMsg(null)
        try {
          const value = await call('start', { dataset: dataset.trim(), models: [...chosen], scorer, limit: Number(limit) || undefined, sensitive })
          setMsg({ ok: true, text: t('new.started', { id: value.runId }) })
          onStarted(value.runId)
        } catch (cause) { setMsg({ ok: false, text: errText(cause) }) }
        setBusy(false)
      }
      return h('section', { className: 'me-card' },
        h('h2', { className: 'me-h2' }, t('new.title')),
        h('div', { className: 'me-row' },
          h('label', { className: 'me-field me-grow' }, t('new.dataset'),
            h('input', { className: 'me-input', value: dataset, placeholder: '/path/to/dataset.jsonl', onChange: (e) => setDataset(e.target.value) })),
          info?.examplePath && h('button', { type: 'button', className: 'me-btn', onClick: () => setDataset(info.examplePath) }, t('new.example'))),
        models.length > 0 && h('div', { className: 'me-field' }, t('new.models'),
          h('div', { className: 'me-row' }, models.map((m) => h('label', { key: m.id, className: 'me-check' },
            h('input', { type: 'checkbox', checked: chosen.has(m.id), onChange: () => toggle(m.id) }), m.id)))),
        h('div', { className: 'me-row' },
          h('label', { className: 'me-field' }, t('new.scorer'),
            h('select', { className: 'me-select', value: scorer, onChange: (e) => setScorer(e.target.value) },
              (info?.scorers ?? ['auto']).map((s) => h('option', { key: s, value: s }, s)))),
          h('label', { className: 'me-field' }, t('new.limit'),
            h('input', { className: 'me-input', type: 'number', min: 1, value: limit, style: { width: 140 }, onChange: (e) => setLimit(e.target.value) })),
          h('label', { className: 'me-check', style: { height: 30 } },
            h('input', { type: 'checkbox', checked: sensitive, onChange: (e) => setSensitive(e.target.checked) }), t('new.sensitive'))),
        h('div', { className: 'me-row', style: { alignItems: 'center' } },
          h('button', { type: 'button', className: 'me-btn me-primary', disabled: busy || !dataset.trim() || chosen.size === 0, onClick: start }, t('new.start')),
          msg && h('span', { className: `me-hint ${msg.ok ? 'me-success' : 'me-error'}` }, msg.text)))
    }

    function RunsCard({ runs, onOpen, onRefresh }) {
      return h('section', { className: 'me-card' },
        h('div', { className: 'me-card-head' },
          h('h2', { className: 'me-h2' }, t('runs.title')),
          h('button', { type: 'button', className: 'me-btn', onClick: onRefresh }, t('runs.refresh'))),
        runs.length === 0
          ? h('div', { className: 'me-hint' }, t('runs.empty'))
          : h('table', { className: 'me-table' },
            h('thead', {}, h('tr', {},
              h('th', {}, t('col.time')), h('th', {}, t('col.dataset')), h('th', {}, t('col.status')),
              h('th', {}, t('col.progress')), h('th', {}, t('col.best')))),
            h('tbody', {}, runs.map((run) => h('tr', { key: run.id, className: 'me-click', onClick: () => onOpen(run.id) },
              h('td', {}, fmtTime(run.startedAt)),
              h('td', {}, `${run.dataset}（${run.samples}）`),
              h('td', {}, h('span', { className: chipClass(run.status) }, statusLabel(run.status))),
              h('td', { className: 'me-num' }, `${run.progress?.done ?? 0}/${run.progress?.planned ?? 0}`),
              h('td', {}, (run.leaderboard ?? []).slice(0, 3).map((row) => `${row.id} ${pct(row.meanScore)}`).join('，') || (run.models ?? []).join('、')))))))
    }

    function RunDetail({ runId, onBack, onChanged }) {
      const [run, setRun] = useState(null)
      const [report, setReport] = useState(null)
      const [error, setError] = useState('')
      const load = useCallback(async () => {
        try {
          const value = await call('status', { runId })
          setRun(value.run)
          if (value.run && value.run.status !== 'running') {
            call('report', { runId }).then((r) => setReport(r.markdown)).catch(() => setReport(null))
          }
          return value.run
        } catch (cause) { setError(errText(cause)); return null }
      }, [runId])
      useEffect(() => {
        let stopped = false
        let timer = null
        const tick = async () => {
          const current = await load()
          if (!stopped && current?.status === 'running') timer = setTimeout(tick, 1500)
          else if (!stopped) onChanged()
        }
        tick()
        return () => { stopped = true; if (timer) clearTimeout(timer) }
      }, [load])
      const act = async (endpoint, payload) => {
        setError('')
        try { await call(endpoint, payload); setTimeout(() => load(), 300); onChanged() } catch (cause) { setError(errText(cause)) }
      }
      if (!run) return h('section', { className: 'me-card' }, h('button', { type: 'button', className: 'me-link', onClick: onBack }, `← ${t('detail.back')}`), error && h('div', { className: 'me-hint me-error' }, error))
      const done = run.progress?.done ?? 0
      const planned = run.progress?.planned ?? 0
      const best = Math.max(0.0001, ...run.models.map((m) => m.meanScore ?? 0))
      const sorted = [...run.models].sort((a, b) => (b.meanScore ?? 0) - (a.meanScore ?? 0))
      return h(React.Fragment, {},
        h('section', { className: 'me-card' },
          h('div', { className: 'me-card-head' },
            h('button', { type: 'button', className: 'me-link', onClick: onBack }, `← ${t('detail.back')}`),
            h('div', { className: 'me-row' },
              run.status === 'running' && h('button', { type: 'button', className: 'me-btn', onClick: () => act('cancel', { runId }) }, t('detail.cancel')),
              (run.status === 'cancelled' || run.status === 'failed') && h('button', { type: 'button', className: 'me-btn', onClick: () => act('start', { resumeRunId: runId }) }, t('detail.resume')))),
          h('div', { className: 'me-row', style: { alignItems: 'center' } },
            h('b', {}, run.id),
            h('span', { className: chipClass(run.status) }, statusLabel(run.status)),
            h('span', { className: 'me-hint' }, `${run.dataset?.name ?? ''}（${run.dataset?.samples ?? 0}） · ${run.config?.scorer ?? ''}${run.config?.sensitive ? ' · sensitive' : ''} · ${fmtTime(run.startedAt)}`)),
          h('div', { className: 'me-progress', role: 'progressbar', 'aria-valuenow': done, 'aria-valuemax': planned },
            h('span', { style: { width: `${planned ? (100 * done) / planned : 0}%` } })),
          h('div', { className: 'me-hint' }, `${done}/${planned}${run.progress?.errors ? ` · ${t('detail.errors')} ${run.progress.errors}` : ''}`),
          run.error && h('div', { className: 'me-hint me-error' }, run.error),
          (run.warnings ?? []).map((w, i) => h('div', { key: i, className: 'me-hint me-warn' }, w)),
          error && h('div', { className: 'me-hint me-error' }, error)),
        h('section', { className: 'me-card' },
          h('h2', { className: 'me-h2' }, t('detail.leaderboard')),
          h('table', { className: 'me-table' },
            h('thead', {}, h('tr', {},
              h('th', {}, '#'), h('th', {}, t('detail.model')), h('th', { style: { width: '30%' } }, t('detail.mean')),
              h('th', { className: 'me-num' }, t('detail.acc')), h('th', { className: 'me-num' }, t('detail.done')),
              h('th', { className: 'me-num' }, t('detail.errors')), h('th', { className: 'me-num' }, t('detail.p50')),
              h('th', { className: 'me-num' }, t('detail.tokens')))),
            h('tbody', {}, sorted.map((m, i) => h('tr', { key: m.id },
              h('td', {}, i + 1),
              h('td', {}, h('b', {}, m.id)),
              h('td', {}, h('div', { className: 'me-row', style: { alignItems: 'center', flexWrap: 'nowrap' } },
                h('div', { className: 'me-bar', style: { flex: 1 } }, h('span', { style: { width: `${(100 * (m.meanScore ?? 0)) / best}%` } })),
                h('span', { className: 'me-num', style: { minWidth: 52 } }, pct(m.meanScore)))),
              h('td', { className: 'me-num' }, pct(m.accuracy)),
              h('td', { className: 'me-num' }, `${m.completed}/${m.planned}`),
              h('td', { className: 'me-num' }, m.errors ?? 0),
              h('td', { className: 'me-num' }, m.latency?.p50 != null ? `${m.latency.p50} ms` : '—'),
              h('td', { className: 'me-num' }, m.tokens ? `${m.tokens.prompt ?? 0} / ${m.tokens.completion ?? 0}` : '—')))))),
        h('section', { className: 'me-card' },
          h('h2', { className: 'me-h2' }, t('detail.report')),
          run.runDir && h('div', { className: 'me-hint' }, `${t('detail.dir')}: `, h('span', { className: 'me-mono' }, run.runDir)),
          report ? h('pre', { className: 'me-report' }, report) : h('div', { className: 'me-hint' }, t('detail.reportPending'))))
    }

    function EvalPage() {
      const [, setLocaleTick] = useState(0)
      const [info, setInfo] = useState(null)
      const [runs, setRuns] = useState([])
      const [openId, setOpenId] = useState(null)
      const [error, setError] = useState('')
      const mounted = useRef(true)
      useEffect(() => {
        mounted.current = true
        const unsubscribe = services.ctx?.locale?.subscribe?.(() => setLocaleTick((n) => n + 1))
        return () => { mounted.current = false; unsubscribe?.() }
      }, [])
      const loadInfo = useCallback(() => call('models').then((v) => mounted.current && setInfo(v)).catch((c) => mounted.current && setError(errText(c))), [])
      const loadRuns = useCallback(() => call('list').then((v) => mounted.current && setRuns(v.runs ?? [])).catch((c) => mounted.current && setError(errText(c))), [])
      useEffect(() => { loadInfo(); loadRuns() }, [])
      return h('div', { className: 'me-page' },
        h('style', {}, CSS),
        h('div', { className: 'me-inner' },
          h('h1', { className: 'me-h1' }, h(EvalIcon, { size: 20 }), t('panel')),
          h('p', { className: 'me-intro' }, t('intro')),
          error && h('div', { className: 'me-hint me-error' }, error),
          openId
            ? h(RunDetail, { key: openId, runId: openId, onBack: () => { setOpenId(null); loadRuns() }, onChanged: loadRuns })
            : h(React.Fragment, {},
              h(ModelsCard, { info, onReload: () => { setError(''); loadInfo() } }),
              h(NewRunCard, { info, onStarted: (id) => { loadRuns(); setOpenId(id) } }),
              h(RunsCard, { runs, onOpen: setOpenId, onRefresh: loadRuns }))))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        services.ctx = ctx
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, EvalPage))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: () => t('panel'),
        }, EvalIcon))
      },
    }
  },
})
