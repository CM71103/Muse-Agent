"""muse_hands.actions - pyautogui/mss primitives behind the sidecar.

Each fn takes the request payload dict, returns a JSON-serializable dict.
Screenshot returns base64 PNG (no file writes).
"""

from __future__ import annotations

import base64
import io

import pyautogui


def _need(payload, *keys):
    missing = [k for k in keys if payload.get(k) is None]
    if missing:
        raise ValueError(f"missing required field(s): {', '.join(missing)}")


def screenshot(payload: dict) -> dict:
    import mss

    with mss.mss() as sct:
        mon = sct.monitors[payload.get("monitor", 1) or 1]
        shot = sct.grab(mon)
        png = mss.tools.to_png(shot.rgb, shot.size)

    if payload.get("max_side"):
        # downscale via PIL if available, else return full
        try:
            from PIL import Image

            img = Image.open(io.BytesIO(png))
            img.thumbnail((payload["max_side"], payload["max_side"]))
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            png = buf.getvalue()
        except ImportError:
            pass

    return {
        "ok": True,
        "action": "screenshot",
        "width": shot.size.width if hasattr(shot.size, "width") else shot.size[0],
        "height": shot.size.height if hasattr(shot.size, "height") else shot.size[1],
        "image_b64": base64.b64encode(png).decode("ascii"),
    }


def click(payload: dict, clicks: int = 1) -> dict:
    _need(payload, "x", "y")
    button = payload.get("button", "left")
    pyautogui.click(x=int(payload["x"]), y=int(payload["y"]), clicks=clicks, button=button)
    return {"ok": True, "action": "click", "x": int(payload["x"]), "y": int(payload["y"]), "clicks": clicks}


def move(payload: dict) -> dict:
    _need(payload, "x", "y")
    pyautogui.moveTo(int(payload["x"]), int(payload["y"]), duration=payload.get("duration", 0.2))
    return {"ok": True, "action": "move", "x": int(payload["x"]), "y": int(payload["y"])}


def drag(payload: dict) -> dict:
    _need(payload, "x", "y", "to_x", "to_y")
    pyautogui.moveTo(int(payload["x"]), int(payload["y"]))
    pyautogui.drag(
        int(payload["to_x"]) - int(payload["x"]),
        int(payload["to_y"]) - int(payload["y"]),
        duration=payload.get("duration", 0.5),
        button=payload.get("button", "left"),
    )
    return {"ok": True, "action": "drag", "from": [int(payload["x"]), int(payload["y"])],
            "to": [int(payload["to_x"]), int(payload["to_y"])]}


def scroll(payload: dict) -> dict:
    amount = int(payload.get("amount", -3))
    x = payload.get("x")
    y = payload.get("y")
    if x is not None and y is not None:
        pyautogui.scroll(amount, int(x), int(y))
    else:
        pyautogui.scroll(amount)
    return {"ok": True, "action": "scroll", "amount": amount}


def type_text(payload: dict) -> dict:
    _need(payload, "text")
    pyautogui.typewrite(payload["text"], interval=payload.get("interval", 0.02))
    return {"ok": True, "action": "type", "chars": len(payload["text"])}


def hotkey(payload: dict) -> dict:
    _need(payload, "keys")
    combo = payload["keys"]
    keys = [k.strip() for k in combo.split("+") if k.strip()]
    if not keys:
        raise ValueError("empty key combo")
    pyautogui.hotkey(*keys)
    return {"ok": True, "action": "hotkey", "keys": keys}
