const DEFAULT_PORT = 18792

const BADGE = {
  on: { text: 'ON', color: '#FF5A36' },
  off: { text: '', color: '#000000' },
  connecting: { text: '…', color: '#F59E0B' },
  error: { text: '!', color: '#B91C1C' },
}

const KEEPALIVE_ALARM = 'openclaw-keepalive'
const KEEPALIVE_INTERVAL_MIN = 0.4 // ~24s, under Chrome's 30s kill threshold
const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 30000
const NOTIFICATION_ID = 'openclaw-relay-status'

let alwaysOn = true

/** @type {WebSocket|null} */
let relayWs = null
/** @type {Promise<void>|null} */
let relayConnectPromise = null

let debuggerListenersInstalled = false

let nextSession = 1
let reconnectDelay = RECONNECT_BASE_MS
/** @type {number|null} */
let reconnectTimer = null
let wasConnected = false

/** @type {Map<number, {state:'connecting'|'connected', sessionId?:string, targetId?:string, attachOrder?:number}>} */
const tabs = new Map()
/** @type {Map<string, number>} */
const tabBySession = new Map()
/** @type {Map<string, number>} */
const childSessionToTab = new Map()

/** @type {Map<number, {resolve:(v:any)=>void, reject:(e:Error)=>void}>} */
const pending = new Map()

// ─── Keepalive via chrome.alarms ────────────────────────────────────────────

function startKeepalive() {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: KEEPALIVE_INTERVAL_MIN })
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return
  // Just touching the service worker keeps it alive.
  // Also nudge reconnect if we should be connected but aren't.
  if (alwaysOn && (!relayWs || relayWs.readyState !== WebSocket.OPEN)) {
    scheduleReconnect()
  }
})

startKeepalive()

// ─── Helpers ────────────────────────────────────────────────────────────────

function nowStack() {
  try {
    return new Error().stack || ''
  } catch {
    return ''
  }
}

async function getRelayPort() {
  const stored = await chrome.storage.local.get(['relayPort'])
  const raw = stored.relayPort
  const n = Number.parseInt(String(raw || ''), 10)
  if (!Number.isFinite(n) || n <= 0 || n > 65535) return DEFAULT_PORT
  return n
}

function setBadge(tabId, kind) {
  const cfg = BADGE[kind]
  void chrome.action.setBadgeText({ tabId, text: cfg.text }).catch(() => {})
  void chrome.action.setBadgeBackgroundColor({ tabId, color: cfg.color }).catch(() => {})
  void chrome.action.setBadgeTextColor({ tabId, color: '#FFFFFF' }).catch(() => {})
}

function isEligibleUrl(url) {
  if (!url) return false
  return !url.startsWith('chrome://') && !url.startsWith('chrome-extension://') && !url.startsWith('devtools://')
}

// ─── Notifications ──────────────────────────────────────────────────────────

function notify(title, message) {
  chrome.notifications.create(NOTIFICATION_ID, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title,
    message,
    priority: 1,
  }, () => {
    // Auto-clear after 4 seconds
    setTimeout(() => chrome.notifications.clear(NOTIFICATION_ID, () => {}), 4000)
  })
}

// ─── Relay connection ───────────────────────────────────────────────────────

async function ensureRelayConnection() {
  if (relayWs && relayWs.readyState === WebSocket.OPEN) return
  if (relayConnectPromise) return await relayConnectPromise

  relayConnectPromise = (async () => {
    const port = await getRelayPort()
    const httpBase = `http://127.0.0.1:${port}`
    const wsUrl = `ws://127.0.0.1:${port}/extension`

    // Fast preflight: is the relay server up?
    try {
      await fetch(`${httpBase}/`, { method: 'HEAD', signal: AbortSignal.timeout(2000) })
    } catch (err) {
      throw new Error(`Relay server not reachable at ${httpBase} (${String(err)})`)
    }

    const ws = new WebSocket(wsUrl)
    relayWs = ws

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WebSocket connect timeout')), 5000)
      ws.onopen = () => {
        clearTimeout(t)
        resolve()
      }
      ws.onerror = () => {
        clearTimeout(t)
        reject(new Error('WebSocket connect failed'))
      }
      ws.onclose = (ev) => {
        clearTimeout(t)
        reject(new Error(`WebSocket closed (${ev.code} ${ev.reason || 'no reason'})`))
      }
    })

    ws.onmessage = (event) => void onRelayMessage(String(event.data || ''))
    ws.onclose = () => onRelayClosed('closed')
    ws.onerror = () => onRelayClosed('error')

    if (!debuggerListenersInstalled) {
      debuggerListenersInstalled = true
      chrome.debugger.onEvent.addListener(onDebuggerEvent)
      chrome.debugger.onDetach.addListener(onDebuggerDetach)
    }

    // Connection succeeded — reset backoff
    reconnectDelay = RECONNECT_BASE_MS

    // Notify recovery if we were previously connected
    if (wasConnected) {
      notify('OpenClaw Relay', 'Reconnected to relay server')
    }
    wasConnected = true
  })()

  try {
    await relayConnectPromise
  } finally {
    relayConnectPromise = null
  }
}

function onRelayClosed(reason) {
  relayWs = null
  for (const [id, p] of pending.entries()) {
    pending.delete(id)
    p.reject(new Error(`Relay disconnected (${reason})`))
  }

  // Keep debugger sessions alive — only update badges to show relay is reconnecting.
  // We do NOT detach from the Chrome debugger here. The debugger sessions survive
  // independently of the relay WebSocket. On reconnect we re-announce them.
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.state === 'connected') {
      setBadge(tabId, 'connecting')
      void chrome.action.setTitle({
        tabId,
        title: 'OpenClaw Browser Relay: relay reconnecting…',
      }).catch(() => {})
    }
  }
  // Clear child sessions — they reference relay-side state that won't survive restart
  childSessionToTab.clear()

  // Notify user of disconnection
  if (wasConnected) {
    notify('OpenClaw Relay', 'Disconnected from relay server — reconnecting…')
  }

  // Auto-reconnect with exponential backoff
  if (alwaysOn) {
    scheduleReconnect()
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return // already scheduled
  if (relayWs && relayWs.readyState === WebSocket.OPEN) return // already connected

  const delay = reconnectDelay
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS)

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null
    try {
      await ensureRelayConnection()
      // Re-announce tabs whose debugger sessions survived the relay restart
      await reannounceExistingTabs()
      // Attach any new tabs that appeared while disconnected
      await attachAllEligibleTabs()
      // Send tab inventory so relay knows what we have
      sendTabInventory()
    } catch {
      // Will retry via next alarm or next scheduleReconnect call
      if (alwaysOn) {
        scheduleReconnect()
      }
    }
  }, delay)
}

function sendToRelay(payload) {
  const ws = relayWs
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error('Relay not connected')
  }
  ws.send(JSON.stringify(payload))
}

async function maybeOpenHelpOnce() {
  try {
    const stored = await chrome.storage.local.get(['helpOnErrorShown'])
    if (stored.helpOnErrorShown === true) return
    await chrome.storage.local.set({ helpOnErrorShown: true })
    await chrome.runtime.openOptionsPage()
  } catch {
    // ignore
  }
}

function requestFromRelay(command) {
  const id = command.id
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    try {
      sendToRelay(command)
    } catch (err) {
      pending.delete(id)
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

// ─── Re-announce surviving debugger sessions after relay reconnect ──────────

async function reannounceExistingTabs() {
  const entries = [...tabs.entries()]
  for (const [tabId, tab] of entries) {
    if (tab.state !== 'connected' || !tab.sessionId || !tab.targetId) continue
    try {
      // Verify debugger is still attached by querying target info
      const info = /** @type {any} */ (
        await chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo')
      )
      const targetInfo = info?.targetInfo
      if (!targetInfo) throw new Error('no targetInfo')

      // Re-announce to the new relay connection
      sendToRelay({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.attachedToTarget',
          params: {
            sessionId: tab.sessionId,
            targetInfo: { ...targetInfo, attached: true },
            waitingForDebugger: false,
          },
        },
      })
      setBadge(tabId, 'on')
      void chrome.action.setTitle({
        tabId,
        title: 'OpenClaw Browser Relay: attached (click to detach)',
      }).catch(() => {})
    } catch {
      // Debugger session died (tab closed, navigated to chrome://, etc.) — clean up
      if (tab.sessionId) tabBySession.delete(tab.sessionId)
      tabs.delete(tabId)
      setBadge(tabId, 'off')
    }
  }
}

// ─── Tab inventory ──────────────────────────────────────────────────────────

function sendTabInventory() {
  try {
    const inventory = []
    for (const [tabId, tab] of tabs.entries()) {
      if (tab.state === 'connected' && tab.sessionId && tab.targetId) {
        inventory.push({
          tabId,
          sessionId: tab.sessionId,
          targetId: tab.targetId,
        })
      }
    }
    sendToRelay({
      method: 'tabInventory',
      params: { tabs: inventory },
    })
  } catch {
    // ignore — relay may not be ready
  }
}

// ─── Attach all eligible tabs ───────────────────────────────────────────────

async function attachAllEligibleTabs() {
  const allTabs = await chrome.tabs.query({})
  const promises = []
  for (const tab of allTabs) {
    if (!tab.id) continue
    if (tabs.has(tab.id)) continue
    const url = tab.url || tab.pendingUrl || ''
    if (!isEligibleUrl(url)) continue
    promises.push(autoAttachTab(tab.id))
  }
  await Promise.allSettled(promises)
}

// ─── Relay message handling ─────────────────────────────────────────────────

async function onRelayMessage(text) {
  /** @type {any} */
  let msg
  try {
    msg = JSON.parse(text)
  } catch {
    return
  }

  if (msg && msg.method === 'ping') {
    try {
      sendToRelay({ method: 'pong' })
    } catch {
      // ignore
    }
    return
  }

  if (msg && typeof msg.id === 'number' && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.error) p.reject(new Error(String(msg.error)))
    else p.resolve(msg.result)
    return
  }

  if (msg && typeof msg.id === 'number' && msg.method === 'forwardCDPCommand') {
    try {
      const result = await handleForwardCdpCommand(msg)
      sendToRelay({ id: msg.id, result })
    } catch (err) {
      sendToRelay({ id: msg.id, error: err instanceof Error ? err.message : String(err) })
    }
  }
}

// ─── Tab/session lookup ─────────────────────────────────────────────────────

function getTabBySessionId(sessionId) {
  const direct = tabBySession.get(sessionId)
  if (direct) return { tabId: direct, kind: 'main' }
  const child = childSessionToTab.get(sessionId)
  if (child) return { tabId: child, kind: 'child' }
  return null
}

function getTabByTargetId(targetId) {
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.targetId === targetId) return tabId
  }
  return null
}

// ─── Attach / detach ────────────────────────────────────────────────────────

async function attachTab(tabId, opts = {}) {
  const debuggee = { tabId }
  await chrome.debugger.attach(debuggee, '1.3')
  await chrome.debugger.sendCommand(debuggee, 'Page.enable').catch(() => {})

  const info = /** @type {any} */ (await chrome.debugger.sendCommand(debuggee, 'Target.getTargetInfo'))
  const targetInfo = info?.targetInfo
  const targetId = String(targetInfo?.targetId || '').trim()
  if (!targetId) {
    throw new Error('Target.getTargetInfo returned no targetId')
  }

  const sessionId = `cb-tab-${nextSession++}`
  const attachOrder = nextSession

  tabs.set(tabId, { state: 'connected', sessionId, targetId, attachOrder })
  tabBySession.set(sessionId, tabId)
  void chrome.action.setTitle({
    tabId,
    title: 'OpenClaw Browser Relay: attached (click to detach)',
  }).catch(() => {})

  if (!opts.skipAttachedEvent) {
    sendToRelay({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.attachedToTarget',
        params: {
          sessionId,
          targetInfo: { ...targetInfo, attached: true },
          waitingForDebugger: false,
        },
      },
    })
  }

  setBadge(tabId, 'on')
  return { sessionId, targetId }
}

async function detachTab(tabId, reason) {
  const tab = tabs.get(tabId)
  if (tab?.sessionId && tab?.targetId) {
    try {
      sendToRelay({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.detachedFromTarget',
          params: { sessionId: tab.sessionId, targetId: tab.targetId, reason },
        },
      })
    } catch {
      // ignore
    }
  }

  if (tab?.sessionId) tabBySession.delete(tab.sessionId)
  tabs.delete(tabId)

  for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
    if (parentTabId === tabId) childSessionToTab.delete(childSessionId)
  }

  try {
    await chrome.debugger.detach({ tabId })
  } catch {
    // ignore
  }

  setBadge(tabId, 'off')
  void chrome.action.setTitle({
    tabId,
    title: 'OpenClaw Browser Relay (click to attach/detach)',
  }).catch(() => {})
}

// ─── Click handler (toggle for active tab) ──────────────────────────────────

async function connectOrToggleForActiveTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
  const tabId = active?.id
  if (!tabId) return

  const existing = tabs.get(tabId)
  if (existing?.state === 'connected') {
    await detachTab(tabId, 'toggle')
    return
  }

  tabs.set(tabId, { state: 'connecting' })
  setBadge(tabId, 'connecting')
  void chrome.action.setTitle({
    tabId,
    title: 'OpenClaw Browser Relay: connecting to local relay…',
  }).catch(() => {})

  try {
    await ensureRelayConnection()
    await attachTab(tabId)
  } catch (err) {
    tabs.delete(tabId)
    setBadge(tabId, 'error')
    void chrome.action.setTitle({
      tabId,
      title: 'OpenClaw Browser Relay: relay not running (open options for setup)',
    }).catch(() => {})
    void maybeOpenHelpOnce()
    const message = err instanceof Error ? err.message : String(err)
    console.warn('attach failed', message, nowStack())
  }
}

// ─── CDP command handler ────────────────────────────────────────────────────

async function handleForwardCdpCommand(msg) {
  const method = String(msg?.params?.method || '').trim()
  const params = msg?.params?.params || undefined
  const sessionId = typeof msg?.params?.sessionId === 'string' ? msg.params.sessionId : undefined

  // Map command to tab
  const bySession = sessionId ? getTabBySessionId(sessionId) : null
  const targetId = typeof params?.targetId === 'string' ? params.targetId : undefined
  const tabId =
    bySession?.tabId ||
    (targetId ? getTabByTargetId(targetId) : null) ||
    (() => {
      // No sessionId: pick the first connected tab (stable-ish).
      for (const [id, tab] of tabs.entries()) {
        if (tab.state === 'connected') return id
      }
      return null
    })()

  if (!tabId) throw new Error(`No attached tab for method ${method}`)

  /** @type {chrome.debugger.DebuggerSession} */
  const debuggee = { tabId }

  if (method === 'Runtime.enable') {
    try {
      await chrome.debugger.sendCommand(debuggee, 'Runtime.disable')
      await new Promise((r) => setTimeout(r, 50))
    } catch {
      // ignore
    }
    return await chrome.debugger.sendCommand(debuggee, 'Runtime.enable', params)
  }

  if (method === 'Target.createTarget') {
    const url = typeof params?.url === 'string' ? params.url : 'about:blank'
    const tab = await chrome.tabs.create({ url, active: false })
    if (!tab.id) throw new Error('Failed to create tab')
    await new Promise((r) => setTimeout(r, 100))
    const attached = await attachTab(tab.id)
    return { targetId: attached.targetId }
  }

  if (method === 'Target.closeTarget') {
    const target = typeof params?.targetId === 'string' ? params.targetId : ''
    const toClose = target ? getTabByTargetId(target) : tabId
    if (!toClose) return { success: false }
    try {
      await chrome.tabs.remove(toClose)
    } catch {
      return { success: false }
    }
    return { success: true }
  }

  if (method === 'Target.activateTarget') {
    const target = typeof params?.targetId === 'string' ? params.targetId : ''
    const toActivate = target ? getTabByTargetId(target) : tabId
    if (!toActivate) return {}
    const tab = await chrome.tabs.get(toActivate).catch(() => null)
    if (!tab) return {}
    if (tab.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {})
    }
    await chrome.tabs.update(toActivate, { active: true }).catch(() => {})
    return {}
  }

  const tabState = tabs.get(tabId)
  const mainSessionId = tabState?.sessionId
  const debuggerSession =
    sessionId && mainSessionId && sessionId !== mainSessionId
      ? { ...debuggee, sessionId }
      : debuggee

  return await chrome.debugger.sendCommand(debuggerSession, method, params)
}

// ─── Debugger event forwarding ──────────────────────────────────────────────

function onDebuggerEvent(source, method, params) {
  const tabId = source.tabId
  if (!tabId) return
  const tab = tabs.get(tabId)
  if (!tab?.sessionId) return

  if (method === 'Target.attachedToTarget' && params?.sessionId) {
    childSessionToTab.set(String(params.sessionId), tabId)
  }

  if (method === 'Target.detachedFromTarget' && params?.sessionId) {
    childSessionToTab.delete(String(params.sessionId))
  }

  try {
    sendToRelay({
      method: 'forwardCDPEvent',
      params: {
        sessionId: source.sessionId || tab.sessionId,
        method,
        params,
      },
    })
  } catch {
    // ignore
  }
}

function onDebuggerDetach(source, reason) {
  const tabId = source.tabId
  if (!tabId) return
  if (!tabs.has(tabId)) return
  void detachTab(tabId, reason)
}

// ─── Tab lifecycle events → relay ───────────────────────────────────────────

function forwardTabEvent(eventName, details) {
  try {
    sendToRelay({
      method: 'tabLifecycleEvent',
      params: { event: eventName, ...details },
    })
  } catch {
    // ignore — relay may not be connected
  }
}

// New tab created → auto-attach + notify relay
chrome.tabs.onCreated.addListener((tab) => {
  forwardTabEvent('tabCreated', {
    tabId: tab.id,
    url: tab.url || tab.pendingUrl || '',
    title: tab.title || '',
  })
  if (tab.id && alwaysOn) {
    // Small delay — tab may not have a URL yet
    setTimeout(() => void autoAttachTab(tab.id), 300)
  }
})

// Tab removed → notify relay
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  forwardTabEvent('tabRemoved', { tabId, windowId: removeInfo.windowId, isWindowClosing: removeInfo.isWindowClosing })
  // Clean up local state if we were tracking it
  const tab = tabs.get(tabId)
  if (tab) {
    if (tab.sessionId) tabBySession.delete(tab.sessionId)
    tabs.delete(tabId)
    for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
      if (parentTabId === tabId) childSessionToTab.delete(childSessionId)
    }
  }
})

// Tab URL/title updated → notify relay
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' || changeInfo.url || changeInfo.title) {
    forwardTabEvent('tabUpdated', {
      tabId,
      url: tab.url || '',
      title: tab.title || '',
      status: changeInfo.status,
      urlChanged: !!changeInfo.url,
    })
  }
  // Auto-attach on complete (handles navigations in existing tabs)
  if (changeInfo.status === 'complete' && alwaysOn) {
    void autoAttachTab(tabId)
  }
})

// Navigation completed → notify relay
chrome.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId !== 0) return // only top-level frame
  forwardTabEvent('navigationCompleted', {
    tabId: details.tabId,
    url: details.url,
  })
})

// Navigation committed → ensure tab stays attached
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return
  if (alwaysOn && details.tabId) {
    // Re-attach after navigation if needed (debugger can detach on cross-origin nav)
    setTimeout(() => void autoAttachTab(details.tabId), 200)
  }
})

// ─── Action click ───────────────────────────────────────────────────────────

chrome.action.onClicked.addListener(() => void connectOrToggleForActiveTab())

// ─── Install handler ────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  void chrome.runtime.openOptionsPage()
})

// ─── Always-on auto-attach ──────────────────────────────────────────────────

async function loadAlwaysOn() {
  const stored = await chrome.storage.local.get(['alwaysOn'])
  // Default to true when not set
  alwaysOn = stored.alwaysOn !== false
}

async function autoAttachTab(tabId) {
  if (!alwaysOn) return
  if (tabs.has(tabId)) return

  // Skip chrome:// and extension pages — debugger can't attach to those
  try {
    const tab = await chrome.tabs.get(tabId)
    if (!tab?.url && !tab?.pendingUrl) return // tab not ready
    const url = tab.url || tab.pendingUrl || ''
    if (!isEligibleUrl(url)) return
  } catch {
    return
  }

  tabs.set(tabId, { state: 'connecting' })
  setBadge(tabId, 'connecting')

  try {
    await ensureRelayConnection()
    await attachTab(tabId)
  } catch {
    tabs.delete(tabId)
    setBadge(tabId, 'off')
  }
}

// Auto-attach when user switches to a tab
chrome.tabs.onActivated.addListener((activeInfo) => {
  void autoAttachTab(activeInfo.tabId)
})

// Listen for alwaysOn changes from options page
chrome.storage.onChanged.addListener((changes) => {
  if (changes.alwaysOn) {
    alwaysOn = changes.alwaysOn.newValue !== false
    if (alwaysOn) {
      // Attach ALL eligible tabs immediately
      void attachAllEligibleTabs()
    }
  }
})

// ─── Service worker startup ────────────────────────────────────────────────

void loadAlwaysOn().then(async () => {
  if (!alwaysOn) return

  try {
    await ensureRelayConnection()
    await attachAllEligibleTabs()
    sendTabInventory()
  } catch {
    // Relay not up yet — reconnect loop will handle it
    scheduleReconnect()
  }
})
