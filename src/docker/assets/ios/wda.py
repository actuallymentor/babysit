"""Keep a WebDriverAgent runner alive on a network iOS device: launch the
installed runner whenever :8100 is down and stay running while it is up.
iOS 16 and older: plain lockdown over TCP :62078, no tunnel.

One supervisor per device per container (flock); supervisors in other
containers share the device, so whichever lives longest keeps it up. Launches
only happen while /status is unreachable, so they do not fight each other.

Usage: wda.py HOST UDID RUNNER_BUNDLE_ID"""
import asyncio
import fcntl
import os
import plistlib
import random
import sys
import time
import urllib.request

from pymobiledevice3.lockdown import create_using_tcp
from pymobiledevice3.services.dvt.testmanaged.xcuitest import TestConfig, XCUITestService

ROOT = os.environ.get( 'BABYSIT_IOS_ROOT', '/opt/babysit-ios' )
POLL = 10
BACKOFF = ( 5, 60 )


def ready( host ):
    try:
        with urllib.request.urlopen( f'http://{ host }:8100/status', timeout=3 ) as response:
            body = response.read().replace( b' ', b'' )
            return b'"ready":true' in body
    except Exception:
        return False


async def launch( host, udid, runner ):
    with open( f'{ ROOT }/records/{ udid }.plist', 'rb' ) as file:
        record = plistlib.load( file )
    lockdown = await create_using_tcp( host, identifier=udid, pair_record=record )
    config = await TestConfig.create_for( lockdown, runner_bundle_id=runner )
    await XCUITestService( lockdown ).run( config )


def supervise( host, udid, runner ):
    lock = open( f'/tmp/babysit-ios-{ udid }.lock', 'w' )
    try:
        fcntl.flock( lock, fcntl.LOCK_EX | fcntl.LOCK_NB )
    except OSError:
        return  # this container already supervises the device

    failures = 0
    while True:
        if ready( host ):
            failures = 0
            time.sleep( POLL )
            continue

        # Jitter so supervisors in different containers rarely launch together
        time.sleep( random.uniform( 0, 2 ) )
        if ready( host ):
            continue

        started = time.time()
        try:
            asyncio.run( launch( host, udid, runner ) )
        except Exception as error:
            print( f'{ time.strftime( "%H:%M:%S" ) } launch failed: { error!r }', file=sys.stderr, flush=True )

        # A runner that lived a while was healthy: restart quickly. Quick exits back off.
        failures = 0 if time.time() - started > 30 else failures + 1
        time.sleep( min( BACKOFF[ 0 ] * 2 ** failures, BACKOFF[ 1 ] ) )


supervise( *sys.argv[ 1: 4 ] )
