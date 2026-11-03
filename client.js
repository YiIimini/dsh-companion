/**
 * dsh-companion — browser half.
 *
 * Loaded by the DSH web shell through `window.__ModuleLoader__` (the shell fetches
 * this file and evaluates it as a SCRIPT; `factory` receives the host's `require`,
 * which is how this file gets React without shipping it).
 *
 * Two seats, one companion:
 *   shell.overlay           the character itself, draggable, position remembered
 *   sidebar.footer.action   a show/hide + character-switch button, so a hidden
 *                           companion is always recoverable
 *
 * The mood comes from the HOST, not from guessing: `state.json` carries `mood`,
 * derived from real `session/event` traffic. This file polls it slowly (one request
 * every few seconds) and never derives agent state on its own.
 *
 * Everything a user can break is handled locally: a failed fetch keeps the last
 * known state, a missing position falls back to the bottom-right corner, and no
 * code path throws — an exception here would cost the whole GUI its overlay.
 */

window.__ModuleLoader__.load({
  id: 'dsh-companion',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef, useState, useSyncExternalStore } = React

    const STYLE_ID = 'dsh-companion-style'
    const BASE = '/dsh-companion'
    const STATE_URL = `${BASE}/state.json`
    const WRITE_URL = `${STATE_URL}/state`
    const POLL_MS = 4000
    const MOOD_WINDOW_MS = 6000
    const SAVE_DEBOUNCE_MS = 450

    const CHARACTERS = [
      { id: 'fish', label: '大肥鱼' },
      { id: 'whale', label: '鲸鱼娘' },
      { id: 'pixel', label: '像素鱼' },
    ]

    const LINES = {
      fish: ['今天也要好好干活哦', '米饭煮好了', '哼，本鱼才不胖', '摸一下头就继续写代码吧', '这个 bug 我看过了，就在这里'],
      whale: ['本小姐查过了，问题在这里喵', '笨蛋主人，先跑测试', '尾巴摇一下，好运就来', '才不是大肥鱼呢', '喷水！开工！'],
      pixel: ['READY.', 'COMPILING…', '0 ERRORS? SUSPICIOUS.', 'PING.', 'SAVE EARLY, SAVE OFTEN.'],
    }

    const DEFAULTS = Object.freeze({
      visible: true,
      x: null,
      y: null,
      character: 'fish',
      name: '小蓝',
      clicks: 0,
    })

    /* ── styles ────────────────────────────────────────────────────────────── */

    const CSS = `
.dshc-root{position:fixed;z-index:2147481000;width:112px;height:112px;pointer-events:auto;touch-action:none;user-select:none;-webkit-user-select:none}
.dshc-root[data-visible="false"]{display:none}
.dshc-stage{position:absolute;inset:0;display:flex;align-items:flex-end;justify-content:center;cursor:grab;transform-origin:50% 90%;animation:dshc-bob 3.6s ease-in-out infinite}
.dshc-root[data-dragging="true"] .dshc-stage{cursor:grabbing;animation-play-state:paused}
.dshc-root[data-mood="working"] .dshc-stage{animation:dshc-bob 1.5s ease-in-out infinite}
.dshc-svg{width:104px;height:104px;display:block;filter:drop-shadow(0 6px 10px rgba(0,0,0,.28));transition:transform .25s ease}
.dshc-root[data-mood="working"] .dshc-svg{transform:scale(1.04)}
.dshc-sway{animation:dshc-sway 4.8s ease-in-out infinite;transform-origin:50% 90%}
.dshc-root[data-mood="working"] .dshc-sway{animation-duration:1.9s}
.dshc-eye{animation:dshc-blink 5.2s infinite}
.dshc-bubble{position:absolute;left:50%;bottom:106px;transform:translateX(-50%);max-width:220px;padding:7px 11px;border-radius:12px;font-size:12px;line-height:1.45;white-space:nowrap;color:var(--dsw-alias-label-primary,#eef2f7);background:var(--dsw-alias-bg-elevated,#1b2130);border:1px solid var(--dsw-alias-border-secondary,rgba(255,255,255,.14));box-shadow:0 8px 22px rgba(0,0,0,.32);pointer-events:none;opacity:0;transition:opacity .18s ease, transform .18s ease}
.dshc-bubble[data-show="true"]{opacity:1;transform:translateX(-50%) translateY(-2px)}
.dshc-badge{position:absolute;right:6px;top:16px;font-size:10px;letter-spacing:.06em;padding:2px 6px;border-radius:999px;color:#0b1220;background:#7dd3fc;opacity:0;transition:opacity .2s ease}
.dshc-root[data-mood="working"] .dshc-badge{opacity:1}
@keyframes dshc-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
@keyframes dshc-sway{0%,100%{transform:rotate(-3deg)}50%{transform:rotate(3deg)}}
@keyframes dshc-blink{0%,92%,100%{transform:scaleY(1)}96%{transform:scaleY(.08)}}
@media (prefers-reduced-motion: reduce){
  .dshc-stage,.dshc-sway,.dshc-eye{animation:none !important}
}
`

    function installStyle() {
      if (typeof document === 'undefined') return () => {}
      const existing = document.getElementById(STYLE_ID)
      if (existing) return () => {}
      const tag = document.createElement('style')
      tag.id = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => {
        if (tag.parentNode) tag.parentNode.removeChild(tag)
      }
    }

    /* ── store: one module-level object, two seats reading it ──────────────── */

    const store = {
      state: { ...DEFAULTS },
      mood: 'idle',
      dragging: false,
      bubble: '',
      subscribers: new Set(),
    }

    function emit() {
      for (const notify of store.subscribers) {
        try {
          notify()
        } catch {
          /* a broken subscriber is not the companion's problem */
        }
      }
    }

    function patch(next) {
      store.state = { ...store.state, ...next }
      emit()
    }

    function subscribe(notify) {
      store.subscribers.add(notify)
      return () => store.subscribers.delete(notify)
    }

    function snapshot() {
      return store
    }

    let inflight = null
    async function pull() {
      if (inflight) return inflight
      inflight = (async () => {
        try {
          const response = await fetch(STATE_URL, { headers: { accept: 'application/json' }, cache: 'no-store' })
          if (!response.ok) return
          const body = await response.json()
          if (!body || typeof body !== 'object') return
          const next = {}
          if (typeof body.visible === 'boolean') next.visible = body.visible
          if (typeof body.x === 'number' || body.x === null) next.x = body.x
          if (typeof body.y === 'number' || body.y === null) next.y = body.y
          if (typeof body.character === 'string') next.character = body.character
          if (typeof body.name === 'string' && body.name.length > 0) next.name = body.name
          if (typeof body.clicks === 'number') next.clicks = body.clicks
          // Never trust a mood the host did not derive: fall back to the stamp.
          if (typeof body.mood === 'string') store.mood = body.mood
          else if (typeof body.activityAt === 'number' && body.activityAt > 0) {
            store.mood = Date.now() - body.activityAt < MOOD_WINDOW_MS ? 'working' : 'idle'
          }
          patch(next)
        } catch {
          /* offline, restarting, or the route is not mounted yet: keep last state */
        } finally {
          inflight = null
        }
      })()
      return inflight
    }

    let saveTimer = null
    function scheduleSave(partial) {
      patch(partial)
      if (saveTimer !== null) clearTimeout(saveTimer)
      saveTimer = setTimeout(() => {
        saveTimer = null
        const body = { x: store.state.x, y: store.state.y, visible: store.state.visible, character: store.state.character }
        fetch(WRITE_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          cache: 'no-store',
        }).catch(() => {})
      }, SAVE_DEBOUNCE_MS)
    }

    function say(line) {
      store.bubble = line
      emit()
      if (store.bubbleTimer) clearTimeout(store.bubbleTimer)
      store.bubbleTimer = setTimeout(() => {
        store.bubble = ''
        emit()
      }, 4200)
    }

    function pickLine(character) {
      const pool = LINES[character] ?? LINES.fish
      return pool[Math.floor(Math.random() * pool.length)]
    }

    /* ── artwork: three inline SVG characters, no asset files ──────────────── */

    function Eyes({ x1, x2, y, r = 3.4 }) {
      return h(
        'g',
        { className: 'dshc-eye' },
        h('circle', { cx: x1, cy: y, r, fill: '#0b1220' }),
        h('circle', { cx: x2, cy: y, r, fill: '#0b1220' }),
      )
    }

    function FishSVG() {
      return h(
        'svg',
        { className: 'dshc-svg', viewBox: '0 0 120 120', role: 'img', 'aria-label': '大肥鱼' },
        h(
          'g',
          { className: 'dshc-sway' },
          h('path', { d: 'M84 60 L110 40 L104 60 L110 82 Z', fill: '#3b82f6' }),
          h('ellipse', { cx: 56, cy: 62, rx: 40, ry: 31, fill: '#4f9df8' }),
          h('ellipse', { cx: 50, cy: 52, rx: 24, ry: 15, fill: '#7db8fb', opacity: 0.55 }),
          h('path', { d: 'M44 34 q10 -14 20 -4 q-8 8 -20 4 Z', fill: '#2f6fd0' }),
          h('ellipse', { cx: 30, cy: 64, rx: 5, ry: 4, fill: '#bfe0ff', opacity: 0.9 }),
          h(Eyes, { x1: 40, x2: 58, y: 58, r: 3.6 }),
          h('path', { d: 'M44 74 q8 6 16 0', stroke: '#0b1220', strokeWidth: 2.2, fill: 'none', strokeLinecap: 'round' }),
        ),
      )
    }

    function WhaleSVG() {
      return h(
        'svg',
        { className: 'dshc-svg', viewBox: '0 0 120 120', role: 'img', 'aria-label': '鲸鱼娘' },
        h(
          'g',
          { className: 'dshc-sway' },
          h('path', { d: 'M86 58 q22 -18 24 2 q-14 12 -24 6 Z', fill: '#1d4ed8' }),
          h('ellipse', { cx: 56, cy: 64, rx: 40, ry: 28, fill: '#2f6fe4' }),
          h('ellipse', { cx: 54, cy: 74, rx: 30, ry: 14, fill: '#9fc7ff', opacity: 0.7 }),
          h('path', { d: 'M50 36 q6 -16 16 -16 q-2 12 -8 18 Z', fill: '#1e40af' }),
          h('path', { d: 'M36 34 q-2 -14 10 -16 q4 10 0 18 Z', fill: '#f472b6' }),
          h(Eyes, { x1: 42, x2: 60, y: 60, r: 3.4 }),
          h('circle', { cx: 48, cy: 70, r: 5, fill: '#f9a8d4', opacity: 0.45 }),
          h('path', { d: 'M44 76 q8 5 15 0', stroke: '#0b1220', strokeWidth: 2, fill: 'none', strokeLinecap: 'round' }),
        ),
      )
    }

    function PixelSVG() {
      const cells = []
      for (let row = 0; row < 8; row += 1) {
        for (let col = 0; col < 8; col += 1) {
          const on = (row >= 2 && row <= 5 && col >= 1 && col <= 5) || (col === 6 && (row === 3 || row === 4))
          if (!on) continue
          cells.push(h('rect', { key: `${row}-${col}`, x: 18 + col * 11, y: 24 + row * 11, width: 10, height: 10, fill: row < 3 ? '#38bdf8' : '#0ea5e9' }))
        }
      }
      return h(
        'svg',
        { className: 'dshc-svg', viewBox: '0 0 120 120', role: 'img', 'aria-label': '像素鱼', shapeRendering: 'crispEdges' },
        h('g', { className: 'dshc-sway' }, cells, h(Eyes, { x1: 44, x2: 62, y: 66, r: 3 })),
      )
    }

    function Character({ id }) {
      if (id === 'whale') return h(WhaleSVG, null)
      if (id === 'pixel') return h(PixelSVG, null)
      return h(FishSVG, null)
    }

    /* ── seat 1: the companion ────────────────────────────────────────────── */

    function CompanionSeat() {
      const view = useSyncExternalStore(subscribe, snapshot, snapshot)
      const [dragging, setDragging] = useState(false)
      const drag = useRef(null)
      const rootRef = useRef(null)

      useEffect(() => {
        installStyle()
        pull()
        const timer = setInterval(pull, POLL_MS)
        return () => clearInterval(timer)
      }, [])

      // A window that shrinks must not strand the pet off-screen.
      useEffect(() => {
        function onResize() {
          const { x, y } = store.state
          if (x === null || y === null) return
          const maxX = Math.max(0, window.innerWidth - 112)
          const maxY = Math.max(0, window.innerHeight - 112)
          const nx = Math.min(maxX, Math.max(0, x))
          const ny = Math.min(maxY, Math.max(0, y))
          if (nx !== x || ny !== y) patch({ x: nx, y: ny })
        }
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [])

      const onPointerDown = (event) => {
        if (event.button !== undefined && event.button !== 0) return
        const node = rootRef.current
        if (!node) return
        const rect = node.getBoundingClientRect()
        drag.current = { id: event.pointerId, dx: event.clientX - rect.left, dy: event.clientY - rect.top, moved: 0 }
        setDragging(true)
        try {
          node.setPointerCapture(event.pointerId)
        } catch {
          /* capture is a nicety, not a requirement */
        }
      }

      const onPointerMove = (event) => {
        const current = drag.current
        if (!current || current.id !== event.pointerId) return
        const maxX = Math.max(0, window.innerWidth - 112)
        const maxY = Math.max(0, window.innerHeight - 112)
        const nx = Math.min(maxX, Math.max(0, Math.round(event.clientX - current.dx)))
        const ny = Math.min(maxY, Math.max(0, Math.round(event.clientY - current.dy)))
        current.moved += 1
        patch({ x: nx, y: ny })
      }

      const onPointerUp = (event) => {
        const current = drag.current
        if (!current || current.id !== event.pointerId) return
        drag.current = null
        setDragging(false)
        const { x, y } = store.state
        if (current.moved === 0) {
          // A click, not a drag: say something and keep the count honest.
          const clicks = store.state.clicks + 1
          say(pickLine(store.state.character))
          scheduleSave({ clicks })
          return
        }
        scheduleSave({ x, y })
      }

      const { visible, x, y, character, name } = view.state
      const style = {}
      if (x === null || y === null) {
        style.right = '24px'
        style.bottom = '104px'
      } else {
        style.left = `${x}px`
        style.top = `${y}px`
      }

      return h(
        'div',
        {
          ref: rootRef,
          className: 'dshc-root',
          'data-visible': String(visible),
          'data-mood': view.mood,
          'data-dragging': String(dragging),
          style,
          onPointerDown,
          onPointerMove,
          onPointerUp,
          onPointerCancel: onPointerUp,
          title: `${name} · 拖动换个位置，点一下说话`,
          role: 'button',
          tabIndex: -1,
          'aria-label': `${name} 桌宠`,
        },
        h('div', { className: 'dshc-bubble', 'data-show': String(view.bubble.length > 0) }, view.bubble),
        h('div', { className: 'dshc-badge' }, 'WORKING'),
        h('div', { className: 'dshc-stage' }, h(Character, { id: character })),
      )
    }

    /* ── seat 2: show/hide + switch, so hiding is never a one-way door ────── */

    function PanelSeat() {
      const view = useSyncExternalStore(subscribe, snapshot, snapshot)
      const [open, setOpen] = useState(false)

      useEffect(() => {
        installStyle()
        pull()
      }, [])

      const current = CHARACTERS.find((item) => item.id === view.state.character) ?? CHARACTERS[0]

      return h(
        'div',
        { style: { position: 'relative', display: 'inline-flex' } },
        h(
          'button',
          {
            type: 'button',
            onClick: () => setOpen((value) => !value),
            title: `伙伴：${current.label}${view.state.visible ? '' : '（已隐藏）'}`,
            'aria-label': `伙伴 ${current.label}`,
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              height: '28px',
              padding: '0 9px',
              borderRadius: '8px',
              border: '1px solid var(--dsw-alias-border-secondary, rgba(255,255,255,.14))',
              background: 'transparent',
              color: 'var(--dsw-alias-label-primary, #e8eef7)',
              fontSize: '12px',
              cursor: 'pointer',
            },
          },
          h('span', { 'aria-hidden': true, style: { fontSize: '14px', lineHeight: 1 } }, '🐟'),
          h('span', null, current.label),
        ),
        open
          ? h(
              'div',
              {
                style: {
                  position: 'absolute',
                  bottom: '34px',
                  left: 0,
                  minWidth: '150px',
                  padding: '6px',
                  borderRadius: '10px',
                  border: '1px solid var(--dsw-alias-border-secondary, rgba(255,255,255,.14))',
                  background: 'var(--dsw-alias-bg-elevated, #161b26)',
                  boxShadow: '0 10px 26px rgba(0,0,0,.35)',
                  zIndex: 30,
                },
              },
              h(
                'button',
                {
                  type: 'button',
                  onClick: () => scheduleSave({ visible: !store.state.visible }),
                  style: rowStyle(),
                },
                store.state.visible ? '隐藏伙伴' : '显示伙伴',
              ),
              CHARACTERS.map((item) =>
                h(
                  'button',
                  {
                    key: item.id,
                    type: 'button',
                    onClick: () => {
                      scheduleSave({ character: item.id })
                      say(pickLine(item.id))
                      setOpen(false)
                    },
                    style: { ...rowStyle(), fontWeight: item.id === current.id ? 600 : 400 },
                  },
                  item.id === current.id ? `● ${item.label}` : `○ ${item.label}`,
                ),
              ),
            )
          : null,
      )
    }

    function rowStyle() {
      return {
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '6px 8px',
        borderRadius: '7px',
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary, #e8eef7)',
        fontSize: '12px',
        cursor: 'pointer',
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const release = installStyle()
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'dsh-companion', order: 700 }, CompanionSeat),
        )
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            { name: 'sidebar.footer.action', id: 'dsh-companion-toggle', order: 40, label: () => '伙伴' },
            PanelSeat,
          ),
        )
        pull()
        if (typeof ctx.effect === 'function') {
          ctx.effect(() => release, 'dsh-companion: styles')
        }
      },
    }
  },
})
