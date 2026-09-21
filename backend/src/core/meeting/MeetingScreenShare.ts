/**
 * MeetingScreenShare — best-effort "share your screen like a normal user" for
 * the common web meeting UIs (Google Meet, Zoom Web, Microsoft Teams Web).
 *
 * The meeting runs in the user's real Chrome (via RealDesktop2 CDP), so
 * sharing is done by evaluating small DOM-automation snippets in the meeting
 * tab: find the "Present / Share" button by its accessible label, click it,
 * then confirm the share source in the dialog that appears.
 *
 * This is deliberately heuristic: meeting UIs change and are localized, so the
 * snippets degrade to a clear status string the companion can surface (and the
 * user can always click Share themselves). The deterministic, testable part is
 * the orchestration in MeetingCompanion — this module just supplies the
 * provider-specific browser glue.
 */

export type MeetingProvider = 'meet' | 'zoom' | 'teams' | 'other';

export function detectMeetingProvider(url: string): MeetingProvider {
  const u = url.toLowerCase();
  if (u.includes('meet.google.com')) return 'meet';
  if (u.includes('zoom.us')) return 'zoom';
  if (u.includes('teams.microsoft.com') || u.includes('teams.live.com')) return 'teams';
  return 'other';
}

export type ShareTarget = 'screen' | 'window' | 'tab';

const WAIT = `const __wait = (ms) => new Promise((r) => setTimeout(r, ms));`;

const CLICK_HELPER = `const __find = (re) =>
  [...document.querySelectorAll('button, [role="button"], [aria-label], [data-tooltip]')]
    .find((el) => re.test((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('data-tooltip') || '') + ' ' + (el.textContent || '')));`;

/** Return a status string describing what happened (or what was not found). */
export function meetingShareScript(provider: MeetingProvider, target: ShareTarget = 'screen'): string {
  if (provider === 'meet') return meetShareScript(target);
  if (provider === 'zoom') return zoomShareScript(target);
  if (provider === 'teams') return teamsShareScript(target);
  return genericShareScript();
}

export function meetingStopShareScript(provider: MeetingProvider): string {
  if (provider === 'meet') {
    return `(async () => { ${WAIT} ${CLICK_HELPER}
      const stop = __find(/stop presenting|stop sharing|stop screen share|you are presenting/i);
      if (stop) { stop.click(); return 'stopped sharing'; }
      return 'stop-share button not found';
    })()`;
  }
  if (provider === 'zoom') {
    return `(async () => { ${WAIT} ${CLICK_HELPER}
      const stop = __find(/stop share/i);
      if (stop) { stop.click(); return 'stopped sharing'; }
      return 'stop-share button not found';
    })()`;
  }
  if (provider === 'teams') {
    return `(async () => { ${WAIT} ${CLICK_HELPER}
      const stop = __find(/stop presenting|stop sharing/i);
      if (stop) { stop.click(); return 'stopped sharing'; }
      return 'stop-share button not found';
    })()`;
  }
  return genericStopShareScript();
}

/** Toggle the local mic (best-effort DOM automation like the share scripts). */
export function meetingMuteScript(provider: MeetingProvider, muted: boolean): string {
  const state = muted ? /mute|turn off mic|microphone off|muted/i : /unmute|turn on mic|microphone on|unmuted|mute yourself/i;
  const label = muted ? 'mute' : 'unmute';
  const generic = `(async () => { ${WAIT} ${CLICK_HELPER}
    const mic = __find(${state});
    if (!mic) return '${label} button not found';
    mic.click();
    return '${label} clicked';
  })()`;
  if (provider === 'meet') {
    return `(async () => { ${WAIT} ${CLICK_HELPER}
      const mic = __find(/mic|microphone/i);
      if (!mic) return '${label} button not found';
      mic.click();
      return '${label} clicked';
    })()`;
  }
  if (provider === 'zoom') {
    return `(async () => { ${WAIT} ${CLICK_HELPER}
      const mic = __find(/mute|unmute|microphone/i);
      if (!mic) return '${label} button not found';
      mic.click();
      return '${label} clicked';
    })()`;
  }
  if (provider === 'teams') {
    return `(async () => { ${WAIT} ${CLICK_HELPER}
      const mic = __find(/mute|unmute|microphone/i);
      if (!mic) return '${label} button not found';
      mic.click();
      return '${label} clicked';
    })()`;
  }
  return generic;
}

/** Raise/lower the (virtual) hand in the meeting (best-effort DOM automation). */
export function meetingRaiseHandScript(provider: MeetingProvider, raised: boolean): string {
  const label = raised ? 'raise hand' : 'lower hand';
  const re = raised ? /raise\s*hand|raise\s+your\s+hand/i : /lower\s*hand|lower\s+your\s+hand|put\s+down/i;
  return `(async () => { ${WAIT} ${CLICK_HELPER}
    const btn = __find(${re});
    if (!btn) return '${label} button not found';
    btn.click();
    return '${label} clicked';
  })()`;
}

/**
 * Send a message in the meeting chat (best-effort DOM automation): open the
 * chat panel if closed, find the composer, type the message, press Enter.
 */
export function meetingChatScript(provider: MeetingProvider, message: string): string {
  const safe = JSON.stringify(message);
  const openChat = provider === 'meet'
    ? `const chatBtn = __find(/chat|in meeting messages/i); if (chatBtn && !document.querySelector('[role="complementary"]')) chatBtn.click();`
    : provider === 'teams'
      ? `const chatBtn = __find(/show chat|chat/i); if (chatBtn) chatBtn.click();`
      : `const chatBtn = __find(/chat/i); if (chatBtn) chatBtn.click();`;
  return `(async () => { ${WAIT} ${CLICK_HELPER}
    ${openChat}
    await __wait(500);
    const box = document.querySelector('textarea, [contenteditable="true"], [role="textbox"]');
    if (!box) return 'chat input not found';
    box.focus();
    if (box.tagName === 'TEXTAREA') {
      box.value = ${safe};
      box.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      box.textContent = ${safe};
      box.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
    await __wait(200);
    const form = box.closest('form');
    if (form) { form.requestSubmit(); return 'message sent'; }
    const send = __find(/send|^\\s*\\u27a4\\s*$/i);
    if (send) { send.click(); return 'message sent'; }
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    return 'message entered (Enter pressed)';
  })()`;
}

function meetShareScript(target: ShareTarget): string {
  const source = target === 'tab' ? 'a chrome tab' : target === 'window' ? 'a window' : 'your entire screen';
  return `(async () => { ${WAIT} ${CLICK_HELPER}
    const present = __find(/present now|present|share screen|share your screen/i);
    if (!present) return 'present button not found';
    present.click();
    await __wait(800);
    const source = __find(new RegExp('${source.replace(/\s+/g, '\\s+')}', 'i'));
    if (source) source.click();
    await __wait(400);
    const confirm = __find(/^\\s*share\\s*$/i);
    if (confirm) confirm.click();
    return 'share clicked';
  })()`;
}

function zoomShareScript(target: ShareTarget): string {
  void target;
  return `(async () => { ${WAIT} ${CLICK_HELPER}
    const share = __find(/share screen/i);
    if (!share) return 'share screen button not found';
    share.click();
    await __wait(900);
    const screen = __find(/screen/i);
    if (screen) screen.click();
    await __wait(400);
    const confirm = __find(/^\\s*share\\s*$/i);
    if (confirm) confirm.click();
    return 'share clicked';
  })()`;
}

function teamsShareScript(target: ShareTarget): string {
  const source = target === 'tab' ? 'window' : 'screen';
  return `(async () => { ${WAIT} ${CLICK_HELPER}
    const share = __find(/share content|share screen|^share$/i);
    if (!share) return 'share button not found';
    share.click();
    await __wait(900);
    const src = __find(new RegExp('${source}', 'i'));
    if (src) src.click();
    await __wait(400);
    const confirm = __find(/share screen/i);
    if (confirm) confirm.click();
    return 'share clicked';
  })()`;
}

function genericShareScript(): string {
  return `(async () => { ${WAIT} ${CLICK_HELPER}
    const btn = __find(/present|share screen|share content/i);
    if (!btn) return 'share button not found';
    btn.click();
    return 'share clicked';
  })()`;
}

function genericStopShareScript(): string {
  return `(async () => { ${WAIT} ${CLICK_HELPER}
    const stop = __find(/stop presenting|stop sharing|stop share/i);
    if (stop) { stop.click(); return 'stopped sharing'; }
    return 'stop-share button not found';
  })()`;
}
