"""
Umbra Social Automation CLI — unified entry point for X.com, YouTube, and Instagram.
Called by Umbra's SocialAutomation.ts via subprocess with JSON-line protocol.
Each call receives a JSON action on stdin and emits a JSON result on stdout.
"""

import sys
import json
import os
import time
from typing import Any, Dict, Optional

# -- Add the script dir to path so platform modules can import each other --
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)

from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

# ---------------------------------------------------------------------------
# Shared utilities
# ---------------------------------------------------------------------------

DATA_DIR = os.environ.get("UMBRA_SOCIAL_DIR", os.path.join(SCRIPT_DIR, "sessions"))
os.makedirs(DATA_DIR, exist_ok=True)

def storage_path(platform: str) -> str:
    return os.path.join(DATA_DIR, f"{platform}_state.json")

def load_session(page, platform: str) -> bool:
    """Try to restore a saved Playwright session. Returns True if valid."""
    sp = storage_path(platform)
    if not os.path.exists(sp):
        return False
    try:
        page.context.storage_state(path=sp)
        if platform == "x":
            page.goto("https://x.com/home", timeout=30000)
            page.wait_for_selector('nav[role="navigation"]', timeout=10000)
        elif platform == "youtube":
            page.goto("https://www.youtube.com", timeout=30000)
            page.wait_for_selector('ytd-app', timeout=10000)
        elif platform == "instagram":
            page.goto("https://www.instagram.com", timeout=30000)
            page.wait_for_selector('section', timeout=10000)
        return True
    except Exception:
        return False

def save_session(context, platform: str) -> None:
    context.storage_state(path=storage_path(platform))

# ---------------------------------------------------------------------------
# X.com (Twitter)
# ---------------------------------------------------------------------------

def x_login(page, email: str, password: str) -> bool:
    try:
        print("[social] Logging into X.com...", file=sys.stderr)
        page.goto("https://x.com/login", timeout=30000)
        page.wait_for_selector('input[name="text"]', timeout=10000)
        page.fill('input[name="text"]', email)
        page.keyboard.press("Enter")
        page.wait_for_selector('input[name="password"]', timeout=10000)
        page.fill('input[name="password"]', password)
        page.keyboard.press("Enter")
        page.wait_for_url("https://x.com/home", timeout=15000)
        save_session(page.context, "x")
        print("[social] X.com login OK", file=sys.stderr)
        return True
    except Exception as e:
        print(f"[social] X.com login failed: {e}", file=sys.stderr)
        return False

def x_post(page, text: str, media_files: Optional[list] = None) -> dict:
    try:
        page.goto("https://x.com/compose/tweet", timeout=30000)
        page.wait_for_selector('div[role="textbox"]', timeout=10000)
        page.fill('div[role="textbox"]', text)
        if media_files:
            input_file = page.locator('input[data-testid="fileInput"]').first
            input_file.set_input_files(media_files)
            page.wait_for_timeout(3000)
        tweet_button = page.locator('button[data-testid="tweetButton"]')
        tweet_button.click()
        page.wait_for_timeout(5000)
        return {"ok": True, "platform": "x", "action": "post", "text_preview": text[:140]}
    except Exception as e:
        return {"ok": False, "error": str(e)}

def x_comment(page, query: str, comment_text: str, max_comments: int = 3) -> dict:
    try:
        page.goto(f"https://twitter.com/search?q={query}&src=typed_query&f=top", timeout=60000)
        page.wait_for_timeout(5000)
        tweets = page.query_selector_all('article[role="article"]')
        if not tweets:
            return {"ok": False, "error": "No tweets found"}
        commented = 0
        for tweet in tweets[:max_comments * 3]:
            if commented >= max_comments:
                break
            try:
                reply_btn = tweet.query_selector('button[data-testid="reply"]')
                if not reply_btn:
                    continue
                reply_btn.click()
                page.wait_for_selector('div[role="dialog"] div[role="textbox"]', timeout=10000)
                textbox = page.query_selector('div[role="dialog"] div[role="textbox"]')
                if textbox:
                    textbox.fill(comment_text)
                    page.wait_for_timeout(1000)
                    send_btn = page.query_selector('div[role="dialog"] button[data-testid="tweetButton"]')
                    if send_btn:
                        send_btn.click()
                        commented += 1
                        page.wait_for_timeout(3000)
            except Exception as e:
                print(f"[social] comment error: {e}", file=sys.stderr)
        return {"ok": True, "platform": "x", "action": "comment", "commented": commented}
    except Exception as e:
        return {"ok": False, "error": str(e)}

def x_search(page, query: str, max_results: int = 10) -> dict:
    try:
        page.goto("https://x.com/explore", timeout=30000)
        page.wait_for_timeout(3000)
        page.fill('input[aria-label="Search query"]', query)
        page.keyboard.press("Enter")
        page.wait_for_timeout(4000)
        tweets_data = []
        collected = 0
        while collected < max_results:
            articles = page.query_selector_all('article')
            for art in articles:
                if collected >= max_results:
                    break
                try:
                    text_el = art.query_selector('div[lang]')
                    text = text_el.inner_text() if text_el else ""
                    tweets_data.append({"text": text[:300]})
                    collected += 1
                except Exception:
                    continue
            if collected < max_results:
                page.mouse.wheel(0, 3000)
                page.wait_for_timeout(2000)
        return {"ok": True, "platform": "x", "action": "search", "results": tweets_data}
    except Exception as e:
        return {"ok": False, "error": str(e)}

# ---------------------------------------------------------------------------
# YouTube
# ---------------------------------------------------------------------------

def yt_login(page, email: str, password: str) -> bool:
    try:
        print("[social] Logging into YouTube...", file=sys.stderr)
        page.goto("https://www.youtube.com", timeout=30000)
        page.click("text=Sign in", timeout=10000)
        page.wait_for_url("https://accounts.google.com/**")
        page.fill('input[type="email"]', email)
        page.click('button:has-text("Next")')
        page.wait_for_timeout(2000)
        page.fill('input[type="password"]', password)
        page.click('button:has-text("Next")')
        page.wait_for_url("https://www.youtube.com/*", timeout=15000)
        save_session(page.context, "youtube")
        print("[social] YouTube login OK", file=sys.stderr)
        return True
    except Exception as e:
        print(f"[social] YouTube login failed: {e}", file=sys.stderr)
        return False

def yt_upload(page, context, video_path: str, title: str, description: str) -> dict:
    try:
        print("[social] Starting YouTube upload...", file=sys.stderr)
        page.wait_for_selector('button[aria-label="Create"]', timeout=10000)
        page.click('button[aria-label="Create"]')
        page.click('tp-yt-paper-item:has-text("Upload video")', timeout=5000)
        upload_page = context.pages[-1]
        upload_page.wait_for_load_state("domcontentloaded")
        upload_page.set_input_files('input[type="file"]', video_path)
        upload_page.wait_for_selector('#textbox', timeout=200000)
        title_input = upload_page.locator('#textbox').nth(0)
        description_input = upload_page.locator('#textbox').nth(1)
        title_input.fill(title)
        description_input.fill(description)
        # Click through Next buttons
        for _ in range(3):
            upload_page.locator("ytcp-button:has-text('Next')").click()
            upload_page.wait_for_timeout(5000)
        # Set public + publish
        upload_page.locator("tp-yt-paper-radio-button[name='PUBLIC']").click()
        upload_page.locator("ytcp-button:has-text('Publish')").click()
        page.wait_for_timeout(10000)
        return {"ok": True, "platform": "youtube", "action": "upload", "title": title}
    except Exception as e:
        return {"ok": False, "error": str(e)}

def yt_comment(page, query: str, comment_text: str, max_comments: int = 3) -> dict:
    try:
        page.goto("https://www.youtube.com", timeout=30000)
        search_box = page.locator('input.yt-searchbox-input')
        search_box.fill(query)
        search_box.press("Enter")
        page.wait_for_selector("ytd-video-renderer", timeout=10000)
        first_video = page.locator("ytd-video-renderer").first
        first_video.click()
        page.wait_for_timeout(3000)
        # Scroll to comments
        page.mouse.wheel(0, 2000)
        page.wait_for_timeout(2000)
        commented = 0
        comment_box = page.locator('#placeholder-area')
        if comment_box.count() > 0:
            comment_box.first.click()
            page.wait_for_timeout(1000)
            editor = page.locator('#contenteditable-root')
            if editor.count() > 0:
                editor.first.fill(comment_text)
                page.wait_for_timeout(500)
                submit = page.locator('#submit-button')
                if submit.count() > 0:
                    submit.first.click()
                    commented = 1
        return {"ok": True, "platform": "youtube", "action": "comment", "commented": commented}
    except Exception as e:
        return {"ok": False, "error": str(e)}

# ---------------------------------------------------------------------------
# Instagram
# ---------------------------------------------------------------------------

def ig_post(page, image_path: str, caption: str) -> dict:
    try:
        print("[social] Instagram post (placeholder)...", file=sys.stderr)
        page.goto("https://www.instagram.com", timeout=30000)
        # Instagram automation requires complex selectors that change frequently
        # This is a foundation - full IG posting needs a dedicated implementation
        return {"ok": False, "error": "Instagram posting requires manual login + 2FA. Use X.com or YouTube for now."}
    except Exception as e:
        return {"ok": False, "error": str(e)}

# ---------------------------------------------------------------------------
# Main CLI
# ---------------------------------------------------------------------------

def main():
    """Read a JSON action from stdin, execute, emit JSON result on stdout."""
    raw = sys.stdin.read()
    if not raw.strip():
        print(json.dumps({"ok": False, "error": "No input"}))
        sys.exit(1)

    try:
        req = json.loads(raw)
    except json.JSONDecodeError as e:
        print(json.dumps({"ok": False, "error": f"Invalid JSON: {e}"}))
        sys.exit(1)

    platform = req.get("platform", "")
    action = req.get("action", "")
    email = req.get("email", "")
    password = req.get("password", "")
    headless = req.get("headless", True)

    if not platform or not action:
        print(json.dumps({"ok": False, "error": "platform and action are required"}))
        sys.exit(1)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless, slow_mo=100)

        # Try to restore session first
        sp = storage_path(platform)
        has_session = os.path.exists(sp)
        if has_session:
            context = browser.new_context(storage_state=sp)
        else:
            context = browser.new_context()

        page = context.new_page()
        result: dict = {"ok": False, "error": "Unknown action"}

        try:
            # Verify session validity
            session_valid = load_session(page, platform) if has_session else False
            if not session_valid and email and password:
                if platform == "x":
                    ok = x_login(page, email, password)
                elif platform == "youtube":
                    ok = yt_login(page, email, password)
                else:
                    ok = False
                if not ok:
                    result = {"ok": False, "error": f"Login to {platform} failed"}
                    print(json.dumps(result))
                    browser.close()
                    sys.exit(1)

            # Dispatch action
            if platform == "x":
                if action == "post":
                    result = x_post(page,
                        text=req.get("text", ""),
                        media_files=req.get("media_files"))
                elif action == "comment":
                    result = x_comment(page,
                        query=req.get("query", ""),
                        comment_text=req.get("comment_text", ""),
                        max_comments=req.get("max_comments", 3))
                elif action == "search":
                    result = x_search(page,
                        query=req.get("query", ""),
                        max_results=req.get("max_results", 10))
                elif action == "login":
                    result = {"ok": True, "platform": "x", "action": "login"}
            elif platform == "youtube":
                if action == "upload":
                    result = yt_upload(page, context,
                        video_path=req.get("video_path", ""),
                        title=req.get("title", ""),
                        description=req.get("description", ""))
                elif action == "comment":
                    result = yt_comment(page,
                        query=req.get("query", ""),
                        comment_text=req.get("comment_text", ""),
                        max_comments=req.get("max_comments", 3))
                elif action == "login":
                    result = {"ok": True, "platform": "youtube", "action": "login"}
            elif platform == "instagram":
                if action == "post":
                    result = ig_post(page,
                        image_path=req.get("image_path", ""),
                        caption=req.get("caption", ""))
                else:
                    result = {"ok": False, "error": f"Instagram action '{action}' not implemented yet"}
            else:
                result = {"ok": False, "error": f"Unknown platform: {platform}"}

            # Save session after any action
            save_session(page.context, platform)

        except Exception as e:
            result = {"ok": False, "error": str(e)}
        finally:
            browser.close()

    print(json.dumps(result))

if __name__ == "__main__":
    main()