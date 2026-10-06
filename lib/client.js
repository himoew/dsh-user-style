// dsh-user-style 客户端半边（预打包 bundle 形态，手写、无需构建器）。
//
// 契约来自 @deepseek-ai/dsh-client-modules：
//   · 产物必须调用 window.__ModuleLoader__.load({ id, factory })，执行时只注册 factory；
//   · factory 里用 require() 取平台 seed 模块（react / react-dom 在基座表内）；
//   · module.exports 是 Cordis 插件：{ inject, apply }，apply 里通过 slots 注册界面。
//
// 注册两个界面：
//   1. conversation.composer.dock —— 工作页面上的悬浮面板（用户主要入口）
//   2. plugins.bundle.config       —— 插件页里的完整设置页（批量编辑）
//
// 悬浮面板为什么要 portal 到 body：dock 位于多层 flex / 滚动容器内，就地渲染会被裁切，
// 而 position:fixed 又会被祖先的 transform 影响（底部信息栏插件为同样原因这么做）。
window.__ModuleLoader__.load({
  id: 'dsh-user-style',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    'use strict'

    var React = require('react')

    // react-dom 是可选 seed 模块：缺席时退化为就地渲染（不崩，只是可能被裁切）。
    var ReactDOM = null
    try {
      var rd = require('react-dom')
      if (rd && typeof rd.createPortal === 'function') ReactDOM = rd
    } catch (err) {
      ReactDOM = null
    }

    var RPC_BASE = '/_dsh/dsh-user-style'
    var RPC_TIMEOUT_MS = 15000
    var BUNDLE_ID = 'dsh-user-style'
    var DOCK_SLOT = 'conversation.composer.dock'
    var CONFIG_SLOT = 'plugins.bundle.config'
    var POSITION_KEY = 'dsh-user-style:pos'
    var STYLE_ID = 'dsh-user-style-css'

    /** 极简 RPC：与宿主 webServer 路由对应。 */
    function rpc(method, args) {
      var controller = typeof AbortController === 'function' ? new AbortController() : null
      var timer = null
      if (controller) {
        timer = setTimeout(function () {
          controller.abort()
        }, RPC_TIMEOUT_MS)
      }
      return fetch(RPC_BASE + '/' + method, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args || {}),
        signal: controller ? controller.signal : undefined,
      })
        .then(function (res) {
          return res.text().then(function (raw) {
            var body = null
            try {
              body = JSON.parse(raw)
            } catch (err) {
              body = null
            }
            if (!res.ok) throw new Error((body && body.error) || 'HTTP ' + res.status)
            return body
          })
        })
        .finally(function () {
          if (timer !== null) clearTimeout(timer)
        })
    }

    // ------------------------------------------------------------------ 小工具

    /** 条目文本 ↔ 多行文本框。 */
    function itemsToText(items) {
      return (Array.isArray(items) ? items : []).join('\n')
    }

    function textToItems(text) {
      return String(text || '')
        .split('\n')
        .map(function (line) {
          return line.replace(/^\s*[-*]\s*/, '').trim()
        })
        .filter(Boolean)
    }

    /** 本地即时预览。宿主渲染的真源在 /preview，这里只为「还没保存也能看到」。 */
    function renderLocalPreview(itemsText, notes) {
      var items = textToItems(itemsText)
      var extra = String(notes || '').trim()
      if (items.length === 0 && !extra) return '（空：这份档案不会注入任何内容）'
      return (
        '## 用户工作风格（User working style）\n' +
        '以下是用户本人设定的工作偏好。除非用户在本次对话中明确另有要求，否则按此执行：\n' +
        items
          .map(function (item) {
            return '- ' + item
          })
          .join('\n') +
        (extra ? '\n\n' + extra : '')
      )
    }

    /** 从 slot props 里尽力取出会话 id（不同载体给的位置不一样）。 */
    function sessionIdFromProps(props) {
      if (!props || typeof props !== 'object') return ''
      var candidates = [
        props.sessionId,
        props.owner && props.owner.sessionId,
        props.owner && props.owner.header && props.owner.header.id,
        props.session && props.session.id,
      ]
      for (var i = 0; i < candidates.length; i += 1) {
        if (typeof candidates[i] === 'string' && candidates[i]) return candidates[i]
      }
      return ''
    }

    var SOURCE_LABEL = {
      session: '仅本会话',
      workspace: '当前工作区',
      default: '全局',
      none: '未启用',
    }

    /**
     * 工作区短名：取路径最后一段（如 D:\New-Blue fish's work\User Plugin → User Plugin）。
     * 最后一段太短或是纯数字时（如 "...\work place 2"），带上上一级避免看不出是哪个。
     */
    function shortWorkspaceLabel(path) {
      var text = String(path || '').replace(/[\\/]+$/, '')
      if (!text) return ''
      var parts = text.split(/[\\/]+/).filter(Boolean)
      if (parts.length === 0) return text
      var last = parts[parts.length - 1]
      if (parts.length >= 2 && (last.length <= 3 || /^\d+$/.test(last))) {
        return parts[parts.length - 2] + ' / ' + last
      }
      return last.length > 24 ? last.slice(0, 23) + '…' : last
    }

    /**
     * 找出「当前会话落在哪个已绑定的工作区里」（最长匹配）。
     * 纯客户端计算，不需要宿主参与——所以这部分改动可以热更新。
     */
    function matchBoundWorkspace(workspaces, cwd) {
      var target = String(cwd || '').toLowerCase()
      if (!target || !Array.isArray(workspaces)) return ''
      var best = null
      for (var i = 0; i < workspaces.length; i += 1) {
        var entry = workspaces[i]
        if (!entry || !entry.boundProfileId) continue
        var key = String(entry.path || '').toLowerCase().replace(/[\\/]+$/, '')
        if (!key) continue
        var inside = target === key || target.indexOf(key + '\\') === 0 || target.indexOf(key + '/') === 0
        if (!inside) continue
        if (!best || key.length > best.key.length) best = { key: key, path: entry.path }
      }
      return best ? best.path : ''
    }

    /** 药丸贴着屏幕边缘时最小化：只看锚点位置算，不测量元素，避免「缩小→不再贴边→放大」的抖动循环。 */
    var EDGE_PX = 16
    function isAtScreenEdge(pos) {
      if (!pos || typeof window === 'undefined') return false
      return (
        pos.left <= EDGE_PX ||
        pos.top <= EDGE_PX ||
        pos.left + 150 >= window.innerWidth - EDGE_PX ||
        pos.top + 30 >= window.innerHeight - EDGE_PX
      )
    }

    /** 悬浮面板样式：只注入一次，类名统一加 dshus- 前缀避免撞车。 */
    function ensureStyles() {
      if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return
      var css = [
        '.dshus-pill{position:fixed;z-index:2147483000;display:flex;align-items:center;gap:6px;',
        'padding:5px 10px;border-radius:999px;border:1px solid rgba(128,128,128,.45);',
        'background:rgba(127,127,127,.14);backdrop-filter:blur(8px);color:inherit;cursor:grab;',
        'font:inherit;font-size:12px;line-height:1.4;opacity:.72;transition:opacity .15s,border-color .15s;user-select:none}',
        '.dshus-pill:hover{opacity:1}',
        '.dshus-pill[data-active="1"]{border-color:rgba(80,160,255,.75);opacity:.95}',
        // 贴边最小化：只剩一个圆点，别挡视线；悬停恢复可见度，点开还是完整面板。
        '.dshus-pill[data-min="1"]{padding:6px;border-radius:50%;opacity:.5}',
        '.dshus-pill[data-min="1"]:hover{opacity:1}',
        '.dshus-dot{width:7px;height:7px;border-radius:50%;background:rgba(128,128,128,.7);flex:0 0 auto}',
        '.dshus-pill[data-active="1"] .dshus-dot{background:#4a9eff}',
        '.dshus-panel{position:fixed;z-index:2147483001;width:308px;max-height:76vh;overflow:auto;',
        'border-radius:12px;border:1px solid rgba(128,128,128,.4);background:rgba(28,28,30,.97);',
        'color:#f2f2f2;box-shadow:0 12px 40px rgba(0,0,0,.45);padding:12px;font:inherit;font-size:12px;line-height:1.55}',
        '@media (prefers-color-scheme: light){.dshus-panel{background:rgba(252,252,253,.99);color:#1a1a1a}}',
        '.dshus-h{font-weight:600;font-size:12px;margin:0 0 6px;display:flex;justify-content:space-between;align-items:center;gap:8px}',
        '.dshus-sub{opacity:.62;font-size:11px;word-break:break-all}',
        '.dshus-sec{border-top:1px solid rgba(128,128,128,.25);margin-top:10px;padding-top:10px}',
        '.dshus-row{display:flex;align-items:flex-start;gap:8px;padding:6px 7px;border-radius:8px;cursor:pointer}',
        '.dshus-row:hover{background:rgba(128,128,128,.16)}',
        '.dshus-row[data-sel="1"]{background:rgba(74,158,255,.18);outline:1px solid rgba(74,158,255,.45)}',
        '.dshus-radio{width:12px;height:12px;border-radius:50%;border:1.5px solid rgba(128,128,128,.8);flex:0 0 auto;margin-top:3px}',
        '.dshus-row[data-sel="1"] .dshus-radio{border-color:#4a9eff;background:radial-gradient(circle,#4a9eff 45%,transparent 52%)}',
        '.dshus-name{font-weight:600}',
        '.dshus-tag{font-size:10px;padding:1px 5px;border-radius:999px;background:rgba(128,128,128,.28);margin-left:6px;white-space:nowrap}',
        '.dshus-btns{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}',
        '.dshus-btn{padding:4px 9px;border-radius:7px;border:1px solid rgba(128,128,128,.45);background:transparent;color:inherit;cursor:pointer;font:inherit;font-size:11px}',
        '.dshus-btn:hover{background:rgba(128,128,128,.18)}',
        '.dshus-btn[disabled]{opacity:.4;cursor:default}',
        '.dshus-btn[data-primary="1"]{border-color:rgba(74,158,255,.7);background:rgba(74,158,255,.16)}',
        '.dshus-ta{width:100%;box-sizing:border-box;min-height:88px;resize:vertical;border-radius:8px;',
        '.dshus-select{width:100%;box-sizing:border-box;margin-top:4px;padding:5px 7px;border-radius:7px;',
        'border:1px solid rgba(128,128,128,.45);background:rgba(127,127,127,.12);color:inherit;font:inherit;font-size:11px}',
        'border:1px solid rgba(128,128,128,.4);background:rgba(127,127,127,.10);color:inherit;font:inherit;font-size:11px;padding:6px 8px}',
        '.dshus-pre{white-space:pre-wrap;word-break:break-word;margin:6px 0 0;padding:7px 8px;border-radius:8px;',
        'background:rgba(127,127,127,.13);font-size:11px;max-height:150px;overflow:auto}',
        '.dshus-err{color:#ff6b61;font-size:11px;margin-top:6px}',
        '.dshus-ok{color:#3fb950;font-size:11px;margin-top:6px}',
        '.dshus-close{border:0;background:transparent;color:inherit;cursor:pointer;font:inherit;opacity:.7;padding:2px 4px}',
        '.dshus-close:hover{opacity:1}',
      ].join('')
      var el = document.createElement('style')
      el.id = STYLE_ID
      el.textContent = css
      document.head.appendChild(el)
    }

    function readPosition() {
      try {
        var raw = window.localStorage.getItem(POSITION_KEY)
        if (!raw) return null
        var pos = JSON.parse(raw)
        if (pos && typeof pos.left === 'number' && typeof pos.top === 'number') return pos
      } catch (err) {
        /* 忽略 */
      }
      return null
    }

    function writePosition(pos) {
      try {
        window.localStorage.setItem(POSITION_KEY, JSON.stringify(pos))
      } catch (err) {
        /* 忽略 */
      }
    }

    // -------------------------------------------------------------- 共享状态逻辑

    function useStyleState() {
      var [state, setState] = React.useState(null)
      var [busy, setBusy] = React.useState(false)
      var [error, setError] = React.useState('')
      var [notice, setNotice] = React.useState('')

      function reload() {
        setError('')
        return rpc('getState', {})
          .then(function (next) {
            setState(next)
            return next
          })
          .catch(function (err) {
            setError('读取失败：' + String((err && err.message) || err))
          })
      }

      function call(method, args, message) {
        setBusy(true)
        setError('')
        setNotice('')
        return rpc(method, args)
          .then(function (next) {
            setState(next)
            if (message) setNotice(message)
          })
          .catch(function (err) {
            setError(String((err && err.message) || err))
          })
          .finally(function () {
            setBusy(false)
          })
      }

      React.useEffect(function () {
        reload()
      }, [])

      return { state: state, busy: busy, error: error, notice: notice, reload: reload, call: call, setNotice: setNotice }
    }

    // ----------------------------------------------- 界面一：工作页面上的悬浮面板

    function FloatingStyle(props) {
      var store = useStyleState()
      var state = store.state
      var [open, setOpen] = React.useState(false)
      var [editing, setEditing] = React.useState(false)
      var [draftText, setDraftText] = React.useState('')
      var [selectedId, setSelectedId] = React.useState('')
      var [workspacePath, setWorkspacePath] = React.useState('')
      var [pos, setPos] = React.useState(readPosition)
      var panelRef = React.useRef(null)
      var pillRef = React.useRef(null)
      var dragRef = React.useRef(null)
      var propsSessionId = sessionIdFromProps(props)

      React.useEffect(function () {
        try {
          ensureStyles()
        } catch (err) {
          /* 忽略 */
        }
      }, [])

      var effectiveId = state && state.effective ? state.effective.profileId : ''

      // 生效档案变化时让选中项跟上；用户手动选过就不覆盖。
      React.useEffect(function () {
        if (!state) return
        setSelectedId(function (current) {
          if (current && state.store.profiles.some(function (p) { return p.id === current })) return current
          if (effectiveId) return effectiveId
          return state.store.profiles.length > 0 ? state.store.profiles[0].id : ''
        })
      }, [state])

      // 工作区下拉的选中项：默认当前工作区；用户选过别的就保留（只要它还在列表里）。
      React.useEffect(function () {
        if (!state) return
        var list = Array.isArray(state.workspaces) ? state.workspaces : []
        setWorkspacePath(function (current) {
          if (current && list.some(function (w) { return w.path === current })) return current
          return state.cwd || (list[0] ? list[0].path : '')
        })
      }, [state])

      var selectedProfile = null
      if (state) {
        selectedProfile =
          state.store.profiles.filter(function (p) {
            return p.id === selectedId
          })[0] || null
      }

      // 展开时把选中档案的条目载入编辑框
      React.useEffect(function () {
        if (!open || !editing) return
        if (!selectedProfile) {
          setDraftText('')
          return
        }
        setDraftText(itemsToText(selectedProfile.items) + (selectedProfile.notes ? '\n\n' + selectedProfile.notes : ''))
      }, [open, editing, selectedId, state])

      // 窗口缩放后把药丸拉回可见范围，避免它被留在屏幕外。
      React.useEffect(
        function () {
          function clamp() {
            setPos(function (current) {
              if (!current) return current
              var left = Math.max(0, Math.min(current.left, window.innerWidth - 30))
              var top = Math.max(0, Math.min(current.top, window.innerHeight - 24))
              return left === current.left && top === current.top ? current : { left: left, top: top }
            })
          }
          window.addEventListener('resize', clamp)
          clamp()
          return function () {
            window.removeEventListener('resize', clamp)
          }
        },
        [],
      )

      // 点外部或按 Esc 关闭
      React.useEffect(function () {
        if (!open) return undefined
        function onDown(event) {
          var t = event.target
          if (panelRef.current && panelRef.current.contains(t)) return
          if (pillRef.current && pillRef.current.contains(t)) return
          setOpen(false)
        }
        function onKey(event) {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onDown, true)
        document.addEventListener('keydown', onKey, true)
        return function () {
          document.removeEventListener('mousedown', onDown, true)
          document.removeEventListener('keydown', onKey, true)
        }
      }, [open])

      // 拖动：位移超过阈值算拖动，否则算点击（同一个按钮上兼顾两种手势）
      function onPointerDown(event) {
        if (event.button !== 0 || !pillRef.current) return
        var rect = pillRef.current.getBoundingClientRect()
        dragRef.current = { startX: event.clientX, startY: event.clientY, left: rect.left, top: rect.top, moved: false }
        function onMove(moveEvent) {
          var drag = dragRef.current
          if (!drag) return
          var dx = moveEvent.clientX - drag.startX
          var dy = moveEvent.clientY - drag.startY
          if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return
          drag.moved = true
          setPos({
            left: Math.max(4, Math.min(window.innerWidth - 60, drag.left + dx)),
            top: Math.max(4, Math.min(window.innerHeight - 32, drag.top + dy)),
          })
        }
        function onUp() {
          var drag = dragRef.current
          dragRef.current = null
          document.removeEventListener('mousemove', onMove, true)
          document.removeEventListener('mouseup', onUp, true)
          if (drag && drag.moved) {
            var rect2 = pillRef.current ? pillRef.current.getBoundingClientRect() : null
            if (rect2) writePosition({ left: rect2.left, top: rect2.top })
          } else {
            setOpen(function (v) {
              return !v
            })
            store.reload()
          }
        }
        document.addEventListener('mousemove', onMove, true)
        document.addEventListener('mouseup', onUp, true)
      }

      if (!state) return null

      var effective = state.effective || { profileId: '', source: 'none' }
      var effectiveProfile =
        state.store.profiles.filter(function (p) {
          return p.id === effective.profileId
        })[0] || null

      // 药丸上显示的「范围」：
      //   工作区 → 用户选定的那个文件夹短名（避免只写「当前工作区」让人误解成别的意思）
      //   全局/仅本会话 → 就写这两个词
      var boundPath = matchBoundWorkspace(state.workspaces, state.cwd)
      var scopeText = ''
      var scopeTip = ''
      if (effective.source === 'workspace') {
        var shownPath = boundPath || state.cwd
        scopeText = shortWorkspaceLabel(shownPath)
        scopeTip = '作用范围：工作区 ' + shownPath
      } else if (effective.source === 'session') {
        scopeText = '仅本会话'
        scopeTip = '作用范围：仅本次对话'
      } else if (effective.source === 'default') {
        scopeText = '全局'
        scopeTip = '作用范围：所有对话'
      }

      var minimized = isAtScreenEdge(pos)
      var pillStyle = pos ? { left: pos.left + 'px', top: pos.top + 'px' } : { right: '18px', bottom: '96px' }
      var pillTitle = (effectiveProfile ? '当前：' + effectiveProfile.name + '（' + (scopeTip || SOURCE_LABEL[effective.source] || '未启用') + '）' : '当前未启用任何风格') + '；点击打开，可拖动'

      var pillChildren = [React.createElement('span', { key: 'dot', className: 'dshus-dot' })]
      if (!minimized) {
        pillChildren.push('风格 · ' + (effectiveProfile ? effectiveProfile.name : '未启用'))
        if (effectiveProfile && scopeText) pillChildren.push(React.createElement('span', { key: 'scope', className: 'dshus-tag' }, scopeText))
      }

      var pill = React.createElement(
        'button',
        {
          type: 'button',
          ref: pillRef,
          className: 'dshus-pill',
          style: pillStyle,
          'data-active': effectiveProfile ? '1' : '0',
          'data-min': minimized ? '1' : '0',
          title: pillTitle,
          onMouseDown: onPointerDown,
        },
        pillChildren,
      )

      var panel = null
      if (open) {
        var rect = pillRef.current ? pillRef.current.getBoundingClientRect() : null
        var panelStyle
        if (rect) {
          // 贴边适配：上方空间不够就翻到药丸下方；两侧也都留边距，避免出屏。
          var PANEL_W = 308
          var GAP = 8
          var MARGIN = 8
          var spaceAbove = rect.top - GAP - MARGIN
          var spaceBelow = window.innerHeight - rect.bottom - GAP - MARGIN
          var panelLeft = Math.max(MARGIN, Math.min(rect.left, window.innerWidth - PANEL_W - MARGIN))
          var placeBelow = spaceAbove < 240 && spaceBelow > spaceAbove
          var panelHeight = Math.min(Math.max(placeBelow ? spaceBelow : spaceAbove, 180), Math.round(window.innerHeight * 0.76))
          panelStyle = placeBelow
            ? { left: panelLeft + 'px', top: rect.bottom + GAP + 'px', maxHeight: panelHeight + 'px' }
            : { left: panelLeft + 'px', bottom: window.innerHeight - rect.top + GAP + 'px', maxHeight: panelHeight + 'px' }
        } else {
          panelStyle = { right: '18px', bottom: '140px' }
        }

        var rows = state.store.profiles.map(function (profile) {
          var isSel = profile.id === selectedId
          var isEffective = profile.id === effective.profileId
          return React.createElement(
            'div',
            {
              key: profile.id,
              className: 'dshus-row',
              'data-sel': isSel ? '1' : '0',
              onClick: function () {
                setSelectedId(profile.id)
              },
            },
            React.createElement('span', { className: 'dshus-radio' }),
            React.createElement(
              'span',
              { style: { flex: '1 1 auto', minWidth: 0 } },
              React.createElement('span', { className: 'dshus-name' }, profile.name),
              isEffective ? React.createElement('span', { className: 'dshus-tag' }, '生效中') : null,
              React.createElement('div', { className: 'dshus-sub' }, profile.summary || profile.items.length + ' 条'),
            ),
          )
        })

        // 已知工作区列表（宿主从 DSH 的工作区存储读出）。老版本宿主不给这个字段，
        // 那时退化成「只能应用到当前工作区」，界面不会坏。
        var workspaces = Array.isArray(state.workspaces) && state.workspaces.length > 0 ? state.workspaces : null
        var selectedWorkspace = null
        if (workspaces) {
          selectedWorkspace =
            workspaces.filter(function (w) {
              return w.path === workspacePath
            })[0] || null
        }
        var selectedWorkspaceBinding = null
        if (selectedWorkspace && selectedWorkspace.boundProfileId) {
          selectedWorkspaceBinding =
            state.store.profiles.filter(function (p) {
              return p.id === selectedWorkspace.boundProfileId
            })[0] || null
        }

        var scopeButtons = [
          {
            key: 'default',
            label: '全局',
            title: '所有对话都用它',
            disabled: store.busy || !selectedId,
            primary: effective.source === 'default',
            run: function () {
              store.call('setDefault', { id: selectedId }, '已应用到全局')
            },
          },
          {
            key: 'session',
            label: '仅本会话',
            title: '只有本次对话用它，不改全局',
            disabled: store.busy || !selectedId,
            primary: effective.source === 'session',
            run: function () {
              store.call('setSessionOverride', { sessionId: propsSessionId || state.sessionId, id: selectedId }, '已应用到本次会话')
            },
          },
        ]

        panel = React.createElement(
          'div',
          { className: 'dshus-panel', ref: panelRef, style: panelStyle },
          React.createElement(
            'div',
            { className: 'dshus-h' },
            React.createElement('span', null, '工作风格'),
            React.createElement('button', { type: 'button', className: 'dshus-close', onClick: function () { setOpen(false) }, title: '关闭' }, '✕'),
          ),
          React.createElement(
            'div',
            { className: 'dshus-sub' },
            '当前：' + (effectiveProfile ? effectiveProfile.name : '未启用') + (scopeText ? ' ｜ ' + scopeText : ''),
          ),
          effective.source === 'workspace'
            ? React.createElement('div', { className: 'dshus-sub' }, '绑定的工作区：' + (boundPath || state.cwd))
            : null,
          React.createElement('div', { className: 'dshus-sub' }, '本会话工作区：' + (state.cwd || '（未知）')),

          React.createElement('div', { className: 'dshus-sec' }, React.createElement('div', { className: 'dshus-h' }, '选择档案'), rows),

          React.createElement(
            'div',
            { className: 'dshus-sec' },
            React.createElement('div', { className: 'dshus-h' }, '应用到'),
            React.createElement(
              'div',
              { className: 'dshus-btns' },
              scopeButtons.map(function (b) {
                return React.createElement(
                  'button',
                  {
                    key: b.key,
                    type: 'button',
                    className: 'dshus-btn',
                    'data-primary': b.primary ? '1' : '0',
                    disabled: b.disabled,
                    title: b.title,
                    onClick: b.run,
                  },
                  b.label,
                )
              }),
            ),
            React.createElement(
              'div',
              { className: 'dshus-btns' },
              React.createElement(
                'button',
                {
                  type: 'button',
                  className: 'dshus-btn',
                  disabled: store.busy,
                  onClick: function () {
                    store.call('setSessionOverride', { sessionId: propsSessionId || state.sessionId, id: '' }, '已清除本会话')
                  },
                },
                '清除本会话',
              ),
              React.createElement(
                'button',
                {
                  type: 'button',
                  className: 'dshus-btn',
                  disabled: store.busy,
                  onClick: function () {
                    store.call('setDefault', { id: '' }, '已停用全局默认')
                  },
                },
                '停用全局',
              ),
            ),

            // 工作区：从已知工作区里挑，而不是只认「当前」那一个。
            workspaces
              ? React.createElement(
                  'div',
                  null,
                  React.createElement('div', { className: 'dshus-sub', style: { marginTop: 10 } }, '工作区（可挑选任意一个）'),
                  React.createElement(
                    'select',
                    {
                      className: 'dshus-select',
                      value: workspacePath,
                      onChange: function (event) {
                        setWorkspacePath(event.target.value)
                      },
                    },
                    workspaces.map(function (w) {
                      var bindingName = ''
                      if (w.boundProfileId) {
                        var bound = state.store.profiles.filter(function (p) { return p.id === w.boundProfileId })[0]
                        bindingName = bound ? bound.name : w.boundProfileId
                      }
                      return React.createElement(
                        'option',
                        { key: w.path, value: w.path },
                        w.path +
                          (w.isCurrent ? '  （当前）' : '') +
                          (bindingName ? '  · 已绑定：' + bindingName : '') +
                          (!w.boundProfileId && w.sessionCount ? '  · ' + w.sessionCount + ' 个会话' : ''),
                      )
                    }),
                  ),
                  React.createElement(
                    'div',
                    { className: 'dshus-btns' },
                    React.createElement(
                      'button',
                      {
                        type: 'button',
                        className: 'dshus-btn',
                        'data-primary': selectedWorkspace && selectedWorkspace.isCurrent && effective.source === 'workspace' ? '1' : '0',
                        disabled: store.busy || !selectedId || !workspacePath,
                        onClick: function () {
                          store.call('bindWorkspace', { cwd: workspacePath, id: selectedId }, '已应用到该工作区')
                        },
                      },
                      selectedWorkspace && selectedWorkspace.isCurrent ? '应用到此工作区（当前）' : '应用到此工作区',
                    ),
                    React.createElement(
                      'button',
                      {
                        type: 'button',
                        className: 'dshus-btn',
                        disabled: store.busy || !workspacePath || !selectedWorkspaceBinding,
                        title: selectedWorkspaceBinding ? '解除后该工作区会跟随全局' : '该工作区当前没有绑定',
                        onClick: function () {
                          store.call('bindWorkspace', { cwd: workspacePath, id: '' }, '已解除该工作区的绑定')
                        },
                      },
                      '解除绑定',
                    ),
                  ),
                  React.createElement(
                    'div',
                    { className: 'dshus-sub' },
                    selectedWorkspaceBinding
                      ? '该工作区当前绑定：' + selectedWorkspaceBinding.name
                      : '该工作区未绑定（会跟随全局设置）',
                  ),
                  state.workspacesReadError
                    ? React.createElement('div', { className: 'dshus-sub' }, '（工作区列表读取不完整，仅供参考）')
                    : null,
                )
              : React.createElement(
                  'div',
                  null,
                  React.createElement('div', { className: 'dshus-sub', style: { marginTop: 10 } }, '工作区'),
                  React.createElement(
                    'div',
                    { className: 'dshus-btns' },
                    React.createElement(
                      'button',
                      {
                        type: 'button',
                        className: 'dshus-btn',
                        disabled: store.busy || !selectedId || !state.cwd,
                        onClick: function () {
                          store.call('bindWorkspace', { cwd: state.cwd, id: selectedId }, '已应用到当前工作区')
                        },
                      },
                      '当前工作区',
                    ),
                  ),
                  React.createElement('div', { className: 'dshus-sub' }, '（宿主版本较旧，暂时只能选当前工作区）'),
                ),
          ),

          React.createElement(
            'div',
            { className: 'dshus-sec' },
            React.createElement(
              'div',
              { className: 'dshus-h' },
              React.createElement('span', null, '编辑「' + (selectedProfile ? selectedProfile.name : '—') + '」'),
              React.createElement(
                'button',
                { type: 'button', className: 'dshus-close', onClick: function () { setEditing(function (v) { return !v }) } },
                editing ? '收起' : '展开',
              ),
            ),
            editing
              ? React.createElement(
                  'div',
                  null,
                  React.createElement('div', { className: 'dshus-sub' }, '一行一条；空行之后的内容算补充说明'),
                  React.createElement('textarea', {
                    className: 'dshus-ta',
                    value: draftText,
                    onChange: function (event) {
                      setDraftText(event.target.value)
                    },
                  }),
                  React.createElement(
                    'div',
                    { className: 'dshus-btns' },
                    React.createElement(
                      'button',
                      {
                        type: 'button',
                        className: 'dshus-btn',
                        'data-primary': '1',
                        disabled: store.busy || !selectedId,
                        onClick: function () {
                          var parts = String(draftText).split(/\n\s*\n/)
                          store.call(
                            'upsertProfile',
                            {
                              id: selectedId,
                              name: selectedProfile ? selectedProfile.name : '',
                              summary: selectedProfile ? selectedProfile.summary : '',
                              items: textToItems(parts[0] || ''),
                              notes: parts.slice(1).join('\n\n').trim(),
                            },
                            '已保存',
                          )
                        },
                      },
                      '保存',
                    ),
                  ),
                  React.createElement('pre', { className: 'dshus-pre' }, renderLocalPreview(draftText, '')),
                )
              : React.createElement('pre', { className: 'dshus-pre' }, state.preview || '（空：当前没有启用任何风格档案）'),
          ),

          store.error ? React.createElement('div', { className: 'dshus-err' }, store.error) : null,
          store.notice ? React.createElement('div', { className: 'dshus-ok' }, store.notice) : null,
        )
      }

      var content = React.createElement('div', null, pill, panel)
      if (ReactDOM) return ReactDOM.createPortal(content, document.body)
      return content
    }

    // --------------------------------------------------- 界面二：插件页里的完整设置页

    function UserStyleConfig() {
      var store = useStyleState()
      var state = store.state
      var [selectedId, setSelectedId] = React.useState('')
      var [draft, setDraft] = React.useState({ name: '', summary: '', itemsText: '', notes: '' })

      React.useEffect(function () {
        if (!state) return
        var effectiveId = state.effective && state.effective.profileId ? state.effective.profileId : ''
        setSelectedId(function (current) {
          if (current && state.store.profiles.some(function (p) { return p.id === current })) return current
          if (effectiveId) return effectiveId
          return state.store.profiles.length > 0 ? state.store.profiles[0].id : ''
        })
      }, [state])

      React.useEffect(function () {
        if (!state || !selectedId) {
          setDraft({ name: '', summary: '', itemsText: '', notes: '' })
          return
        }
        var found =
          state.store.profiles.filter(function (p) {
            return p.id === selectedId
          })[0] || null
        if (!found) return
        setDraft({
          name: found.name || '',
          summary: found.summary || '',
          itemsText: itemsToText(found.items),
          notes: found.notes || '',
        })
      }, [state, selectedId])

      if (!state) {
        return React.createElement('div', { style: { padding: 8 } }, store.error || '正在读取风格档案…')
      }

      var effective = state.effective || { profileId: '', source: 'none' }
      var sourceLabel = SOURCE_LABEL[effective.source] || effective.source
      var box = { border: '1px solid rgba(128,128,128,.28)', borderRadius: 8, padding: 12, marginBottom: 12 }
      var inputStyle = {
        width: '100%',
        boxSizing: 'border-box',
        padding: '6px 8px',
        borderRadius: 6,
        border: '1px solid rgba(128,128,128,.35)',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
      }
      var areaStyle = Object.assign({}, inputStyle, { minHeight: 132, resize: 'vertical' })
      var btn = {
        padding: '5px 10px',
        borderRadius: 6,
        border: '1px solid rgba(128,128,128,.4)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
      }
      var btnPrimary = Object.assign({}, btn, { background: 'rgba(128,128,128,.18)', fontWeight: 600 })

      function profileRow(profile) {
        var isSelected = profile.id === selectedId
        var isDefault = state.store.defaultProfileId === profile.id
        return React.createElement(
          'li',
          {
            key: profile.id,
            style: {
              padding: '6px 8px',
              borderRadius: 6,
              cursor: 'pointer',
              background: isSelected ? 'rgba(128,128,128,.16)' : 'transparent',
            },
            onClick: function () {
              setSelectedId(profile.id)
            },
          },
          React.createElement('strong', null, profile.name),
          isDefault ? React.createElement('span', { style: { opacity: 0.65, fontSize: 12 } }, ' · 全局默认') : null,
          React.createElement('div', { style: { opacity: 0.65, fontSize: 12 } }, profile.summary || profile.items.length + ' 条'),
        )
      }

      return React.createElement(
        'div',
        { style: { padding: '4px 2px', fontSize: 13, lineHeight: 1.6 } },
        React.createElement(
          'div',
          { style: box },
          React.createElement('div', { style: { fontWeight: 600, marginBottom: 8 } }, '当前生效'),
          React.createElement('div', null, '来源：' + sourceLabel + (effective.profileId ? ' ｜ 档案：' + effective.profileId : '')),
          state.cwd ? React.createElement('div', { style: { opacity: 0.65, fontSize: 12 } }, '工作区：' + state.cwd) : null,
          React.createElement('div', { style: { opacity: 0.65, fontSize: 12 } }, '数据目录：' + state.dataDir),
          store.error ? React.createElement('div', { style: { color: '#e5534b', fontSize: 12 } }, store.error) : null,
          store.notice ? React.createElement('div', { style: { color: '#3fb950', fontSize: 12 } }, store.notice) : null,
        ),
        React.createElement(
          'div',
          { style: { display: 'flex', gap: 16, flexWrap: 'wrap' } },
          React.createElement(
            'div',
            { style: { flex: '1 1 320px', minWidth: 280 } },
            React.createElement(
              'div',
              { style: box },
              React.createElement('div', { style: { fontWeight: 600, marginBottom: 8 } }, '档案（' + state.store.profiles.length + '）'),
              React.createElement('ul', { style: { listStyle: 'none', margin: 0, padding: 0 } }, state.store.profiles.map(profileRow)),
              React.createElement(
                'div',
                { style: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' } },
                React.createElement('button', { style: btnPrimary, disabled: store.busy || !selectedId, onClick: function () { store.call('setDefault', { id: selectedId }, '已设为全局默认') } }, '设为全局默认'),
                React.createElement('button', { style: btn, disabled: store.busy, onClick: function () { store.call('setDefault', { id: '' }, '已停用全局默认') } }, '停用默认'),
                React.createElement('button', { style: btn, disabled: store.busy || !selectedId, onClick: function () { store.call('bindWorkspace', { id: selectedId }, '已绑定到当前工作区') } }, '绑定当前工作区'),
                React.createElement('button', { style: btn, disabled: store.busy || !selectedId, onClick: function () { store.call('setSessionOverride', { id: selectedId }, '本会话已临时切换') } }, '仅本会话'),
                React.createElement('button', { style: btn, disabled: store.busy, onClick: function () { store.call('setSessionOverride', { id: '' }, '已清除本会话覆盖') } }, '清除会话覆盖'),
              ),
            ),
          ),
          React.createElement(
            'div',
            { style: { flex: '1 1 320px', minWidth: 280 } },
            React.createElement(
              'div',
              { style: box },
              React.createElement('div', { style: { fontWeight: 600, marginBottom: 8 } }, '编辑'),
              React.createElement('div', { style: { opacity: 0.65, fontSize: 12 } }, '名称'),
              React.createElement('input', { style: inputStyle, value: draft.name, onChange: function (e) { setDraft(Object.assign({}, draft, { name: e.target.value })) } }),
              React.createElement('div', { style: { opacity: 0.65, fontSize: 12, marginTop: 8 } }, '一句话说明'),
              React.createElement('input', { style: inputStyle, value: draft.summary, onChange: function (e) { setDraft(Object.assign({}, draft, { summary: e.target.value })) } }),
              React.createElement('div', { style: { opacity: 0.65, fontSize: 12, marginTop: 8 } }, '风格条目（一行一条，会被逐条注入）'),
              React.createElement('textarea', { style: areaStyle, value: draft.itemsText, onChange: function (e) { setDraft(Object.assign({}, draft, { itemsText: e.target.value })) } }),
              React.createElement('div', { style: { opacity: 0.65, fontSize: 12, marginTop: 8 } }, '补充说明（可选，整段附在条目之后）'),
              React.createElement('textarea', { style: Object.assign({}, areaStyle, { minHeight: 64 }), value: draft.notes, onChange: function (e) { setDraft(Object.assign({}, draft, { notes: e.target.value })) } }),
              React.createElement(
                'div',
                { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 } },
                React.createElement('button', { style: btnPrimary, disabled: store.busy || !selectedId, onClick: function () { store.call('upsertProfile', Object.assign({ id: selectedId }, draft), '已保存') } }, '保存'),
                React.createElement('button', { style: btn, disabled: store.busy, onClick: function () { store.call('upsertProfile', Object.assign({}, draft, { id: '', name: (draft.name || '风格') + ' 副本' }), '已另存为新档案') } }, '另存为新档案'),
                React.createElement('button', { style: btn, disabled: store.busy || !selectedId, onClick: function () { if (window.confirm('确定删除档案「' + draft.name + '」？')) store.call('deleteProfile', { id: selectedId }, '已删除') } }, '删除'),
                React.createElement('button', { style: btn, disabled: store.busy, onClick: function () { store.reload().then(function () { store.setNotice('已刷新') }) } }, '刷新'),
              ),
            ),
            React.createElement(
              'div',
              { style: box },
              React.createElement('div', { style: { fontWeight: 600, marginBottom: 8 } }, '这份草稿会注入的内容'),
              React.createElement('pre', { style: { whiteSpace: 'pre-wrap', margin: 0, fontSize: 12 } }, renderLocalPreview(draft.itemsText, draft.notes)),
            ),
            React.createElement(
              'div',
              { style: box },
              React.createElement('div', { style: { fontWeight: 600, marginBottom: 8 } }, '当前实际注入的内容'),
              React.createElement('pre', { style: { whiteSpace: 'pre-wrap', margin: 0, fontSize: 12 } }, state.preview || '（空：当前没有启用任何风格档案）'),
            ),
          ),
        ),
      )
    }

    // ---------------------------------------------------------------------- 装配

    module.exports = {
      inject: ['slots'],
      async apply(ctx) {
        try {
          ensureStyles()
        } catch (err) {
          /* 样式注入失败不影响注册 */
        }

        var slots = null
        try { slots = ctx.slots } catch (err) { slots = null }
        if (!slots && typeof ctx.get === 'function') {
          try { slots = ctx.get('slots') } catch (err) { slots = null }
        }
        if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
          console.warn('[dsh-user-style] slots 服务不可用，界面未挂载')
          return
        }

        // 工作页面上的悬浮面板：挂在输入框 dock 槽位（同 profile 的底部信息栏插件验证过它）。
        // 组件本身 portal 到 body，所以不受 dock 布局与滚动容器影响。
        slots.inject(DOCK_SLOT, function () {
          return slots.register({ name: DOCK_SLOT, id: BUNDLE_ID, priority: -900 }, function (slotProps) {
            return React.createElement(FloatingStyle, slotProps || {})
          })
        })

        // 插件页里的完整设置页。plugins.bundle.config 是带 key 的槽位：DSH 校验的是 key
        // （bundle 包名），不是列表槽位的 id 字段；用错会让整个 web 条目在启动时失败。
        slots.inject(CONFIG_SLOT, function () {
          return slots.register({ name: CONFIG_SLOT, key: BUNDLE_ID, label: function () { return '工作风格' } }, UserStyleConfig)
        })
      },

      // 测试钩子：这几个纯函数的效果只体现在界面文字和位置上，肉眼难核对，
      // 交给 tests/test-client.mjs 断言（Cordis 只读 name/inject/apply，多一个键无副作用）。
      __test: {
        shortWorkspaceLabel: shortWorkspaceLabel,
        matchBoundWorkspace: matchBoundWorkspace,
        isAtScreenEdge: isAtScreenEdge,
      },
    }

    return module.exports
  },
})
