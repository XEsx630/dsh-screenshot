// dsh-screenshot — WeChat-style screenshot for the DeepSeek Harness composer (Client half).
//
// Adds a "截图" button beside the composer controls. Clicking it offers two
// modes: capture the screen directly, or hide the DSH window first and then
// capture. A full-screen overlay shows the captured frame with a dim mask;
// drag to select a rectangle (WeChat style), then confirm. Cropping happens
// SERVER-SIDE (host PowerShell) — the browser only sends the display-space
// rectangle plus the rendered stage size. The finished PNG is stored as a
// regular upload and attached to the message as a hidden input reference
// (source "screenshot"), serialized to `截图：<path>` on submit, so the model
// receives the path and reads the image with the local vision MCP.
//
// Client entries must register via window.__ModuleLoader__.load({ id, factory });
// the factory receives a synchronous `require` and returns module exports.
window.__ModuleLoader__.load({
  id: 'dsh-screenshot',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const API_PATH = '/api/screenshot'
    const SOURCE = 'screenshot'
    const HIDDEN_LABEL = '__dsh_screenshot_hidden__:'

    function errorMessage(error) {
      return error instanceof Error ? error.message : String(error)
    }

    async function responseJson(response) {
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
      return body
    }

    async function captureShot(hideWindow) {
      return responseJson(
        await fetch(`${API_PATH}/capture`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ hideWindow: hideWindow === true }),
        }),
      )
    }

    function deleteShot(id) {
      return fetch(`${API_PATH}/preview?id=${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {})
    }

    function sizeText(bytes) {
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
      if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
      return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GiB`
    }

    function modelLine(file) {
      return `\u622a\u56fe\uff1a\`${file.path}\``
    }

    function stripSerializedLines(draft, files) {
      const lines = new Set(files.map(modelLine))
      return String(draft || '')
        .split('\n')
        .filter((line) => !lines.has(line.trim()))
        .join('\n')
        .replace(/^\n+|\n+$/g, '')
    }

    // ── per-session draft reference controller ──────────────────────────────
    class ScreenshotDraftController {
      constructor(ctx) {
        this.ctx = ctx
        this.pending = new Map()
        this.inFlight = new Map()
        this.refIndex = new Map()
        this.listeners = new Map()
        this.expiry = new Map()
        this.serializing = new Set()
        this.counter = 0
      }

      pendingFor(sessionId) {
        return this.pending.get(String(sessionId)) || []
      }

      subscribe(sessionId, listener) {
        const key = String(sessionId)
        let set = this.listeners.get(key)
        if (!set) {
          set = new Set()
          this.listeners.set(key, set)
        }
        set.add(listener)
        return () => {
          set.delete(listener)
          if (set.size === 0) this.listeners.delete(key)
        }
      }

      publish(sessionId) {
        const set = this.listeners.get(String(sessionId))
        if (!set) return
        for (const listener of set) listener()
      }

      scope(sessionId) {
        const actx = this.ctx.sessions.scope(sessionId)
        if (!actx) throw new Error('当前会话尚未就绪')
        return { actx, shell: this.ctx.conversation.input.for(actx) }
      }

      insertReference(sessionId, entry) {
        const { actx, shell } = this.scope(sessionId)
        const input = shell.snapshot
        if (!input || input.phase !== 'plain') return false
        return actx.bail(actx, 'slash/input-insert-reference', {
          reference: {
            source: SOURCE,
            ref: entry.ref,
            label: `${HIDDEN_LABEL}${entry.ref}`,
            clipboardText: '',
          },
          span: {
            start: input.draft.length,
            end: input.draft.length,
            draftRev: input.draftRev,
          },
        }) === true
      }

      attach(sessionId, file) {
        const key = String(sessionId)
        this.clearInFlight(key)
        const entry = { ...file, ref: `${key}-${++this.counter}` }
        if (!this.insertReference(sessionId, entry)) {
          throw new Error('输入框正忙，请稍后重新截图')
        }
        const next = [...this.pendingFor(key), entry]
        this.pending.set(key, next)
        this.refIndex.set(entry.ref, { sessionId: key, entry })
        this.publish(key)
        return entry
      }

      remove(sessionId, ref) {
        const key = String(sessionId)
        const entries = this.pendingFor(key)
        const entry = entries.find((item) => item.ref === ref)
        if (!entry) return
        const { shell } = this.scope(sessionId)
        const input = shell.snapshot
        const occurrence = input.occurrences.find((item) => item.source === SOURCE && item.ref === ref)
        if (occurrence) {
          shell.setDraft(input.draft.slice(0, occurrence.offset) + input.draft.slice(occurrence.offset + 1))
        }
        const next = entries.filter((item) => item.ref !== ref)
        if (next.length > 0) this.pending.set(key, next)
        else this.pending.delete(key)
        this.refIndex.delete(ref)
        this.publish(key)
      }

      fileForRef(ref) {
        return this.refIndex.get(ref)?.entry
      }

      markSerializing(ref) {
        const record = this.refIndex.get(ref)
        if (record) this.serializing.add(record.sessionId)
      }

      reconcile(sessionId, occurrences) {
        const key = String(sessionId)
        const entries = this.pendingFor(key)
        if (entries.length === 0) return
        const refs = new Set(
          (occurrences || [])
            .filter((item) => item.source === SOURCE)
            .map((item) => item.ref),
        )
        const missing = entries.filter((entry) => !refs.has(entry.ref))
        if (missing.length === 0) return

        if (this.serializing.delete(key)) {
          this.pending.delete(key)
          this.inFlight.set(key, entries)
          const previous = this.expiry.get(key)
          if (previous) previous()
          this.expiry.set(key, this.ctx.timeout(() => this.clearInFlight(key), 30_000))
          this.publish(key)
          return
        }

        for (const entry of missing) this.refIndex.delete(entry.ref)
        const next = entries.filter((entry) => refs.has(entry.ref))
        if (next.length > 0) this.pending.set(key, next)
        else this.pending.delete(key)
        this.publish(key)
      }

      restoreFailed(sessionId) {
        const key = String(sessionId)
        const entries = this.inFlight.get(key)
        if (!entries || entries.length === 0) return
        const expiry = this.expiry.get(key)
        if (expiry) expiry()
        this.expiry.delete(key)
        this.inFlight.delete(key)

        const { shell } = this.scope(sessionId)
        const cleaned = stripSerializedLines(shell.snapshot.draft, entries)
        shell.setDraft(cleaned)

        const restored = []
        for (const entry of entries) {
          if (this.insertReference(sessionId, entry)) restored.push(entry)
          else this.refIndex.delete(entry.ref)
        }
        if (restored.length > 0) this.pending.set(key, restored)
        this.publish(key)
      }

      clearInFlight(sessionId) {
        const key = String(sessionId)
        const expiry = this.expiry.get(key)
        if (expiry) expiry()
        this.expiry.delete(key)
        const entries = this.inFlight.get(key) || []
        for (const entry of entries) this.refIndex.delete(entry.ref)
        this.inFlight.delete(key)
      }

      dispose() {
        for (const cancel of this.expiry.values()) cancel()
        this.expiry.clear()
        this.pending.clear()
        this.inFlight.clear()
        this.refIndex.clear()
        this.listeners.clear()
        this.serializing.clear()
      }
    }

    // ── capture overlay: mask + drag-select + crop + confirm ────────────────
    function ScreenshotOverlay(props) {
      const { shot, onCancel, onDone } = props
      const [loaded, setLoaded] = React.useState(false)
      const [loadError, setLoadError] = React.useState('')
      const [rect, setRect] = React.useState(null)
      const [dragging, setDragging] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [dragBox, setDragBox] = React.useState(null)
      const stageRef = React.useRef(null)

      // Cropping happens server-side (host PowerShell); the browser only
      // displays the preview and reports the display-space rectangle plus the
      // rendered stage size, so no canvas or image decoding is involved.

      const scale = Math.min(1, (window.innerWidth - 24) / shot.width, (window.innerHeight - 96) / shot.height)

      const onPointerDown = (event) => {
        if (!loaded) {
          setError('请等待画面加载完成后再框选')
          return
        }
        const box = (stageRef.current || event.currentTarget).getBoundingClientRect()
        // Snapshot the stage box for the whole drag so a later layout change
        // (e.g. the image finishing its load) cannot shift the selection.
        setDragBox({ width: box.width, height: box.height, left: box.left, top: box.top })
        const start = { x: event.clientX - box.left, y: event.clientY - box.top }
        setDragging(start)
        setRect({ x0: start.x, y0: start.y, x1: start.x, y1: start.y })
      }
      const onPointerMove = (event) => {
        if (!dragging) return
        const box = dragBox || (stageRef.current || event.currentTarget).getBoundingClientRect()
        const x = event.clientX - box.left
        const y = event.clientY - box.top
        setRect({ x0: dragging.x, y0: dragging.y, x1: x, y1: y })
      }
      const onPointerUp = () => {
        setDragging(null)
      }

      const current = rect || dragging ? rect : null
      const disp = current
        ? {
            left: Math.min(current.x0, current.x1),
            top: Math.min(current.y0, current.y1),
            width: Math.abs(current.x1 - current.x0),
            height: Math.abs(current.y1 - current.y0),
          }
        : null
      const phys = disp
        ? { width: Math.max(1, Math.round(disp.width / scale)), height: Math.max(1, Math.round(disp.height / scale)) }
        : null

      const doCrop = async () => {
        if (!disp || busy) return
        if (disp.width <= 2 || disp.height <= 2) {
          setError('请拖拽框选一个区域后再确定')
          return
        }
        // Use the same stage box the drag started with so the selection and the
        // stage size always share one coordinate snapshot.
        const box = dragBox || (stageRef.current ? stageRef.current.getBoundingClientRect() : null)
        if (!box || box.width <= 0 || box.height <= 0) {
          setError('截图画布不可用，请重试')
          return
        }
        setBusy(true)
        setError('')
        try {
          const response = await fetch(`${API_PATH}/crop`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              id: shot.id,
              rect: { x: disp.left, y: disp.top, w: disp.width, h: disp.height },
              stage: { w: box.width, h: box.height },
            }),
          })
          const body = await responseJson(response)
          await onDone(body.file)
        } catch (err) {
          setError(errorMessage(err))
          setBusy(false)
        }
      }

      const cancel = () => {
        deleteShot(shot.id)
        onCancel()
      }

      const selectAll = () => {
        const box = stageRef.current ? stageRef.current.getBoundingClientRect() : null
        if (!box) return
        setRect({ x0: 0, y0: 0, x1: box.width, y1: box.height })
      }

      return React.createElement(
        'div',
        {
          className: 'dsh-screenshot-overlay',
          onPointerDown: onPointerDown,
          onPointerMove: onPointerMove,
          onPointerUp: onPointerUp,
        },
        React.createElement(
          'div',
          { ref: stageRef, className: 'dsh-screenshot-stage' },
          React.createElement('img', {
            src: shot.url,
            width: Math.round(shot.width * scale),
            height: Math.round(shot.height * scale),
            draggable: false,
            // Inline-lock the rendered size so global CSS (e.g. img{max-width})
            // cannot resize the stage mid-drag and skew the crop coordinates.
            style: {
              display: 'block',
              width: `${Math.round(shot.width * scale)}px`,
              height: `${Math.round(shot.height * scale)}px`,
              maxWidth: 'none',
            },
            onLoad: () => setLoaded(true),
            onError: () => setLoadError('预览图加载失败，请重试'),
          }),
          !loaded && !loadError
            ? React.createElement(
                'div',
                { className: 'dsh-screenshot-loading dsh-screenshot-loading-overlay' },
                React.createElement('span', null, '正在加载截图…'),
              )
            : null,
          disp
            ? React.createElement('div', {
                className: 'dsh-screenshot-select',
                style: { left: disp.left, top: disp.top, width: disp.width, height: disp.height },
              })
            : null,
          disp && phys
            ? React.createElement(
                'div',
                { className: 'dsh-screenshot-size', style: { left: disp.left, top: disp.top - 24 } },
                `${phys.width} × ${phys.height}`,
              )
            : null,
        ),
        React.createElement(
          'div',
          {
            className: 'dsh-screenshot-toolbar',
            // Keep toolbar clicks from starting a new selection: the overlay's
            // pointer handlers must never see presses on the buttons.
            onPointerDown: (event) => event.stopPropagation(),
          },
          error ? React.createElement('span', { className: 'dsh-screenshot-error' }, error) : null,
          loadError ? React.createElement('span', { className: 'dsh-screenshot-error' }, loadError) : null,
          React.createElement(
            'button',
            { type: 'button', className: 'dsh-screenshot-btn', onClick: selectAll, disabled: busy },
            '全选',
          ),
          React.createElement(
            'button',
            { type: 'button', className: 'dsh-screenshot-btn', onClick: cancel, disabled: busy },
            '取消',
          ),
          React.createElement(
            'button',
            {
              type: 'button',
              className: 'dsh-screenshot-btn dsh-screenshot-btn-primary',
              onClick: doCrop,
              disabled: !disp || disp.width <= 2 || disp.height <= 2 || busy,
            },
            busy ? '处理中…' : '确定',
          ),
        ),
      )
    }

    // ── composer screenshot button + mode menu ──────────────────────────────
    function ScreenshotButton(props) {
      const input = props.useInput((state) => state) || props.input
      const sessionId = props.sessionId
      const [menuOpen, setMenuOpen] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [shot, setShot] = React.useState(null)

      const startCapture = async (hideWindow) => {
        setMenuOpen(false)
        if (!sessionId || busy) return
        setBusy(true)
        try {
          const result = await captureShot(hideWindow)
          setShot(result)
        } catch (err) {
          window.setTimeout(() => window.alert(`截图失败：${errorMessage(err)}`), 0)
        } finally {
          setBusy(false)
        }
      }

      const done = async (file) => {
        try {
          props.controller.attach(sessionId, file)
        } finally {
          deleteShot(shot.id)
          setShot(null)
        }
      }

      const disabled = busy || !input || input.phase !== 'plain'

      return React.createElement(
        'div',
        { className: 'dsh-screenshot-control' },
        React.createElement(
          'button',
          {
            type: 'button',
            className: 'dsh-screenshot-button',
            disabled,
            'aria-label': busy ? '正在截图' : '截图',
            title: '截图（微信式：遮罩框选，可隐藏当前窗口）',
            onClick: () => setMenuOpen((open) => !open),
          },
          React.createElement('span', { className: 'dsh-screenshot-icon', 'aria-hidden': true }, '📷'),
          React.createElement('span', null, busy ? '截图中' : '截图'),
        ),
        menuOpen
          ? React.createElement(
              'div',
              { className: 'dsh-screenshot-menu' },
              React.createElement(
                'button',
                { type: 'button', className: 'dsh-screenshot-menu-item', onClick: () => startCapture(false) },
                React.createElement('span', null, '截取屏幕任意区域'),
                React.createElement('small', null, '不隐藏窗口，遮罩框选'),
              ),
              React.createElement(
                'button',
                { type: 'button', className: 'dsh-screenshot-menu-item', onClick: () => startCapture(true) },
                React.createElement('span', null, '隐藏当前窗口后截图'),
                React.createElement('small', null, '临时隐藏 DSH 窗口，截取被遮挡内容'),
              ),
            )
          : null,
        shot
          ? React.createElement(
              ScreenshotOverlay,
              {
                shot,
                onCancel: () => {
                  deleteShot(shot.id)
                  setShot(null)
                },
                onDone: done,
              },
            )
          : null,
      )
    }

    // ── pending screenshot cards above the composer ─────────────────────────
    function ScreenshotRail(props) {
      const input = props.useInput((state) => state)
      const promptError = props.useSession((session) => session.promptError) || null
      const files = usePending(props.controller, props.sessionId)

      React.useEffect(() => {
        props.controller.reconcile(props.sessionId, input?.occurrences || [])
      }, [props.controller, props.sessionId, input?.draftRev])

      React.useEffect(() => {
        if (promptError) props.controller.restoreFailed(props.sessionId)
      }, [props.controller, props.sessionId, promptError])

      if (files.length === 0) return null
      return React.createElement(
        'div',
        { className: 'dsh-screenshot-rail', 'aria-label': '待发送截图' },
        files.map((file) =>
          React.createElement(
            'div',
            { className: 'dsh-screenshot-chip', key: file.ref },
            React.createElement('span', { className: 'dsh-screenshot-chip-icon', 'aria-hidden': true }, '📷'),
            React.createElement(
              'span',
              { className: 'dsh-screenshot-chip-copy' },
              React.createElement('strong', { title: file.name }, file.name),
              React.createElement('small', null, sizeText(file.size)),
            ),
            React.createElement(
              'button',
              {
                type: 'button',
                'aria-label': `移除 ${file.name}`,
                title: '从本次消息移除',
                onClick: () => props.controller.remove(props.sessionId, file.ref),
              },
              '×',
            ),
          ),
        ),
      )
    }

    function usePending(controller, sessionId) {
      const [, render] = React.useState(0)
      React.useEffect(
        () => controller.subscribe(sessionId, () => render((value) => value + 1)),
        [controller, sessionId],
      )
      return controller.pendingFor(sessionId)
    }

    // ── styles ──────────────────────────────────────────────────────────────
    const CSS = `
      [data-decoration="chip"][title^="${HIDDEN_LABEL}"]{display:none!important}
      .dsh-screenshot-control{position:relative;display:flex;align-items:center;min-width:0}
      .dsh-screenshot-button{height:28px;border:0;border-radius:14px;padding:0 9px;display:inline-flex;align-items:center;gap:4px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
      .dsh-screenshot-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
      .dsh-screenshot-button:disabled{opacity:.55}
      .dsh-screenshot-icon{font-size:13px;line-height:1}
      .dsh-screenshot-menu{position:absolute;bottom:34px;left:0;z-index:60;min-width:220px;padding:6px;display:flex;flex-direction:column;gap:2px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-specific-input-major);box-shadow:var(--dsw-shadow-lv2)}
      .dsh-screenshot-menu-item{display:flex;flex-direction:column;gap:2px;align-items:flex-start;padding:8px 10px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:16px;text-align:left;cursor:pointer}
      .dsh-screenshot-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
      .dsh-screenshot-menu-item small{color:var(--dsw-alias-label-tertiary);font-size:11px}
      .dsh-screenshot-overlay{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;user-select:none;cursor:crosshair}
      .dsh-screenshot-stage{position:relative;display:inline-block;background:#000}
      .dsh-screenshot-loading{display:grid;place-items:center;min-width:260px;min-height:140px;color:#fff;font-size:13px;padding:12px}
      .dsh-screenshot-loading-overlay{position:absolute;inset:0;background:rgba(0,0,0,.4);pointer-events:none}
      .dsh-screenshot-select{position:absolute;border:1px solid #fff;background:rgba(255,255,255,0.12);box-shadow:0 0 0 9999px rgba(0,0,0,.45);pointer-events:none}
      .dsh-screenshot-size{position:absolute;transform:translateY(-100%);padding:1px 6px;border-radius:4px;background:rgba(0,0,0,.7);color:#fff;font:12px/18px sans-serif;pointer-events:none}
      .dsh-screenshot-toolbar{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:10000;display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-specific-input-major);box-shadow:var(--dsw-shadow-lv2)}
      .dsh-screenshot-btn{min-width:64px;padding:6px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}
      .dsh-screenshot-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
      .dsh-screenshot-btn:disabled{opacity:.5;cursor:default}
      .dsh-screenshot-btn-primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}
      .dsh-screenshot-error{color:var(--dsw-alias-state-error-primary);font-size:12px}
      .dsh-screenshot-rail{box-sizing:border-box;width:100%;max-width:var(--dsh-composer-card-max-width);margin:0 auto 6px;padding:0 var(--dsh-composer-side-clearance);display:flex;gap:8px;overflow-x:auto;scrollbar-width:none}
      .dsh-screenshot-rail::-webkit-scrollbar{display:none}
      .dsh-screenshot-chip{min-width:180px;max-width:260px;height:54px;box-sizing:border-box;display:flex;align-items:center;gap:9px;padding:8px 8px 8px 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-specific-input-major);box-shadow:var(--dsw-shadow-lv1);color:var(--dsw-alias-label-primary)}
      .dsh-screenshot-chip-icon{width:28px;height:28px;display:grid;place-items:center;flex:none;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:15px}
      .dsh-screenshot-chip-copy{display:flex;flex-direction:column;min-width:0;flex:1}
      .dsh-screenshot-chip-copy strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px}
      .dsh-screenshot-chip-copy small{color:var(--dsw-alias-label-secondary);font-size:10px;line-height:14px}
      .dsh-screenshot-chip>button{width:24px;height:24px;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary);font-size:18px;line-height:20px;cursor:pointer;flex:none}
      .dsh-screenshot-chip>button:hover{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary)}
    `

    const inject = ['slots', 'sessions', 'conversation', 'inputTriggers', 'timer']

    function apply(ctx) {
      const controller = new ScreenshotDraftController(ctx)
      ctx.effect(() => () => controller.dispose(), 'dsh-screenshot: draft-file state')

      ctx.effect(() => ctx.inputTriggers.registerSource({
        trigger: '@',
        name: SOURCE,
        order: 11_000,
        candidates: async () => [],
        onPick: () => undefined,
        codec: {
          clipboardText: () => '',
          serialize: async (ref) => {
            const file = controller.fileForRef(ref)
            if (!file) throw new Error('待发送截图已失效，请重新截图')
            controller.markSerializing(ref)
            return modelLine(file)
          },
        },
      }), 'dsh-screenshot: hidden reference codec')

      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.plugin = 'dsh-screenshot'
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'dsh-screenshot: styles')

      ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left',
        id: 'screenshot-button',
        order: 9800,
        label: '截图',
      }, (props) => React.createElement(ScreenshotButton, { ...props, controller })))

      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock',
        id: 'screenshot-rail',
        order: 85,
        label: '待发送截图',
      }, (props) => React.createElement(ScreenshotRail, { ...props, controller })))
    }

    exports.name = 'dsh-screenshot'
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})