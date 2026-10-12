"""Exercise the real packaged launcher with an isolated, disposable profile."""
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

executable = str(Path(sys.argv[1]).resolve())
with tempfile.TemporaryDirectory(prefix="t3-packaged-runtime-") as temporary:
    root = Path(temporary)
    env = dict(os.environ, T3CODE_MANAGED_RUNTIME_ROOT=str(root / "runtimes"))
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    child = subprocess.Popen(
        [executable, "desktop-runtime", "attach", "acceptance", "--bootstrap-fd", "0"],
        env=env, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
    )
    bootstrap = {"port": port, "host": "127.0.0.1", "t3Home": str(root / "profile"),
                 "desktopBootstrapSecret": secrets.token_hex(32)}
    child.stdin.write((json.dumps(bootstrap) + "\n").encode())
    child.stdin.close()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        deadline = time.monotonic() + 120
        while True:
            if child.poll() is not None:
                raise RuntimeError("Packaged launcher exited: " + child.stderr.read().decode())
            try:
                with opener.open(f"http://127.0.0.1:{port}/.well-known/t3/environment", timeout=1) as response:
                    descriptor = json.load(response)
                assert descriptor["environmentId"]
                break
            except (OSError, ValueError):
                if time.monotonic() > deadline:
                    log = root / "runtimes/acceptance/server.log"
                    raise RuntimeError("Packaged readiness timed out: " + (log.read_text()[-2000:] if log.exists() else "no log"))
                time.sleep(0.2)  # Bounded endpoint readiness polling, not an activity timeout.
        inspection = subprocess.check_output([executable, "desktop-runtime", "inspect", "acceptance"], env=env, timeout=15)
        assert json.loads(inspection)["healthy"] is True
        print("Packaged detached runtime ready; owned identity and health verified.")
    finally:
        subprocess.run([executable, "desktop-runtime", "stop", "acceptance"], env=env, timeout=30, check=True)
        if child.poll() is None:
            child.terminate()
        child.wait(timeout=10)
