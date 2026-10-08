#!/usr/bin/env python3
"""Native Docker operator acceptance. Fresh synthetic installations only; never host port 2099."""
import argparse
import datetime as dt
import http.client
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("customer_smoke", ROOT / "scripts/smoke-customer-install.py")
smoke = importlib.util.module_from_spec(spec); spec.loader.exec_module(smoke)
KIT = smoke.KIT


class LocalHTTP(http.client.HTTPConnection):
    def __init__(self, location):
        super().__init__("localhost", timeout=5); self.location = location
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(5); self.sock.connect(self.location)


def observe(location, method="GET", path="/status"):
    connection = LocalHTTP(location)
    try:
        connection.request(method, path)
        response = connection.getresponse()
        return response.status, json.loads(response.read())
    finally:
        connection.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument("--image", required=True)
    args = parser.parse_args()
    folder = Path(tempfile.mkdtemp(prefix="operator-smoke-", dir=ROOT / ".local-dev"))
    directory = folder / "install"
    worker = None; install = None; mock_name = None; stamp = None; target = None
    output = None
    def cli(*arguments):
        result = subprocess.run([sys.executable, str(ROOT / "deploy/customer/siftgate.py"), "--directory", str(directory), *arguments], capture_output=True, text=True)
        if result.returncode: raise RuntimeError(result.stderr)
        return json.loads(result.stdout)
    def operator(*arguments, ok=True):
        result = subprocess.run([sys.executable, str(directory / "kit/siftgate_operator.py"), "--directory", str(directory), *arguments], capture_output=True, text=True)
        if ok and result.returncode: raise RuntimeError(result.stderr)
        if not ok:
            assert result.returncode != 0
            return
        return json.loads(result.stdout)
    def start_worker():
        return subprocess.Popen([sys.executable, str(directory / "kit/siftgate_operator.py"), "--directory", str(directory), "serve"], stdin=subprocess.DEVNULL, stdout=output, stderr=output, start_new_session=True)
    def wait_job(job_id, require_downtime=False):
        deadline = time.monotonic() + 180
        seen_down = False; independent_reads = 0
        while time.monotonic() < deadline:
            try:
                code, status = observe(socket_path)
                assert code == 200
                job = next((item for item in status["jobs"] if item["id"] == job_id), None)
                if not KIT.local_probe(install.meta["port"], "live"):
                    seen_down = True; independent_reads += 1
                if job and job["status"] in ("succeeded", "rejected", "needs_attention"):
                    assert job["status"] == "succeeded", json.dumps(job)
                    if require_downtime: assert seen_down and independent_reads > 0
                    assert sum(event["event"] == "started" for event in job["events"]) == 1
                    return job
            except (OSError, http.client.HTTPException):
                pass
            time.sleep(.15)
        raise RuntimeError("Synthetic operator job timed out; inspect private evidence")
    try:
        selected_port = smoke.port(); assert selected_port != 2099
        cli("init", "--image", args.image, "--local-image", "--timezone", "Asia/Shanghai", "--port", str(selected_port))
        install = KIT.Install.load(directory); assert install.meta["port"] != 2099
        cli("up")
        password = "synthetic operator smoke passphrase"
        access = (directory / "config/activate-code.txt").read_text().strip()
        smoke.request(install, "/api/auth/identity/activate", {"code": access, "password": password})
        token = smoke.request(install, "/api/auth/login", {"password": password})["token"]
        mock_name = install.meta["project"] + "-operator-mock"
        handler = "require('http').createServer((req,res)=>{req.resume();req.on('end',()=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'synthetic',object:'chat.completion',model:'gpt-4o-mini',choices:[{index:0,message:{role:'assistant',content:'operator-ok'},finish_reason:'stop'}],usage:{prompt_tokens:3,completion_tokens:2,total_tokens:5}}))})}).listen(3099,'0.0.0.0')"
        install.docker("run", "-d", "--name", mock_name, "--network", install.meta["project"] + "_default", "--label", "siftgate.operator-smoke=true", "--entrypoint", "node", install.meta["image"], "-e", handler)
        smoke.request(install, "/api/dashboard/nodes/openai", {"name":"Operator synthetic provider","base_url":f"http://{mock_name}:3099","api_key":"synthetic-provider-key","disabled":False}, token, "PUT")
        key = smoke.request(install, "/api/dashboard/api-keys", {"name":"operator-fixture","allow_auto":False,"allow_direct":True,"allowed_nodes":["openai"],"allowed_models":["gpt-4o-mini"],"daily_token_limit":10000,"daily_cost_limit":1}, token)
        before = install.container()
        operator("init", "--development", "--confirm")
        bridge = operator("bridge", "--enable", "--confirm"); assert bridge["restarted"] is False
        assert install.container()["State"]["StartedAt"] == before["State"]["StartedAt"]
        first = operator("plan", "backup", "--request-id", "operator-smoke-backup")
        assert operator("plan", "backup", "--request-id", "operator-smoke-backup")["id"] == first["id"]
        operator("approve", first["id"], "--plan-digest", "wrong", "--accept-downtime", ok=False)
        assert install.container()["State"]["StartedAt"] == before["State"]["StartedAt"]
        operator("approve", first["id"], "--plan-digest", first["plan_digest"], "--accept-downtime")
        socket_path = operator("socket-path")["socket"]
        output = (folder / "worker.log").open("wb"); os.chmod(folder / "worker.log", 0o600)
        worker = start_worker()
        completed = wait_job(first["id"], require_downtime=True)
        assert completed["checkpoint"]["checksums_verified"] is True
        assert completed["checkpoint"]["restore_drill_verified"] is False
        install = KIT.Install.load(directory)
        bridge_state = smoke.request(install, "/api/dashboard/operator/status", token=token)
        assert bridge_state["operator"]["installation_id"] == install.meta["id"]
        assert bridge_state["state"] == "online"
        assert observe(socket_path, "POST", "/approve")[0] == 405
        mounts = install.container()["Mounts"]
        assert any(item["Destination"] == "/operator-status" and item["RW"] is False for item in mounts)
        assert not any("docker.sock" in item["Destination"] or item["Destination"] == "/operator" for item in mounts)
        stamp = install.meta["project"] + "-operator-image-fixture"
        install.docker("create", "--name", stamp, install.meta["image"])
        target = install.docker("commit", stamp); install.docker("rm", stamp); stamp = None
        upgrade = operator("plan", "upgrade", "--request-id", "operator-smoke-upgrade", "--image", target)
        operator("approve", upgrade["id"], "--plan-digest", upgrade["plan_digest"], "--accept-downtime", ok=False)
        operator("approve", upgrade["id"], "--plan-digest", upgrade["plan_digest"], "--accept-downtime", "--accept-image-trust-and-current-kit-compatibility")
        wait_job(upgrade["id"])
        install = KIT.Install.load(directory); assert install.meta["image"] == target
        answer = smoke.request(install, "/v1/chat/completions", {"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"synthetic operator request"}],"max_tokens":16}, key["key"])
        assert answer["choices"][0]["message"]["content"] == "operator-ok"
        # Stop only the synthetic operator BEFORE the scheduled execution. Queued
        # approval must survive, and the next worker must execute it exactly once.
        scheduled = operator("plan", "backup", "--request-id", "operator-smoke-restart")
        start = dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=8)
        end = start + dt.timedelta(minutes=3)
        operator("approve", scheduled["id"], "--plan-digest", scheduled["plan_digest"], "--accept-downtime", "--not-before", start.isoformat(), "--not-after", end.isoformat())
        worker.terminate(); worker.wait(timeout=10); worker = None
        assert operator("show", scheduled["id"])["status"] == "queued"
        worker = start_worker(); wait_job(scheduled["id"])
        recorded = operator("status")
        assert len(recorded["jobs"]) == 3 and all(job["status"] == "succeeded" for job in recorded["jobs"])
        assert password not in json.dumps(recorded) and key["key"] not in json.dumps(recorded)
        (folder / "verified-public-status.json").write_text(json.dumps(recorded, indent=2))
        print(json.dumps({"passed":["enrollment-no-restart","exact-host-approval","idempotent-plan","readonly-networkless-preflight","durable-stage-journal","unix-status-during-gateway-stop","read-only-instance-bound-bridge","no-web-write-api","verified-backup-not-restore-claim","same-code-image-upgrade","api-key-preserved","queued-job-survives-worker-restart"],"public_status":str(folder / "verified-public-status.json")},indent=2))
    finally:
        if worker:
            worker.terminate()
            try: worker.wait(timeout=90)
            except subprocess.TimeoutExpired: worker.kill(); worker.wait(timeout=10)
        if output: output.close()
        if install:
            if mock_name: install.docker("rm", "-f", mock_name)
            if stamp: install.docker("rm", stamp)
            install.compose("down", "--timeout", "45", timeout=90)
            if target: install.docker("image", "rm", target)
        print("Synthetic operator evidence: " + str(folder), file=sys.stderr)


if __name__ == "__main__": main()
