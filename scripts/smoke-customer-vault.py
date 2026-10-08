#!/usr/bin/env python3
"""Native restore-drill acceptance on a fresh synthetic gateway, never port 2099."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "deploy/customer"))
import siftgate_vault as vault
spec = importlib.util.spec_from_file_location("customer_smoke", ROOT / "scripts/smoke-customer-install.py")
smoke = importlib.util.module_from_spec(spec); spec.loader.exec_module(smoke)
KIT = smoke.KIT


def main():
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument("--image", required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    output = args.output or ROOT / ".local-dev"; output.mkdir(parents=True, exist_ok=True)
    folder = Path(tempfile.mkdtemp(prefix="vault-smoke-", dir=output)).resolve(); directory = folder / "install"
    install = None; mock = None; verifier = None; job = None
    def cli(*arguments):
        result = subprocess.run([sys.executable, str(ROOT / "deploy/customer/siftgate.py"), "--directory", str(directory), *arguments], capture_output=True, text=True)
        if result.returncode: raise RuntimeError("Synthetic kit command failed: " + result.stderr)
        return json.loads(result.stdout)
    try:
        port = smoke.port(); assert port != 2099
        cli("init", "--image", args.image, "--local-image", "--timezone", "Asia/Shanghai", "--port", str(port))
        install = KIT.Install.load(directory); cli("up")
        code = (directory / "config/activate-code.txt").read_text().strip()
        password = "synthetic vault acceptance password"
        smoke.request(install, "/api/auth/identity/activate", {"code": code, "password": password})
        token = smoke.request(install, "/api/auth/login", {"password": password})["token"]
        mock = install.meta["project"] + "-vault-mock"
        handler = "require('http').createServer((req,res)=>{req.resume();req.on('end',()=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'synthetic-vault',object:'chat.completion',model:'gpt-4o-mini',choices:[{index:0,message:{role:'assistant',content:'vault-ok'},finish_reason:'stop'}],usage:{prompt_tokens:3,completion_tokens:2,total_tokens:5}}))})}).listen(3099,'0.0.0.0')"
        install.docker("run", "-d", "--name", mock, "--network", install.meta["project"] + "_default", "--entrypoint", "node", install.meta["image"], "-e", handler)
        smoke.request(install, "/api/dashboard/nodes/openai", {"base_url": "http://" + mock + ":3099", "api_key": "synthetic-provider", "disabled": False}, token, "PUT")
        key = smoke.request(install, "/api/dashboard/api-keys", {"name": "vault-fixture", "allow_auto": False, "allow_direct": True,
            "allowed_nodes": ["openai"], "allowed_models": ["gpt-4o-mini"], "daily_token_limit": 10000, "daily_cost_limit": 1}, token)
        body = {"model": "openai/gpt-4o-mini", "messages": [{"role": "user", "content": "synthetic restore evidence"}], "max_tokens": 16}
        smoke.request(install, "/v1/chat/completions", body, key["key"])
        saved = cli("backup", "--accept-downtime")
        backup_id = Path(saved["backup"]).name
        before = install.container(); verifier = vault.Vault(install)
        selected = next(item for item in verifier.catalog()["items"] if item["id"] == backup_id)
        assert selected["last_verified_drill"] is None
        job = verifier.plan(backup_id, selected["manifest_digest"], "native-vault-acceptance")
        result = verifier.execute(job["id"], job["plan_digest"], confirmed=True)
        if result["status"] != "succeeded": raise RuntimeError("Synthetic restore verification failed: " + str(result["error_code"]))
        after = install.container()
        assert after["Id"] == before["Id"] and after["State"]["StartedAt"] == before["State"]["StartedAt"]
        assert after["RestartCount"] == before["RestartCount"]
        assert result["evidence"]["database"]["tables"]["gateway_api_keys"]["rows"] >= 1
        assert result["evidence"]["database"]["tables"]["call_logs"]["rows"] >= 1
        assert result["evidence"]["managed_sessions_revoked"] is True
        assert result["evidence"]["network"] == "none" and result["evidence"]["published_ports"] is False
        assert result["cleanup_confirmed"] is True
        # The original management session, routing config and business Key still work.
        smoke.request(install, "/api/dashboard/api-keys", token=token)
        reply = smoke.request(install, "/v1/chat/completions", body, key["key"])
        assert reply["choices"][0]["message"]["content"] == "vault-ok"
        assert verifier.execute(job["id"], job["plan_digest"], confirmed=True)["id"] == result["id"]
        receipt = {"format": "siftgate-vault-smoke-v1", "image_id": install.meta["image"], "platform": "linux/" + install.meta["engine_arch"],
                   "drill_id": job["id"], "backup_id": backup_id, "source_restart_count_unchanged": True,
                   "checks": ["backup_integrity", "independent_directory_restore", "network_none", "no_published_port", "http_readiness",
                              "key_log_and_configuration_match", "copied_sessions_revoked", "source_session_and_key_preserved", "cleanup_verified", "idempotent_receipt"]}
        KIT.write_json(folder / "result.json", receipt)
        print(json.dumps(receipt, indent=2))
    finally:
        if verifier and job: verifier.cleanup(job["id"])
        if install:
            if mock: install.docker("rm", "-f", mock)
            install.compose("down", "--timeout", "45", timeout=90)
        print("Synthetic vault evidence: " + str(folder), file=sys.stderr)


if __name__ == "__main__": main()
