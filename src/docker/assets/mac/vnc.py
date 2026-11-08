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
            vnc.keyboard.write(' '.join(args))
        elif action == 'key':
            for chord in args:
                vnc.keyboard.press(*chord.split('+'))
                await asyncio.sleep(0.1)
        elif action == 'unlock':
            vnc.keyboard.press('Shift')  # wake the login window and focus its field
            await asyncio.sleep(1.5)
            vnc.keyboard.write(password)
            vnc.keyboard.press('Return')
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
