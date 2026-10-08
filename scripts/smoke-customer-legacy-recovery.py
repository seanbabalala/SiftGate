#!/usr/bin/env python3
"""Actual legacy-release recovery and JWT rotation, on new synthetic instances only."""
import argparse
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"deploy/customer"))
import siftgate_vault as vault
import siftgate_tools as tools
spec=importlib.util.spec_from_file_location("customer_smoke",ROOT/"scripts/smoke-customer-install.py")
smoke=importlib.util.module_from_spec(spec); spec.loader.exec_module(smoke)
KIT=smoke.KIT


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image",required=True); parser.add_argument("--baseline-kit",type=Path,required=True); parser.add_argument("--output",type=Path)
    args=parser.parse_args(); output=args.output or ROOT/".local-dev"; output.mkdir(parents=True,exist_ok=True)
    baseline=json.loads((args.baseline_kit/"release.json").read_text())
    assert baseline["version"]=="v2.11.7" and baseline["image"]==args.image
    folder=Path(tempfile.mkdtemp(prefix="legacy-recovery-",dir=output)).resolve(); source=folder/"source"; installations=[]
    def cli(script,directory,*arguments):
        result=subprocess.run([sys.executable,str(script),"--directory",str(directory),*arguments],capture_output=True,text=True)
        if result.returncode: raise RuntimeError("Synthetic legacy recovery action failed: "+result.stderr)
        return json.loads(result.stdout)
    current=ROOT/"deploy/customer/siftgate.py"
    try:
        port=smoke.port(); assert port!=2099
        cli(args.baseline_kit/"siftgate.py",source,"init","--image",args.image,"--local-image","--timezone","Asia/Shanghai","--port",str(port))
        install=KIT.Install.load(source); installations.append(install)
        actual_version=install.docker("run","--rm","--network","none","--read-only","--cap-drop","ALL",
            "--security-opt","no-new-privileges:true","--entrypoint","node",install.meta["image"],"-p","require('/app/package.json').version")
        assert actual_version=="2.11.7"
        # Old release did not implement nodes.disabled. Force every synthetic
        # provider URL to an unreachable container-loopback port before any boot.
        isolate="const fs=require('fs'),y=require('js-yaml'),p='/config/gateway.config.yaml',c=y.load(fs.readFileSync(p,'utf8'));c.nodes=c.nodes.map(n=>({...n,base_url:'http://127.0.0.1:1',api_key:'synthetic-no-vendor',health_check:{...n.health_check,enabled:false}}));fs.writeFileSync(p,y.dump(c,{lineWidth:110}));"
        install.compose("run","--rm","--no-deps","--entrypoint","node","siftgate","-e",isolate)
        cli(current,source,"up")
        password=(source/"config/initial-admin-password.txt").read_text().strip()
        token=smoke.request(install,"/api/auth/login",{"password":password})["token"]
        key=smoke.request(install,"/api/dashboard/api-keys",{"name":"legacy-synthetic-key","allow_auto":False,"allow_direct":True,
            "allowed_nodes":["openai"],"allowed_models":["gpt-4o-mini"],"daily_token_limit":100,"daily_cost_limit":1},token)
        before=install.container()
        tools.bootstrap(install,confirmed=True)
        assert install.container()["Id"]==before["Id"] and install.container()["State"]["StartedAt"]==before["State"]["StartedAt"]
        saved=cli(current,source,"backup","--accept-downtime")
        install=KIT.Install.load(source); installations[0]=install
        backup=Path(saved["backup"]); original_config=(source/"config/gateway.config.yaml").read_bytes()
        verifier=vault.Vault(install); selected=verifier.backup(backup.name)
        job=verifier.plan(backup.name,selected[2],"legacy-native-restore")
        result=verifier.execute(job["id"],job["plan_digest"],confirmed=True)
        assert result["status"]=="succeeded",result["error_code"]
        assert result["evidence"]["legacy_sessions_revoked"] and not result["evidence"]["legacy_session_rotation_required_before_cutover"]
        destination=folder/"restored"; restored_port=smoke.port(); assert restored_port!=2099
        cli(current,destination,"restore","--backup",str(backup),"--local-image","--port",str(restored_port))
        restored=KIT.Install.load(destination); installations.append(restored); cli(current,destination,"up")
        smoke.assert_rejected(restored,"/api/dashboard/api-keys",token)
        renewed=smoke.request(restored,"/api/auth/login",{"password":password})["token"]
        assert key["item"]["id"] in json.dumps(smoke.request(restored,"/api/dashboard/api-keys",token=renewed))
        assert smoke.request(install,"/api/dashboard/api-keys",token=token) is not None
        assert (source/"config/gateway.config.yaml").read_bytes()==original_config
        receipt={"format":"siftgate-legacy-recovery-smoke-v1","platform":"linux/"+install.meta["engine_arch"],"source_image":install.meta["image"],"source_version":actual_version,
            "drill_id":job["id"],"checks":["actual_legacy_release","host_bootstrap_without_restart","frozen_backup_tools","legacy_isolated_drill",
                "only_session_secret_changed","old_jwt_rejected_after_restore","same_password_works","business_key_preserved","source_session_and_config_preserved"]}
        KIT.write_json(folder/"result.json",receipt); print(json.dumps(receipt,indent=2))
    finally:
        for install in reversed(installations): install.compose("down","--timeout","45",timeout=90)
        print("Synthetic legacy recovery evidence: "+str(folder),file=sys.stderr)


if __name__=="__main__": main()
