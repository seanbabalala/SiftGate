#!/usr/bin/env python3
"""Real baseline->candidate image/kit upgrade on a fresh synthetic installation.

Before signing exists, ONLY ReleaseCache input is injected with an explicitly
non-publishable local harness manifest. Image/config checks, kit extraction,
preflight, journal, backups, switch, HTTP and data checks run for real. This never
constitutes publisher-signature acceptance and accepts no existing install path.
"""
import argparse
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import time
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"deploy/customer"))
import siftgate as kit
import siftgate_operator as operator
import siftgate_release as release
from siftgate_releases import ReleaseCache
import siftgate_tools as tools
import siftgate_vault as vault


def module(name,file):
    spec=importlib.util.spec_from_file_location(name,file); value=importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value


smoke=module("customer_smoke",ROOT/"scripts/smoke-customer-install.py")
packager=module("customer_packager",ROOT/"scripts/package-customer-release.py")


def harness_release(folder,install,source,target,source_version,target_version):
    payload={name:(ROOT/path).read_bytes() for path,name in packager.FILES.items()}
    # Deliberately a fixture identity, NOT a claim that dirty files are a Git commit.
    identity=hashlib.sha1(release.canonical({name:hashlib.sha256(data).hexdigest() for name,data in payload.items()})).hexdigest()
    reference=release.REGISTRY+"@"+target["runtime_image_id"]
    payload["release.json"]=release.canonical({"format":"siftgate-customer-release-v1","version":"v"+target_version,"commit":identity,"image":reference})
    archive=folder/"installer.tar.gz"
    with tarfile.open(archive,"w:gz") as tar:
        for name,data in sorted(payload.items()):
            item=tarfile.TarInfo("siftgate-v"+target_version+"/"+name); item.size=len(data); item.mode=0o600
            tar.addfile(item,io.BytesIO(data))
    manifest={"format":"siftgate-local-upgrade-harness-NOT-A-RELEASE","repository":release.REPOSITORY,
        "version":target_version,"tag":"v"+target_version,"source_commit":identity,"image":reference,
        "platforms":{"linux/"+target["architecture"]:{"image":reference,"config_digest":target["config_digest"]}},
        "installer":{"name":"siftgate-v"+target_version+"-install.tar.gz","sha256":release.sha256(archive),"bytes":archive.stat().st_size},
        "compatibility":{"source_versions":[source_version],"source_config_digests":{source_version:{"linux/"+source["architecture"]:source["config_digest"]}},
            "source_kit_protocols":[1,2],"target_kit_protocol":2,"operator_protocol":1,
            "database":{"type":"sqlite","migration":"startup_schema_sync","reversible":False},"downtime_required":True}}
    raw=release.canonical(manifest); (folder/"harness-manifest.json").write_bytes(raw)
    return release.VerifiedRelease(manifest,hashlib.sha256(raw).hexdigest())


def source_session(install, source_version):
    """Exercise the published installer's actual identity protocol, never fabricate login state."""
    status=smoke.request(install,"/api/auth/status")
    if release.version(source_version)>=(2,12,0):
        assert status.get("identity",{}).get("mode")=="managed" and status["identity"]["setupRequired"] is True
        assert not (install.root/"config/initial-admin-password.txt").exists()
        password="synthetic baseline activation password"
        code=(install.root/"config/activate-code.txt").read_text().strip()
        smoke.request(install,"/api/auth/identity/activate",{"code":code,"password":password})
        assert not (install.root/"config/activate-code.txt").exists()
        assert smoke.request(install,"/api/auth/status")["identity"]["setupRequired"] is False
        mode="managed"
    else:
        assert source_version=="2.11.7" and status.get("identity",{}).get("mode","legacy")=="legacy"
        password=(install.root/"config/initial-admin-password.txt").read_text().strip()
        mode="legacy"
    token=smoke.request(install,"/api/auth/login",{"password":password})["token"]
    assert token
    return password,token,mode


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-image",required=True); parser.add_argument("--image",required=True)
    parser.add_argument("--baseline-kit",type=Path,required=True); parser.add_argument("--output",type=Path)
    args=parser.parse_args(); output=args.output or ROOT/".local-dev"; output.mkdir(parents=True,exist_ok=True)
    baseline=json.loads((args.baseline_kit/"release.json").read_text()); assert baseline["image"]==args.source_image
    folder=Path(tempfile.mkdtemp(prefix="cross-version-",dir=output)).resolve(); directory=folder/"gateway"
    install=None; mock=None
    def cli(script,*arguments):
        result=subprocess.run([sys.executable,str(script),"--directory",str(directory),*arguments],capture_output=True,text=True)
        if result.returncode: raise RuntimeError("Synthetic upgrade fixture action failed: "+result.stderr)
        return json.loads(result.stdout)
    current=ROOT/"deploy/customer/siftgate.py"
    try:
        port=smoke.port(); assert port!=2099
        cli(args.baseline_kit/"siftgate.py","init","--image",args.source_image,"--local-image","--timezone","Asia/Shanghai","--port",str(port))
        install=kit.Install.load(directory)
        isolate="const fs=require('fs'),y=require('js-yaml'),p='/config/gateway.config.yaml',c=y.load(fs.readFileSync(p,'utf8'));c.nodes=c.nodes.map(n=>({...n,base_url:'http://127.0.0.1:1',api_key:'synthetic-no-vendor',health_check:{...n.health_check,enabled:false}}));fs.writeFileSync(p,y.dump(c,{lineWidth:110}));"
        install.compose("run","--rm","--no-deps","--entrypoint","node","siftgate","-e",isolate)
        cli(current,"up")
        def image_version(image):
            return install.docker("run","--rm","--network","none","--read-only","--cap-drop","ALL","--entrypoint","node",image,"-p","require('/app/package.json').version")
        source_version=image_version(install.meta["image"]); target_version=image_version(args.image)
        assert source_version==baseline["version"].lstrip("v") and release.version(source_version)<release.version(target_version)
        assert target_version==json.loads((ROOT/"package.json").read_text())["version"]
        password,token,identity_mode=source_session(install,source_version)
        mock=install.meta["project"]+"-upgrade-mock"
        handler="require('http').createServer((req,res)=>{req.resume();req.on('end',()=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'synthetic-upgrade',object:'chat.completion',model:'gpt-4o-mini',choices:[{index:0,message:{role:'assistant',content:'upgrade-ok'},finish_reason:'stop'}],usage:{prompt_tokens:3,completion_tokens:2,total_tokens:5}}))})}).listen(3099,'0.0.0.0')"
        install.docker("run","-d","--name",mock,"--network",install.meta["project"]+"_default","--entrypoint","node",install.meta["image"],"-e",handler)
        smoke.request(install,"/api/dashboard/nodes/openai",{"base_url":"http://"+mock+":3099","api_key":"synthetic-provider",**({"disabled":False} if identity_mode=="managed" else {})},token,"PUT")
        key=smoke.request(install,"/api/dashboard/api-keys",{"name":"upgrade-synthetic-key","allow_auto":False,"allow_direct":True,
            "allowed_nodes":["openai"],"allowed_models":["gpt-4o-mini"],"daily_token_limit":10000,"daily_cost_limit":1},token)
        body={"model":"openai/gpt-4o-mini","messages":[{"role":"user","content":"synthetic migration acceptance"}],"max_tokens":16}
        assert smoke.request(install,"/v1/chat/completions",body,key["key"])["usage"]["total_tokens"]==5
        config=(directory/"config/gateway.config.yaml").read_bytes(); before=install.container()
        tools.bootstrap(install,confirmed=True); old_tools=kit.tool_directory(install.root,install.meta)
        assert install.container()["State"]["StartedAt"]==before["State"]["StartedAt"]
        op=operator.Operator.enroll(directory)
        source=release.inspect_local_image(install,install.meta["image"],folder)
        target=release.inspect_local_image(install,args.image,folder)
        fixture=harness_release(folder,install,source,target,source_version,target_version)
        def cached(cache,digest,**kwargs):
            assert digest==fixture.digest; return fixture,folder
        def prepared(cache,digest,selected,**kwargs):
            assert digest==fixture.digest and selected.meta["id"]==install.meta["id"]; return target
        # Only artifact input is supplied by the local harness. Never patch
        # Docker, migration, HTTP, file hashing, preflight or completion checks.
        with patch.object(ReleaseCache,"get",cached),patch.object(ReleaseCache,"prepare_image",prepared):
            job=op.plan_verified(fixture.digest,"native-cross-version",offline=True)
            now=time.time(); op.approve(job["id"],job["plan_digest"],now,now+600,True)
            result=op.run_once(job["id"])
        assert result["status"]=="succeeded",result["error_code"]
        install=kit.Install.load(directory)
        assert install.meta["image"]==target["runtime_image_id"] and install.meta["app_version"]==target_version
        assert kit.tool_directory(directory,install.meta)!=old_tools and old_tools.exists()
        assert (directory/"config/gateway.config.yaml").read_bytes()==config
        notice=smoke.request(install,"/api/dashboard/release-updates",token=token)
        assert notice["current_version"]==target_version and notice["automatic_install"] is False and notice["publisher_verified"] is False
        before_db=vault.database_evidence(directory/"backups"/result["checkpoint"]["id"]/"data/gateway.db")
        # Snapshot the candidate to compare checkpointed databases, never pretend
        # immutable SQLite reads of a live WAL file are safe evidence.
        after_backup=cli(current,"backup","--accept-downtime")
        after_db=vault.database_evidence(Path(after_backup["backup"])/"data/gateway.db")
        assert before_db==after_db
        assert key["item"]["id"] in json.dumps(smoke.request(install,"/api/dashboard/api-keys",token=token))
        assert smoke.request(install,"/v1/chat/completions",body,key["key"])["choices"][0]["message"]["content"]=="upgrade-ok"
        receipt={"format":"siftgate-cross-version-smoke-v1","platform":"linux/"+target["architecture"],
            "source_version":source_version,"source_identity_mode":identity_mode,"target_version":target_version,"source_image":args.source_image,
            "source_config_digest":source["config_digest"],"target_config_digest":target["config_digest"],
            "target_runtime_id":target["runtime_image_id"],"job_id":job["id"],"publisher_signature_tested":False,
            "harness_manifest_not_publishable":True,"checks":["actual_cross_version_upgrade","actual_config_digest_compatibility",
                "paired_image_and_host_kit","old_kit_and_checkpoint_retained","business_database_unchanged","configuration_preserved",
                "existing_management_session_preserved","business_key_and_mock_traffic_preserved","release_notice_api_available","http_ready_after_upgrade"]}
        kit.write_json(folder/"result.json",receipt); print(json.dumps(receipt,indent=2))
    finally:
        if install:
            if mock: install.docker("rm","-f",mock)
            install.compose("down","--timeout","45",timeout=90)
        print("Synthetic cross-version evidence: "+str(folder),file=sys.stderr)


if __name__=="__main__": main()
