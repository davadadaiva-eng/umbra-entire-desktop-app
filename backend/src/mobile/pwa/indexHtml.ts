/**
 * The Umbra smartphone PWA — embedded so it ships with the compiled OS
 * (no asset-copy step). Pairing uses encrypted QR (ECDH + AES-256-GCM),
 * commands and the compressed live view run over the encrypted relay, and
 * the client attempts a direct WebRTC data channel when the PC reports a
 * media backend. Zero central routing.
 *
 * NOTE: the inline JS below deliberately avoids backtick template literals
 * and `${}` so it can live inside this TypeScript template literal.
 */

export const pwaHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"/>
<meta name="theme-color" content="#0f1117"/>
<meta name="mobile-web-app-capable" content="yes"/>
<title>Umbra — Remote</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0f1117;color:#e6e6e6;font-family:system-ui,-apple-system,sans-serif;min-height:100vh}
header{padding:14px 16px;background:#161a22;border-bottom:1px solid #22262f;display:flex;align-items:center;gap:10px;position:sticky;top:0;z-index:5}
header h1{font-size:16px;font-weight:600}
.dot{width:9px;height:9px;border-radius:50%;background:#e5484d;display:inline-block}
.dot.ok{background:#30a46c}
main{padding:16px;max-width:560px;margin:0 auto;display:flex;flex-direction:column;gap:16px}
.card{background:#161a22;border:1px solid #22262f;border-radius:12px;padding:14px}
.card h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#9ba1aa;margin-bottom:10px}
input,textarea,button{font:inherit;color:inherit}
input[type=text],textarea{width:100%;background:#0f1117;border:1px solid #2a2f3a;border-radius:8px;padding:10px}
textarea{min-height:64px;resize:vertical}
button{background:#4f46e5;border:0;color:#fff;border-radius:8px;padding:10px 14px;cursor:pointer;font-weight:600}
button.secondary{background:#262b36}
button:disabled{opacity:.45;cursor:not-allowed}
.row{display:flex;gap:8px;flex-wrap:wrap}
video{width:100%;border-radius:10px;background:#000;display:block}
img#live{width:100%;border-radius:10px;background:#000;display:block}
#scanBox{position:relative;overflow:hidden;border-radius:10px;background:#000}
#scanBox video{min-height:180px;object-fit:cover}
#log{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;color:#9ba1aa;white-space:pre-wrap;max-height:180px;overflow-y:auto}
.hidden{display:none}
.muted{color:#9ba1aa;font-size:12px}
.titem{border:1px solid #22262f;border-radius:10px;padding:10px;margin-bottom:10px;background:#12151d}
.titem .tdesc{font-weight:600;font-size:14px}
.titem .tmeta{font-size:11px;color:#9ba1aa;margin-top:3px}
.titem .tsteps{margin-top:8px}
.tstep{font-size:12px;color:#c3c7cf;padding:3px 0;border-top:1px solid #1d2129}
.tstep.done{color:#30a46c}
.tstep.cur{color:#e6c76a}
.tstep.err{color:#e5484d}
.badge{display:inline-block;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;border-radius:999px;padding:2px 8px;margin-left:6px;vertical-align:2px}
.b-completed{background:#14301f;color:#30a46c}
.b-executing{background:#2a2410;color:#e6c76a}
.b-failed{background:#301418;color:#e5484d}
.b-cancelled{background:#232830;color:#9ba1aa}
.b-pending,.b-planning,.b-healing{background:#1c2130;color:#8ab4f8}
.tbar{height:4px;background:#1d2129;border-radius:2px;margin-top:6px;overflow:hidden}
.tbar i{display:block;height:100%;background:#4f46e5;border-radius:2px}
</style>
</head>
<body>
<header>
  <span class="dot" id="statusDot"></span>
  <h1>Umbra OS <span class="muted">remote</span></h1>
  <span class="muted" id="statusText">not paired</span>
</header>
<main>

  <div class="card" id="pairCard">
    <h2>Pair with your PC</h2>
    <div class="row">
      <button id="scanBtn">Scan QR</button>
      <button class="secondary" id="pasteBtn">Paste payload</button>
      <button class="secondary" id="autoPairBtn">Auto-pair</button>
    </div>
    <div id="scanBox" class="hidden"><video id="scanner" playsinline muted></video></div>
    <div id="pasteBox" class="hidden" style="margin-top:10px">
      <textarea id="payloadInput" placeholder='Paste the pairing payload JSON here, e.g. {"sessionId":"...","host":"192.168.1.5","port":9444,...}'></textarea>
      <div class="row" style="margin-top:8px"><button id="payloadOk">Connect</button></div>
    </div>
    <div id="deviceNameRow" style="margin-top:10px">
      <input type="text" id="deviceName" placeholder="Device name (e.g. Pixel 9)" value="Phone"/>
    </div>
    <div id="pairingErr" class="muted" style="color:#e5484d;margin-top:8px"></div>
  </div>

  <div class="card">
    <h2>Ask Umbra</h2>
    <textarea id="chatInput" placeholder="Type or speak a task — Umbra runs it in the cloud, on your connectors, or on your PC if it’s on…"></textarea>
    <div class="row" style="margin-top:8px">
      <button id="btnAsk">Send</button>
      <button class="secondary" id="btnMic">🎤 Speak</button>
    </div>
    <div class="muted" style="margin-top:6px">Routed automatically: cloud agents, connected devices, or your PC.</div>
  </div>

  <div class="card" id="tasksCard">
    <h2>Tasks <span class="muted">(synced over the device mesh)</span>
      <button class="secondary" id="btnRefreshTasks" style="float:right;padding:4px 10px">Refresh</button>
    </h2>
    <div id="taskList" class="muted">Loading tasks…</div>
    <div class="muted" style="margin-top:8px">Live updates from the PC’s agent. Cancel/retry run through the consent-gated channel.</div>
  </div>

  <div class="card" id="planCard">
    <h2>Plan &amp; devices
      <button class="secondary" id="btnRefreshDevices" style="float:right;padding:4px 10px">Refresh</button>
    </h2>
    <div id="deviceInfo" class="muted">Loading…</div>
  </div>

  <div class="card" id="voiceCard">
    <h2>Push-to-talk
      <button class="secondary" id="btnRefreshVoice" style="float:right;padding:4px 10px">Refresh</button>
    </h2>
    <div id="voiceInfo" class="muted">Loading…</div>
    <div class="row" style="margin-top:8px">
      <input type="text" id="pttCombo" placeholder="Hotkey, e.g. Ctrl+Shift+V" style="flex:1"/>
      <button id="btnSetPtt">Enable</button>
      <button class="secondary" id="btnDisablePtt">Disable</button>
    </div>
    <div class="muted" style="margin-top:6px" id="pttMsg">Hold the hotkey, speak, release — Umbra transcribes, routes and runs the task.</div>
  </div>

  <div class="card" id="viewCard" style="display:none">
    <h2>Live view <span class="muted">(compressed frames)</span></h2>
    <img id="live" alt="live" width="100%"/>
    <div class="row" style="margin-top:8px">
      <button id="btnScreenshot">Screenshot</button>
      <button class="secondary" id="btnSub">Subscribe stream</button>
      <button class="secondary" id="btnTask">Submit task</button>
    </div>
    <div style="margin-top:10px">
      <input type="text" id="taskInput" placeholder="Describe a task for the agent..."/>
    </div>
  </div>

  <div class="card">
    <h2>Command console</h2>
    <div class="row">
      <button class="secondary" data-cmd='{"action":"screenshot"}'>Shot</button>
      <button class="secondary" data-cmd='{"action":"status"}'>Status</button>
      <button class="secondary" data-cmd='{"action":"getSessions"}'>Sessions</button>
      <button class="secondary" data-cmd='{"action":"getMacros"}'>Macros</button>
    </div>
    <div class="row" style="margin-top:8px">
      <input type="text" id="actionInput" placeholder='{"action":"...","params":{...}}'/>
      <button id="btnSend">Send</button>
    </div>
    <div class="muted" style="margin-top:6px">Every action is consent-gated on the PC. Emergency stop: create ~/.umbra/emergency-stop.</div>
  </div>

  <div class="card">
    <h2>Log</h2>
    <div id="log"></div>
  </div>

</main>

<script>
(function(){
"use strict";
var logEl = document.getElementById('log');
var statusDot = document.getElementById('statusDot');
var statusText = document.getElementById('statusText');
function log(msg){ logEl.textContent = new Date().toISOString().slice(11,19) + '  ' + msg + '\\n' + logEl.textContent.slice(0, 4000); }
function setStatus(text, ok){ statusText.textContent = text; statusDot.className = 'dot' + (ok ? ' ok' : ''); }

// ── base64 (browser) helpers ────────────────────────────────
function bytesToB64(bytes){
  var bin = '';
  var CH = 0x8000;
  for (var i = 0; i < bytes.length; i += CH){
    var chunk = bytes.subarray(i, i + CH);
    for (var j = 0; j < chunk.length; j++){ bin += String.fromCharCode(chunk[j]); }
  }
  return btoa(bin);
}
function b64ToBytes(b64){
  var bin = atob(b64);
  var out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++){ out[i] = bin.charCodeAt(i); }
  return out;
}
function pemToBuf(pem){
  var body = pem.replace(/-----BEGIN [^-]+-----/,'').replace(/-----END [^-]+-----/,'').replace(/\\s/g,'');
  return b64ToBytes(body);
}
function bufToPem(buf){
  var b64 = bytesToB64(buf);
  var lines = [];
  for (var i = 0; i < b64.length; i += 64){ lines.push(b64.slice(i, i + 64)); }
  return '-----BEGIN PUBLIC KEY-----\\n' + lines.join('\\n') + '\\n-----END PUBLIC KEY-----';
}

// ── pairing state ───────────────────────────────────────────
var pair = null;          // QR payload
var aesKey = null;        // CryptoKey (AES-GCM)
var deviceId = null;
var ws = null;
var subscribed = false;
var reqSeq = 0;
var pending = {};

// ── camera scanner ──────────────────────────────────────────
var scannerStream = null;
document.getElementById('scanBtn').addEventListener('click', function(){
  document.getElementById('scanBox').classList.remove('hidden');
  var video = document.getElementById('scanner');
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia){
    navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}}).then(function(stream){
      scannerStream = stream;
      video.srcObject = stream;
      video.play();
      tryScan();
    }).catch(function(e){ log('Camera unavailable: ' + e.message + ' — use paste instead.'); });
  } else {
    log('Camera not supported on this device — use paste instead.');
  }
  if ('BarcodeDetector' in window){
    try {
      var detector = new BarcodeDetector({formats:['qr_code']});
      var iv = setInterval(function(){
        detector.detect(video).then(function(codes){
          for (var i = 0; i < codes.length; i++){
            var raw = codes[i].rawValue;
            if (raw && raw.indexOf('sessionId') !== -1){ stopScanner(); connectFromPayload(raw); clearInterval(iv); return; }
          }
        }).catch(function(){});
      }, 500);
    } catch(e){ log('BarcodeDetector unavailable.'); }
  }
});
function stopScanner(){
  if (scannerStream){ scannerStream.getTracks().forEach(function(t){ t.stop(); }); scannerStream = null; }
  document.getElementById('scanBox').classList.add('hidden');
}
document.getElementById('pasteBtn').addEventListener('click', function(){
  document.getElementById('pasteBox').classList.toggle('hidden');
});
document.getElementById('autoPairBtn').addEventListener('click', function(){
  // Same-origin: the PWA is served from the PC, so this works over plain
  // HTTP on the LAN — no camera, no secure-context requirement, no paste.
  log('Fetching pairing payload from the PC…');
  fetch('/api/pairing', {method:'POST'}).then(function(r){ return r.json(); }).then(function(j){
    if (!j.payload){ throw new Error('no payload'); }
    connectFromPayload(JSON.stringify(j.payload));
  }).catch(function(e){
    log('Auto-pair failed: ' + e.message + ' — scan the QR or paste instead.');
  });
});
document.getElementById('payloadOk').addEventListener('click', function(){
  var raw = document.getElementById('payloadInput').value.trim();
  connectFromPayload(raw);
});

function connectFromPayload(raw){
  try {
    pair = JSON.parse(raw);
    if (!pair.sessionId || !pair.host || !pair.port || !pair.publicKeyPem){ throw new Error('invalid payload'); }
    log('Pairing payload parsed (host ' + pair.host + ':' + pair.port + ')');
    startPairing();
  } catch(e){
    document.getElementById('pairingErr').textContent = 'Invalid pairing payload: ' + e.message;
    log('Pairing failed: ' + e.message);
  }
}

// ── WebCrypto: ECDH → AES-GCM key ───────────────────────────
function deriveKey(peerSpki){
  return crypto.subtle.generateKey({name:'ECDH', namedCurve:'P-256'}, true, ['deriveBits'])
    .then(function(keys){
      return crypto.subtle.importKey('spki', pemToBuf(peerSpki), {name:'ECDH', namedCurve:'P-256'}, false, [])
        .then(function(peerPub){
          return {keys: keys, peerPub: peerPub};
        });
    })
    .then(function(ctx){
      return crypto.subtle.deriveBits({name:'ECDH', public: ctx.peerPub}, ctx.keys.privateKey, 256)
        .then(function(bits){
          return crypto.subtle.importKey('raw', ctx.keys.publicKey, {name:'ECDH', namedCurve:'P-256'}, false, [])
            .then(function(ignored){ return {bits: bits, pub: ctx.keys.publicKey}; });
        });
    })
    .then(function(ctx){
      return crypto.subtle.digest('SHA-256', ctx.bits).then(function(hash){
        return crypto.subtle.importKey('raw', hash, {name:'AES-GCM'}, false, ['encrypt','decrypt']).then(function(k){
          return {key: k, pubSpki: ctx.pub};
        });
      });
    })
    .then(function(r){
      return crypto.subtle.exportKey('spki', r.pubSpki).then(function(spki){ return {key: r.key, pubPem: bufToPem(new Uint8Array(spki))}; });
    });
}

// ── AEAD codec (wire-compatible with Node EncryptedChannel) ─
function encText(text){
  var iv = crypto.getRandomValues(new Uint8Array(12));
  var data = new TextEncoder().encode(text);
  return crypto.subtle.encrypt({name:'AES-GCM', iv: iv}, aesKey, data).then(function(combined){
    var c = new Uint8Array(combined);
    return {iv: bytesToB64(iv), tag: bytesToB64(c.subarray(c.length-16)), data: bytesToB64(c.subarray(0, c.length-16)), v: 1};
  });
}
function decMsg(enc){
  var iv = b64ToBytes(enc.iv);
  var tag = b64ToBytes(enc.tag);
  var data = b64ToBytes(enc.data);
  var combined = new Uint8Array(data.length + 16);
  combined.set(data, 0);
  combined.set(tag, data.length);
  return crypto.subtle.decrypt({name:'AES-GCM', iv: iv}, aesKey, combined).then(function(pt){
    return JSON.parse(new TextDecoder().decode(pt));
  });
}

// ── signaling + pairing ─────────────────────────────────────
function startPairing(){
  setStatus('connecting…', false);
  deriveKey(pair.publicKeyPem).then(function(r){
    var url2 = (location.protocol === 'https:' ? 'wss://' : 'ws://') + pair.host + ':' + pair.port;
    ws = new WebSocket(url2);
    ws.onopen = function(){
      log('Signaling connected — pairing…');
      var name = document.getElementById('deviceName').value || 'Phone';
      ws.send(JSON.stringify({type:'pair', sessionId: pair.sessionId, name: name, devicePublicKeyPem: r.pubPem}));
    };
    ws.onmessage = function(ev){
      var msg = JSON.parse(ev.data);
      if (msg.type === 'paired'){
        deviceId = msg.deviceId;
        aesKey = r.key;
        log('Paired as ' + msg.deviceId);
        hello();
      } else if (msg.type === 'welcome'){
        setStatus('connected', true);
        log('Welcome: relayFps=' + msg.relayFps + ' webrtc=' + msg.webrtc);
        document.getElementById('pairCard').style.display = 'none';
        document.getElementById('viewCard').style.display = 'block';
        loadDeviceInfo();
        if (msg.webrtc === true){ tryWebRTC(msg.stunServers || [], msg.turnServers || []); }
      } else if (msg.type === 'enc'){
        handleEnc(msg.enc);
      } else if (msg.type === 'pair-failed' || msg.type === 'error'){
        log('Error: ' + (msg.error || 'unknown'));
        setStatus('pairing failed', false);
      }
    };
    ws.onclose = function(){ setStatus('disconnected', false); log('Signaling closed'); };
    ws.onerror = function(){ log('Signaling error'); setStatus('connection error', false); };
  }).catch(function(e){ log('Key derivation failed: ' + e.message); });
}

function hello(){
  ws.send(JSON.stringify({type:'hello', deviceId: deviceId}));
}

function sendEnc(payload){
  if (!ws || ws.readyState !== 1 || !aesKey) return;
  encText(JSON.stringify(payload)).then(function(enc){
    ws.send(JSON.stringify({type:'enc', enc: enc}));
  });
}

function handleEnc(enc){
  if (!aesKey) return;
  decMsg(enc).then(function(inner){
    if (inner.t === 'frame'){
      if (inner.image){
        var img = document.getElementById('live');
        img.src = 'data:image/jpeg;base64,' + inner.image;
      }
    } else if (inner.t === 'result'){
      var p = pending[inner.reqId];
      if (p){ p(inner); delete pending[inner.reqId]; }
      log('RESULT ' + (inner.ok ? JSON.stringify(inner.result) : 'ERR: ' + inner.error));
    } else if (inner.t === 'subscribed'){
      subscribed = true;
      log('Stream subscribed (fps ' + inner.fps + ')');
    } else if (inner.t === 'pong'){
      log('pong');
    } else if (inner.t === 'status'){
      log('STATUS ' + JSON.stringify(inner.status));
    } else if (inner.t === 'webrtc-unavailable'){
      log('WebRTC media backend unavailable — using encrypted relay.');
    } else {
      log('MSG ' + JSON.stringify(inner).slice(0, 200));
    }
  }).catch(function(e){ log('decrypt failed: ' + e.message); });
}

function command(action, params){
  return new Promise(function(resolve){
    var reqId = 'r' + (++reqSeq);
    pending[reqId] = resolve;
    sendEnc({t:'cmd', action: action, params: params || {}, reqId: reqId});
  });
}

// ── Ask Umbra (text + speech) ───────────────────────────────
var chatInput = document.getElementById('chatInput');
function askUmbra(desc){
  if (!desc) return;
  log('Asking Umbra: ' + desc);
  fetch('/api/chat', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({message: desc})})
    .then(function(r){ return r.json(); })
    .then(function(j){
      var d = j.dispatch || j;
      log('DISPATCH → target=' + d.target + ' taskId=' + d.taskId);
      chatInput.value = '';
    })
    .catch(function(){
      // PWA served from the PC: fall back to the encrypted command channel.
      command('submitTask', {description: desc}).then(function(){ chatInput.value = ''; });
    });
}
document.getElementById('btnAsk').addEventListener('click', function(){ askUmbra(chatInput.value.trim()); });

var SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
var recorder = null;
document.getElementById('btnMic').addEventListener('click', function(){
  if (!SpeechRec){ log('Speech recognition not supported in this browser.'); return; }
  if (!recorder){
    recorder = new SpeechRec();
    recorder.lang = 'en-US';
    recorder.interimResults = true;
    recorder.onresult = function(e){
      var t = '';
      for (var i = 0; i < e.results.length; i++){ t += e.results[i][0].transcript; }
      chatInput.value = t;
    };
    recorder.onend = function(){
      log('Speech finished');
      var text = chatInput.value.trim();
      if (text){ log('Submitting: ' + text); askUmbra(text); }
    };
    recorder.onerror = function(e){ log('Mic error: ' + e.error); };
  }
  try { recorder.start(); log('Listening…'); } catch(e){ log('Mic error: ' + e.message); }
});

// ── WebRTC attempt (data channel path, falls back to relay) ─
function tryWebRTC(stunServers, turnServers){
  if (!window.RTCPeerConnection){ return; }
  try {
    var iceServers = (stunServers || []).map(function(u){ return {urls: u}; })
      .concat((turnServers || []).map(function(u){ return {urls: u}; }));
    var pc = new RTCPeerConnection({iceServers: iceServers});
    var ch = pc.createDataChannel('umbra');
    ch.onopen = function(){ log('WebRTC data channel open'); };
    pc.onicecandidate = function(e){
      if (e.candidate){
        sendEnc({t:'webrtc-signal', signal:{kind:'candidate', candidate:{candidate:e.candidate.candidate, sdpMid:e.candidate.sdpMid, sdpMLineIndex:e.candidate.sdpMLineIndex}}});
      }
    };
    pc.createOffer().then(function(offer){
      return pc.setLocalDescription(offer).then(function(){
        sendEnc({t:'webrtc-signal', signal:{kind:'offer', description:{type:offer.type, sdp:offer.sdp}}});
      });
    }).catch(function(){ log('WebRTC offer failed — using relay.'); });
  } catch(e){ log('WebRTC unavailable — using relay.'); }
}

// ── Plan & devices (plan name, token budget, mesh limit) ────
function fmtUsd(n){ return (typeof n === 'number' && isFinite(n)) ? n.toFixed(2) : '0.00'; }
function budgetLine(plan){
  if (!plan){ return ''; }
  var b = plan.budgetUsd;
  var r = plan.remainingUsd;
  if (b === Infinity || b == null){ return 'Budget: <b>Unlimited (your keys)</b>'; }
  if (b === 0){ return 'Budget: <b>Free models only</b>'; }
  return 'Budget: <b>$' + fmtUsd(r) + ' left</b> of $' + fmtUsd(b);
}
function loadDeviceInfo(){
  var el = document.getElementById('deviceInfo');
  if (!el) return;
  fetch('/api/devices').then(function(r){ return r.json(); }).then(function(j){
    var d = j.devices || j;
    var limit = d.deviceLimit;
    var list = d.registered || [];
    var plan = d.plan || {};
    var html = 'Plan: <b>' + String(plan.name || 'Free') + '</b> · ' + budgetLine(plan) +
      '<br/>Device limit: <b>' + (limit === 'unlimited' ? 'Unlimited' : String(limit)) + '</b>' +
      ' · Registered: <b>' + list.length + '</b>';
    if (list.length > 0){
      html += '<div style="margin-top:8px">';
      for (var i = 0; i < list.length; i++){
        var dev = list[i];
        html += '<div class="tstep' + (dev.online ? ' done' : '') + '">' + dev.name +
          ' <span class="muted">(' + dev.role + (dev.online ? ', online' : ', offline') + ')</span></div>';
      }
      html += '</div>';
    }
    el.innerHTML = html;
  }).catch(function(e){
    el.textContent = 'Devices unavailable: ' + e.message;
  });
}
// ── Voice / push-to-talk settings card ─────────────────────
function loadVoiceStatus(){
  var el = document.getElementById('voiceInfo');
  if (!el) return;
  fetch('/api/voice/ptt').then(function(r){ return r.json(); }).then(function(j){
    var p = j.pushToTalk || {};
    var state = p.enabled ? '<span style="color:#30a46c">armed</span>' : '<span style="color:#9ba1aa">off</span>';
    var mic = p.micOk ? '<span style="color:#30a46c">ok</span>' : '<span style="color:#e5484d">no mic / not configured</span>';
    el.innerHTML = 'State: <b>' + state + '</b> · Combo: <b>' + (p.combo || '—') + '</b>' +
      '<br/>Capturing: <b>' + (p.capturing ? 'yes' : 'no') + '</b> · Mic: ' + mic;
    document.getElementById('pttCombo').value = p.combo || '';
  }).catch(function(e){
    el.textContent = 'Voice status unavailable: ' + e.message;
  });
}
function setPushToTalk(combo, enabled){
  var msg = document.getElementById('pttMsg');
  msg.textContent = 'Saving…';
  fetch('/api/voice/ptt', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({combo: combo, enabled: !!enabled})})
    .then(function(r){ return r.json(); })
    .then(function(j){
      if (j.error){ msg.textContent = 'Failed: ' + j.error; return; }
      msg.textContent = enabled ? 'Push-to-talk enabled — hold ' + combo + ' to talk.' : 'Push-to-talk disabled.';
      loadVoiceStatus();
    })
    .catch(function(e){ msg.textContent = 'Failed: ' + e.message; });
}
document.getElementById('btnRefreshVoice').addEventListener('click', loadVoiceStatus);
document.getElementById('btnSetPtt').addEventListener('click', function(){
  setPushToTalk(document.getElementById('pttCombo').value.trim(), true);
});
document.getElementById('btnDisablePtt').addEventListener('click', function(){
  setPushToTalk('', false);
});
loadVoiceStatus();

// ── UI wiring ───────────────────────────────────────────────
document.getElementById('btnScreenshot').addEventListener('click', function(){
  sendEnc({t:'frame'});
});
document.getElementById('btnSub').addEventListener('click', function(){
  if (!subscribed){ sendEnc({t:'subscribe'}); } else { sendEnc({t:'unsubscribe'}); subscribed = false; }
});
document.getElementById('btnTask').addEventListener('click', function(){
  var desc = document.getElementById('taskInput').value.trim();
  if (!desc) return;
  command('submitTask', {description: desc}).then(function(){ document.getElementById('taskInput').value = ''; });
});
document.getElementById('btnSend').addEventListener('click', function(){
  var raw = document.getElementById('actionInput').value.trim();
  if (!raw) return;
  try {
    var msg = JSON.parse(raw);
    command(msg.action, msg.params || {}).then(function(){ document.getElementById('actionInput').value = ''; });
  } catch(e){ log('Invalid command JSON: ' + e.message); }
});
var quick = document.querySelectorAll('[data-cmd]');
for (var i = 0; i < quick.length; i++){
  quick[i].addEventListener('click', function(){
    var m = JSON.parse(this.getAttribute('data-cmd'));
    command(m.action, m.params || {});
  });
}

// ── Task dashboard (synced over the device mesh / REST + WS) ──
var taskList = document.getElementById('taskList');
var tasksCache = {};
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
function taskBadge(st){ return '<span class="badge b-' + esc(st) + '">' + esc(st) + '</span>'; }
function taskSummary(t){
  var p = t.progress != null ? t.progress : (t.completedStepCount != null && t.plan && t.plan.length ? Math.round(100 * t.completedStepCount / t.plan.length) : (t.completedStepCount != null ? t.completedStepCount : 0));
  var meta = (t.node ? 'node: ' + esc(t.node) : '') + (t.priority ? ' · priority ' + t.priority : '');
  var actions = '';
  if (t.status === 'failed' || t.status === 'cancelled'){
    actions = '<div class="row" style="margin-top:8px"><button class="secondary" data-retry="' + esc(t.id) + '">↻ Retry</button></div>';
  }
  return '\\n    <div class="titem"><div class="tdesc">' + esc(t.description || t.id) + taskBadge(t.status || 'pending') + '</div>'
    + '<div class="tmeta">' + meta + (t.error ? ' · <span style="color:#e5484d">' + esc(t.error) + '</span>' : '') + '</div>'
    + (t.totalSteps ? '<div class="tbar"><i style="width:' + Math.min(100, p || 0) + '%"></i></div><div class="tmeta">' + (t.completedStepCount != null ? t.completedStepCount : '?') + '/' + t.totalSteps + ' steps</div>' : '')
    + actions
    + '</div>';
}
function renderTasks(){
  var ids = Object.keys(tasksCache).sort().reverse();
  if (!ids.length){ taskList.textContent = 'No active tasks.'; return; }
  taskList.innerHTML = ids.map(function(id){ return taskSummary(tasksCache[id]); }).join('');
}
function upsertTask(t){
  if (!t || !t.id) return;
  var prev = tasksCache[t.id];
  tasksCache[t.id] = t;
  if (prev && prev.status === 'completed' && (t.status === 'completed' || !t.status)) return; // keep finished snapshot
  renderTasks();
}
function loadTasks(){
  fetch('/api/tasks', {headers:{'Accept':'application/json'}})
    .then(function(r){ return r.json(); })
    .then(function(j){
      var list = (j && j.tasks) || [];
      if (list && list.length){ for (var i = 0; i < list.length; i++){ upsertTask(list[i]); } }
      if (!Object.keys(tasksCache).length){ taskList.textContent = 'No active tasks.'; }
    })
    .catch(function(){ taskList.textContent = 'Could not load tasks — is the agent running?'; });
}
document.getElementById('btnRefreshTasks').addEventListener('click', loadTasks);

// Live task events: the ApiServer (/api/ws on port 8787) relays every
// task:created/started/completed/failed/cancelled as {type:'event', name, payload}.
(function(){
  var w = null;
  function open(){
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    var port = (location.hostname === 'localhost' || location.hostname === '127.0.0.1') ? ':8787' : '';
    w = new WebSocket(proto + location.hostname + port + '/api/ws');
    w.onopen = function(){ log('Task stream connected'); };
    w.onmessage = function(ev){
      try {
        var m = JSON.parse(ev.data);
        if (m && m.type === 'event' && m.name && m.name.indexOf('task:') === 0){
          var t = (m.payload && typeof m.payload === 'object') ? m.payload : {id: String(m.payload)};
          upsertTask(t);
          log('TASK ' + m.name + ' ' + (t.id || ''));
        }
      } catch(e){ }
    };
    w.onclose = function(){ setTimeout(open, 3000); };
    w.onerror = function(){ try { w.close(); } catch(e){} };
  }
  open();
})();

// Consent-gated retry: ask the PC for a consent grant first, then POST the
// retry (with the task description) to the agent's REST API.
function retryTask(taskId, description){
  log('Requesting consent to retry ' + taskId + '…');
  fetch('/api/consent', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({action:'request', reason: 'retry task ' + taskId})})
    .then(function(r){ return r.json(); })
    .then(function(j){
      if (j && j.result !== 'granted'){ log('Retry denied: ' + (j && j.result)); return; }
      return fetch('/api/task/' + encodeURIComponent(taskId) + '/retry', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({description: description || ''})})
        .then(function(r){ return r.json(); })
        .then(function(j2){
          log('Retry sent: ' + (j2 && j2.taskId ? j2.taskId : JSON.stringify(j2)));
          loadTasks();
        });
    })
    .catch(function(e){ log('Retry failed: ' + e.message); });
}

document.getElementById('taskList').addEventListener('click', function(ev){
  var el = ev.target;
  if (el && el.getAttribute && el.getAttribute('data-retry')){
    var id = el.getAttribute('data-retry');
    var t = tasksCache[id] || {};
    retryTask(id, t.description);
  }
});

// Consent-gated cancel: ask the PC for a consent grant first, then POST the
// cancel to the agent's REST API.
function cancelTask(taskId){
  log('Requesting consent to cancel ' + taskId + '…');
  fetch('/api/consent', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({action:'request', reason: 'cancel task ' + taskId})})
    .then(function(r){ return r.json(); })
    .then(function(j){
      if (j && j.result !== 'granted'){ log('Cancel denied: ' + (j && j.result)); return; }
      return fetch('/api/task/' + encodeURIComponent(taskId) + '/cancel', {method:'POST'})
        .then(function(r){ return r.json(); })
        .then(function(j2){
          log('Cancel sent: ' + (j2 && j2.cancelled ? j2.cancelled : JSON.stringify(j2)));
          loadTasks();
        });
    })
    .catch(function(e){ log('Cancel failed: ' + e.message); });
}
log('Umbra remote loaded. Scan the QR from your PC’s /pair page.');
})();
</script>
</body>
</html>`;
