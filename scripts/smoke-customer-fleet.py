#!/usr/bin/env python3
"""Real SSH Fleet/offline upgrade acceptance on three new synthetic installations.

SSH endpoints have distinct pinned host keys but share this test host/engine;
this is not a hardware-failover claim. Only publisher verification is injected
for a NON-PUBLISHABLE local artifact fixture. RPC, offline file/layer checks,
image loading, plans, approvals, upgrades, failures and data checks are real.
Never accepts an existing installation directory or touches system SSH config.
"""
import argparse
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"deploy/customer"))
import siftgate as kit
import siftgate_operator as operator
import siftgate_release as release
import siftgate_tools as host_tools
from siftgate_releases import ReleaseCache
from siftgate_control_store import ControlStore,ControlError
from siftgate_control_service import ControlService,ControlWorker
from siftgate_transport import AgentClient,ssh_configuration,TransportError


def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path); value=importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value


smoke=load("customer_smoke",ROOT/"scripts/smoke-customer-install.py")
upgrade=load("upgrade_smoke",ROOT/"scripts/smoke-customer-upgrade.py")


class Endpoint:
    def __init__(self,folder,install,fixture,artifact,client_key):
        self.folder=folder; folder.mkdir(mode=0o700); self.install=install
        self.port=smoke.port(); assert self.port!=2099
        host=folder/"host"; subprocess.run(["ssh-keygen","-q","-t","ed25519","-N","","-f",str(host)],check=True,capture_output=True)
        authorized=folder/"authorized_keys"; authorized.write_bytes(client_key.with_suffix(".pub").read_bytes()); authorized.chmod(0o600)
        known=folder/"known_hosts"; known.write_text("[127.0.0.1]:"+str(self.port)+" "+host.with_suffix(".pub").read_text())
        wrapper=folder/"agent-fixture.py"
        # Outside the shipped kit. Select the current sealed kit exactly as a
        # stable Agent entrypoint does, and inject only the artifact verifier.
        wrapper.write_text('''import hashlib,io,json,os,sys
from pathlib import Path
sys.dont_write_bytecode=True
root=Path(INSTALL_ROOT)
metadata=json.loads((root/'installation.json').read_text())
active=root/metadata.get('host_tools',{}).get('directory','kit')
sys.path.insert(0,str(active))
import siftgate as kit
import siftgate_release as trust
import siftgate_agent as agent
assert kit.tool_directory(root,metadata)==active
expected=Path(ARTIFACT_ROOT)/'harness-manifest.json'
raw=expected.read_bytes()
assert hashlib.sha256(raw).hexdigest()==EXPECTED_DIGEST
manifest=trust.json_bytes(raw)
assert manifest['format']=='siftgate-local-upgrade-harness-NOT-A-RELEASE'
def fixture_verifier(manifest_path,bundle_path,**kwargs):
    assert trust.read_bytes(manifest_path,trust.MAX_MANIFEST)==raw
    assert trust.read_bytes(bundle_path,65536)==b'LOCAL TEST ONLY - NOT A PUBLISHER SIGNATURE\\n'
    if kwargs.get('trusted_root'):
        assert trust.sha256(kwargs['trusted_root'])==kwargs['trusted_root_sha256']
    return trust.VerifiedRelease(manifest,EXPECTED_DIGEST)
trust.verify_release=fixture_verifier
payload=sys.stdin.buffer.read(512*1024+1)
assert len(payload)<=512*1024
request=trust.json_bytes(payload)
with Path(AUDIT_FILE).open('a') as log:
    log.write(json.dumps({'command':str(request.get('command'))[:80],'request_id':str(request.get('request_id'))[:80]})+'\\n')
sys.stdin=io.TextIOWrapper(io.BytesIO(payload))
sys.argv=[str(active/'siftgate_agent.py'),'--directory',str(root),'rpc']
try: agent.main()
except Exception as error:
    code=str(error) if isinstance(error,(agent.op.OperatorFailure,trust.ReleaseError)) else 'fixture_agent_error'
    print(json.dumps({'format':agent.PROTOCOL,'ok':False,'error_code':code}));sys.exit(1)
'''.replace("INSTALL_ROOT",repr(str(install.root))).replace("ARTIFACT_ROOT",repr(str(artifact))).replace("EXPECTED_DIGEST",repr(fixture.digest)).replace("AUDIT_FILE",repr(str(folder/"rpc-audit.jsonl"))))
        user=pwd.getpwuid(os.getuid()).pw_name
        # Explicit PATH is fixture-owned; noninteractive macOS ssh sessions do
        # not necessarily inherit the Rancher Docker CLI location.
        command=" ".join(shlex.quote(value) for value in ("/usr/bin/env","PATH="+os.environ["PATH"],sys.executable,"-B",str(wrapper)))
        config=folder/"sshd_config"
        config.write_text(f"""Port {self.port}
ListenAddress 127.0.0.1
HostKey {host}
PidFile {folder}/sshd.pid
AuthorizedKeysFile {authorized}
AllowUsers {user}
PasswordAuthentication no
KbdInteractiveAuthentication no
AuthenticationMethods publickey
PubkeyAuthentication yes
UsePAM no
PermitRootLogin no
PermitUserRC no
PermitUserEnvironment no
DisableForwarding yes
StrictModes yes
ForceCommand {command}
""")
        self.log=(folder/"sshd.log").open("w")
        self.process=subprocess.Popen([shutil.which("sshd") or "/usr/sbin/sshd","-D","-e","-f",str(config)],stdout=self.log,stderr=self.log)
        self.configuration=ssh_configuration("127.0.0.1",user,str(install.root),str(kit.tool_directory(install.root,install.meta)/"siftgate_agent.py"),str(client_key),str(known),self.port,sys.executable)
        deadline=time.monotonic()+10
        while time.monotonic()<deadline:
            assert self.process.poll() is None,"Synthetic SSH daemon exited; inspect its private log"
            try:
                with socket.create_connection(("127.0.0.1",self.port),timeout=.2): break
            except OSError: time.sleep(.1)
        else: raise RuntimeError("Synthetic SSH endpoint did not listen")

    def close(self):
        if self.process.poll() is None: self.process.terminate(); self.process.wait(timeout=10)
        self.log.close()


def main():
    os.umask(0o077)
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-image",required=True); parser.add_argument("--image",required=True)
    parser.add_argument("--baseline-kit",type=Path,required=True); parser.add_argument("--output",type=Path)
    args=parser.parse_args(); output=args.output or ROOT/".local-dev"; output.mkdir(parents=True,exist_ok=True)
    baseline=json.loads((args.baseline_kit/"release.json").read_text()); assert baseline["image"]==args.source_image
    folder=Path(tempfile.mkdtemp(prefix="fleet-ssh-",dir=output)).resolve(); installations=[]; endpoints=[]; identities=[]
    artifact=folder/"artifacts"; artifact.mkdir(mode=0o700); package=folder/"offline"; package.mkdir(mode=0o700)
    def cli(directory,script,*arguments):
        value=subprocess.run([sys.executable,"-B",str(script),"--directory",str(directory),*arguments],capture_output=True,text=True)
        if value.returncode: raise RuntimeError("Synthetic fleet fixture command failed: "+value.stderr)
        return json.loads(value.stdout)
    current=ROOT/"deploy/customer/siftgate.py"
    try:
        for index in range(3):
            directory=folder/("gateway-"+str(index)); port=smoke.port(); assert port!=2099
            cli(directory,args.baseline_kit/"siftgate.py","init","--image",args.source_image,"--local-image","--timezone","Asia/Shanghai","--port",str(port))
            install=kit.Install.load(directory); installations.append(install)
            isolate="const fs=require('fs'),y=require('js-yaml'),p='/config/gateway.config.yaml',c=y.load(fs.readFileSync(p,'utf8'));c.nodes=c.nodes.map(n=>({...n,base_url:'http://127.0.0.1:1',api_key:'synthetic-no-vendor',health_check:{...n.health_check,enabled:false}}));fs.writeFileSync(p,y.dump(c,{lineWidth:110}));"
            install.compose("run","--rm","--no-deps","--entrypoint","node","siftgate","-e",isolate)
            cli(directory,current,"up")
            password=(directory/"config/initial-admin-password.txt").read_text().strip()
            token=smoke.request(install,"/api/auth/login",{"password":password})["token"]
            key=smoke.request(install,"/api/dashboard/api-keys",{"name":"fleet-synthetic-key","allow_auto":False,"allow_direct":True,
                "allowed_nodes":["openai"],"allowed_models":["gpt-4o-mini"],"daily_token_limit":100,"daily_cost_limit":1},token)
            identities.append((token,key["item"]["id"]))
            before=install.container()
            host_tools.bootstrap(install,confirmed=True); operator.Operator.enroll(directory)
            assert install.container()["State"]["StartedAt"]==before["State"]["StartedAt"]
        source=release.inspect_local_image(installations[0],installations[0].meta["image"],artifact)
        target=release.inspect_local_image(installations[0],args.image,artifact)
        target_version=json.loads((ROOT/"package.json").read_text())["version"]
        fixture=upgrade.harness_release(artifact,installations[0],source,target,baseline["version"].lstrip("v"),target_version)
        (package/"release.json").write_bytes((artifact/"harness-manifest.json").read_bytes())
        (package/"release.sigstore.jsonl").write_bytes(b"LOCAL TEST ONLY - NOT A PUBLISHER SIGNATURE\n")
        shutil.copyfile(artifact/"installer.tar.gz",package/"installer.tar.gz")
        raw=artifact/"export.tar"
        installations[0].docker("image","save","--output",str(raw),target["runtime_image_id"],timeout=1200)
        release.normalize_offline_image(fixture,raw,package/"image.tar",target["architecture"]); raw.unlink()
        kit.write_json(package/"offline.json",{"format":"siftgate-offline-v1","architecture":target["architecture"],"release_digest":fixture.digest})
        root=artifact/"out-of-band-test-root"; root.write_text("SEPARATELY PINNED SYNTHETIC TRUST FIXTURE\n")
        client_key=folder/"client"; subprocess.run(["ssh-keygen","-q","-t","ed25519","-N","","-f",str(client_key)],check=True,capture_output=True)
        home=folder/"control"; store=ControlStore.initialize(home,"planner",confirmed=True)
        store.activate("planner",(home/"activate-code.txt").read_text().strip(),"synthetic fleet planner password")
        invitation=store.invite("planner","approver",["approver"]); store.activate("approver",invitation["code"],"synthetic fleet approver password")
        service=ControlService(store); worker=ControlWorker(service,poll_interval=.2,operation_timeout=900); sites=[]; imported=[]
        for index,install in enumerate(installations):
            ReleaseCache(install.root/"operator/releases").pin_trusted_root(root,release.sha256(root),confirmed=True)
            staged=cli(install.root,ROOT/"deploy/customer/siftgate_agent.py","stage-offline","--source",str(package),"--confirm")["result"]
            endpoint=Endpoint(folder/("ssh-"+str(index)),install,fixture,artifact,client_key); endpoints.append(endpoint)
            site=service.enroll("SSH synthetic "+str(index),endpoint.configuration,"native-test",confirmed=True); sites.append(site)
            before=install.container()
            value=service.import_offline("planner",site,staged["package_id"]); imported.append(value)
            assert value["config_digest"]==target["config_digest"] and value["approved"] is False
            assert install.container()["Id"]==before["Id"] and install.container()["State"]["StartedAt"]==before["State"]["StartedAt"]
            (install.root/"operator/inbox"/staged["package_id"]/"image.tar").unlink()
            if index==0:
                # Exercise the shipped exporter too, not just harness image
                # construction. Crypto remains the same explicit fixture seam.
                def verified_fixture(manifest_path,bundle_path,**kwargs):
                    assert release.read_bytes(manifest_path,release.MAX_MANIFEST)==(artifact/"harness-manifest.json").read_bytes()
                    assert release.read_bytes(bundle_path,65536)==b"LOCAL TEST ONLY - NOT A PUBLISHER SIGNATURE\n"
                    return fixture
                with patch.object(release,"verify_release",side_effect=verified_fixture):
                    exported=ReleaseCache(install.root/"operator/releases").export_offline(fixture.digest,install,folder/"exported",local=True)
                assert exported["contains_trust_root"] is False and set(path.name for path in (folder/"exported").iterdir())=={
                    "release.json","release.sigstore.jsonl","installer.tar.gz","image.tar","offline.json"}
                assert release.verify_offline_image(fixture,folder/"exported/image.tar",target["architecture"])["config_digest"]==target["config_digest"]
        # Real key mismatch must fail in SSH before the fixed Agent is invoked.
        wrong=endpoints[0].folder/"wrong_known_hosts"
        wrong.write_text("[127.0.0.1]:"+str(endpoints[0].port)+" "+(endpoints[1].folder/"host.pub").read_text())
        bad=copy.deepcopy(endpoints[0].configuration); bad.update(known_hosts_file=str(wrong),host_keys_sha256=release.sha256(wrong))
        audit=endpoints[0].folder/"rpc-audit.jsonl"; before=audit.read_bytes()
        try: AgentClient(bad,installations[0].meta["id"]).observe(); raise AssertionError("Wrong SSH host key accepted")
        except TransportError: pass
        assert audit.read_bytes()==before
        def propose(request,operation,selected):
            result=service.prepare("planner",{"request_id":request,"operation":operation,
                "targets":[{"site_id":site,**({"release_digest":fixture.digest,"offline":True} if operation=="upgrade" else {})} for site in selected],
                "canary":1,"wave_size":1,"failure_threshold":1})
            assert result["proposal"],result["preflight"]; return result["proposal"]
        def approve(job):
            body={"plan_digest":job["plan_digest"],"not_before":operator.timestamp(),"not_after":operator.timestamp(time.time()+900),"accept_downtime":True}
            try: service.approve("planner",job["id"],body); raise AssertionError("Self approval accepted")
            except ControlError as error: assert error.status==403
            return service.approve("approver",job["id"],body)
        # A real post-review configuration change rejects target0 and stops the
        # rest; no fake target result is supplied to the worker.
        failure=propose("ssh-failure-threshold","backup",sites); approve(failure); worker.deliver_host_reviews()
        assert store.worker_job(failure["id"])["status"]=="queued"
        config=installations[0].root/"config/gateway.config.yaml"; config.write_bytes(config.read_bytes()+b"\n# synthetic post-review change\n")
        failed=worker.run_once(); assert failed["status"]=="paused" and failed["error_code"]=="failure_threshold_reached",failed
        assert len(failed["results"])==1 and failed["results"][0]["status"]=="rejected"
        store.request_stop("planner",failure["id"],cancel=True)
        job=propose("ssh-native-upgrade","upgrade",sites); approve(job)
        canary=worker.run_once(); assert canary["status"]=="awaiting_promotion",canary
        assert kit.Install.load(installations[0].root).meta["app_version"]==target_version
        for install in installations[1:]: assert install.container()["Image"]==source["runtime_image_id"]
        store.request_stop("planner",job["id"]); assert worker.run_once() is None
        assert store.worker_job(job["id"])["status"]=="paused"
        store.promote("approver",job["id"],job["plan_digest"])
        wave=worker.run_once(); assert wave["status"]=="awaiting_promotion",wave
        assert kit.Install.load(installations[1].root).meta["app_version"]==target_version
        store.request_stop("planner",job["id"],cancel=True); assert worker.run_once() is None
        assert installations[2].container()["Image"]==source["runtime_image_id"]
        remaining=propose("ssh-replanned-final","upgrade",sites[2:]); approve(remaining)
        last=worker.run_once(); assert last["status"]=="completed",last
        for index,install in enumerate(installations):
            current_install=kit.Install.load(install.root)
            assert current_install.meta["app_version"]==target_version
            token,key_id=identities[index]
            assert key_id in json.dumps(smoke.request(current_install,"/api/dashboard/api-keys",token=token))
            assert service.observe("planner",sites[index])["ready"]
        receipt={"format":"siftgate-fleet-smoke-v1","platform":"linux/"+target["architecture"],"target_config_digest":target["config_digest"],
            "source_config_digest":source["config_digest"],"source_version":baseline["version"].lstrip("v"),"target_version":target_version,
            "installations":3,"ssh_endpoints":3,"shared_physical_host_and_engine":True,"publisher_signature_tested":False,
            "jobs":[failure["id"],job["id"],remaining["id"]],"checks":["real_pinned_ssh_rpc","wrong_host_key_refused_before_agent",
                "offline_import_and_layer_verification","verified_local_image_export","import_does_not_deploy","independent_approver","actual_canary_upgrade",
                "manual_next_wave","pause_prevents_dispatch","cancel_preserves_remaining_source","failure_threshold_prevents_later_targets",
                "fresh_plan_for_remaining_target","existing_keys_and_sessions_preserved","final_http_observed"]}
        kit.write_json(folder/"result.json",receipt); print(json.dumps(receipt,indent=2))
    finally:
        for endpoint in reversed(endpoints): endpoint.close()
        for install in reversed(installations): kit.Install.load(install.root).compose("down","--timeout","45",timeout=90)
        for path in (package/"image.tar",artifact/"export.tar",folder/"exported/image.tar"):
            if path.exists(): path.unlink()
        print("Synthetic SSH Fleet evidence: "+str(folder),file=sys.stderr)


if __name__=="__main__": main()
