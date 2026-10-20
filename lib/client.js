// dsh-screenshot — WeChat-style screenshot for the DeepSeek Harness composer (client half).
//
// Adds a camera button to the composer's left control group. Two capture modes
// (hide the DSH window first, or capture it as-is) plus an all-screens variant
// share one full-viewport overlay: the captured frame is shown scaled to fit,
// the user drags a rectangle, and the host crops it in physical pixels.
//
// The cropped PNG comes back as a Blob and is attached through the SAME draft
// attachment service the composer uses for pasted images. DSH then renders its
// own attachment card, sends the bytes with the prompt, and no path has to be
// serialized into the message. A "send as file" toggle falls back to a generic
// file attachment (path handle in the prompt) for text-only models.
//
// Client entries must register via window.__ModuleLoader__.load({ id, factory });
// the factory receives a synchronous `require` and returns module exports.

window.__ModuleLoader__.load({
  id: 'dsh-screenshot',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const API = '/api/screenshot'
    const MODE_KEY = 'dsh-screenshot:attach-mode:v1'
    // Above this size an image attachment is risky for provider image budgets;
    // fall back to a generic file, which has no admission limit.
    const MAX_INLINE_BYTES = 6 * 1024 * 1024

    let toastHost

    function toast(message, tone = 'info') {
      if (typeof document === 'undefined') return
      if (!toastHost || !toastHost.isConnected) {
        toastHost = document.createElement('div')
        toastHost.className = 'dsh-shot-toasts'
        document.body.appendChild(toastHost)
      }
      const node = document.createElement('div')
      node.className = `dsh-shot-toast dsh-shot-toast-${tone}`
      node.textContent = message
      toastHost.appendChild(node)
      window.setTimeout(() => {
        node.classList.add('dsh-shot-toast-out')
        window.setTimeout(() => node.remove(), 200)
      }, 2800)
    }

    function errorMessage(error) {
      return error instanceof Error ? error.message : String(error)
    }

    async function callApi(path, init) {
      const response = await fetch(path, init)
      let body = {}
      try {
        body = await response.json()
      } catch {
        // fall through to the status-based message
      }
      if (!response.ok || body?.ok === false) {
        throw new Error(body?.error || `请求失败（HTTP ${response.status}）`)
      }
      return body
    }

    function readMode() {
      try {
        return window.localStorage.getItem(MODE_KEY) === 'file' ? 'file' : 'image'
      } catch {
        return 'image'
      }
    }

    function writeMode(mode) {
      try {
        window.localStorage.setItem(MODE_KEY, mode)
      } catch {
        // private-mode storage failures leave the in-memory choice in charge
      }
    }

    /**
     * Turn a cropped shot into a DSH draft attachment.
     *
     * Image drafts send the bytes with the prompt (the model sees the picture);
     * file drafts upload through `ctx.fileUpload` and reach the model as a saved
     * path. Both then ride DSH's normal submit path — no hidden references.
     */
    async function attachShot(ctx, { sessionId, file, mode, inputActions }) {
      try {
        const response = await fetch(`${API}/file?id=${encodeURIComponent(file.id)}`)
        if (!response.ok) throw new Error(`读取截图失败（HTTP ${response.status}）`)
        const blob = await response.blob()

        const downgraded = mode === 'image' && blob.size > MAX_INLINE_BYTES
        const asFile = mode === 'file' || downgraded
        const type = asFile ? 'application/octet-stream' : 'image/png'
        const upload = new File([blob], file.name, { type })

        const conversation = ctx.conversation
        if (typeof conversation?.createDrafts !== 'function') {
          throw new Error('当前 DSH 缺少附件接口（需要 DSH 0.2 及以上）')
        }
        const actions = resolveInputActions(ctx, sessionId, inputActions)
        if (!actions) throw new Error('无法访问输入框（DSH 版本不兼容）')

        const drafts = conversation.createDrafts(sessionId, [upload])
        try {
          if (!actions.addAttachments(drafts.map((draft) => draft.id))) {
            throw new Error('输入框正忙，请稍后重试')
          }
        } catch (failure) {
          for (const draft of drafts) {
            try {
              conversation.releaseDraftAttachment?.(draft.id)
            } catch {
              // the registry may already be gone with the session
            }
          }
          throw failure
        }
        return { kind: asFile ? 'file' : 'image', downgraded }
      } finally {
        void fetch(`${API}/file?id=${encodeURIComponent(file.id)}`, { method: 'DELETE' }).catch(() => {})
      }
    }

    function resolveInputActions(ctx, sessionId, inputActions) {
      if (inputActions && typeof inputActions.addAttachments === 'function') return inputActions
      // Fallback for hosts whose slot props omit `inputActions`: the session
      // input shell exposes the same action face.
      try {
        return ctx.conversation?.input?.shell?.(sessionId)?.actions
      } catch {
        return undefined
      }
    }

    function deleteCapture(id) {
      void fetch(`${API}/preview?id=${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {})
    }

    const clamp = (min, max, value) => Math.max(min, Math.min(max, value))

    // ── capture overlay: dim mask, drag selection, confirm ──────────────────
    function ScreenshotOverlay({ shot, onCancel, onDone }) {
      const [loaded, setLoaded] = useState(false)
      const [loadError, setLoadError] = useState('')
      const [rect, setRect] = useState(null)
      const [stage, setStage] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [viewport, setViewport] = useState({ w: window.innerWidth, h: window.innerHeight })

      const stageRef = useRef(null)
      const dragRef = useRef(null)

      useEffect(() => {
        const onResize = () => {
          setViewport({ w: window.innerWidth, h: window.innerHeight })
          setRect(null)
          setStage(null)
        }
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [])

      useEffect(() => {
        const root = document.documentElement
        const previous = root.style.overflow
        root.style.overflow = 'hidden'
        return () => {
          root.style.overflow = previous
        }
      }, [])

      const scale = Math.max(
        0.05,
        Math.min(1, (viewport.w - 48) / shot.width, (viewport.h - 168) / shot.height),
      )
      const displayWidth = Math.max(1, Math.round(shot.width * scale))
      const displayHeight = Math.max(1, Math.round(shot.height * scale))

      const pointIn = (box, event) => ({
        x: clamp(0, box.width, event.clientX - box.left),
        y: clamp(0, box.height, event.clientY - box.top),
      })

      const onPointerDown = (event) => {
        if (event.button !== 0 || busy || !loaded) return
        const box = stageRef.current?.getBoundingClientRect()
        if (!box || box.width <= 0 || box.height <= 0) return
        const rawX = event.clientX - box.left
        const rawY = event.clientY - box.top
        // Only presses on the picture start a selection; the letterboxed area
        // is dead space so a stray click cannot create a 0×0 crop.
        if (rawX < 0 || rawY < 0 || rawX > box.width || rawY > box.height) return
        const point = pointIn(box, event)
        dragRef.current = { box, x0: point.x, y0: point.y, pointerId: event.pointerId }
        event.currentTarget.setPointerCapture?.(event.pointerId)
        setStage({ w: box.width, h: box.height })
        setRect({ x0: point.x, y0: point.y, x1: point.x, y1: point.y })
        setError('')
      }

      const onPointerMove = (event) => {
        const drag = dragRef.current
        if (!drag) return
        const point = pointIn(drag.box, event)
        setRect({ x0: drag.x0, y0: drag.y0, x1: point.x, y1: point.y })
      }

      const onPointerUp = (event) => {
        if (!dragRef.current) return
        dragRef.current = null
        try {
          event.currentTarget.releasePointerCapture?.(event.pointerId)
        } catch {
          // capture already released by the browser
        }
      }

      const normalized = rect
        ? {
            left: Math.min(rect.x0, rect.x1),
            top: Math.min(rect.y0, rect.y1),
            width: Math.abs(rect.x1 - rect.x0),
            height: Math.abs(rect.y1 - rect.y0),
          }
        : null

      const usable = normalized !== null && normalized.width > 2 && normalized.height > 2
      const physical = normalized
        ? {
            w: Math.max(1, Math.round(normalized.width / scale)),
            h: Math.max(1, Math.round(normalized.height / scale)),
          }
        : null

      const selectAll = () => {
        const box = stageRef.current?.getBoundingClientRect()
        if (!box) return
        setStage({ w: box.width, h: box.height })
        setRect({ x0: 0, y0: 0, x1: box.width, y1: box.height })
        setError('')
      }

      const confirm = useCallback(async () => {
        if (busy || !usable) {
          setError(usable ? '' : '请拖拽框选一个区域')
          return
        }
        const box = stageRef.current?.getBoundingClientRect()
        const stageSize = stage || (box ? { w: box.width, h: box.height } : null)
        if (!stageSize || stageSize.w <= 0 || stageSize.h <= 0) {
          setError('画布不可用，请重试')
          return
        }
        setBusy(true)
        setError('')
        try {
          const file = await callApi(`${API}/crop`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              id: shot.id,
              rect: { x: normalized.left, y: normalized.top, w: normalized.width, h: normalized.height },
              stage: { w: stageSize.w, h: stageSize.h },
            }),
          })
          await onDone(file)
        } catch (failure) {
          setError(errorMessage(failure))
          setBusy(false)
        }
      }, [busy, normalized, onDone, shot.id, stage, usable])

      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            if (!busy) onCancel()
          } else if (event.key === 'Enter') {
            event.preventDefault()
            event.stopPropagation()
            void confirm()
          }
        }
        window.addEventListener('keydown', onKey, true)
        return () => window.removeEventListener('keydown', onKey, true)
      }, [busy, confirm, onCancel])

      return h(
        'div',
        {
          className: 'dsh-shot-overlay',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': '截图框选',
          onPointerDown,
          onPointerMove,
          onPointerUp,
          onPointerCancel: onPointerUp,
        },
        h(
          'div',
          {
            ref: stageRef,
            className: 'dsh-shot-stage',
            style: { width: `${displayWidth}px`, height: `${displayHeight}px` },
          },
          h('img', {
            className: 'dsh-shot-image',
            src: shot.url,
            alt: '屏幕截图预览',
            draggable: false,
            onLoad: () => setLoaded(true),
            onError: () => setLoadError('预览图加载失败，请重新截图'),
          }),
          !loaded && !loadError
            ? h('div', { className: 'dsh-shot-loading' }, '正在加载截图…')
            : null,
          normalized
            ? h('div', {
                className: 'dsh-shot-selection',
                style: {
                  left: `${normalized.left}px`,
                  top: `${normalized.top}px`,
                  width: `${normalized.width}px`,
                  height: `${normalized.height}px`,
                },
              })
            : null,
          normalized && physical
            ? h(
                'div',
                {
                  className: 'dsh-shot-size',
                  style: { left: `${normalized.left}px`, top: `${Math.max(0, normalized.top - 26)}px` },
                },
                `${physical.w} × ${physical.h}`,
              )
            : null,
        ),
        h(
          'div',
          { className: 'dsh-shot-toolbar', onPointerDown: (event) => event.stopPropagation() },
          error || loadError
            ? h('span', { className: 'dsh-shot-error' }, error || loadError)
            : h('span', { className: 'dsh-shot-hint' }, '拖拽框选 · Enter 确定 · Esc 取消'),
          h('button', { type: 'button', className: 'dsh-shot-btn', onClick: selectAll, disabled: busy }, '全选'),
          h(
            'button',
            { type: 'button', className: 'dsh-shot-btn', onClick: onCancel, disabled: busy },
            '取消',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-shot-btn dsh-shot-btn-primary',
              onClick: () => void confirm(),
              disabled: busy || !usable,
            },
            busy ? '处理中…' : '确定',
          ),
        ),
      )
    }

    // ── composer button + capture menu ──────────────────────────────────────
    function ScreenshotButton({ controller, sessionId, inputActions, useInput, input }) {
      const liveInput = typeof useInput === 'function' ? useInput((state) => state) : input
      const [menuOpen, setMenuOpen] = useState(false)
      const [busy, setBusy] = useState(false)
      const [shot, setShot] = useState(null)
      const [mode, setMode] = useState(readMode)
      const rootRef = useRef(null)

      useEffect(() => {
        if (!menuOpen) return undefined
        const onDown = (event) => {
          if (rootRef.current && !rootRef.current.contains(event.target)) setMenuOpen(false)
        }
        document.addEventListener('pointerdown', onDown, true)
        return () => document.removeEventListener('pointerdown', onDown, true)
      }, [menuOpen])

      useEffect(
        () => () => {
          if (shot) deleteCapture(shot.id)
        },
        [shot],
      )

      const start = async (options) => {
        setMenuOpen(false)
        if (!sessionId || busy) return
        if (options.hideWindow && !document.hasFocus()) {
          toast('请先点击 DSH 窗口，再使用「隐藏窗口后截图」', 'warn')
          return
        }
        setBusy(true)
        try {
          const captured = await callApi(`${API}/capture`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(options),
          })
          setShot(captured)
        } catch (failure) {
          toast(`截图失败：${errorMessage(failure)}`, 'error')
        } finally {
          setBusy(false)
        }
      }

      const finish = async (file) => {
        setShot(null)
        try {
          const outcome = await attachShot(controller.ctx, { sessionId, file, mode, inputActions })
          if (outcome.downgraded) toast('截图超过 6 MB，已按文件发送', 'warn')
          else if (outcome.kind === 'file') toast('截图已作为文件加入输入框')
          else toast('截图已加入输入框')
        } catch (failure) {
          toast(`未能加入输入框：${errorMessage(failure)}`, 'error')
        }
      }

      const cancel = () => {
        if (shot) deleteCapture(shot.id)
        setShot(null)
      }

      const disabled = busy || !sessionId || !liveInput || liveInput.phase !== 'plain'

      return h(
        'div',
        { className: 'dsh-shot-control', ref: rootRef },
        h(
          'button',
          {
            type: 'button',
            className: 'dsh-shot-button',
            disabled,
            title: '截图（微信式框选，可直接发给模型）',
            'aria-label': busy ? '正在截图' : '截图',
            'aria-haspopup': 'menu',
            'aria-expanded': menuOpen,
            onClick: () => setMenuOpen((open) => !open),
          },
          h('span', { className: 'dsh-shot-icon', 'aria-hidden': 'true' }, '📷'),
          h('span', null, busy ? '截图中' : '截图'),
        ),
        menuOpen
          ? h(
              'div',
              { className: 'dsh-shot-menu', role: 'menu' },
              h(
                'button',
                {
                  type: 'button',
                  role: 'menuitem',
                  className: 'dsh-shot-menu-item',
                  onClick: () => void start({ hideWindow: false }),
                },
                h('span', null, '截取屏幕区域'),
                h('small', null, '不隐藏窗口，遮罩框选'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  role: 'menuitem',
                  className: 'dsh-shot-menu-item',
                  onClick: () => void start({ hideWindow: true }),
                },
                h('span', null, '隐藏窗口后截图'),
                h('small', null, '临时隐藏 DSH，截取被遮住的内容'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  role: 'menuitem',
                  className: 'dsh-shot-menu-item',
                  onClick: () => void start({ hideWindow: false, allScreens: true }),
                },
                h('span', null, '截取全部屏幕'),
                h('small', null, '多显示器时截取整个虚拟桌面'),
              ),
              h('div', { className: 'dsh-shot-menu-divider' }),
              h(
                'label',
                { className: 'dsh-shot-menu-toggle' },
                h('input', {
                  type: 'checkbox',
                  checked: mode === 'image',
                  onChange: (event) => {
                    const next = event.target.checked ? 'image' : 'file'
                    setMode(next)
                    writeMode(next)
                  },
                }),
                h('span', null, '以图片附件发送'),
                h('small', null, '关闭后按文件路径发送（需要能读图的工具）'),
              ),
            )
          : null,
        shot ? h(ScreenshotOverlay, { shot, onCancel: cancel, onDone: finish }) : null,
      )
    }

    // ── styles ──────────────────────────────────────────────────────────────
    const CSS = `
      .dsh-shot-control{position:relative;display:flex;align-items:center;min-width:0}
      .dsh-shot-button{height:28px;border:0;border-radius:14px;padding:0 9px;display:inline-flex;align-items:center;gap:4px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
      .dsh-shot-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
      .dsh-shot-button:disabled{opacity:.55;cursor:default}
      .dsh-shot-icon{font-size:13px;line-height:1}
      .dsh-shot-menu{position:absolute;bottom:34px;left:0;z-index:60;min-width:236px;padding:6px;display:flex;flex-direction:column;gap:2px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-specific-input-major);box-shadow:var(--dsw-shadow-lv2)}
      .dsh-shot-menu-item{display:flex;flex-direction:column;gap:2px;align-items:flex-start;padding:8px 10px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:16px;text-align:left;cursor:pointer}
      .dsh-shot-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
      .dsh-shot-menu-item small,.dsh-shot-menu-toggle small{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:15px}
      .dsh-shot-menu-divider{height:1px;margin:4px 6px;background:var(--dsw-alias-border-l2)}
      .dsh-shot-menu-toggle{display:grid;grid-template-columns:auto 1fr;gap:2px 8px;align-items:center;padding:8px 10px;border-radius:8px;color:var(--dsw-alias-label-primary);font-size:12px;line-height:16px;cursor:pointer}
      .dsh-shot-menu-toggle input{margin:0;grid-row:1}
      .dsh-shot-menu-toggle small{grid-column:2}
      .dsh-shot-overlay{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.66);display:flex;align-items:center;justify-content:center;user-select:none;cursor:crosshair}
      .dsh-shot-stage{position:relative;background:#000;box-shadow:0 18px 60px rgba(0,0,0,.55);overflow:hidden}
      .dsh-shot-image{display:block;width:100%;height:100%;max-width:none;pointer-events:none}
      .dsh-shot-loading{position:absolute;inset:0;display:grid;place-items:center;color:#fff;font-size:13px;background:rgba(0,0,0,.45);pointer-events:none}
      .dsh-shot-selection{position:absolute;border:1px solid #fff;background:rgba(255,255,255,.08);box-shadow:0 0 0 9999px rgba(0,0,0,.42);pointer-events:none}
      .dsh-shot-size{position:absolute;padding:1px 6px;border-radius:4px;background:rgba(0,0,0,.75);color:#fff;font:12px/18px sans-serif;pointer-events:none;white-space:nowrap}
      .dsh-shot-toolbar{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:10000;display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-specific-input-major);box-shadow:var(--dsw-shadow-lv2);cursor:default}
      .dsh-shot-hint{color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap}
      .dsh-shot-error{color:var(--dsw-alias-state-error-primary);font-size:12px;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .dsh-shot-btn{min-width:64px;padding:6px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}
      .dsh-shot-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
      .dsh-shot-btn:disabled{opacity:.5;cursor:default}
      .dsh-shot-btn-primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}
      .dsh-shot-toasts{position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:10001;display:flex;flex-direction:column;gap:8px;pointer-events:none}
      .dsh-shot-toast{max-width:420px;padding:8px 14px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-specific-input-major);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;box-shadow:var(--dsw-shadow-lv2);opacity:1;transition:opacity .18s ease}
      .dsh-shot-toast-out{opacity:0}
      .dsh-shot-toast-error{color:var(--dsw-alias-state-error-primary)}
      .dsh-shot-toast-warn{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-primary))}
    `

    // `fileUpload` is required by the conversation service when it registers a
    // generic-file draft, and the service rebinds `this.ctx` to this plugin's
    // context on access — so declare it here.
    const inject = ['slots', 'conversation', 'fileUpload']

    function apply(ctx) {
      const controller = { ctx }

      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.plugin = 'dsh-screenshot'
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'dsh-screenshot: 样式')

      ctx.slots.inject('conversation.input.left', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.left',
            id: 'screenshot-button',
            order: 9800,
          },
          (props) => h(ScreenshotButton, { ...props, controller }),
        ),
      )
    }

    const module = { exports: {} }
    module.exports.name = 'dsh-screenshot'
    module.exports.apply = apply
    module.exports.inject = inject
    return module.exports
  },
})
