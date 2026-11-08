#!/usr/bin/env python3
"""Drive a Mac's Screen Sharing (VNC, Apple auth) from the command line.

  vnc.py NAME shot [OUT.png]            screenshot (default /tmp/mac-NAME.png)
  vnc.py NAME click X Y [right|double]  move + click, coords = screenshot pixels
  vnc.py NAME move X Y
  vnc.py NAME drag X1 Y1 X2 Y2
  vnc.py NAME type TEXT...              type text literally
  vnc.py NAME key Cmd+space [Return..]  key chords, one arg per chord
  vnc.py NAME scroll up|down [N]
  vnc.py NAME unlock                    wake the screen, type the stored password, Return

Credentials come from the staged registry (~/.config/babysit-mac), never argv.
"""

import asyncio
import json
import os
import sys

import asyncvnc

ROOT = os.environ.get('BABYSIT_MAC_ROOT') or os.path.expanduser('~/.config/babysit-mac')
SETTLE = 0.35  # let the Mac repaint before a follow-up shot
KEY_DELAY = float(os.environ.get('BABYSIT_MAC_KEY_DELAY') or 0.12)  # the server drops key events that arrive too fast


# US-layout shifted symbols -> the base key. macOS ignores a bare shifted keysym
# (capital letter, "!") from VNC, so those are sent as Shift + base key.
SHIFTED = {
    '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0',
    '_': '-', '+': '=', '{': '[', '}': ']', '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/', '~': '`',
}


def keysym(name):
    """X11 keysym for a key. Single characters map straight from Unicode:
    asyncvnc's own char table resolves many letters to obscure duplicate
    keysyms that macOS silently drops."""
    if len(name) == 1:
        return ord(name) if ord(name) < 0x100 else 0x01000000 + ord(name)
    return asyncvnc.key_codes[name]


async def tap(vnc, *names):
    """Press keys together, release in reverse, flushing each event: the server drops bursts."""
    codes = [keysym(name) for name in names]
    for code in codes:
        vnc.keyboard.writer.write(b'\x04\x01\x00\x00' + code.to_bytes(4, 'big'))
        await vnc.drain()
        await asyncio.sleep(KEY_DELAY)
    for code in reversed(codes):
        vnc.keyboard.writer.write(b'\x04\x00\x00\x00' + code.to_bytes(4, 'big'))
        await vnc.drain()
        await asyncio.sleep(KEY_DELAY)


async def write_text(vnc, text):
    for char in text:
        base = char.lower() if char.isupper() else SHIFTED.get(char)
        await (tap(vnc, 'Shift', base) if base else tap(vnc, char))


def load(name):
    registry = json.load(open(f'{ROOT}/macs.json')).get('macs', [])
    mac = next((m for m in registry if name in (m['name'], m['host'])), None)
    if not mac:
        sys.exit(f'unknown mac {name!r}; try: babysit mac list')
    password = open(f"{ROOT}/{mac['name']}/password").read().rstrip('\n')
    return mac, password


async def run(name, action, args):
    mac, password = load(name)
    async with asyncvnc.connect(mac['host'], port=mac.get('vnc_port', 5900), username=mac['user'], password=password) as vnc:

        if action == 'shot':
            from PIL import Image
            out = args[0] if args else f'/tmp/mac-{mac["name"]}.png'
            pixels = await vnc.screenshot()
            Image.fromarray(pixels).save(out)
            h, w = pixels.shape[:2]
            print(f'{out} {w}x{h}')
            return

        if action in ('click', 'move', 'drag'):
            x, y = int(args[0]), int(args[1])
            vnc.mouse.move(x, y)
            if action == 'click':
                kind = args[2] if len(args) > 2 else 'left'
                if kind == 'right': vnc.mouse.right_click()
                else:
                    vnc.mouse.click()
                    if kind == 'double': vnc.mouse.click()
            elif action == 'drag':
                with vnc.mouse.hold():
                    await asyncio.sleep(0.1)
                    vnc.mouse.move(int(args[2]), int(args[3]))
                    await asyncio.sleep(0.1)
        elif action == 'type':
            await write_text(vnc, ' '.join(args))
        elif action == 'key':
            for chord in args:
                await tap(vnc, *chord.split('+'))
        elif action == 'unlock':
            await tap(vnc, 'Shift')  # wake the login window and focus its field
            await asyncio.sleep(1.5)
            await write_text(vnc, password)
            await tap(vnc, 'Return')
            await asyncio.sleep(2)
        elif action == 'scroll':
            (vnc.mouse.scroll_up if args[0] == 'up' else vnc.mouse.scroll_down)(int(args[1]) if len(args) > 1 else 3)
        else:
            sys.exit(__doc__)

        await asyncio.sleep(SETTLE)
        await vnc.drain()


if __name__ == '__main__':
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    asyncio.run(run(sys.argv[1], sys.argv[2], sys.argv[3:]))
