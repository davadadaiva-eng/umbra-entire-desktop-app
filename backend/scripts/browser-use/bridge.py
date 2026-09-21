"""Umbra x Browser-Use bridge.

Reads JSON-line requests on stdin, runs a browser-use Agent in the user's
Chrome (CDP-connected instance on port 9223), and writes JSON-line results
back on stdout. Runs one request at a time.

Request:  {"id": "...", "task": "...", "stop_file": "path", "max_steps": 25, "model": "fast"}
Progress: {"id": "...", "event": "step", "n": 1, "info": "..."}
Result:   {"id": "...", "event": "done", "ok": true, "result": "...", "url": "...", "steps": 3, "seconds": 12.5}
          {"id": "...", "event": "done", "ok": false, "aborted": true}
          {"id": "...", "event": "done", "ok": false, "error": "..."}
"""

import asyncio
import json
import os
import subprocess
import sys
import time

os.environ["ANONYMIZED_TELEMETRY"] = "false"
os.environ["BROWSER_USE_LOGGING_LEVEL"] = "error"

from browser_use import Agent, Browser, Tools, ActionResult  # noqa: E402
from browser_use.llm.openai.chat import ChatOpenAI  # noqa: E402

CDP_URL = os.environ.get("UMBRA_CDP_URL", "http://127.0.0.1:9223")


def load_llm(model_key: str):
    with open(os.path.expanduser("~/.umbra/config.json"), "r", encoding="utf-8") as f:
        cfg = json.load(f)
    llm_cfg = cfg["openaiCompatible"]
    model = cfg["models"].get(model_key, cfg["models"]["fast"])
    return ChatOpenAI(
        model=model,
        base_url=llm_cfg["endpoint"],
        api_key=llm_cfg["apiKey"],
        temperature=0.1,
        max_completion_tokens=8192,
    )


def open_windows_app(name: str) -> str:
    exe = name.strip()
    mapping = {
        "notepad": "notepad.exe",
        "calculator": "calc.exe",
        "calc": "calc.exe",
        "explorer": "explorer.exe",
        "cmd": "cmd.exe",
        "command prompt": "cmd.exe",
        "paint": "mspaint.exe",
        "wordpad": "wordpad.exe",
        "terminal": "cmd.exe",
        "chrome": r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        "edge": "msedge.exe",
        "snipping tool": "snippingtool.exe",
    }
    resolved = mapping.get(exe.lower(), exe)
    try:
        if os.path.exists(resolved):
            subprocess.Popen([resolved], shell=False)
        else:
            os.startfile(resolved)
        return f"Opened {name}"
    except Exception as e:  # noqa: BLE001
        return f"Failed to open {name}: {e}"


tools = Tools()
tools.action("Open a Windows desktop application by name (e.g. notepad, calculator, explorer, cmd, paint, chrome). Use this to open apps on the agent desktop.")(open_windows_app)

_browser: Browser | None = None


async def get_browser() -> Browser:
    global _browser
    if _browser is None:
        _browser = Browser(cdp_url=CDP_URL, headless=False, keep_alive=True)
    return _browser


async def run_request(req: dict) -> None:
    rid = req["id"]
    task = req["task"]
    stop_file = req.get("stop_file")
    max_steps = int(req.get("max_steps", 25))
    model = req.get("model", "fast")

    def emit(obj: dict) -> None:
        obj["id"] = rid
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()

    stop_flag = {"armed": False}

    def on_step(state, output, step_number):
        info = ""
        if output is not None:
            try:
                actions = getattr(output, "action", None)
                if isinstance(actions, list):
                    names = []
                    for a in actions:
                        dump = getattr(a, "model_dump", None)
                        if dump is not None:
                            d = dump()
                            if isinstance(d, dict):
                                for k, v in d.items():
                                    if v is not None:
                                        names.append(str(k))
                    info = ", ".join(names)
                elif actions is not None:
                    info = str(actions)
            except Exception:  # noqa: BLE001
                info = ""
        emit({"event": "step", "n": step_number, "info": info})

    try:
        browser = await get_browser()
        llm = load_llm(model)

        agent = Agent(
            task=task,
            llm=llm,
            browser=browser,
            tools=tools,
            use_vision=False,
            flash_mode=True,
            use_judge=False,
            max_actions_per_step=3,
            generate_gif=False,
            register_new_step_callback=on_step,
            include_recent_events=True,
        )

        agent_task = asyncio.create_task(agent.run(max_steps=max_steps))

        async def watchdog():
            while not agent_task.done():
                await asyncio.sleep(0.3)
                if stop_file and os.path.exists(stop_file):
                    stop_flag["armed"] = True
                    agent_task.cancel()
                    return

        watcher = asyncio.create_task(watchdog())

        t0 = time.time()
        try:
            history = await agent_task
        finally:
            watcher.cancel()

        if stop_flag["armed"]:
            try:
                await browser.close()
            except Exception:  # noqa: BLE001
                pass
            emit({"event": "done", "ok": False, "aborted": True})
            return

        result = history.final_result() or ""
        url = ""
        urls = history.urls()
        if urls:
            url = urls[-1]
        emit({
            "event": "done",
            "ok": True,
            "result": result,
            "url": url,
            "steps": history.number_of_steps(),
            "seconds": round(time.time() - t0, 1),
        })
    except asyncio.CancelledError:
        emit({"event": "done", "ok": False, "aborted": True})
    except Exception as e:  # noqa: BLE001
        emit({"event": "done", "ok": False, "error": str(e)[:500]})


async def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        await run_request(req)


if __name__ == "__main__":
    asyncio.run(main())
