/**
 * Umbra Browser Link — Popup Script
 */

const toggle = document.getElementById('toggle');
const toggleCard = document.getElementById('toggleCard');
const statusPill = document.getElementById('statusPill');
const statusText = document.getElementById('statusText');
const sessionId = document.getElementById('sessionId');
const statEvents = document.getElementById('statEvents');
const statTabs = document.getElementById('statTabs');
const stats = document.getElementById('stats');
const sessionCard = document.getElementById('sessionCard');
const logo = document.getElementById('logo');
const subtitle = document.getElementById('subtitle');
const clearBtn = document.getElementById('clearBtn');

function updateUI(res) {
  if (!res) return;
  const isOn = res.enabled;

  // Toggle
  toggle.classList.toggle('on', isOn);
  toggleCard.classList.toggle('disabled', !isOn);

  // Dim sections when off
  stats.classList.toggle('disabled', !isOn);
  sessionCard.classList.toggle('disabled', !isOn);
  logo.classList.toggle('disabled', !isOn);

  // Stats
  statEvents.textContent = res.eventCount || 0;
  statTabs.textContent = res.tabCount || 0;
  sessionId.textContent = res.sessionId || '—';

  // Status pill
  if (!isOn) {
    statusPill.className = 'status-pill paused';
    statusText.textContent = 'Tracking paused';
    subtitle.textContent = 'Disabled';
  } else if (res.umbraOnline) {
    statusPill.className = 'status-pill online';
    statusText.textContent = 'Connected to Umbra';
    subtitle.textContent = 'Streaming live';
  } else {
    statusPill.className = 'status-pill offline';
    const q = res.eventCount || 0;
    statusText.textContent = q > 0 ? `Offline · ${q} queued` : 'Offline · queuing';
    subtitle.textContent = 'Buffering locally';
  }
}

// Load state
chrome.runtime.sendMessage({ type: 'popup:getStatus' }, updateUI);

// Toggle tracking
toggle.addEventListener('click', () => {
  const isOn = toggle.classList.contains('on');
  chrome.runtime.sendMessage({ type: 'popup:toggle', enabled: !isOn }, () => {
    chrome.runtime.sendMessage({ type: 'popup:getStatus' }, updateUI);
  });
});

// Clear queue
clearBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'popup:clearQueue' }, () => {
    statEvents.textContent = '0';
    // Refresh status to update the pill text
    chrome.runtime.sendMessage({ type: 'popup:getStatus' }, updateUI);
  });
});

// Periodic refresh
setInterval(() => {
  chrome.runtime.sendMessage({ type: 'popup:getStatus' }, updateUI);
}, 2_000);
