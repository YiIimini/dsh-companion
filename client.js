/**
 * dsh-companion — browser half.
 *
 * Loaded by the DSH web shell through `window.__ModuleLoader__`: the shell fetches
 * this file and evaluates it as a SCRIPT; `factory` receives the host's `require`,
 * which is how this file gets React without shipping it. No static `inject` on the
 * module means a host that never provides `slots` leaves this plugin idle instead of
 * pending forever — an exception here would cost the whole GUI its overlay.
 *
 * Two seats, one companion:
 *   shell.overlay           the character itself, draggable, position remembered
 *   sidebar.footer.action   a show/hide + character-switch button, so a hidden
 *                           companion is always recoverable
 *
 * Characters come from two places:
 *   built-in  `whale` / `fish` / `pixel` — inline SVG, no assets, no requests
 *   user skin `skin:<file>`             — an image the user dropped into
 *                                          `$DSH_HOME/companion/skins/`, served by
 *                                          the host half's allow-listed route
 * An image that fails to load falls back to the built-in whale rather than leaving a
 * broken icon on screen.
 *
 * The mood comes from the HOST, not from guessing: `state.json` carries `mood`,
 * derived from real `session/event` traffic. This file polls it slowly and never
 * derives agent state on its own.
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
    const SKINS_URL = `${BASE}/skins.json`
    const SKIN_URL = (file) => `${BASE}/skins/${encodeURIComponent(file)}`
    const POLL_MS = 4000
    const MOOD_WINDOW_MS = 6000
    const SAVE_DEBOUNCE_MS = 450

    const BUILTINS = [
      { id: 'whale', label: '像素鲸' },
      { id: 'fish', label: '像素肥鱼' },
      { id: 'pixel', label: '小方块' },
    ]

    const LINES = {
      whale: ['今天也要好好干活哦', '喷水！开工！', '哼，本小姐才不胖', '摸一下头就继续写代码吧', '这个 bug 我看过了，就在这里'],
      fish: ['米饭煮好了', '才不是大肥鱼呢', '肚子饿了就写不动代码', '先跑测试再吃饭', '本鱼盯着你呢'],
      pixel: ['READY.', 'COMPILING…', '0 ERRORS? SUSPICIOUS.', 'PING.', 'SAVE EARLY, SAVE OFTEN.'],
      fallback: ['我在这里', '要不要休息一下', '接着干！'],
    }

    const DEFAULTS = Object.freeze({
      visible: true,
      x: null,
      y: null,
      character: 'whale',
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
.dshc-art{width:104px;height:96px;display:block;filter:drop-shadow(0 6px 10px rgba(0,0,0,.28));transition:transform .25s ease}
.dshc-root[data-mood="working"] .dshc-art{transform:scale(1.04)}
.dshc-img{object-fit:contain;object-position:center bottom;height:104px}
.dshc-sway{animation:dshc-sway 4.8s ease-in-out infinite;transform-origin:50% 90%}
.dshc-root[data-mood="working"] .dshc-sway{animation-duration:1.9s}
.dshc-bubble{position:absolute;left:50%;bottom:104px;transform:translateX(-50%);max-width:230px;padding:7px 11px;border-radius:12px;font-size:12px;line-height:1.45;white-space:nowrap;color:var(--dsw-alias-label-primary,#eef2f7);background:var(--dsw-alias-bg-elevated,#1b2130);border:1px solid var(--dsw-alias-border-secondary,rgba(255,255,255,.14));box-shadow:0 8px 22px rgba(0,0,0,.32);pointer-events:none;opacity:0;transition:opacity .18s ease, transform .18s ease}
.dshc-bubble[data-show="true"]{opacity:1;transform:translateX(-50%) translateY(-2px)}
.dshc-badge{position:absolute;right:4px;top:14px;font-size:10px;letter-spacing:.06em;padding:2px 6px;border-radius:999px;color:#0b1220;background:#7dd3fc;opacity:0;transition:opacity .2s ease}
.dshc-root[data-mood="working"] .dshc-badge{opacity:1}
@keyframes dshc-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
@keyframes dshc-sway{0%,100%{transform:rotate(-3deg)}50%{transform:rotate(3deg)}}
@media (prefers-reduced-motion: reduce){
  .dshc-stage,.dshc-sway{animation:none !important}
}
`

    function installStyle() {
      if (typeof document === 'undefined') return () => {}
      if (document.getElementById(STYLE_ID)) return () => {}
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
      bubble: '',
      skins: [],
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

    async function pullSkins() {
      try {
        const response = await fetch(SKINS_URL, { headers: { accept: 'application/json' }, cache: 'no-store' })
        if (!response.ok) return
        const body = await response.json()
        if (body && Array.isArray(body.skins)) {
          store.skins = body.skins.filter((item) => item && typeof item.file === 'string')
          emit()
        }
      } catch {
        /* an empty skin list is a perfectly good answer */
      }
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
      const key = character.startsWith('skin:') ? 'fallback' : character
      const pool = LINES[key] ?? LINES.fallback
      return pool[Math.floor(Math.random() * pool.length)]
    }

    function labelOf(character) {
      if (character.startsWith('skin:')) return character.slice(5).replace(/\.[^.]+$/, '')
      const builtin = BUILTINS.find((item) => item.id === character)
      return builtin ? builtin.label : '伙伴'
    }

    /* ── artwork ───────────────────────────────────────────────────────────── */

    /* Block-built characters: a fixed 200x150 grid, integer coordinates, hard
     * edges. Two flat colors plus a belly and an accent per character — that is
     * what keeps a 104px desktop pet readable instead of a smudge of gradients. */
    const TINT = {
      sea: '#3b82f6',
      seaDark: '#2563eb',
      seaDeep: '#1d4ed8',
      seaBelly: '#eaf4ff',
      mint: '#34d399',
      mintDark: '#059669',
      mintDeep: '#047857',
      mintBelly: '#ecfdf5',
      sky: '#7dd3fc',
      skyDark: '#0ea5e9',
      skyBelly: '#e8fbff',
      ink: '#0b1220',
      blush: '#ff9fb4',
      water: '#a9dcff',
    }

    /* Each entry: [x, y, w, h, tint, opacity?] — all in the 200x150 grid. */
    const BLOCKS = {
      whale: [
        [118, 8, 10, 26, 'water'],
        [102, 16, 10, 18, 'water', 0.85],
        [134, 16, 10, 18, 'water', 0.85],
        [10, 70, 36, 26, 'seaDeep'],
        [30, 54, 22, 58, 'seaDeep'],
        [45, 42, 132, 86, 'sea'],
        [105, 26, 36, 16, 'seaDark'],
        [55, 98, 112, 30, 'seaBelly'],
        [72, 86, 18, 26, 'seaDark'],
        [88, 60, 20, 20, 'ink'],
        [93, 65, 7, 7, '#ffffff'],
        [62, 92, 18, 10, 'blush', 0.8],
        [120, 104, 28, 6, 'ink', 0.5],
      ],
      fish: [
        [12, 66, 34, 30, 'mintDeep'],
        [32, 52, 20, 58, 'mintDeep'],
        [46, 46, 128, 78, 'mint'],
        [56, 96, 106, 28, 'mintBelly'],
        [70, 86, 16, 24, 'mintDark'],
        [92, 62, 20, 20, 'ink'],
        [97, 67, 7, 7, '#ffffff'],
        [120, 62, 20, 20, 'ink'],
        [125, 67, 7, 7, '#ffffff'],
        [64, 90, 18, 10, 'blush', 0.75],
        [122, 102, 24, 6, 'ink', 0.45],
      ],
      pixel: [
        [70, 40, 80, 70, 'sky'],
        [52, 58, 22, 34, 'skyDark'],
        [146, 58, 22, 34, 'skyDark'],
        [80, 88, 60, 22, 'skyBelly'],
        [86, 58, 18, 18, 'ink'],
        [116, 58, 18, 18, 'ink'],
        [66, 86, 14, 9, 'blush', 0.8],
        [132, 86, 14, 9, 'blush', 0.8],
        [96, 94, 16, 6, 'ink', 0.4],
      ],
    }

    function BlockArt({ id, label }) {
      const blocks = BLOCKS[id] ?? BLOCKS.whale
      return h(
        'svg',
        {
          className: 'dshc-art',
          viewBox: '0 0 200 150',
          role: 'img',
          'aria-label': label,
          shapeRendering: 'crispEdges',
        },
        blocks.map(([x, y, w, ht, tint, opacity], index) =>
          h('rect', {
            key: index,
            x,
            y,
            width: w,
            height: ht,
            fill: TINT[tint] ?? tint,
            opacity: opacity ?? 1,
          }),
        ),
      )
    }

    function SkinImage({ file, onFail }) {
      return h('img', {
        className: 'dshc-art dshc-img',
        src: SKIN_URL(file),
        alt: '',
        draggable: false,
        'aria-label': '伙伴',
        onError: onFail,
      })
    }

    function Character({ id }) {
      const [failed, setFailed] = useState(false)
      if (id.startsWith('skin:') && !failed) {
        return h(SkinImage, { file: id.slice(5), onFail: () => setFailed(true) })
      }
      if (id === 'fish') return h(BlockArt, { id: 'fish', label: '像素肥鱼' })
      if (id === 'pixel') return h(BlockArt, { id: 'pixel', label: '小方块' })
      return h(BlockArt, { id: 'whale', label: '像素鲸' })
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
          say(pickLine(store.state.character))
          scheduleSave({ clicks: store.state.clicks + 1 })
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

    function rowStyle(active) {
      return {
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '6px 8px',
        borderRadius: '7px',
        border: 'none',
        background: active ? 'rgba(125,211,252,.16)' : 'transparent',
        color: 'var(--dsw-alias-label-primary, #e8eef7)',
        fontSize: '12px',
        fontWeight: active ? 600 : 400,
        cursor: 'pointer',
      }
    }

    function PanelSeat() {
      const view = useSyncExternalStore(subscribe, snapshot, snapshot)
      const [open, setOpen] = useState(false)

      useEffect(() => {
        installStyle()
        pull()
      }, [])

      useEffect(() => {
        if (open) pullSkins()
      }, [open])

      const current = view.state.character
      const label = labelOf(current)

      return h(
        'div',
        { style: { position: 'relative', display: 'inline-flex' } },
        h(
          'button',
          {
            type: 'button',
            onClick: () => setOpen((value) => !value),
            title: `伙伴：${label}${view.state.visible ? '' : '（已隐藏）'}`,
            'aria-label': `伙伴 ${label}`,
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
          h('span', null, label),
        ),
        open
          ? h(
              'div',
              {
                style: {
                  position: 'absolute',
                  bottom: '34px',
                  left: 0,
                  minWidth: '168px',
                  maxHeight: '264px',
                  overflowY: 'auto',
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
                  style: rowStyle(false),
                },
                store.state.visible ? '隐藏伙伴' : '显示伙伴',
              ),
              h('div', { style: { margin: '4px 8px', fontSize: '11px', color: '#7d92ab' } }, '内置'),
              BUILTINS.map((item) =>
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
                    style: rowStyle(item.id === current),
                  },
                  item.id === current ? `● ${item.label}` : `○ ${item.label}`,
                ),
              ),
              view.skins.length > 0
                ? h('div', { style: { margin: '4px 8px', fontSize: '11px', color: '#7d92ab' } }, '我的皮肤')
                : null,
              view.skins.map((skin) =>
                h(
                  'button',
                  {
                    key: skin.file,
                    type: 'button',
                    onClick: () => {
                      scheduleSave({ character: `skin:${skin.file}` })
                      say(pickLine('skin:'))
                      setOpen(false)
                    },
                    title: `${skin.file} · ${Math.round((skin.bytes ?? 0) / 1024)} KB`,
                    style: rowStyle(`skin:${skin.file}` === current),
                  },
                  `skin:${skin.file}` === current ? `● ${skin.file}` : `○ ${skin.file}`,
                ),
              ),
              view.skins.length === 0
                ? h(
                    'div',
                    { style: { margin: '2px 8px 6px', fontSize: '11px', lineHeight: 1.5, color: '#7d92ab' } },
                    '把喜欢的 PNG 放进 ~/.dsh/companion/skins/ 就能在这里选。',
                  )
                : null,
            )
          : null,
      )
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
