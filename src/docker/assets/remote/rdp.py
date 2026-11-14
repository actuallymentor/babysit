#!/usr/bin/env python3
"""Drive a Windows PC's Remote Desktop from the command line.

  rdp.py NAME shot [OUT.png] [--full]   screenshot, long edge <= 1568 px unless --full
  rdp.py NAME click X Y [right|double]  coordinates are pixels of the LAST shot
  rdp.py NAME move X Y
  rdp.py NAME drag X1 Y1 X2 Y2
  rdp.py NAME type TEXT...              type text literally
  rdp.py NAME key Win+r [Return..]      key chords, one arg per chord
  rdp.py NAME scroll up|down [N]
  rdp.py NAME unlock                    reconnect: signing in again clears the lock screen
  rdp.py NAME password                  type the stored password into the focused field; no Return
  rdp.py NAME close                     disconnect (the Windows session keeps running)
  rdp.py NAME run [SCRIPT]              several actions in order: "click 10 20; type hi; key Return; shot"

One FreeRDP client per PC stays connected on a private virtual display
(Xvfb), so commands after the first are fast. Credentials come from the
staged registry; the password reaches FreeRDP and xdotool on stdin, never argv.
"""

import fcntl
import os
import subprocess
import sys
import time

import vnc  # shared script parsing, shot scaling and registry loading

vnc.KIND = 'windows'

SIZE = os.environ.get('BABYSIT_RDP_SIZE') or '1920x1080'
STATE = os.environ.get('BABYSIT_RDP_STATE') or '/tmp/babysit-rdp'
CONNECT_TIMEOUT = float(os.environ.get('BABYSIT_RDP_TIMEOUT') or 45)
SETTLE = 0.35  # let the screen repaint before a follow-up shot

# Babysit chord names -> xdotool keysyms (anything else passes through)
KEY_NAMES = {
    'win': 'super', 'cmd': 'super', 'super': 'super', 'ctrl': 'ctrl', 'control': 'ctrl',
    'alt': 'alt', 'shift': 'shift', 'esc': 'Escape', 'del': 'Delete', 'backspace': 'BackSpace',
    'enter': 'Return', 'return': 'Return', 'tab': 'Tab', 'space': 'space', '+': 'plus',
}


# ---------------------------------------------------------------------------
# Pure logic: unit-tested

def xdotool_chord(chord):
    """`Ctrl+Shift+Esc` -> `ctrl+shift+Escape`; `Win+r` -> `super+r`."""
    return '+'.join(KEY_NAMES.get(part.lower(), part) for part in vnc.parse_chord(chord))


def freerdp_args(pc, size=SIZE):
    """xfreerdp3 argv for one PC. No password here: /from-stdin reads it."""
    return [
        'xfreerdp3', f"/v:{pc['host']}", f"/u:{pc['user']}", '/from-stdin:force',
        '/cert:tofu',                    # pin the PC's certificate on first contact
        f'/size:{size}', '/log-level:WARN',
        '/auth-pkg-list:!kerberos',      # LAN PCs authenticate with NTLM; skips realm noise
        '+auto-reconnect', '/auto-reconnect-max-retries:20',
        '-clipboard', '/audio-mode:2',   # nothing leaves the container but input
        '/client-hostname:babysit',
    ]


# ---------------------------------------------------------------------------
# Session: Xvfb + xfreerdp3 per PC, recorded under STATE/NAME

def state_dir(pc):
    path = f"{STATE}/{pc['name']}"
    os.makedirs(path, mode=0o700, exist_ok=True)
    return path


def alive(pid_file):
    try:
        pid = int(open(pid_file).read())
        os.kill(pid, 0)
        return pid
    except (OSError, ValueError):
        return None


def read_display(pc):
    try:
        return open(f'{state_dir(pc)}/display').read().strip()
    except OSError:
        return None


def free_display():
    """First X display number with no lock file."""
    for number in range(90, 200):
        if not os.path.exists(f'/tmp/.X{number}-lock'):
            return f':{number}'
    sys.exit('no free X display for the RDP client')


def xdo(display, *args, stdin=None):
    return subprocess.run(['xdotool', *args], env={**os.environ, 'DISPLAY': display},
                          input=stdin, text=True, capture_output=True)


def window_up(display):
    return bool(xdo(display, 'search', '--onlyvisible', '--class', 'freerdp').stdout.strip())


def close(pc):
    """Stop this PC's client and display. The Windows session itself keeps running."""
    directory = state_dir(pc)
    for name in ('freerdp', 'xvfb'):
        pid = alive(f'{directory}/{name}.pid')
        if pid:
            os.kill(pid, 15)
    for name in ('freerdp.pid', 'xvfb.pid', 'display'):
        try:
            os.remove(f'{directory}/{name}')
        except OSError:
            pass


def failure_reason(log):
    """The line of a FreeRDP log a person needs."""
    text = open(log, errors='replace').read()
    for marker, reason in (
        ('LOGON_FAILURE', 'wrong user or password (Microsoft accounts: the password, not the PIN; "only allow Windows Hello sign-in" off)'),
        ('AUTHENTICATION_FAILED', 'wrong user or password'),
        ('PASSWORD_EXPIRED', 'the account password expired; sign in on the PC and change it'),
        ('ACCOUNT_RESTRICTION', 'the account may not log in remotely (blank password, or not in Remote Desktop Users)'),
        ('CONNECT_TRANSPORT_FAILED', 'Remote Desktop does not answer (PC asleep or off, or Remote Desktop disabled)'),
        ('verification failed', "the PC's certificate changed since first contact"),
    ):
        if marker in text:
            return reason
    lines = [line for line in text.splitlines() if 'ERROR' in line]
    return lines[-1] if lines else 'the RDP client exited'


def connect(pc, password):
    """Start Xvfb and a detached xfreerdp3, wait for its window. Returns the display."""
    directory = state_dir(pc)
    close(pc)

    display = free_display()
    xvfb = subprocess.Popen(['Xvfb', display, '-screen', '0', f'{SIZE}x24', '-nolisten', 'tcp'],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    open(f'{directory}/xvfb.pid', 'w').write(str(xvfb.pid))
    open(f'{directory}/display', 'w').write(display)

    log = f'{directory}/freerdp.log'
    client = subprocess.Popen(freerdp_args(pc), stdin=subprocess.PIPE, stdout=open(log, 'w'), stderr=subprocess.STDOUT,
                              env={**os.environ, 'DISPLAY': display}, start_new_session=True, text=True)
    client.stdin.write(password + '\n')
    client.stdin.close()
    open(f'{directory}/freerdp.pid', 'w').write(str(client.pid))

    deadline = time.monotonic() + CONNECT_TIMEOUT
    while time.monotonic() < deadline:
        if client.poll() is not None:
            close(pc)
            sys.exit(f"{pc['name']}: RDP failed: {failure_reason(log)}")
        if window_up(display):
            time.sleep(3)  # the window maps before the desktop finishes drawing
            return display
        time.sleep(0.5)

    close(pc)
    sys.exit(f"{pc['name']}: no Remote Desktop window within {CONNECT_TIMEOUT:.0f}s; see {log}")


def session(pc, password):
    """The PC's live display, connecting first when needed. One caller at a time."""
    with open(f'{state_dir(pc)}/lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        display = read_display(pc)
        if display and alive(f'{state_dir(pc)}/freerdp.pid') and window_up(display):
            return display
        return connect(pc, password)


# ---------------------------------------------------------------------------
# Actions

def settled(display, timeout=3.0, step=0.25):
    """A screenshot once the screen stops changing: input travels to the PC and
    its repaint comes back over the network, so a grab right after a key is stale."""
    from PIL import ImageGrab
    deadline = time.monotonic() + timeout
    previous = ImageGrab.grab(xdisplay=display)
    while time.monotonic() < deadline:
        time.sleep(step)
        current = ImageGrab.grab(xdisplay=display)
        if current.tobytes() == previous.tobytes():
            return current
        previous = current
    return previous


def shot(display, pc, args):
    from PIL import Image
    full = '--full' in args
    paths = [a for a in args if a != '--full']
    out = paths[0] if paths else f"/tmp/windows-{pc['name']}.png"
    image = settled(display)
    width, height = image.size
    scale = 1.0 if full else vnc.shot_scale(width, height)
    if scale > 1:
        image = image.resize((round(width / scale), round(height / scale)), Image.LANCZOS)
    image.save(out)
    vnc.write_scale(pc, scale)
    print(f'{out} {image.width}x{image.height} (screen {width}x{height}, scale {scale:.3f}); click/move/drag use these pixels')


def act(display, pc, password, action, args):
    if action == 'shot':
        return shot(display, pc, args)

    scale = vnc.read_scale(pc)
    point = lambda x, y: [str(v) for v in vnc.to_framebuffer(x, y, scale)]

    if action == 'click':
        kind = args[2] if len(args) > 2 else 'left'
        clicks = ['click', '--repeat', '2', '1'] if kind == 'double' else ['click', '3' if kind == 'right' else '1']
        xdo(display, 'mousemove', *point(args[0], args[1]), *clicks)
    elif action == 'move':
        xdo(display, 'mousemove', *point(args[0], args[1]))
    elif action == 'drag':
        xdo(display, 'mousemove', *point(args[0], args[1]), 'mousedown', '1', 'sleep', '0.1',
            'mousemove', *point(args[2], args[3]), 'sleep', '0.1', 'mouseup', '1')
    elif action == 'type':
        xdo(display, 'type', '--delay', '15', '--file', '-', stdin=' '.join(args))
    elif action == 'password':
        # From the staged file over stdin, so the agent never sees or handles it
        xdo(display, 'type', '--delay', '15', '--file', '-', stdin=password)
    elif action == 'key':
        for chord in args:
            xdo(display, 'key', xdotool_chord(chord))
    elif action == 'scroll':
        xdo(display, 'click', '--repeat', str(int(args[1]) if len(args) > 1 else 3), '4' if args[0] == 'up' else '5')
    else:
        sys.exit(f'unknown action {action!r}\n{__doc__}')

    time.sleep(SETTLE)


def main(argv):
    if len(argv) < 2:
        sys.exit(__doc__)
    name, action, args = argv[0], argv[1], argv[2:]
    pc, password = vnc.load(name)

    if action == 'close':
        return close(pc)
    if action == 'unlock':
        close(pc)
        session(pc, password)
        return print(f"{pc['name']}: signed in again")

    statements = vnc.parse_script(' '.join(args) if args else sys.stdin.read()) if action == 'run' else [[action, *args]]
    if not statements:
        sys.exit('run: empty script')

    display = session(pc, password)
    for step, *step_args in statements:
        act(display, pc, password, step, step_args)


if __name__ == '__main__':
    main(sys.argv[1:])
