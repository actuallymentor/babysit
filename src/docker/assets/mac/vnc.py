#!/usr/bin/env python3
"""Drive a Mac's Screen Sharing (VNC, Apple auth) from the command line.

  vnc.py NAME shot [OUT.png] [--full]   screenshot, long edge <= 1568 px unless --full
  vnc.py NAME click X Y [right|double]  coordinates are pixels of the LAST shot
  vnc.py NAME move X Y
  vnc.py NAME drag X1 Y1 X2 Y2
  vnc.py NAME type TEXT...              type text literally
  vnc.py NAME key Cmd+space [Return..]  key chords, one arg per chord (Shift chords are ignored by macOS; type capitals)
  vnc.py NAME scroll up|down [N]
  vnc.py NAME unlock                    wake the lock screen, type the stored password, click its submit arrow
  vnc.py NAME password                  type the stored password into the focused field (OS auth dialogs); no Return
  vnc.py NAME run [SCRIPT]              several actions on ONE connection: "click 10 20; type hi; key Return; shot"
                                        (statements split on ; or newlines; script from args, else stdin)

Credentials come from the staged registry (~/.config/babysit-mac), never argv.
Every new connection costs a login and a ~2 s keyboard warm-up, so chain actions with `run`.
"""

import asyncio
import json
import os
import shlex
import sys
import time

ROOT = os.environ.get('BABYSIT_MAC_ROOT') or os.path.expanduser('~/.config/babysit-mac')
STATE = os.environ.get('BABYSIT_MAC_STATE') or '/tmp'
SETTLE = 0.35  # let the Mac repaint before a follow-up shot

# macOS Screen Sharing ignores the first keyboard events of a new connection
# (measured: all lost below ~1 s, still the first one lost at 1.5 s, none at 2 s)
WARMUP = float(os.environ.get('BABYSIT_MAC_WARMUP') or 2.5)
KEY_DELAY = float(os.environ.get('BABYSIT_MAC_KEY_DELAY') or 0.05)

# Screenshots are shrunk so the long edge fits what a vision model reads well
MAX_EDGE = int(os.environ.get('BABYSIT_MAC_SHOT_EDGE') or 1568)

KEYBOARD = ('type', 'key', 'unlock', 'password')


# ---------------------------------------------------------------------------
# Pure logic (no VNC, no PIL): unit-tested

def split_statements(text):
    """Split a script on `;` and newlines that sit outside quotes."""
    statements, current, quote = [], '', None
    for char in text:
        if quote:
            current += char
            if char == quote:
                quote = None
        elif char in '"\'':
            current += char
            quote = char
        elif char in ';\n':
            statements.append(current)
            current = ''
        else:
            current += char
    statements.append(current)
    return [s.strip() for s in statements if s.strip() and not s.strip().startswith('#')]


def parse_script(text):
    """`click 10 20; type "a; b"` -> [['click', '10', '20'], ['type', 'a; b']]"""
    return [shlex.split(statement) for statement in split_statements(text)]


def shot_scale(width, height, max_edge=MAX_EDGE):
    """Factor the framebuffer is shrunk by for a shot (1.0 = untouched)."""
    return max(1.0, max(width, height) / max_edge)


def to_framebuffer(x, y, scale):
    """Shot pixels -> framebuffer pixels."""
    return round(float(x) * scale), round(float(y) * scale)


def keysym(name, key_codes=None):
    """X11 keysym for a key. Single characters map straight from Unicode:
    asyncvnc's own char table resolves many letters to obscure duplicate
    keysyms that macOS silently drops."""
    if len(name) == 1:
        return ord(name) if ord(name) < 0x100 else 0x01000000 + ord(name)
    if key_codes is None:
        import asyncvnc
        key_codes = asyncvnc.key_codes
    return key_codes[name]


def lock_arrow(width, height):
    """Framebuffer pixel of the lock screen's submit arrow (the ring right of the password field).
    The field sits at the horizontal centre, ~91% down; the arrow ~3.7% of the width to its right
    (measured at 3360x2100 and 1920x1080)."""
    return round(width * 0.5 + width * 0.0372), round(height * 0.908)


def parse_chord(chord):
    """`Cmd+space` -> ['Cmd', 'space']; a lone `+` or `Cmd++` keeps the plus key."""
    if chord == '+':
        return ['+']
    if chord.endswith('++'):
        return [*chord[:-2].split('+'), '+']
    return chord.split('+')


# ---------------------------------------------------------------------------
# Registry and per-Mac screenshot scale

def load(name):
    registry = json.load(open(f'{ROOT}/macs.json')).get('macs', [])
    mac = next((m for m in registry if name in (m['name'], m['host'])), None)
    if not mac:
        sys.exit(f'unknown mac {name!r}; try: babysit mac list')
    password = open(f"{ROOT}/{mac['name']}/password").read().rstrip('\n')
    return mac, password


def scale_path(mac):
    return f"{STATE}/babysit-mac-{mac['name']}.scale"


def read_scale(mac):
    try:
        return float(json.load(open(scale_path(mac)))['scale'])
    except (OSError, ValueError, KeyError):
        return 1.0


def write_scale(mac, scale):
    with open(scale_path(mac), 'w') as handle:
        json.dump({'scale': scale}, handle)


# ---------------------------------------------------------------------------
# VNC actions

class Pump:
    """Keep reading server messages for the whole connection.

    The Mac sends framebuffer updates while we type. asyncvnc only reads when a
    screenshot is requested, so unread updates piled up and the stream fell out
    of step (a hang, or "ValueError: <garbage encoding>"). The pump consumes
    everything as it arrives; screenshots wait on it instead of reading.
    """

    def __init__(self, vnc):
        import asyncvnc
        self.vnc = vnc
        self.video_update = asyncvnc.UpdateType.VIDEO
        self.updated = asyncio.Event()
        self.error = None
        self.task = asyncio.create_task(self.run())

    async def run(self):
        try:
            while True:
                if await self.vnc.read() is self.video_update:
                    self.updated.set()
        except asyncio.CancelledError:
            raise
        except Exception as error:  # connection closed or a stream error: wake any waiter
            self.error = error
            self.updated.set()

    async def screenshot(self, timeout=30):
        """A complete frame: ask for the whole screen, wait for updates until every pixel arrived."""
        video = self.vnc.video
        deadline = time.monotonic() + timeout
        while True:
            video.data = None  # empty data makes refresh() a full (non-incremental) request
            self.updated.clear()
            video.refresh()
            await self.vnc.drain()
            try:
                await asyncio.wait_for(self.updated.wait(), max(0.1, deadline - time.monotonic()))
            except asyncio.TimeoutError:
                raise TimeoutError(f'no screen update from the Mac within {timeout}s')
            if self.error:
                raise ConnectionError(f'VNC stream ended: {self.error!r}')
            if video.is_complete():
                return video.as_rgba()
            await asyncio.sleep(0.1)  # partial frame: ask for the whole screen again

    async def close(self):
        self.task.cancel()
        await asyncio.gather(self.task, return_exceptions=True)


async def tap(vnc, *names):
    """Press keys together, release in reverse, flushing every event."""
    import asyncvnc
    codes = [keysym(name, asyncvnc.key_codes) for name in names]
    for code in codes:
        vnc.keyboard.writer.write(b'\x04\x01\x00\x00' + code.to_bytes(4, 'big'))
        await vnc.drain()
        await asyncio.sleep(KEY_DELAY)
    for code in reversed(codes):
        vnc.keyboard.writer.write(b'\x04\x00\x00\x00' + code.to_bytes(4, 'big'))
        await vnc.drain()
        await asyncio.sleep(KEY_DELAY)


async def write_text(vnc, text):
    # Capitals and symbols go out as their own keysyms. A Shift_L key event is
    # ignored by the server, but it adds Shift itself for a shifted keysym.
    for char in text:
        await tap(vnc, char)


async def shot(vnc, mac, args):
    from PIL import Image
    full = '--full' in args
    paths = [a for a in args if a != '--full']
    out = paths[0] if paths else f'/tmp/mac-{mac["name"]}.png'
    pixels = await vnc.pump.screenshot()
    height, width = pixels.shape[:2]
    scale = 1.0 if full else shot_scale(width, height)
    image = Image.fromarray(pixels)
    if scale > 1:
        image = image.resize((round(width / scale), round(height / scale)), Image.LANCZOS)
    image.save(out)
    write_scale(mac, scale)
    print(f'{out} {image.width}x{image.height} (screen {width}x{height}, scale {scale:.3f}); click/move/drag use these pixels')


async def act(vnc, mac, password, action, args, started):
    """One action. `started` is when the connection was made (for the warm-up)."""
    if action == 'shot':
        await shot(vnc, mac, args)
        return

    if action in KEYBOARD:
        await asyncio.sleep(max(0.0, WARMUP - (time.monotonic() - started)))

    scale = read_scale(mac)

    if action in ('click', 'move', 'drag'):
        vnc.mouse.move(*to_framebuffer(args[0], args[1], scale))
        if action == 'click':
            kind = args[2] if len(args) > 2 else 'left'
            if kind == 'right':
                vnc.mouse.right_click()
            else:
                vnc.mouse.click()
                if kind == 'double':
                    vnc.mouse.click()
        elif action == 'drag':
            with vnc.mouse.hold():
                await asyncio.sleep(0.1)
                vnc.mouse.move(*to_framebuffer(args[2], args[3], scale))
                await asyncio.sleep(0.1)
    elif action == 'type':
        await write_text(vnc, ' '.join(args))
    elif action == 'key':
        for chord in args:
            await tap(vnc, *parse_chord(chord))
    elif action == 'password':
        # Typed from the staged file so the agent never sees or handles it
        await write_text(vnc, password)
    elif action == 'unlock':
        await tap(vnc, 'Shift')  # wake the login window and focus its field
        await asyncio.sleep(1.5)
        await write_text(vnc, password)
        await asyncio.sleep(0.5)
        # The lock screen ignores Return from VNC but accepts a click on its submit arrow
        vnc.mouse.move(*lock_arrow(vnc.video.width, vnc.video.height))
        await vnc.drain()
        await asyncio.sleep(0.3)
        vnc.mouse.click()
        await asyncio.sleep(6)
    elif action == 'scroll':
        (vnc.mouse.scroll_up if args[0] == 'up' else vnc.mouse.scroll_down)(int(args[1]) if len(args) > 1 else 3)
    else:
        sys.exit(f'unknown action {action!r}\n{__doc__}')

    await asyncio.sleep(SETTLE)
    await vnc.drain()


async def run(name, statements):
    import asyncvnc
    mac, password = load(name)
    async with asyncvnc.connect(mac['host'], port=mac.get('vnc_port', 5900), username=mac['user'], password=password) as vnc:
        started = time.monotonic()
        vnc.pump = Pump(vnc)
        try:
            for action, *args in statements:
                await act(vnc, mac, password, action, args, started)
        finally:
            await vnc.pump.close()


def main(argv):
    if len(argv) < 2:
        sys.exit(__doc__)
    name, action, args = argv[0], argv[1], argv[2:]
    if action == 'run':
        script = ' '.join(args) if args else sys.stdin.read()
        statements = parse_script(script)
        if not statements:
            sys.exit('run: empty script')
    else:
        statements = [[action, *args]]
    asyncio.run(run(name, statements))


if __name__ == '__main__':
    main(sys.argv[1:])
