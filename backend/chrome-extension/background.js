/**
 * Umbra Browser Link — Background Service Worker
 *
 * ALWAYS-ON browser telemetry for Umbra OS.
 * Collects everything even when Umbra is offline.
 * Persists the event queue to chrome.storage.local so no data is lost.
 * When Umbra comes online, flushes the full backlog automatically.
 *
 * Data collected:
 *   - Browser fingerprint (OS, browser, screen, timezone, hardware)
 *   - Tab lifecycle (create, close, navigate, activate, pin, audible)
 *   - Window lifecycle (create, close)
 *   - Cookie sweep (all domains, auth/secure/session counts)
 *   - Login forms detected & submitted (provider, MFA, field counts)
 *   - OAuth/SSO flows (Google, Microsoft, GitHub, Apple, etc.)
 *   - Web requests (POST auth/api calls, redirects)
 *   - Bookmarks count & structure
 *   - Browsing history (recent)
 *   - Installed extensions
 *   - Page metadata from content scripts (title, OG tags, structure)
 *   - Performance metrics (load times, paint, resources)
 *   - Visibility changes
 *   - Periodic stats (tab/window/extension counts)
 */

// ── Config ──────────────────────────────────────────────────
const UMBRA_HOST_DEFAULT = 'http://127.0.0.1:8787';
const FLUSH_INTERVAL_MS = 5_000;
const COOKIE_SWEEP_INTERVAL_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const STATS_INTERVAL_MS = 60_000;
const PERSIST_INTERVAL_MS = 10_000;     // persist queue to storage every 10s
const CONNECT_CHECK_MS = 3_000;         // check Umbra connection every 3s
const BATCH_CAP = 200;                  // flush when queue reaches this
const MAX_QUEUE = 50_000;               // max events before dropping oldest
const MAX_PERSIST_BYTES = 4_500_000;    // ~4.5 MB (chrome.storage.local limit is 5 MB)
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

// ── State ───────────────────────────────────────────────────
let enabled = true;
let sessionId = `chrome-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
let eventQueue = [];
let cookieSnapshot = {};
let tabState = {};
let activeTabId = null;
let windowCount = 0;
let UMBRA_HOST = UMBRA_HOST_DEFAULT;
let umbraOnline = false;
let backoffMs = BACKOFF_BASE_MS;
let lastFlushResult = 'idle';
let pendingPersist = false;

function host() { return UMBRA_HOST || UMBRA_HOST_DEFAULT; }

// ── Persistent Queue ────────────────────────────────────────
async function loadPersistedQueue() {
  try {
    const data = await chrome.storage.local.get(['umbraEventQueue', 'umbraSessionId']);
    if (data.umbraEventQueue && Array.isArray(data.umbraEventQueue)) {
      eventQueue = data.umbraEventQueue;
      console.log(`[Umbra] Restored ${eventQueue.length} queued events from storage`);
    }
    if (data.umbraSessionId) {
      sessionId = data.umbraSessionId;
    } else {
      await chrome.storage.local.set({ umbraSessionId: sessionId });
    }
  } catch (e) {
    console.warn('[Umbra] Failed to load persisted queue:', e);
  }
}

async function persistQueue() {
  if (pendingPersist) return;
  pendingPersist = true;
  try {
    // Trim if too large
    while (eventQueue.length > 0) {
      const serialized = JSON.stringify(eventQueue);
      if (serialized.length <= MAX_PERSIST_BYTES) break;
      eventQueue.splice(0, Math.ceil(eventQueue.length * 0.1)); // drop oldest 10%
    }
    await chrome.storage.local.set({
      umbraEventQueue: eventQueue,
      umbraSessionId: sessionId,
    });
  } catch (e) {
    console.warn('[Umbra] Failed to persist queue:', e);
  } finally {
    pendingPersist = false;
  }
}

// ── Connection Monitor ──────────────────────────────────────
async function checkUmbraConnection() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${host()}/api/health`, {
      method: 'GET',
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const wasOnline = umbraOnline;
    umbraOnline = res.ok;

    if (!wasOnline && umbraOnline) {
      // Umbra just came online — flush everything immediately
      console.log('[Umbra] Server online — flushing backlog');
      backoffMs = BACKOFF_BASE_MS;
      await flushEvents(true); // force flush
    }
  } catch (e) {
    umbraOnline = false;
  }
}

// ── Bootstrap ───────────────────────────────────────────────
(async () => {
  // Load settings
  const stored = await chrome.storage.local.get(['umbraEnabled', 'umbraHost']);
  if (stored.umbraEnabled === false) enabled = false;
  if (stored.umbraHost) UMBRA_HOST = stored.umbraHost;

  // Restore persisted queue
  await loadPersistedQueue();

  // Alarms
  chrome.alarms.create('umbra-flush', { periodInMinutes: FLUSH_INTERVAL_MS / 60_000 });
  chrome.alarms.create('umbra-cookie-sweep', { periodInMinutes: COOKIE_SWEEP_INTERVAL_MS / 60_000 });
  chrome.alarms.create('umbra-heartbeat', { periodInMinutes: HEARTBEAT_INTERVAL_MS / 60_000 });
  chrome.alarms.create('umbra-stats', { periodInMinutes: STATS_INTERVAL_MS / 60_000 });
  chrome.alarms.create('umbra-persist', { periodInMinutes: PERSIST_INTERVAL_MS / 60_000 });
  chrome.alarms.create('umbra-connect-check', { periodInMinutes: CONNECT_CHECK_MS / 60_000 });

  chrome.alarms.onAlarm.addListener(handleAlarm);

  // Tab events
  chrome.tabs.onCreated.addListener(onTabCreated);
  chrome.tabs.onUpdated.addListener(onTabUpdated);
  chrome.tabs.onRemoved.addListener(onTabRemoved);
  chrome.tabs.onActivated.addListener(onTabActivated);
  chrome.tabs.onDetached.addListener(onTabDetached);
  chrome.tabs.onAttached.addListener(onTabAttached);

  // Window events
  chrome.windows.onCreated.addListener(onWindowCreated);
  chrome.windows.onRemoved.addListener(onWindowRemoved);

  // Navigation / form
  chrome.webNavigation.onBeforeSubmit.addListener(onFormSubmit);
  chrome.webNavigation.onCompleted.addListener(onNavigationComplete);
  chrome.webNavigation.onCommitted.addListener(onNavigationCommitted);

  // Web requests
  chrome.webRequest.onBeforeRequest.addListener(onWebRequest, { urls: ['<all_urls>'] }, ['requestBody']);
  chrome.webRequest.onCompleted.addListener(onWebRequestComplete, { urls: ['<all_urls>'] });

  // Messages
  chrome.runtime.onMessage.addListener(onMessage);

  // ── Always-on initial collection ──────────────────────────
  await sweepCookies();

  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    tabState[t.id] = {
      url: t.url, title: t.title, favIconUrl: t.favIconUrl,
      lastActive: Date.now(), pinned: t.pinned || false,
      audible: t.audible || false, muted: t.mutedInfo?.muted || false,
      windowId: t.windowId, index: t.index,
    };
    if (t.active) activeTabId = t.id;
  }
  windowCount = (await chrome.windows.getAll()).length;

  // Always queue — this data will be stored and flushed when Umbra is available
  const fingerprint = await collectBrowserFingerprint();
  queueEvent({ type: 'session:start', sessionId, ts: Date.now(), ...fingerprint });

  const browserStats = await collectBrowserStats();
  queueEvent({ type: 'browser:stats', ...browserStats, ts: Date.now() });

  const extensions = await collectExtensions();
  if (extensions.length > 0) {
    queueEvent({ type: 'browser:extensions', extensions, count: extensions.length, ts: Date.now() });
  }

  const recentHistory = await collectRecentHistory();
  if (recentHistory.length > 0) {
    queueEvent({ type: 'browser:history', entries: recentHistory, count: recentHistory.length, ts: Date.now() });
  }

  // Persist initial state
  await persistQueue();

  // Initial badge
  updateBadge();

  // Initial connection check
  await checkUmbraConnection();
})();

// ── Alarm handler ───────────────────────────────────────────
function handleAlarm(alarm) {
  switch (alarm.name) {
    case 'umbra-flush':
      flushEvents();
      break;
    case 'umbra-cookie-sweep':
      sweepCookies();
      break;
    case 'umbra-heartbeat':
      sendBackgroundHeartbeat();
      break;
    case 'umbra-stats':
      sendPeriodicStats();
      break;
    case 'umbra-persist':
      persistQueue();
      break;
    case 'umbra-connect-check':
      checkUmbraConnection();
      break;
  }
}

// ── Badge Counter ──────────────────────────────────────────
function updateBadge() {
  const count = eventQueue.length;
  if (!enabled) {
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setBadgeBackgroundColor({ color: '#555' });
  } else if (count === 0) {
    chrome.action.setBadgeText({ text: '' });
  } else if (count >= 1000) {
    chrome.action.setBadgeText({ text: `${Math.round(count / 1000)}k` });
    chrome.action.setBadgeBackgroundColor({ color: '#ff9f43' });
  } else {
    chrome.action.setBadgeText({ text: String(count) });
    chrome.action.setBadgeBackgroundColor({ color: umbraOnline ? '#00b894' : '#6c5ce7' });
  }
}

// ── Event Queue ─────────────────────────────────────────────
function queueEvent(event) {
  if (!enabled) return;
  event.sessionId = sessionId;
  event.ts = event.ts || Date.now();
  eventQueue.push(event);

  // Trim if over limit
  if (eventQueue.length > MAX_QUEUE) {
    eventQueue.splice(0, eventQueue.length - MAX_QUEUE);
  }

  // Update badge
  updateBadge();

  // Auto-flush at batch cap (only if online)
  if (eventQueue.length >= BATCH_CAP && umbraOnline) {
    flushEvents();
  }
}

// ── Flush with retry/backoff ────────────────────────────────
async function flushEvents(force = false) {
  if (eventQueue.length === 0) return;
  if (!force && !umbraOnline) return; // don't waste bandwidth

  const batch = eventQueue.splice(0);
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(`${host()}/api/chrome/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: batch, sessionId, cookieSnapshot }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.ok) {
      lastFlushResult = 'ok';
      backoffMs = BACKOFF_BASE_MS;
      persistQueue();
      updateBadge();
    } else {
      // Server rejected — re-queue
      eventQueue.unshift(...batch);
      lastFlushResult = `rejected:${res.status}`;
      backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
    }
  } catch (err) {
    // Umbra offline or timeout — re-queue
    eventQueue.unshift(...batch);
    if (eventQueue.length > MAX_QUEUE) eventQueue.splice(MAX_QUEUE);
    umbraOnline = false;
    lastFlushResult = 'offline';
    backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
  }
}

// ── Browser Fingerprint ─────────────────────────────────────
async function collectBrowserFingerprint() {
  const ua = navigator.userAgent;
  const platform = navigator.platform || 'unknown';
  const language = navigator.language || 'en';
  const languages = navigator.languages || [language];
  const cookieEnabled = navigator.cookieEnabled;
  const doNotTrack = navigator.doNotTrack;
  const hardwareConcurrency = navigator.hardwareConcurrency || 0;
  const deviceMemory = navigator.deviceMemory || 0;
  const maxTouchPoints = navigator.maxTouchPoints || 0;
  const screenW = screen.width;
  const screenH = screen.height;
  const screenColorDepth = screen.colorDepth;
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const timezoneOffset = new Date().getTimezoneOffset();

  let browserName = 'unknown';
  let browserVersion = '';
  if (/Edg[e\/]/i.test(ua)) { browserName = 'edge'; browserVersion = ua.match(/Edg[e\/]([\d.]+)/)?.[1] || ''; }
  else if (/Chrome/i.test(ua)) { browserName = 'chrome'; browserVersion = ua.match(/Chrome\/([\d.]+)/)?.[1] || ''; }
  else if (/Firefox/i.test(ua)) { browserName = 'firefox'; browserVersion = ua.match(/Firefox\/([\d.]+)/)?.[1] || ''; }
  else if (/Safari/i.test(ua)) { browserName = 'safari'; browserVersion = ua.match(/Version\/([\d.]+)/)?.[1] || ''; }

  let os = 'unknown';
  if (/Windows/i.test(ua)) os = 'windows';
  else if (/Mac OS/i.test(ua)) os = 'macos';
  else if (/Linux/i.test(ua)) os = 'linux';
  else if (/Android/i.test(ua)) os = 'android';
  else if (/iOS|iPhone|iPad/i.test(ua)) os = 'ios';

  return {
    fingerprint: {
      browser: browserName, browserVersion, os, platform,
      language, languages, cookieEnabled, doNotTrack,
      hardwareConcurrency, deviceMemory, maxTouchPoints,
      screen: { width: screenW, height: screenH, colorDepth: screenColorDepth },
      timezone, timezoneOffset, userAgent: ua,
    },
  };
}

// ── Browser Stats ───────────────────────────────────────────
async function collectBrowserStats() {
  let bookmarkCount = 0;
  let historyCount = 0;

  try {
    const bookmarks = await chrome.bookmarks.getTree();
    function countBookmarks(nodes) {
      for (const n of nodes) {
        if (!n.children) bookmarkCount++;
        else countBookmarks(n.children);
      }
    }
    countBookmarks(bookmarks);
  } catch (e) {}

  try {
    const items = await chrome.history.search({ text: '', startTime: 0, maxResults: 10000 });
    historyCount = items.length;
  } catch (e) {}

  const windows = await chrome.windows.getAll();
  const allTabs = await chrome.tabs.query({});

  return {
    tabCount: allTabs.length,
    pinnedTabCount: allTabs.filter(t => t.pinned).length,
    audibleTabCount: allTabs.filter(t => t.audible).length,
    windowCount: windows.length,
    bookmarkCount,
    historyCount,
  };
}

// ── Extensions List ─────────────────────────────────────────
async function collectExtensions() {
  try {
    const exts = await chrome.management.getAll();
    return exts.filter(e => e.enabled).map(e => ({
      id: e.id, name: e.name, version: e.version,
      description: (e.description || '').slice(0, 200),
    }));
  } catch (e) { return []; }
}

// ── Recent History ──────────────────────────────────────────
async function collectRecentHistory() {
  try {
    const items = await chrome.history.search({
      text: '', startTime: Date.now() - 3600_000, maxResults: 50,
    });
    return items.map(h => ({
      url: h.url, title: h.title,
      visitCount: h.visitCount, lastVisitTime: h.lastVisitTime,
    }));
  } catch (e) { return []; }
}

// ── Periodic Stats (every minute) ───────────────────────────
async function sendPeriodicStats() {
  const stats = await collectBrowserStats();
  const extensions = await collectExtensions();
  const recentHistory = await collectRecentHistory();

  queueEvent({
    type: 'browser:stats', ...stats,
    extensionCount: extensions.length,
    recentHistoryCount: recentHistory.length,
    queueSize: eventQueue.length,
    umbraOnline,
    lastFlushResult,
    ts: Date.now(),
  });

  // Full tab state
  const tabs = await chrome.tabs.query({});
  const tabDetails = tabs.map(t => ({
    tabId: t.id, url: t.url || '', title: t.title || '',
    pinned: t.pinned || false, audible: t.audible || false,
    active: t.active || false, windowId: t.windowId,
    favIconUrl: t.favIconUrl || '',
  }));
  queueEvent({ type: 'tabs:state', tabs: tabDetails, count: tabDetails.length, ts: Date.now() });

  // Auth cookie domains
  const authDomains = Object.entries(cookieSnapshot)
    .filter(([_, cookies]) => cookies.some(c => /session|token|auth|jwt|sid|login/i.test(c.name)))
    .map(([domain]) => domain);
  if (authDomains.length > 0) {
    queueEvent({ type: 'cookies:auth', domains: authDomains, count: authDomains.length, ts: Date.now() });
  }
}

// ── Background Heartbeat ────────────────────────────────────
async function sendBackgroundHeartbeat() {
  const tabs = await chrome.tabs.query({});
  const activeTab = tabs.find(t => t.active);
  const windows = await chrome.windows.getAll({ populate: false });

  queueEvent({
    type: 'activity:heartbeat',
    tabId: activeTabId,
    url: activeTab?.url || '',
    title: activeTab?.title || '',
    scrollY: 0, viewportHeight: 0,
    linkCount: 0, formCount: 0,
    totalTabs: tabs.length,
    totalWindows: windows.length,
    audibleTabs: tabs.filter(t => t.audible).length,
    pinnedTabs: tabs.filter(t => t.pinned).length,
    queueSize: eventQueue.length,
    umbraOnline,
    ts: Date.now(),
  });
}

// ── Cookie Sweep ────────────────────────────────────────────
async function sweepCookies() {
  const domains = {};
  let authCookieCount = 0, secureCookieCount = 0, sessionCookieCount = 0;

  try {
    const cookies = await chrome.cookies.getAll({});
    for (const c of cookies) {
      const domain = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
      if (!domains[domain]) domains[domain] = [];
      domains[domain].push({
        name: c.name, hasValue: c.value.length > 0,
        secure: c.secure, httpOnly: c.httpOnly,
        sameSite: c.sameSite, path: c.path,
        expires: c.expirationDate || -1, session: c.session,
      });
      if (c.secure) secureCookieCount++;
      if (c.session) sessionCookieCount++;
      if (/session|token|auth|jwt|sid|login|csrf|refresh/i.test(c.name)) authCookieCount++;
    }
  } catch (err) {}

  cookieSnapshot = domains;

  queueEvent({
    type: 'cookies:sweep',
    domainCount: Object.keys(domains).length,
    cookieCount: Object.values(domains).reduce((s, a) => s + a.length, 0),
    authCookieCount, secureCookieCount, sessionCookieCount,
    domains: Object.keys(domains).slice(0, 100),
    ts: Date.now(),
  });
}

// ── Tab Events ──────────────────────────────────────────────
function onTabCreated(tab) {
  tabState[tab.id] = {
    url: tab.url || '', title: tab.title || '', favIconUrl: tab.favIconUrl || '',
    lastActive: Date.now(), pinned: tab.pinned || false,
    audible: tab.audible || false, muted: tab.mutedInfo?.muted || false,
    windowId: tab.windowId, index: tab.index,
  };
  queueEvent({
    type: 'tab:created', tabId: tab.id, url: tab.url || '', title: tab.title || '',
    pinned: tab.pinned || false, windowId: tab.windowId,
  });
}

function onTabUpdated(tabId, changeInfo, tab) {
  const prev = tabState[tabId];
  tabState[tabId] = {
    url: tab.url, title: tab.title, favIconUrl: tab.favIconUrl,
    lastActive: Date.now(), pinned: tab.pinned || false,
    audible: tab.audible || false, muted: tab.mutedInfo?.muted || false,
    windowId: tab.windowId, index: tab.index,
  };

  if (changeInfo.url) {
    queueEvent({
      type: 'tab:navigate', tabId, url: tab.url, prevUrl: prev?.url || '',
      title: tab.title || '', pinned: tab.pinned || false, windowId: tab.windowId,
    });
    detectOAuthRedirect(tab.url, prev?.url);
  }
  if (changeInfo.title) {
    queueEvent({ type: 'tab:title', tabId, title: tab.title, url: tab.url });
  }
  if (changeInfo.audible !== undefined) {
    queueEvent({ type: 'tab:audible', tabId, audible: changeInfo.audible, url: tab.url });
  }
  if (changeInfo.pinned !== undefined) {
    queueEvent({ type: 'tab:pinned', tabId, pinned: changeInfo.pinned, url: tab.url });
  }
}

function onTabRemoved(tabId) {
  const prev = tabState[tabId];
  delete tabState[tabId];
  queueEvent({ type: 'tab:removed', tabId, url: prev?.url || '', title: prev?.title || '' });
}

function onTabActivated(activeInfo) {
  const prev = activeTabId;
  activeTabId = activeInfo.tabId;
  const state = tabState[activeTabId];
  queueEvent({
    type: 'tab:activate', tabId: activeTabId, prevTabId: prev,
    url: state?.url || '', title: state?.title || '',
    windowId: activeInfo.windowId,
  });
}

function onTabDetached(tabId, detachInfo) {
  queueEvent({ type: 'tab:detach', tabId, fromWindow: detachInfo.oldWindowId });
}

function onTabAttached(tabId, attachInfo) {
  queueEvent({ type: 'tab:attach', tabId, toWindow: attachInfo.newWindowId });
}

// ── Window Events ───────────────────────────────────────────
function onWindowCreated(win) {
  windowCount++;
  queueEvent({ type: 'window:created', windowId: win.id, type: win.type, state: win.state });
}

function onWindowRemoved(windowId) {
  windowCount = Math.max(0, windowCount - 1);
  queueEvent({ type: 'window:removed', windowId });
}

// ── Form / Navigation ───────────────────────────────────────
function onFormSubmit(details) {
  if (!details.url) return;
  const isLoginLike = /login|signin|auth|oauth|saml|sso|session|callback|token|consent/i.test(details.url);
  queueEvent({
    type: 'form:submit', tabId: details.tabId, url: details.url,
    isLoginLike, frameId: details.frameId,
  });
}

function onNavigationComplete(details) {
  if (details.frameId !== 0) return;
  queueEvent({ type: 'nav:complete', tabId: details.tabId, url: details.url });
}

function onNavigationCommitted(details) {
  if (details.frameId !== 0) return;
  queueEvent({
    type: 'nav:commit', tabId: details.tabId, url: details.url,
    transitionType: details.transitionType || '',
    transitionQualifiers: details.transitionQualifiers || [],
  });
}

// ── Web Request Monitoring ──────────────────────────────────
function onWebRequest(details) {
  if (details.method !== 'POST') return;
  const isAuth = /login|signin|auth|oauth|token|session|callback|sso|saml/i.test(details.url);
  const isApi = /api\//i.test(details.url);
  if (isAuth || isApi) {
    queueEvent({
      type: 'webrequest:post', tabId: details.tabId, url: details.url,
      isAuthRelated: isAuth, isApiCall: isApi,
      requestType: details.type,
    });
  }
}

function onWebRequestComplete(details) {
  if (details.statusCode >= 300 && details.statusCode < 400) {
    queueEvent({
      type: 'webrequest:redirect', tabId: details.tabId, url: details.url,
      statusCode: details.statusCode,
    });
  }
}

// ── OAuth / SSO Detection ───────────────────────────────────
const OAUTH_PATTERNS = [
  /accounts\.google\.com\/o\/oauth/i,
  /login\.microsoftonline\.com/i,
  /github\.com\/login\/oauth/i,
  /auth0\.com\/authorize/i,
  /facebook\.com\/v\d+\/dialog\/oauth/i,
  /api\.twitter\.com\/oauth/i,
  /linkedin\.com\/oauth/i,
  /appleid\.apple\.com\/auth/i,
  /id\.apple\.com/i,
  /oauth\.twitter\.com/i,
  /discord\.com\/api\/oauth/i,
  /paypal\.com\/signin/i,
  /okta\.com\/oauth/i,
  /onelogin\.com/i,
  /ping\.com\/federation/i,
  /saml/i,
  /keycloak/i,
  /clerk\./i,
  /supabase.*auth/i,
  /firebase.*auth/i,
];

function detectOAuthRedirect(url, prevUrl) {
  if (!url) return;
  if (OAUTH_PATTERNS.some(p => p.test(url))) {
    queueEvent({
      type: 'oauth:detected', url, prevUrl,
      provider: extractOAuthProvider(url),
      isRedirect: !!prevUrl,
    });
  }
}

function extractOAuthProvider(url) {
  if (/google/i.test(url)) return 'google';
  if (/microsoft|live\.com|azure/i.test(url)) return 'microsoft';
  if (/github/i.test(url)) return 'github';
  if (/facebook/i.test(url)) return 'facebook';
  if (/twitter|x\.com/i.test(url)) return 'twitter';
  if (/linkedin/i.test(url)) return 'linkedin';
  if (/apple/i.test(url)) return 'apple';
  if (/auth0/i.test(url)) return 'auth0';
  if (/okta/i.test(url)) return 'okta';
  if (/discord/i.test(url)) return 'discord';
  if (/paypal/i.test(url)) return 'paypal';
  if (/keycloak/i.test(url)) return 'keycloak';
  if (/clerk/i.test(url)) return 'clerk';
  if (/supabase/i.test(url)) return 'supabase';
  if (/firebase/i.test(url)) return 'firebase';
  return 'unknown';
}

// ── Message Handling (content scripts / popup) ──────────────
function onMessage(msg, sender, sendResponse) {
  if (msg.type === 'login:detected') {
    queueEvent({
      type: 'login:detected',
      tabId: sender.tab?.id, url: sender.tab?.url,
      title: sender.tab?.title || '',
      formAction: msg.action, fieldCount: msg.fieldCount,
      hasPasswordField: msg.hasPassword, hasUsernameField: msg.hasUsername,
      provider: detectLoginProvider(sender.tab?.url),
      formMethod: msg.formMethod || 'unknown',
      formId: msg.formId || '', formClass: msg.formClass || '',
      autocomplete: msg.autocomplete || '',
    });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'login:submitted') {
    const provider = detectLoginProvider(sender.tab?.url);
    queueEvent({
      type: 'login:submitted',
      tabId: sender.tab?.id, url: sender.tab?.url,
      title: sender.tab?.title || '',
      formAction: msg.action, fieldCount: msg.fieldCount,
      hasPassword: msg.hasPassword, hasUsername: msg.hasUsername,
      formMethod: msg.formMethod || 'unknown',
      formId: msg.formId || '',
      provider,
      mfaDetected: msg.mfaDetected || false,
      rememberMeChecked: msg.rememberMeChecked || false,
      saveConnector: msg.saveConnector || false,
    });
    
    // If user approved saving as connector, also send cookies for this domain
    if (msg.saveConnector && sender.tab?.url) {
      try {
        const url = new URL(sender.tab.url);
        const cookies = await chrome.cookies.getAll({ domain: url.hostname });
        if (cookies.length > 0) {
          queueEvent({
            type: 'connector:session',
            tabId: sender.tab?.id,
            url: sender.tab?.url,
            provider,
            cookies: cookies.map(c => ({
              name: c.name,
              value: c.value,
              domain: c.domain,
              path: c.path,
              secure: c.secure,
              httpOnly: c.httpOnly,
              sameSite: c.sameSite,
              expirationDate: c.expirationDate,
              session: c.session,
            })),
            timestamp: Date.now(),
          });
        }
      } catch (err) {
        console.warn('[Umbra] Failed to capture cookies for connector:', err);
      }
    }
    
    sendResponse({ ok: true, saveConnector: msg.saveConnector });
    return true;
  }

  if (msg.type === 'activity:heartbeat') {
    queueEvent({
      type: 'activity:heartbeat',
      tabId: sender.tab?.id, url: sender.tab?.url,
      title: sender.tab?.title || '',
      scrollY: msg.scrollY, scrollPercent: msg.scrollPercent,
      viewportHeight: msg.viewportHeight, viewportWidth: msg.viewportWidth,
      pageHeight: msg.pageHeight,
      linkCount: msg.linkCount, formCount: msg.formCount,
      imageCount: msg.imageCount, videoCount: msg.videoCount,
      inputCount: msg.inputCount, iframeCount: msg.iframeCount,
      h1Count: msg.h1Count,
      hasNav: msg.hasNav, hasFooter: msg.hasFooter, hasSearch: msg.hasSearch,
      lang: msg.lang, description: msg.description,
      canonical: msg.canonical,
      ogTitle: msg.ogTitle, ogDescription: msg.ogDescription, ogImage: msg.ogImage,
      twitterCard: msg.twitterCard, isSecure: msg.isSecure,
      performance: msg.performance,
    });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'page:visibility') {
    queueEvent({
      type: 'page:visibility',
      tabId: sender.tab?.id, url: sender.tab?.url,
      visible: msg.visible, ts: Date.now(),
    });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'page:performance') {
    queueEvent({
      type: 'page:performance',
      tabId: sender.tab?.id, url: sender.tab?.url,
      domContentLoaded: msg.domContentLoaded,
      loadEvent: msg.loadEvent,
      firstPaint: msg.firstPaint,
      firstContentfulPaint: msg.firstContentfulPaint,
      resources: msg.resources, transferSize: msg.transferSize,
    });
    sendResponse({ ok: true });
    return true;
  }

  // ── Popup messages ────────────────────────────────────────
  if (msg.type === 'popup:getStatus') {
    sendResponse({
      enabled, sessionId,
      eventCount: eventQueue.length,
      tabCount: Object.keys(tabState).length,
      windowCount,
      umbraOnline,
      lastFlushResult,
    });
    return true;
  }

  if (msg.type === 'popup:toggle') {
    enabled = msg.enabled;
    chrome.storage.local.set({ umbraEnabled: enabled });
    updateBadge();
    sendResponse({ enabled });
    return true;
  }

  if (msg.type === 'popup:setHost') {
    UMBRA_HOST = msg.host || UMBRA_HOST_DEFAULT;
    chrome.storage.local.set({ umbraHost: UMBRA_HOST });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'popup:clearQueue') {
    eventQueue = [];
    chrome.storage.local.remove(['umbraEventQueue']);
    updateBadge();
    sendResponse({ ok: true, eventCount: 0 });
    return true;
  }

  return false;
}

function detectLoginProvider(pageUrl) {
  if (!pageUrl) return 'unknown';
  const u = pageUrl.toLowerCase();
  if (/google|gmail|accounts\.google/i.test(u)) return 'google';
  if (/microsoft|live\.com|outlook|office/i.test(u)) return 'microsoft';
  if (/github\.com/i.test(u)) return 'github';
  if (/facebook|fb\.com/i.test(u)) return 'facebook';
  if (/twitter|x\.com/i.test(u)) return 'twitter';
  if (/linkedin/i.test(u)) return 'linkedin';
  if (/apple|icloud/i.test(u)) return 'apple';
  if (/amazon/i.test(u)) return 'amazon';
  if (/netflix/i.test(u)) return 'netflix';
  if (/spotify/i.test(u)) return 'spotify';
  if (/slack/i.test(u)) return 'slack';
  if (/discord/i.test(u)) return 'discord';
  if (/zoom/i.test(u)) return 'zoom';
  if (/dropbox/i.test(u)) return 'dropbox';
  if (/cloudflare/i.test(u)) return 'cloudflare';
  if (/vercel/i.test(u)) return 'vercel';
  if (/heroku/i.test(u)) return 'heroku';
  if (/digitalocean/i.test(u)) return 'digitalocean';
  return 'unknown';
}
