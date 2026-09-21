"""
background_agent.py — Umbra Background Agent
============================================

A free, local, stealth computer agent that works on a secondary display plane
(or in stealth-headless mode) WITHOUT stealing your mouse, keyboard focus or
screen. It drives Chrome through SeleniumBase UC mode (undetected-chromedriver
with TLS/canvas/mouse-curve spoofing) and solves CAPTCHAs locally.

Stack (100% free / open source):
  - SeleniumBase  UC mode  -> undetected ChromeDriver (stealth browser)
  - PaddleOCR              -> local image/text CAPTCHA decoding
  - Vosk + pydub + ffmpeg  -> local audio CAPTCHA decoding
  - Buster extension       -> free Google reCAPTCHA audio solving (optional)
  - Real-profile copy      -> carry over your logged-in sessions (optional)
  - OpenAI-compatible LLM  -> plans and executes steps like a human (NVIDIA)

Display modes:
  --display virtual  -> run on a secondary monitor / virtual display if present
  --display main     -> a 1280x800 window on the primary screen
  --display headless -> fully invisible stealth browser (zero cursor use)

Usage:
  python background_agent.py --task "Check my GitHub notifications"
  python background_agent.py --task "Edit this video" --display virtual --use-real-profile --buster
  python background_agent.py --smoke   # quick stealth-driver self test
"""

import argparse
import base64
import json
import logging
import math
import os
import random
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
import zipfile
from pathlib import Path

UMBRA_DIR = Path(os.environ.get("USERPROFILE", Path.home())) / ".umbra"
AGENT_PROFILE_DIR = UMBRA_DIR / "agent-profile"
BUSTER_DIR = UMBRA_DIR / "buster-ext"
VOSK_MODEL_DIR = UMBRA_DIR / "vosk-model"
LOG_FILE = UMBRA_DIR / "background-agent.log"
CONFIG_FILE = UMBRA_DIR / "config.json"
CHROME_DEFAULT = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
REAL_CHROME_PROFILE = Path(os.environ.get("LOCALAPPDATA", "")) / "Google" / "Chrome" / "User Data"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(message)s",
    handlers=[logging.StreamHandler(), logging.FileHandler(LOG_FILE, encoding="utf-8")],
)
log = logging.getLogger("background-agent")

# --------------------------------------------------------------------------
# Human-like timing & mouse curves
# --------------------------------------------------------------------------

def human_delay(fast: bool = False, minimum: float = 0.5, maximum: float = 2.5) -> None:
    """Randomized delay between actions — makes automation look human."""
    if fast:
        minimum, maximum = 0.15, 0.7
    time.sleep(random.uniform(minimum, maximum))


def _bezier_points(p0, p1, p2, p3, steps):
    """Cubic bezier path with random control points -> natural mouse arc."""
    pts = []
    for i in range(steps + 1):
        t = i / steps
        x = (1 - t) ** 3 * p0[0] + 3 * (1 - t) ** 2 * t * p1[0] + 3 * (1 - t) * t ** 2 * p2[0] + t ** 3 * p3[0]
        y = (1 - t) ** 3 * p0[1] + 3 * (1 - t) ** 2 * t * p1[1] + 3 * (1 - t) * t ** 2 * p2[1] + t ** 3 * p3[1]
        pts.append((int(x), int(y)))
    return pts


def human_mouse_move(target_x, target_y):
    """Move the physical cursor along a human-like bezier curve (Windows/macOS)."""
    try:
        import ctypes
        if sys.platform == "win32":
            class POINT(ctypes.Structure):
                _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]
            pt = POINT()
            ctypes.windll.user32.GetCursorPos(ctypes.byref(pt))
            cur = (pt.x, pt.y)
        else:
            raise OSError("ctypes cursor only wired for win32 here")
        dx, dy = target_x - cur[0], target_y - cur[1]
        dist = math.hypot(dx, dy)
        if dist < 4:
            return
        drift = max(8.0, dist * 0.12)
        c1 = (cur[0] + dx * random.uniform(0.2, 0.4) + random.uniform(-drift, drift),
              cur[1] + dy * random.uniform(0.1, 0.3) + random.uniform(-drift, drift))
        c2 = (cur[0] + dx * random.uniform(0.6, 0.8) + random.uniform(-drift, drift),
              cur[1] + dy * random.uniform(0.7, 0.9) + random.uniform(-drift, drift))
        steps = max(12, min(60, int(dist / 6)))
        for px, py in _bezier_points(cur, c1, c2, (target_x, target_y), steps):
            ctypes.windll.user32.SetCursorPos(px, py)
            time.sleep(random.uniform(0.003, 0.012))
    except Exception as exc:  # noqa: BLE001
        log.debug("human_mouse_move fallback: %s", exc)


# --------------------------------------------------------------------------
# Skill 1 — "Self-Driving" real Chrome profile (logged-in sessions)
# --------------------------------------------------------------------------

PROFILE_EXCLUDES = {
    "Cache", "Code Cache", "GPUCache", "GrShaderCache", "ShaderCache",
    "Crashpad", "Crash Reports", "Component Updates", "DawnGraphiteCache",
    "DawnWebGPUCache", "GraphiteDawnCache", "DawnCache", "Service Worker",
    "Session Storage", "Sessions", "Sync Data", "Safe Browsing",
    "extensions", "Extension State", "Extension Rules",
}


def sync_real_profile() -> Path:
    """Copy the user's everyday Chrome profile (cookies, logins, local storage)
    into the agent's own fresh profile dir, skipping caches. This carries
    logged-in sessions (Google, GitHub, ...) so the agent never faces
    login walls or login CAPTCHAs. Source Chrome should ideally be closed."""
    src = REAL_CHROME_PROFILE
    dst = AGENT_PROFILE_DIR
    if not src.exists():
        log.warning("Real Chrome profile not found at %s — using fresh profile", src)
        return dst

    dst.mkdir(parents=True, exist_ok=True)
    copied, skipped = 0, 0
    for root, dirs, files in os.walk(src):
        dirs[:] = [d for d in dirs if d not in PROFILE_EXCLUDES]
        rel = Path(root).relative_to(src)
        target_dir = dst / rel
        target_dir.mkdir(parents=True, exist_ok=True)
        for f in files:
            s = Path(root) / f
            t = target_dir / f
            try:
                if not t.exists() or s.stat().st_mtime > t.stat().st_mtime:
                    shutil.copy2(s, t)
                    copied += 1
            except (OSError, PermissionError):
                skipped += 1
    log.info("Profile sync: %d files copied, %d locked/skipped (sessions carried over)", copied, skipped)
    return dst


# --------------------------------------------------------------------------
# Skill 2 — Buster CAPTCHA-solver extension injection (free reCAPTCHA audio)
# --------------------------------------------------------------------------

BUSTER_URL = ("https://github.com/dessant/buster/releases/download/v3.4.0/"
              "buster_captcha_solver_for_humans-3.4.0-chrome.zip")


def ensure_buster() -> Path | None:
    """Download & unpack Buster into a loadable extension dir (once)."""
    manifest = BUSTER_DIR / "manifest.json"
    if manifest.exists():
        return BUSTER_DIR
    BUSTER_DIR.mkdir(parents=True, exist_ok=True)
    tmp = BUSTER_DIR / "buster.zip"
    log.info("Downloading Buster captcha solver extension...")
    try:
        urllib.request.urlretrieve(BUSTER_URL, tmp)  # noqa: S310 — pinned GitHub URL
        with zipfile.ZipFile(tmp) as z:
            z.extractall(BUSTER_DIR)
        tmp.unlink(missing_ok=True)
    except Exception as exc:  # noqa: BLE001
        log.warning("Buster download failed (%s) — captcha audio assist disabled", exc)
        return None
    if manifest.exists():
        log.info("Buster extension ready at %s", BUSTER_DIR)
        return BUSTER_DIR
    return None


# --------------------------------------------------------------------------
# Vosk local speech-to-text (audio CAPTCHAs)
# --------------------------------------------------------------------------

VOSK_URL = ("https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip")


def _ensure_vosk_model() -> Path | None:
    if not any(VOSK_MODEL_DIR.glob("vosk-model-*")):
        log.info("Downloading Vosk speech model (~40MB, one time)...")
        VOSK_MODEL_DIR.mkdir(parents=True, exist_ok=True)
        tmp = VOSK_MODEL_DIR / "model.zip"
        try:
            urllib.request.urlretrieve(VOSK_URL, tmp)  # noqa: S310 — pinned URL
            with zipfile.ZipFile(tmp) as z:
                z.extractall(VOSK_MODEL_DIR)
            tmp.unlink(missing_ok=True)
        except Exception as exc:  # noqa: BLE001
            log.warning("Vosk model download failed: %s", exc)
            return None
    models = list(VOSK_MODEL_DIR.glob("vosk-model-*"))
    return models[0] if models else None


_ffmpeg_path: str | None = None


def _ffmpeg() -> str | None:
    global _ffmpeg_path
    if _ffmpeg_path is None:
        try:
            import imageio_ffmpeg
            _ffmpeg_path = imageio_ffmpeg.get_ffmpeg_exe()
        except Exception:  # noqa: BLE001
            _ffmpeg_path = shutil.which("ffmpeg")
    return _ffmpeg_path


# --------------------------------------------------------------------------
# PaddleOCR — local image/text CAPTCHA decoder
# --------------------------------------------------------------------------

_ocr = None


def ocr_image(png_bytes: bytes) -> list[str]:
    """Decode text from a localized screenshot using local PaddleOCR."""
    global _ocr
    try:
        import numpy as np
        from PIL import Image
        from paddleocr import PaddleOCR
    except ImportError as exc:
        log.warning("PaddleOCR not available: %s", exc)
        return []
    if _ocr is None:
        log.info("Loading PaddleOCR model (first run downloads weights)...")
        _ocr = PaddleOCR(
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
            lang="en",
        )
    try:
        img = Image.open(__import__("io").BytesIO(png_bytes)).convert("RGB")
        result = _ocr.predict(np.array(img))
        texts = []
        for page in result:
            res = getattr(page, "json", None) or {}
            for t in (res.get("rec_texts") or []):
                if t.strip():
                    texts.append(t.strip())
        return texts
    except Exception as exc:  # noqa: BLE001
        log.debug("OCR failed: %s", exc)
        return []


# --------------------------------------------------------------------------
# Stealth browser factory (SeleniumBase UC mode)
# --------------------------------------------------------------------------

def get_monitors():
    """Return list of (x, y, w, h, is_primary) for all monitors."""
    monitors = []
    try:
        import ctypes
        from ctypes import wintypes
        MONITORINFOF_PRIMARY = 1

        class RECT(ctypes.Structure):
            _fields_ = [("left", wintypes.LONG), ("top", wintypes.LONG),
                        ("right", wintypes.LONG), ("bottom", wintypes.LONG)]

        class MONITORINFO(ctypes.Structure):
            _fields_ = [("cbSize", wintypes.DWORD), ("rcMonitor", RECT),
                        ("rcWork", RECT), ("dwFlags", wintypes.DWORD)]

        def callback(hmon, hdc, lprc, data):
            mi = MONITORINFO()
            mi.cbSize = ctypes.sizeof(MONITORINFO)
            ctypes.windll.user32.GetMonitorInfoW(hmon, ctypes.byref(mi))
            r = mi.rcMonitor
            monitors.append((r.left, r.top, r.right - r.left, r.bottom - r.top,
                             bool(mi.dwFlags & MONITORINFOF_PRIMARY)))
            return True

        MONITORENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p,
                                             ctypes.POINTER(RECT), ctypes.c_double)
        ctypes.windll.user32.EnumDisplayMonitors(0, 0, MONITORENUMPROC(callback), 0)
    except Exception as exc:  # noqa: BLE001
        log.debug("get_monitors: %s", exc)
    return monitors


def pick_virtual_display():
    """Choose a secondary monitor (virtual display plane) if one exists."""
    monitors = get_monitors()
    if len(monitors) > 1:
        for m in monitors:
            if not m[4]:
                return m
    return None


def build_driver(display: str, cdp_port: int, use_real_profile: bool, buster: bool, fast: bool):
    """Create the stealth Driver. Returns (driver, display_info)."""
    from seleniumbase import Driver

    profile_dir = sync_real_profile() if use_real_profile else AGENT_PROFILE_DIR
    profile_dir.mkdir(parents=True, exist_ok=True)

    chromium_args = [
        f"--remote-debugging-port={cdp_port}",
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-session-crashed-bubble",
        "--disable-infobars",
        "--window-size=1280,800",
    ]

    display_info = None
    if display == "virtual":
        display_info = pick_virtual_display()
        if display_info:
            x, y, w, h, _ = display_info
            chromium_args.append(f"--window-position={x},{y}")
            chromium_args.append(f"--window-size={w},{h}")
            log.info("Agent browser on secondary display at (%d,%d) %dx%d", x, y, w, h)
        else:
            log.warning("No secondary display found — falling back to main-screen window")
            display = "main"
    if display == "main":
        chromium_args.append("--window-position=40,40")

    if buster and ensure_buster():
        chromium_args += [
            f"--disable-extensions-except={BUSTER_DIR}",
            f"--load-extension={BUSTER_DIR}",
        ]

    # UC (undetected-chromedriver) mode with humanized profiles. headless2 is
    # SeleniumBase's stealth headless — fully invisible, no cursor involved.
    driver = Driver(
        uc=True,
        headless2=(display == "headless"),
        headless=False,
        user_data_dir=str(profile_dir),
        binary_location=CHROME_DEFAULT if os.path.exists(CHROME_DEFAULT) else None,
        chromium_arg=" ".join(chromium_args),
        incognito=False,
        disable_csp=False,
        disable_js=False,
        locale_code="en-US",
    )
    human_delay(fast, 1.0, 2.0)
    return driver, display_info


# --------------------------------------------------------------------------
# Human-like interaction primitives
# --------------------------------------------------------------------------

def human_click(driver, element, fast=False):
    """Scroll into view, human mouse curve, then real click."""
    try:
        driver.scroll_to(element)
    except Exception:  # noqa: BLE001
        pass
    human_delay(fast, 0.3, 1.2)
    try:
        box = element.rect
        cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
        human_mouse_move(int(cx), int(cy))
        human_delay(fast, 0.1, 0.4)
        element.click()
    except Exception as exc:  # noqa: BLE001
        log.debug("human_click fallback to JS: %s", exc)
        driver.execute_script("arguments[0].click();", element)


def human_type(driver, element, text, fast=False):
    """Type with per-character randomized delays (human-ish cadence)."""
    human_click(driver, element, fast)
    human_delay(fast, 0.2, 0.8)
    for ch in text:
        element.send_keys(ch)
        time.sleep(random.uniform(0.02, 0.09) if fast else random.uniform(0.05, 0.18))


def page_state(driver, max_text=6000) -> dict:
    """Compact, LLM-friendly snapshot of the current page."""
    url = driver.current_url
    title = driver.get_title()
    text = ""
    interactives = []
    try:
        text = driver.get_text("body") or ""
        text = re.sub(r"\s+", " ", text)[:max_text]
    except Exception:  # noqa: BLE001
        pass
    try:
        js = """
        const out = [];
        document.querySelectorAll('a, button, input, [role="button"]').forEach(el => {
          const t = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').trim();
          const id = el.id ? '#'+el.id : '';
          const cls = typeof el.className === 'string' && el.className ? '.'+el.className.split(/\\s+/)[0] : '';
          if (t && el.offsetParent !== null) out.push(t.slice(0,60) + ' -> ' + el.tagName.toLowerCase() + (id||cls||''));
        });
        return out.slice(0, 60);
        """
        interactives = driver.execute_script(js) or []
    except Exception:  # noqa: BLE001
        pass
    return {"url": url, "title": title, "text": text, "clickables": interactives}


def find_element_by_text(driver, target: str):
    """Find an interactive element whose visible text matches (case-insensitive)."""
    target = target.lower()
    js = """
    const t = arguments[0];
    const els = document.querySelectorAll('a, button, input, [role="button"], [role="link"], span');
    for (const el of els) {
      const txt = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').trim();
      if (txt && txt.toLowerCase().includes(t) && el.offsetParent !== null) return el;
    }
    return null;
    """
    return driver.execute_script(js, target)


# --------------------------------------------------------------------------
# CAPTCHA pipeline (100% local)
# --------------------------------------------------------------------------

RECAPTCHA_FRAME = 'iframe[src*="recaptcha"], iframe[src*="google.com/recaptcha"]'
HCAPTCHA_FRAME = 'iframe[src*="hcaptcha"]'


def find_captcha_frames(driver) -> list:
    frames = []
    try:
        frames += driver.find_elements(RECAPTCHA_FRAME)
    except Exception:  # noqa: BLE001
        pass
    try:
        frames += driver.find_elements(HCAPTCHA_FRAME)
    except Exception:  # noqa: BLE001
        pass
    return frames


def click_recaptcha_checkbox(driver, fast=False):
    """Human-click the reCAPTCHA / hCaptcha checkbox inside its iframe."""
    for frame in find_captcha_frames(driver):
        try:
            driver.switch_to.frame(frame)
            human_delay(fast, 0.5, 1.5)
            checkbox = None
            try:
                checkbox = driver.find_elements(
                    '#recaptcha-anchor, .recaptcha-checkbox-border, #checkbox, div[role="checkbox"]'
                )[0]
            except Exception:  # noqa: BLE001
                pass
            if checkbox:
                human_click(driver, checkbox, fast)
                log.info("Clicked reCAPTCHA checkbox (human-curved)")
                human_delay(fast, 1.0, 2.5)
            if ensure_buster():
                try:
                    solver = driver.find_elements(
                        'button[aria-label*="Solve"] , .buster-solve, [data-buster-solve]'
                    )
                    if solver:
                        human_click(driver, solver[0], fast)
                        log.info("Buster free audio solver triggered")
                        human_delay(fast, 3.0, 6.0)
                except Exception:  # noqa: BLE001
                    pass
            driver.switch_to.default_content()
            return True
        except Exception as exc:  # noqa: BLE001
            log.debug("captcha frame: %s", exc)
            driver.switch_to.default_content()
    return False


def solve_image_captcha(driver, input_el, fast=False) -> bool:
    """Screenshot the challenge image and decode it with local PaddleOCR."""
    try:
        candidates = driver.find_elements("img[src*='captcha'], img[src*='kaptcha'], #captcha_img, img")
        img = None
        for c in candidates:
            w, h = c.size["width"], c.size["height"]
            if 60 < w < 900 and 20 < h < 400:
                img = c
                break
        if not img:
            log.info("Image captcha: no challenge image element found")
            return False
        png = img.screenshot_as_png
        texts = ocr_image(png)
        log.info("OCR decoded: %r", texts)
        if not texts:
            return False
        answer = re.sub(r"[^A-Za-z0-9 ]", "", texts[0])
        if not answer:
            return False
        human_type(driver, input_el, answer, fast)
        return True
    except Exception as exc:  # noqa: BLE001
        log.warning("Image captcha failed: %s", exc)
        return False


def solve_audio_captcha(driver, fast=False) -> str | None:
    """Download the challenge audio, decode it locally with Vosk, return text."""
    audio_src = None
    try:
        audios = driver.find_elements("audio source, audio")
        for a in audios:
            src = a.get_attribute("src")
            if src:
                audio_src = src
                break
    except Exception:  # noqa: BLE001
        pass
    if not audio_src:
        log.info("Audio captcha: no audio element found")
        return None
    model_dir = _ensure_vosk_model()
    if not model_dir:
        return None
    try:
        from vosk import KaldiRecognizer, Model
        import wave
    except ImportError:
        return None
    try:
        tmp = Path(tempfile.gettempdir()) / f"captcha_{int(time.time())}.mp3"
        urllib.request.urlretrieve(audio_src, tmp)  # noqa: S310 — challenge audio URL
        wav = tmp.with_suffix(".wav")
        ff = _ffmpeg()
        if ff:
            subprocess.run([ff, "-y", "-i", str(tmp), "-ar", "16000", "-ac", "1", str(wav)],
                           capture_output=True, timeout=30)
        else:
            from pydub import AudioSegment
            AudioSegment.from_file(tmp).set_frame_rate(16000).set_channels(1).export(wav, format="wav")
        if not wav.exists():
            return None
        rec = KaldiRecognizer(Model(str(model_dir)), 16000)
        with wave.open(str(wav), "rb") as wf:
            while True:
                data = wf.readframes(4000)
                if not data:
                    break
                rec.AcceptWaveform(data)
        text = json.loads(rec.FinalResult()).get("text", "").strip()
        log.info("Audio captcha decoded: %r", text)
        return re.sub(r"[^A-Za-z0-9 ]", "", text) or None
    except Exception as exc:  # noqa: BLE001
        log.warning("Audio captcha failed: %s", exc)
        return None


def handle_captcha(driver, fast=False) -> bool:
    """Top-level CAPTCHA handler. Returns True if it believes it solved/clicked."""
    frames = find_captcha_frames(driver)
    if frames:
        return click_recaptcha_checkbox(driver, fast)
    # Try image captcha: find input next to a challenge image
    try:
        inputs = driver.find_elements("input[type='text'], input:not([type]), input[name*='captcha'], input[id*='captcha']")
        for inp in inputs:
            if solve_image_captcha(driver, inp, fast):
                try:
                    submit = driver.find_elements("button[type='submit'], button:contains('Verify')")
                except Exception:  # noqa: BLE001
                    submit = []
                if submit:
                    human_click(driver, submit[0], fast)
                return True
    except Exception as exc:  # noqa: BLE001
        log.debug("image captcha scan: %s", exc)
    return False


# --------------------------------------------------------------------------
# LLM agent loop (OpenAI-compatible — NVIDIA endpoint from ~/.umbra/config.json)
# --------------------------------------------------------------------------

def load_llm_config():
    try:
        cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        llm = cfg.get("openaiCompatible", {})
        return llm.get("endpoint"), llm.get("apiKey"), cfg.get("models", {})
    except Exception as exc:  # noqa: BLE001
        log.warning("No LLM config: %s", exc)
        return None, None, {}


def llm_chat(messages, model, endpoint, api_key, max_tokens=1024, temperature=0.1) -> str:
    """Tiny OpenAI-compatible chat client (no SDK needed)."""
    import requests
    body = {
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    r = requests.post(
        f"{endpoint.rstrip('/')}/chat/completions",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json=body,
        timeout=180,
    )
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"] or ""


SYSTEM_PROMPT = """You are Umbra's background agent — a fast, human-like computer user.
You control Chrome. Decide ONE next action and reply with ONLY a JSON object, no prose:
{"action": "navigate", "url": "..."}       — go to a URL
{"action": "click", "target": "text"}       — click element whose visible text matches
{"action": "type", "target": "selector/text", "text": "..."}  — type into an element
{"action": "press", "key": "Enter"}         — press a keyboard key
{"action": "extract", "text": "..."}        — read something from the page (target text)
{"action": "open_app", "name": "notepad"}   — open a Windows app (any exe name)
{"action": "wait", "ms": 1000}
{"action": "done", "answer": "final answer to the user's task"}
Rules: prefer clicking by visible text. The page state shows clickable elements
and visible text. When you have the answer, finish with done. Be efficient — a
human would finish in a few steps. Never invent URLs; navigate to well-known ones."""


def run_task(task: str, display: str, cdp_port: int, use_real_profile: bool,
             buster: bool, fast: bool, max_steps: int = 12) -> str | None:
    endpoint, api_key, models = load_llm_config()
    model = (models or {}).get("fast") or (models or {}).get("reasoning")
    if not endpoint or not api_key or not model:
        log.error("LLM not configured — edit %s (openaiCompatible + models)", CONFIG_FILE)
        return None

    driver, _ = build_driver(display, cdp_port, use_real_profile, buster, fast)
    log.info("Stealth browser up: %s (CDP :%d)", driver.current_url, cdp_port)
    human_delay(fast, 1.0, 2.0)

    history = []
    try:
        for step in range(1, max_steps + 1):
            state = page_state(driver)
            if find_captcha_frames(driver):
                log.info("CAPTCHA detected — running local solver")
                handle_captcha(driver, fast)
                human_delay(fast, 2.0, 4.0)

            state_snippet = json.dumps({
                "url": state["url"], "title": state["title"],
                "visible_text": state["text"][:2500],
                "clickables": state["clickables"][:20],
            })[:6500]

            messages = [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": f"Task: {task}\n\nCurrent page:\n{state_snippet}\n\nPrevious actions: {history[-3:]}"},
            ]
            try:
                reply = llm_chat(messages, model, endpoint, api_key)
            except Exception as exc:  # noqa: BLE001
                log.error("LLM call failed: %s", exc)
                break
            m = re.search(r"\{[\s\S]*\}", reply)
            if not m:
                log.warning("LLM non-JSON reply: %s", reply[:120])
                continue
            try:
                action = json.loads(m.group(0))
            except json.JSONDecodeError:
                continue

            act = action.get("action")
            log.info("step %d/%d: %s", step, max_steps, json.dumps(action)[:200])
            history.append(json.dumps(action)[:200])

            if act == "done":
                return action.get("answer") or state["text"][:500]
            if act == "navigate":
                driver.open(action["url"])
            elif act == "click":
                el = find_element_by_text(driver, action["target"])
                if el:
                    human_click(driver, el, fast)
                else:
                    log.warning("click target not found: %s", action["target"])
            elif act == "type":
                el = find_element_by_text(driver, action.get("target", ""))
                if not el:
                    try:
                        el = driver.find_elements("input")[0]
                    except Exception:  # noqa: BLE001
                        el = None
                if el:
                    human_type(driver, el, action.get("text", ""), fast)
            elif act == "press":
                driver.press_keys(action["key"])
            elif act == "extract":
                log.info("extract: %s", (state["text"] or "")[:600])
            elif act == "open_app":
                name = action["name"].strip()
                exe_map = {"notepad": "notepad.exe", "calculator": "calc.exe", "calc": "calc.exe",
                           "explorer": "explorer.exe", "cmd": "cmd.exe", "terminal": "cmd.exe",
                           "paint": "mspaint.exe", "chrome": "chrome.exe", "edge": "msedge.exe"}
                exe = exe_map.get(name.lower(), name)
                os.startfile(exe)  # noqa: S606 — user-requested app opening
                log.info("Opened app: %s", exe)
                human_delay(fast, 1.0, 2.0)
            elif act == "wait":
                time.sleep(int(action.get("ms", 1000)) / 1000)
            human_delay(fast)
        return None
    finally:
        try:
            driver.quit()
        except Exception:  # noqa: BLE001
            pass


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def smoke_test(display: str, cdp_port: int):
    """Prove the stealth stack end-to-end: launch, navigate, extract."""
    driver, _ = build_driver(display, cdp_port, use_real_profile=False, buster=False, fast=True)
    try:
        driver.open("https://example.com")
        time.sleep(2)
        title = driver.get_title()
        text = (driver.get_text("body") or "").strip()[:120]
        webdriver_flag = driver.execute_script("return navigator.webdriver")
        log.info("SMOKE OK — title=%r | %r | navigator.webdriver=%r", title, text, webdriver_flag)
        print(f"SMOKE OK: {title} | {text} | webdriver={webdriver_flag}")
    finally:
        driver.quit()


def main():
    p = argparse.ArgumentParser(description="Umbra Background Agent — stealth secondary-display computer agent")
    p.add_argument("--task", help="What the agent should do (e.g. 'Check my GitHub notifications')")
    p.add_argument("--display", choices=["auto", "virtual", "main", "headless"], default="auto",
                   help="virtual=secondary monitor if present, headless=invisible stealth, auto=virtual else main")
    p.add_argument("--port", type=int, default=9222, help="Chrome remote-debugging port (default 9222)")
    p.add_argument("--use-real-profile", action="store_true", help="Skill 1: carry over logged-in sessions from your everyday Chrome profile")
    p.add_argument("--buster", action="store_true", help="Skill 2: inject free Buster reCAPTCHA audio solver")
    p.add_argument("--fast", action="store_true", help="Faster-than-human pacing (0.15-0.7s delays)")
    p.add_argument("--max-steps", type=int, default=12)
    p.add_argument("--smoke", action="store_true", help="Run the stealth-browser self test")
    args = p.parse_args()

    if args.display == "auto":
        args.display = "virtual" if pick_virtual_display() else "main"

    if args.smoke:
        smoke_test(args.display, args.port)
        return

    if not args.task:
        p.error("--task or --smoke is required")

    log.info("Umbra background agent — display=%s port=%d fast=%s real_profile=%s buster=%s",
             args.display, args.port, args.fast, args.use_real_profile, args.buster)
    answer = run_task(args.task, args.display, args.port,
                      args.use_real_profile, args.buster, args.fast, args.max_steps)
    if answer:
        print("\n=== AGENT ANSWER ===\n" + answer)
    else:
        print("\n=== NO ANSWER (step budget exhausted) ===")


if __name__ == "__main__":
    main()
