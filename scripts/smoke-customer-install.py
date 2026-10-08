#!/usr/bin/env python3
"""Real Docker acceptance on fresh synthetic installations. No production names/ports/data."""
import argparse
import importlib.util
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import urllib.request
import urllib.error

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("kit", ROOT / "deploy/customer/siftgate.py")
KIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(KIT)


def port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def request(install, path, data=None, token=None, method=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(f"http://127.0.0.1:{install.meta['port']}{path}",
                                 data=json.dumps(data).encode() if data is not None else None,
                                 headers=headers, method=method)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(req, timeout=30) as response:
        return json.load(response)


def assert_rejected(install, path, token):
    try:
        request(install, path, token=token)
    except urllib.error.HTTPError as error:
        assert error.code == 401
    else:
        raise AssertionError("A revoked management token was accepted")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True, help="Already loaded image to test")
    args = parser.parse_args()
    (ROOT / ".local-dev").mkdir(exist_ok=True)
    workspace = Path(tempfile.mkdtemp(prefix="customer-smoke-", dir=ROOT / ".local-dev"))
    installations = []
    mock_name = None
    stamp_name = None
    upgrade_image = None

    def cli(directory, *arguments):
        result = subprocess.run([sys.executable, str(ROOT / "deploy/customer/siftgate.py"),
                                 "--directory", str(directory), *arguments], capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError(result.stderr)
        return json.loads(result.stdout)

    try:
        directory = workspace / "fresh"
        cli(directory, "init", "--image", args.image, "--local-image", "--timezone", "Asia/Shanghai", "--port", str(port()))
        install = KIT.Install.load(directory)
        installations.append(install)
        cli(directory, "up")
        password = "synthetic customer smoke passphrase"
        access = (directory / "config/activate-code.txt").read_text().strip()
        assert request(install, "/api/auth/status")["identity"]["setupRequired"] is True
        request(install, "/api/auth/identity/activate", {"code": access, "password": password})
        assert not (directory / "config/activate-code.txt").exists()
        token = request(install, "/api/auth/login", {"password": password})["token"]
        # Recovery is host-authorized and must not restart this gateway.
        before = install.container()
        issued = cli(directory, "access-code", "--purpose", "recover", "--confirm")
        recovery = (directory / "config/recover-code.txt").read_text().strip()
        assert "sg_recover_" not in json.dumps(issued)
        assert issued["restarted"] is False
        request(install, "/api/auth/identity/recover", {"code": recovery, "password": password})
        after = install.container()
        assert before["Id"] == after["Id"] and before["State"]["StartedAt"] == after["State"]["StartedAt"]
        assert_rejected(install, "/api/dashboard/api-keys", token)
        token = request(install, "/api/auth/login", {"password": password})["token"]
        # The new explicit switch is enforced; old ignored enabled:false is not reinterpreted on upgrades.
        setup = request(install, "/api/dashboard/launchpad", token=token)
        assert setup["nodes"] and all(not node["enabled"] for node in setup["nodes"])
        mock_name = install.meta["project"] + "-mock"
        handler = """
          require('http').createServer((req,res)=>{
            req.resume(); req.on('end',()=>{ res.setHeader('content-type','application/json');
              res.end(JSON.stringify({id:'synthetic',object:'chat.completion',model:'gpt-4o-mini',
                choices:[{index:0,message:{role:'assistant',content:'customer-kit-ok'},finish_reason:'stop'}],
                usage:{prompt_tokens:3,completion_tokens:2,total_tokens:5}})); });
          }).listen(3099,'0.0.0.0');
        """
        install.docker("run", "-d", "--name", mock_name, "--network", install.meta["project"] + "_default",
                       "--label", "siftgate.customer-smoke=true", "--entrypoint", "node", install.meta["image"], "-e", handler)
        # A real Dashboard config write proves directory-mounted atomic replacement works.
        request(install, "/api/dashboard/nodes/openai", {
            "name": "Customer kit synthetic node", "base_url": f"http://{mock_name}:3099",
            "api_key": "synthetic-provider-fixture", "disabled": False,
        }, token, "PUT")
        key = request(install, "/api/dashboard/api-keys", {
            "name": "customer-kit-synthetic", "allow_auto": True, "allow_direct": True,
            "allowed_nodes": ["openai"], "allowed_models": ["gpt-4o-mini"],
            "daily_token_limit": 100000, "daily_cost_limit": 5,
        }, token)
        body = {"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "synthetic fixture"}]}
        answer = request(install, "/v1/chat/completions", body, key["key"])
        assert answer["choices"][0]["message"]["content"] == "customer-kit-ok"
        assert answer["usage"]["total_tokens"] == 5
        original_config = (directory / "config/gateway.config.yaml").read_bytes()
        # A second immutable image with identical application code tests replacement,
        # NOT arbitrary cross-version schema compatibility. This container is never
        # started and has no secret env, mounts, or runtime data to commit.
        stamp_name = install.meta["project"] + "-image-fixture"
        install.docker("create", "--name", stamp_name, "--label", "siftgate.customer-smoke=" + stamp_name,
                       install.meta["image"])
        upgrade_image = install.docker("commit", stamp_name)
        install.docker("rm", stamp_name)
        stamp_name = None
        cli(directory, "upgrade", "--image", upgrade_image, "--local-image", "--accept-downtime")
        install = KIT.Install.load(directory)
        installations[0] = install
        assert install.meta["image"] == upgrade_image
        assert (directory / "config/gateway.config.yaml").read_bytes() == original_config
        backup = cli(directory, "backup", "--accept-downtime", "--keep", "2")
        assert (directory / "config/gateway.config.yaml").read_bytes() == original_config
        saved = Path(backup["backup"]) / "config"
        assert not (saved / "activate-code.txt").exists() and not (saved / "recover-code.txt").exists()
        assert json.loads((saved / "dashboard-identity.json").read_text())["access"] is None
        # Existing session/key still authenticate after the backup's graceful restart.
        listed = request(install, "/api/dashboard/api-keys", token=token)
        assert key["item"]["id"] in json.dumps(listed)
        second = request(install, "/v1/chat/completions", body, key["key"])
        assert second["usage"]["total_tokens"] == 5
        assert cli(directory, "watchdog")["status"] == "healthy"
        restored_dir = workspace / "restored"
        cli(restored_dir, "restore", "--backup", backup["backup"], "--local-image", "--port", str(port()))
        restored = KIT.Install.load(restored_dir)
        installations.append(restored)
        assert restored.meta["timezone"] == "Asia/Shanghai"
        assert (restored_dir / "config/gateway.config.yaml").read_bytes() == original_config
        # The backup is an independent DB/config copy, not the original writable mount.
        cli(restored_dir, "up")
        assert_rejected(restored, "/api/dashboard/api-keys", token)
        restored_token = request(restored, "/api/auth/login", {"password": password})["token"]
        restored_keys = request(restored, "/api/dashboard/api-keys", token=restored_token)
        assert key["item"]["id"] in json.dumps(restored_keys)
        logs = request(restored, "/api/dashboard/logs?limit=20", token=restored_token)
        assert "gpt-4o-mini" in json.dumps(logs)
        cli(restored_dir, "stop")
        assert cli(restored_dir, "watchdog", "--recover")["status"] == "not-running"
        print(json.dumps({"passed": ["fresh-init", "http-readiness", "one-time-activation", "explicit-disabled-samples", "password-auth", "host-recovery-no-restart", "atomic-dashboard-config",
                                    "gateway-key", "mock-model-request", "wal-aware-backup", "restart-persistence",
                                    "same-code-image-upgrade",
                                    "independent-restore", "timezone-preserved", "restored-session-revocation", "key-log-preservation",
                                    "watchdog-no-revive"], "image": install.meta["image"]}, indent=2))
    finally:
        if mock_name and installations:
            installations[0].docker("rm", "-f", mock_name)
        if stamp_name and installations:
            installations[0].docker("rm", stamp_name)
        for install in reversed(installations):
            install.compose("down", "--timeout", "45", timeout=90)
        if upgrade_image and installations:
            installations[0].docker("image", "rm", upgrade_image)
        # Keep private synthetic files/evidence for diagnosis; no secrets appear in stdout.
        print(f"Synthetic workspace retained locally: {workspace}", file=sys.stderr)


if __name__ == "__main__":
    main()
