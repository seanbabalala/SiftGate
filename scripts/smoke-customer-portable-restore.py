#!/usr/bin/env python3
"""Native config-bound recovery after tag-free image import; synthetic instances only.

Local image metadata is harness input, NOT publisher-signature acceptance.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"deploy/customer"))
import siftgate_release as release
spec=importlib.util.spec_from_file_location("customer_smoke",ROOT/"scripts/smoke-customer-install.py")
smoke=importlib.util.module_from_spec(spec); spec.loader.exec_module(smoke)
KIT=smoke.KIT


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image",required=True); parser.add_argument("--output",type=Path)
    args=parser.parse_args(); output=args.output or ROOT/".local-dev"; output.mkdir(parents=True,exist_ok=True)
    folder=Path(tempfile.mkdtemp(prefix="portable-restore-",dir=output)).resolve()
    installations=[]; raw=folder/"export.tar"; normalized=folder/"image.tar"
    def cli(directory,*arguments):
        completed=subprocess.run([sys.executable,str(ROOT/"deploy/customer/siftgate.py"),"--directory",str(directory),*arguments],capture_output=True,text=True)
        if completed.returncode: raise RuntimeError("Synthetic recovery action failed: "+completed.stderr)
        return json.loads(completed.stdout)
    try:
        source=folder/"source"; port=smoke.port(); assert port!=2099
        cli(source,"init","--image",args.image,"--local-image","--timezone","Asia/Shanghai","--port",str(port))
        install=KIT.Install.load(source); installations.append(install); cli(source,"up")
        password="synthetic portable recovery password"
        smoke.request(install,"/api/auth/identity/activate",{"code":(source/"config/activate-code.txt").read_text().strip(),"password":password})
        token=smoke.request(install,"/api/auth/login",{"password":password})["token"]
        key=smoke.request(install,"/api/dashboard/api-keys",{"name":"portable-synthetic-key","allow_auto":False,"allow_direct":True,
            "allowed_nodes":["openai"],"allowed_models":["gpt-4o-mini"],"daily_token_limit":100,"daily_cost_limit":1},token)
        saved=cli(source,"backup","--accept-downtime")
        backup=Path(saved["backup"]); manifest=KIT.verified_snapshot(backup)
        assert manifest["recovery_kit"] and manifest["image_binding"]
        runtime=install.meta["image"]; arch=install.meta["engine_arch"]
        install.docker("image","save","--output",str(raw),runtime,timeout=1200); os.chmod(raw,0o600)
        identity=release.saved_image_identity(raw)
        assert identity["config_digest"]==manifest["image_binding"]["config_digest"]
        fixture=release.VerifiedRelease({"platforms":{"linux/"+arch:{"config_digest":identity["config_digest"]}}},"0"*64)
        release.normalize_offline_image(fixture,raw,normalized,arch)
        loaded=install.docker("image","load","--input",str(normalized),timeout=1200)
        handles=re.findall(r"^Loaded image ID: (sha256:[a-f0-9]{64})\s*$",loaded,re.MULTILINE); assert len(handles)==1
        destination=folder/"restored"; recovered_port=smoke.port(); assert recovered_port!=2099
        result=cli(destination,"restore","--backup",str(backup),"--image",handles[0],"--local-image","--port",str(recovered_port))
        restored=KIT.Install.load(destination); installations.append(restored)
        assert result["image_identity"]=="verified_config_digest" and result["tool_kit"]=="frozen_backup_kit"
        assert KIT.inventory(destination/"kit")==KIT.inventory(backup/"kit")
        cli(destination,"up")
        smoke.assert_rejected(restored,"/api/dashboard/api-keys",token)
        restored_token=smoke.request(restored,"/api/auth/login",{"password":password})["token"]
        assert key["item"]["id"] in json.dumps(smoke.request(restored,"/api/dashboard/api-keys",token=restored_token))
        assert smoke.request(install,"/api/dashboard/api-keys",token=token) is not None
        receipt={"format":"siftgate-portable-recovery-smoke-v1","platform":"linux/"+arch,"source_runtime_id":runtime,
            "restored_runtime_id":restored.meta["image"],"runtime_handle_changed":runtime!=restored.meta["image"],
            "config_digest":identity["config_digest"],"backup_kit_digest":manifest["recovery_kit"]["files_digest"],
            "publisher_signature_tested":False,"checks":["tag_free_image_import","config_digest_bound_restore","frozen_backup_kit",
                "independent_directory_port","restored_http_ready","copied_sessions_revoked","business_key_preserved","source_session_preserved"]}
        KIT.write_json(folder/"result.json",receipt); print(json.dumps(receipt,indent=2))
    finally:
        for install in reversed(installations): install.compose("down","--timeout","45",timeout=90)
        for path in (raw,normalized):
            if path.exists(): path.unlink()
        print("Synthetic portable recovery evidence: "+str(folder),file=sys.stderr)


if __name__=="__main__": main()
