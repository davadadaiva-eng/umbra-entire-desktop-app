/**
 * Umbra Browser Link — Content Script
 *
 * Injected into every page. Collects:
 *   1. Login form detection (password fields, submit buttons, providers)
 *   2. Form submissions with credential details
 *   3. OAuth/SSO redirect triggers
 *   4. Rich page metadata (title, description, OG tags, language)
 *   5. Page structure (links, forms, images, video, inputs, nav, footer)
 *   6. Scroll depth and viewport
 *   7. Performance metrics (load times)
 *   8. Visibility changes
 */

(() => {
  'use strict';

  const HEARTBEAT_INTERVAL_MS = 15_000;
  const PASSWORD_SELECTORS = 'input[type="password"], input[name*="pass" i], input[name*="pwd" i], input[id*="pass" i], input[autocomplete="current-password"]';
  const USERNAME_SELECTORS = 'input[type="email"], input[type="text"][name*="user" i], input[type="text"][name*="login" i], input[type="text"][name*="email" i], input[type="text"][id*="user" i], input[type="text"][id*="login" i], input[type="email"][id*="email" i], input[autocomplete="username"]';
  const SUBMIT_SELECTORS = 'button[type="submit"], input[type="submit"], button[name*="login" i], button[name*="signin" i], button[id*="login" i], button[id*="signin" i]';

  // ── Page Metadata Collection ──────────────────────────────
  function getPageMetadata() {
    const meta = {};

    // Basic
    meta.title = document.title || '';
    meta.url = location.href;
    meta.isSecure = location.protocol === 'https:';
    meta.lang = document.documentElement.lang || navigator.language || '';
    meta.charset = document.characterSet || '';

    // Meta tags
    const getMeta = (name) => {
      const el = document.querySelector(`meta[name="${name}"], meta[property="${name}"], meta[name="${name.toLowerCase()}"]`);
      return el ? el.getAttribute('content') || '' : '';
    };

    meta.description = getMeta('description') || getMeta('og:description') || getMeta('twitter:description');
    meta.canonical = getMeta('canonical') || document.querySelector('link[rel="canonical"]')?.href || '';
    meta.ogTitle = getMeta('og:title');
    meta.ogDescription = getMeta('og:description');
    meta.ogImage = getMeta('og:image');
    meta.ogType = getMeta('og:type');
    meta.ogUrl = getMeta('og:url');
    meta.twitterCard = getMeta('twitter:card');
    meta.twitterSite = getMeta('twitter:site');
    meta.author = getMeta('author');
    meta.keywords = getMeta('keywords');
    meta.robots = getMeta('robots');
    meta.themeColor = getMeta('theme-color');
    meta.viewport = getMeta('viewport');

    // Page structure
    meta.pageHeight = document.documentElement.scrollHeight;
    meta.pageWidth = document.documentElement.scrollWidth;
    meta.userAgent = navigator.userAgent;

    return meta;
  }

  // ── Page Structure Analysis ───────────────────────────────
  function getPageStructure() {
    const structure = {};

    // Links
    const links = document.querySelectorAll('a[href]');
    structure.linkCount = links.length;
    structure.externalLinks = 0;
    structure.internalLinks = 0;
    structure.nofollowLinks = 0;
    const linkDomains = new Set();
    for (const a of links) {
      try {
        const href = a.href;
        if (href.startsWith('http')) {
          const url = new URL(href);
          if (url.hostname !== location.hostname) {
            structure.externalLinks++;
            linkDomains.add(url.hostname);
          } else {
            structure.internalLinks++;
          }
          if (a.rel && a.rel.includes('nofollow')) structure.nofollowLinks++;
        }
      } catch (e) {}
    }
    structure.uniqueLinkDomains = linkDomains.size;

    // Forms
    const forms = document.querySelectorAll('form');
    structure.formCount = forms.length;
    structure.formDetails = Array.from(forms).slice(0, 20).map(f => ({
      action: f.action || '',
      method: f.method || 'get',
      id: f.id || '',
      class: f.className || '',
      inputCount: f.querySelectorAll('input').length,
      hasPassword: f.querySelector(PASSWORD_SELECTORS) !== null,
      hasFileUpload: f.querySelector('input[type="file"]') !== null,
      hasCaptcha: f.querySelector('[class*="captcha" i], [id*="captcha" i], [class*="recaptcha" i], iframe[src*="captcha"]') !== null,
    }));

    // Images
    structure.imageCount = document.querySelectorAll('img').length;
    structure.lazyImages = document.querySelectorAll('img[loading="lazy"]').length;

    // Video / Audio
    structure.videoCount = document.querySelectorAll('video').length;
    structure.audioCount = document.querySelectorAll('audio').length;

    // Inputs
    structure.inputCount = document.querySelectorAll('input').length;
    structure.textareaCount = document.querySelectorAll('textarea').length;
    structure.selectCount = document.querySelectorAll('select').length;
    structure.buttonCount = document.querySelectorAll('button').length;

    // Headings
    structure.h1Count = document.querySelectorAll('h1').length;
    structure.h2Count = document.querySelectorAll('h2').length;
    structure.h3Count = document.querySelectorAll('h3').length;

    // Structure
    structure.hasNav = document.querySelector('nav, [role="navigation"]') !== null;
    structure.hasFooter = document.querySelector('footer, [role="contentinfo"]') !== null;
    structure.hasHeader = document.querySelector('header, [role="banner"]') !== null;
    structure.hasSearch = document.querySelector('input[type="search"], [role="search"]') !== null;
    structure.hasSidebar = document.querySelector('aside, [role="complementary"]') !== null;

    // Iframes
    structure.iframeCount = document.querySelectorAll('iframe').length;

    // Schema.org / JSON-LD
    const jsonLd = document.querySelectorAll('script[type="application/ld+json"]');
    structure.jsonLdCount = jsonLd.length;
    if (jsonLd.length > 0) {
      try {
        const first = JSON.parse(jsonLd[0].textContent || '{}');
        structure.jsonLdType = first['@type'] || '';
      } catch (e) {}
    }

    // Trackers / analytics
    structure.hasGoogleAnalytics = document.querySelector('script[src*="google-analytics.com"], script[src*="googletagmanager.com"], script[src*="gtag"]') !== null;
    structure.hasFacebookPixel = document.querySelector('script[src*="facebook.net"], script[src*="fbevents.js"]') !== null;
    structure.hasHotjar = document.querySelector('script[src*="hotjar.com"]') !== null;

    return structure;
  }

  // ── Performance Metrics ───────────────────────────────────
  function getPerformanceMetrics() {
    const perf = {};
    try {
      const timing = performance.timing;
      perf.dnsLookup = timing.domainLookupEnd - timing.domainLookupStart;
      perf.tcpConnect = timing.connectEnd - timing.connectStart;
      perf.ttfb = timing.responseStart - timing.requestStart;
      perf.domContentLoaded = timing.domContentLoadedEventEnd - timing.navigationStart;
      perf.loadEvent = timing.loadEventEnd - timing.navigationStart;
      perf.domInteractive = timing.domInteractive - timing.navigationStart;
      perf.responseTime = timing.responseEnd - timing.responseStart;
      perf.domComplete = timing.domComplete - timing.navigationStart;
    } catch (e) {}

    try {
      const paint = performance.getEntriesByType('paint');
      for (const p of paint) {
        if (p.name === 'first-paint') perf.firstPaint = Math.round(p.startTime);
        if (p.name === 'first-contentful-paint') perf.firstContentfulPaint = Math.round(p.startTime);
      }
    } catch (e) {}

    try {
      const resources = performance.getEntriesByType('resource');
      perf.resourceCount = resources.length;
      perf.transferSize = resources.reduce((sum, r) => sum + (r.transferSize || 0), 0);
      const types = {};
      for (const r of resources) {
        const type = r.initiatorType || 'other';
        types[type] = (types[type] || 0) + 1;
      }
      perf.resourceTypes = types;
    } catch (e) {}

    return perf;
  }

  // ── Connector Permission Dialog ───────────────────────────
  function showConnectorPermissionDialog(provider, url) {
    return new Promise((resolve) => {
      // Remove any existing dialog
      const existing = document.getElementById('umbra-connector-dialog');
      if (existing) existing.remove();

      const dialog = document.createElement('div');
      dialog.id = 'umbra-connector-dialog';
      dialog.innerHTML = `
        <style>
          #umbra-connector-dialog {
            position: fixed;
            top: 20px;
            right: 20px;
            width: 380px;
            background: #1a1a2e;
            border: 1px solid #4a4a6a;
            border-radius: 12px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.4);
            z-index: 2147483647;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            color: #e0e0e0;
            animation: umbra-slide-in 0.3s ease-out;
          }
          @keyframes umbra-slide-in {
            from { transform: translateX(100%); opacity: 0; }
            to { transform: translateX(0); opacity: 1; }
          }
          .umbra-dialog-header {
            padding: 16px 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            border-radius: 12px 12px 0 0;
            display: flex;
            align-items: center;
            gap: 12px;
          }
          .umbra-dialog-header svg {
            width: 24px;
            height: 24px;
            fill: white;
          }
          .umbra-dialog-title {
            font-size: 16px;
            font-weight: 600;
            color: white;
          }
          .umbra-dialog-body {
            padding: 20px;
          }
          .umbra-dialog-text {
            font-size: 14px;
            line-height: 1.5;
            margin-bottom: 16px;
            color: #b0b0c0;
          }
          .umbra-dialog-provider {
            display: flex;
            align-items: center;
            gap: 10px;
            padding: 12px;
            background: #252540;
            border-radius: 8px;
            margin-bottom: 16px;
          }
          .umbra-provider-icon {
            width: 32px;
            height: 32px;
            background: #3a3a5a;
            border-radius: 6px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 18px;
          }
          .umbra-provider-name {
            font-weight: 500;
            color: #fff;
          }
          .umbra-provider-url {
            font-size: 12px;
            color: #888;
          }
          .umbra-dialog-buttons {
            display: flex;
            gap: 10px;
          }
          .umbra-btn {
            flex: 1;
            padding: 10px 16px;
            border-radius: 8px;
            font-size: 14px;
            font-weight: 500;
            cursor: pointer;
            border: none;
            transition: all 0.2s;
          }
          .umbra-btn-primary {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
          }
          .umbra-btn-primary:hover {
            transform: translateY(-1px);
            box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
          }
          .umbra-btn-secondary {
            background: #2a2a4a;
            color: #a0a0b0;
          }
          .umbra-btn-secondary:hover {
            background: #3a3a5a;
          }
          .umbra-dialog-checkbox {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 16px;
            font-size: 13px;
            color: #888;
          }
          .umbra-dialog-checkbox input {
            accent-color: #667eea;
          }
        </style>
        <div class="umbra-dialog-header">
          <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
          <div class="umbra-dialog-title">Save to Umbra?</div>
        </div>
        <div class="umbra-dialog-body">
          <div class="umbra-dialog-text">
            We detected you logged into <strong>${provider}</strong>. 
            Save this account as a connector so Umbra can use it for you.
          </div>
          <div class="umbra-dialog-provider">
            <div class="umbra-provider-icon">${getProviderEmoji(provider)}</div>
            <div>
              <div class="umbra-provider-name">${provider}</div>
              <div class="umbra-provider-url">${new URL(url).hostname}</div>
            </div>
          </div>
          <label class="umbra-dialog-checkbox">
            <input type="checkbox" id="umbra-remember-choice" checked>
            Remember this choice for ${provider}
          </label>
          <div class="umbra-dialog-buttons">
            <button class="umbra-btn umbra-btn-secondary" id="umbra-btn-skip">Skip</button>
            <button class="umbra-btn umbra-btn-primary" id="umbra-btn-save">Save Connector</button>
          </div>
        </div>
      `;

      document.body.appendChild(dialog);

      const skipBtn = document.getElementById('umbra-btn-skip');
      const saveBtn = document.getElementById('umbra-btn-save');
      const rememberCheckbox = document.getElementById('umbra-remember-choice');

      skipBtn.addEventListener('click', () => {
        const remember = rememberCheckbox.checked;
        dialog.remove();
        resolve({ save: false, remember });
      });

      saveBtn.addEventListener('click', () => {
        const remember = rememberCheckbox.checked;
        dialog.remove();
        resolve({ save: true, remember });
      });

      // Auto-dismiss after 30 seconds
      setTimeout(() => {
        if (document.getElementById('umbra-connector-dialog')) {
          dialog.remove();
          resolve({ save: false, remember: false });
        }
      }, 30000);
    });
  }

  function getProviderEmoji(provider) {
    const emojis = {
      'google': '🔍',
      'microsoft': '🪟',
      'github': '🐙',
      'facebook': '👤',
      'twitter': '🐦',
      'linkedin': '💼',
      'apple': '',
      'amazon': '📦',
      'netflix': '🎬',
      'spotify': '🎵',
      'slack': '💬',
      'discord': '🎮',
      'zoom': '📹',
      'dropbox': '📁',
    };
    return emojis[provider?.toLowerCase()] || '🔑';
  }

  // ── Login Form Detection ──────────────────────────────────
  function detectLoginForm() {
    const passwords = document.querySelectorAll(PASSWORD_SELECTORS);
    const usernames = document.querySelectorAll(USERNAME_SELECTORS);
    const submits = document.querySelectorAll(SUBMIT_SELECTORS);

    if (passwords.length === 0) return null;

    const form = passwords[0].closest('form');
    const action = form?.action || '';

    // Detect MFA / 2FA
    const mfaPatterns = /mfa|2fa|otp|totp|verify|code|captcha/i;
    const allInputs = form ? form.querySelectorAll('input') : [];
    let mfaDetected = false;
    for (const inp of allInputs) {
      if (mfaPatterns.test(inp.name || '') || mfaPatterns.test(inp.id || '') ||
          mfaPatterns.test(inp.placeholder || '') || mfaPatterns.test(inp.autocomplete || '')) {
        mfaDetected = true;
        break;
      }
    }

    // Detect "remember me" checkbox
    const rememberMe = form ? form.querySelector('input[type="checkbox"][name*="remember" i], input[type="checkbox"][id*="remember" i]') : null;
    const rememberMeChecked = rememberMe ? rememberMe.checked : false;

    // Form autocomplete
    const autocomplete = passwords[0].autocomplete || form?.autocomplete || '';

    // Count field types
    const fieldTypeCounts = {};
    for (const inp of allInputs) {
      const type = inp.type || 'text';
      fieldTypeCounts[type] = (fieldTypeCounts[type] || 0) + 1;
    }

    return {
      hasPassword: true,
      hasUsername: usernames.length > 0,
      fieldCount: allInputs.length,
      action,
      formMethod: form?.method || 'unknown',
      formId: form?.id || '',
      formClass: form?.className || '',
      autocomplete,
      mfaDetected,
      rememberMeChecked,
      fieldTypeCounts,
      inputNames: Array.from(allInputs).map(i => i.name || i.id || i.type).slice(0, 20),
    };
  }

  // ── Observe DOM for login forms ───────────────────────────
  let reportedForm = false;

  function checkForLoginForm() {
    const detected = detectLoginForm();
    if (detected && !reportedForm) {
      reportedForm = true;
      chrome.runtime.sendMessage({ type: 'login:detected', ...detected });
    }
  }

  const observer = new MutationObserver(() => checkForLoginForm());
  observer.observe(document.documentElement, { childList: true, subtree: true });
  checkForLoginForm();

  // ── Form submission interception ───────────────────────────
  document.addEventListener('submit', async (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement)) return;

    const hasPassword = form.querySelector(PASSWORD_SELECTORS) !== null;
    const hasUsername = form.querySelector(USERNAME_SELECTORS) !== null;

    if (hasPassword || hasUsername) {
      const mfaPatterns = /mfa|2fa|otp|totp|verify|code|captcha/i;
      const allInputs = form.querySelectorAll('input');
      let mfaDetected = false;
      for (const inp of allInputs) {
        if (mfaPatterns.test(inp.name || '') || mfaPatterns.test(inp.id || '') ||
            mfaPatterns.test(inp.placeholder || '')) {
          mfaDetected = true;
          break;
        }
      }

      const rememberMe = form.querySelector('input[type="checkbox"][name*="remember" i], input[type="checkbox"][id*="remember" i]');
      const provider = detectLoginProviderFromUrl();

      // Check if user has already set a preference for this provider
      const storageKey = `umbra_connector_pref_${provider}`;
      const stored = await chrome.storage.local.get(storageKey);
      
      if (stored[storageKey] !== undefined) {
        // User already has a preference - respect it
        if (stored[storageKey] === false) {
          // User said "don't ask again" for this provider - just send basic event
          chrome.runtime.sendMessage({
            type: 'login:submitted',
            action: form.action || '',
            fieldCount: allInputs.length,
            hasPassword,
            hasUsername,
            formMethod: form.method || 'get',
            formId: form.id || '',
            provider,
            mfaDetected,
            rememberMeChecked: rememberMe ? rememberMe.checked : false,
            saveConnector: false,
          });
          return;
        }
        // User said "always save" - save without asking
        chrome.runtime.sendMessage({
          type: 'login:submitted',
          action: form.action || '',
          fieldCount: allInputs.length,
          hasPassword,
          hasUsername,
          formMethod: form.method || 'get',
          formId: form.id || '',
          provider,
          mfaDetected,
          rememberMeChecked: rememberMe ? rememberMe.checked : false,
          saveConnector: true,
        });
        return;
      }

      // No preference yet - show permission dialog
      const result = await showConnectorPermissionDialog(provider, location.href);
      
      // Save preference if user checked "remember"
      if (result.remember) {
        await chrome.storage.local.set({ [storageKey]: result.save });
      }

      // Send login event with connector save decision
      chrome.runtime.sendMessage({
        type: 'login:submitted',
        action: form.action || '',
        fieldCount: allInputs.length,
        hasPassword,
        hasUsername,
        formMethod: form.method || 'get',
        formId: form.id || '',
        provider,
        mfaDetected,
        rememberMeChecked: rememberMe ? rememberMe.checked : false,
        saveConnector: result.save,
      });
    }
  }, true);

  // ── OAuth / SSO link clicks ───────────────────────────────
  document.addEventListener('click', (e) => {
    const anchor = e.target.closest('a[href]');
    if (!anchor) return;
    const href = anchor.href || '';
    if (/oauth|sso|signin|login|auth\/|openid/i.test(href)) {
      chrome.runtime.sendMessage({
        type: 'login:detected',
        action: href,
        fieldCount: 0,
        hasPassword: false,
        hasUsername: false,
        formMethod: 'GET (link click)',
        provider: detectOAuthProviderFromUrl(href),
      });
    }
  }, true);

  // ── Page activity heartbeat ────────────────────────────────
  function sendHeartbeat() {
    const structure = getPageStructure();
    const metadata = getPageMetadata();
    const scrollY = window.scrollY;
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;
    const pageHeight = document.documentElement.scrollHeight;
    const scrollPercent = pageHeight > viewportHeight ? Math.round((scrollY / (pageHeight - viewportHeight)) * 100) : 100;

    let performance = {};
    try { performance = getPerformanceMetrics(); } catch (e) {}

    chrome.runtime.sendMessage({
      type: 'activity:heartbeat',
      scrollY,
      scrollPercent,
      viewportHeight,
      viewportWidth,
      pageHeight,
      ...structure,
      lang: metadata.lang,
      description: metadata.description,
      canonical: metadata.canonical,
      ogTitle: metadata.ogTitle,
      ogDescription: metadata.ogDescription,
      ogImage: metadata.ogImage,
      twitterCard: metadata.twitterCard,
      isSecure: metadata.isSecure,
      performance,
    }).catch(() => {});
  }

  setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
  sendHeartbeat();

  // ── Visibility changes ────────────────────────────────────
  document.addEventListener('visibilitychange', () => {
    chrome.runtime.sendMessage({
      type: 'page:visibility',
      visible: !document.hidden,
    }).catch(() => {});
  });

  // ── Performance reporting ─────────────────────────────────
  window.addEventListener('load', () => {
    setTimeout(() => {
      try {
        const perf = getPerformanceMetrics();
        chrome.runtime.sendMessage({
          type: 'page:performance',
          domContentLoaded: perf.domContentLoaded,
          loadEvent: perf.loadEvent,
          firstPaint: perf.firstPaint,
          firstContentfulPaint: perf.firstContentfulPaint,
          resources: perf.resourceCount,
          transferSize: perf.transferSize,
        }).catch(() => {});
      } catch (e) {}
    }, 1000);
  });

  // ── Provider detection helpers ────────────────────────────
  function detectLoginProviderFromUrl() {
    const u = location.hostname.toLowerCase() + location.pathname.toLowerCase();
    if (/google|gmail/i.test(u)) return 'google';
    if (/microsoft|live\.com|outlook/i.test(u)) return 'microsoft';
    if (/github/i.test(u)) return 'github';
    if (/facebook|fb\.com/i.test(u)) return 'facebook';
    if (/twitter|x\.com/i.test(u)) return 'twitter';
    if (/linkedin/i.test(u)) return 'linkedin';
    if (/apple|icloud/i.test(u)) return 'apple';
    if (/amazon/i.test(u)) return 'amazon';
    if (/netflix/i.test(u)) return 'netflix';
    if (/spotify/i.test(u)) return 'spotify';
    if (/slack/i.test(u)) return 'slack';
    if (/discord/i.test(u)) return 'discord';
    return 'unknown';
  }

  function detectOAuthProviderFromUrl(url) {
    const u = url.toLowerCase();
    if (/google/i.test(u)) return 'google';
    if (/microsoft|live\.com|azure/i.test(u)) return 'microsoft';
    if (/github/i.test(u)) return 'github';
    if (/facebook/i.test(u)) return 'facebook';
    if (/twitter|x\.com/i.test(u)) return 'twitter';
    if (/linkedin/i.test(u)) return 'linkedin';
    if (/apple/i.test(u)) return 'apple';
    if (/auth0/i.test(u)) return 'auth0';
    if (/okta/i.test(u)) return 'okta';
    if (/discord/i.test(u)) return 'discord';
    if (/paypal/i.test(u)) return 'paypal';
    if (/keycloak/i.test(u)) return 'keycloak';
    if (/clerk/i.test(u)) return 'clerk';
    if (/supabase/i.test(u)) return 'supabase';
    if (/firebase/i.test(u)) return 'firebase';
    return 'unknown';
  }

  // ── Reset on SPA navigation ───────────────────────────────
  let lastUrl = location.href;
  function checkUrlChange() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      reportedForm = false;
      checkForLoginForm();
    }
  }
  // Use document.documentElement as fallback if body not ready
  const observeTarget = document.body || document.documentElement;
  const urlObserver = new MutationObserver(checkUrlChange);
  urlObserver.observe(observeTarget, { childList: true, subtree: true });
  // Also poll for pushState/replaceState (these don't trigger mutation)
  setInterval(checkUrlChange, 2000);
})();
