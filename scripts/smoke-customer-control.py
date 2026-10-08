#!/usr/bin/env python3
"""Native independent Control Room acceptance against a new synthetic gateway."""
import argparse
import datetime as dt
import http.client
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"deploy/customer"))
from siftgate_control import ControlServer
from siftgate_control_service import ControlService, ControlWorker
from siftgate_control_store import ControlStore
from siftgate_transport import local_configuration
spec=importlib.util.spec_from_file_location("customer_smoke",ROOT/"scripts/smoke-customer-install.py")
smoke=importlib.util.module_from_spec(spec); spec.loader.exec_module(smoke)
KIT=smoke.KIT


def main():
    parser=argparse.ArgumentParser(description=__doc__); parser.add_argument("--image",required=True); parser.add_argument("--output",type=Path)
    args=parser.parse_args(); output=args.output or ROOT/".local-dev"; output.mkdir(parents=True,exist_ok=True)
    folder=Path(tempfile.mkdtemp(prefix="control-smoke-",dir=output)).resolve(); directory=folder/"gateway"; home=folder/"control"
    install=None; server=None; thread=None
    def kit_cli(*arguments):
        result=subprocess.run([sys.executable,str(ROOT/"deploy/customer/siftgate.py"),"--directory",str(directory),*arguments],capture_output=True,text=True)
        if result.returncode: raise RuntimeError("Synthetic installer action failed: "+result.stderr)
        return json.loads(result.stdout)
    def api(method,path,body=None,session=None):
        connection=http.client.HTTPConnection("127.0.0.1",server.server_address[1],timeout=120)
        headers={"Origin":server.origin}
        if body is not None: headers["Content-Type"]="application/json"
        if session: headers.update(Authorization="Bearer "+session["token"],**{"X-SiftGate-CSRF":session["csrf"]})
        connection.request(method,path,json.dumps(body) if body is not None else None,headers)
        response=connection.getresponse(); value=json.loads(response.read()); status=response.status; connection.close()
        return status,value
    def start_control():
        nonlocal server,thread
        server=ControlServer(("127.0.0.1",0),ControlService(ControlStore(home)))
        assert server.server_address[1]!=2099
        server.start_worker(); thread=threading.Thread(target=server.serve_forever); thread.start()
    def stop_control():
        nonlocal server,thread
        if server:
            server.stop_event.set(); server.shutdown(); server.server_close()
            thread.join(5)
            if server.worker_thread: server.worker_thread.join(5)
            assert not thread.is_alive() and not server.worker_thread.is_alive()
            server=None; thread=None
    try:
        port=smoke.port(); assert port!=2099
        kit_cli("init","--image",args.image,"--local-image","--port",str(port),"--timezone","Asia/Shanghai")
        install=KIT.Install.load(directory); kit_cli("up")
        code=(directory/"config/activate-code.txt").read_text().strip()
        smoke.request(install,"/api/auth/identity/activate",{"code":code,"password":"synthetic gateway password"})
        gateway_token=smoke.request(install,"/api/auth/login",{"password":"synthetic gateway password"})["token"]
        subprocess.run([sys.executable,"-B",str(directory/"kit/siftgate_agent.py"),"--directory",str(directory),"enroll","--confirm"],check=True,capture_output=True,text=True)
        subprocess.run([sys.executable,"-B",str(directory/"kit/siftgate_operator.py"),"--directory",str(directory),"bridge","--enable","--confirm"],check=True,capture_output=True,text=True)
        store=ControlStore.initialize(home,"planner",confirmed=True)
        store.activate("planner",(home/"activate-code.txt").read_text().strip(),"synthetic planner password")
        invite=store.invite("planner","approver",["approver"])
        store.activate("approver",invite["code"],"synthetic approver password")
        service=ControlService(store)
        site=service.enroll("Synthetic local gateway",local_configuration(directory,directory/"kit/siftgate_agent.py"),confirmed=True)
        start_control()
        status,planner=api("POST","/api/login",{"username":"planner","password":"synthetic planner password"}); assert status==200
        status,approver=api("POST","/api/login",{"username":"approver","password":"synthetic approver password"}); assert status==200
        assert api("GET","/api/sites",session={"token":gateway_token,"csrf":"not-control"})[0]==401
        def proposal(request):
            status,value=api("POST","/api/proposals",{"request_id":request,"operation":"backup","targets":[{"site_id":site}],"canary":1,"wave_size":1,"failure_threshold":1},planner)
            if status!=201: raise RuntimeError("Synthetic control preflight failed: "+json.dumps(value))
            return value["proposal"]
        def approve(job,start):
            body={"plan_digest":job["plan_digest"],"not_before":start.isoformat(),"not_after":(start+dt.timedelta(minutes=3)).isoformat(),"accept_downtime":True}
            assert api("POST","/api/jobs/"+job["id"]+"/approve",body,planner)[0]==403
            status,value=api("POST","/api/jobs/"+job["id"]+"/approve",body,approver)
            if status!=200: raise RuntimeError("Synthetic approval failed: "+json.dumps(value))
        def wait_job(job,observe_down=False):
            deadline=time.monotonic()+180; saw_down=False
            while time.monotonic()<deadline:
                status,value=api("GET","/api/jobs/"+job["id"],session=planner); assert status==200
                if not KIT.local_probe(port,"live"):
                    saw_down=True; assert api("GET","/health")[1]["status"]=="alive"
                if value["status"] in ("completed","completed_with_failures","needs_attention","rejected","paused"):
                    if value["status"]!="completed": raise RuntimeError("Synthetic control operation failed: "+json.dumps(value))
                    if observe_down: assert saw_down
                    assert len(value["results"])==1
                    events=value["results"][0]["receipt"]["events"]
                    assert sum(event["event"]=="started" for event in events)==1
                    return value
                time.sleep(.1)
            raise RuntimeError("Synthetic control operation did not finish")
        first=proposal("control-native-first")
        approve(first,dt.datetime.now(dt.timezone.utc)+dt.timedelta(seconds=1))
        result=wait_job(first,observe_down=True)
        bridge=smoke.request(install,"/api/dashboard/operator/status",token=gateway_token)
        assert bridge["operator"] and bridge["operator"]["approval_channel"]=="host_owner_or_independent_control",bridge
        observed_job=next(item for item in bridge["operator"]["jobs"] if item["control_job_id"]==first["id"])
        assert any(event["event"]=="control_review_recorded" for event in observed_job["events"])
        # The HTTP request/connection is already closed; execution belongs to the
        # independent host worker, not to the page that submitted approval.
        second=proposal("control-native-restart")
        approve(second,dt.datetime.now(dt.timezone.utc)+dt.timedelta(seconds=10))
        deadline=time.monotonic()+6
        while time.monotonic()<deadline:
            status,scheduled=api("GET","/api/jobs/"+second["id"],session=planner)
            if scheduled["status"]=="queued": break
            time.sleep(.05)
        assert scheduled["status"]=="queued" and len(scheduled["host_reviews"])==1
        target=second["plan"]["targets"][0]
        observed=service.client(site).call("get_job",{"plan_id":target["agent_plan_id"]})
        assert observed["status"]=="planned" and observed["control_review"]["control_job_id"]==second["id"]
        assert not any(event["event"]=="started" for event in observed["events"])
        assert KIT.local_probe(port,"ready")
        stop_control(); start_control()
        restarted=wait_job(second)
        # Interrupt the CONTROL JOURNAL at a dispatch boundary, while using the
        # real host RPC/ledger. This is fault injection, not a simulated SIGKILL
        # of the whole machine or proof of crash safety for arbitrary hardware.
        reconciliation_results=[]
        for execute_remotely in (False,True):
            stop_control()
            service=ControlService(ControlStore(home)); store=service.store
            pending=service.prepare("planner",{"request_id":"control-native-reconcile-"+str(execute_remotely),"operation":"backup",
                "targets":[{"site_id":site}],"canary":1,"wave_size":1,"failure_threshold":1})["proposal"]
            start=time.time(); store.approve("approver",pending["id"],pending["plan_digest"],start,start+180,accept_downtime=True)
            ControlWorker(service).deliver_host_reviews()
            store.claim_next(); target=store.begin_target(pending["id"]); client=service.client(site)
            arguments={"plan_id":target["agent_plan_id"],"plan_digest":target["agent_plan_digest"],"control_job_id":pending["id"]}
            window={"not_before":dt.datetime.fromtimestamp(start,dt.timezone.utc).isoformat(),
                    "not_after":dt.datetime.fromtimestamp(start+180,dt.timezone.utc).isoformat(),"accept_downtime":True}
            client.call("approve_job",{**arguments,**window})
            if execute_remotely:
                actual=client.call("execute_job",arguments,timeout=180); assert actual["status"]=="succeeded"
            before=KIT.Install.load(directory).container()["Id"]
            start_control()
            deadline=time.monotonic()+5
            while time.monotonic()<deadline:
                status,current=api("GET","/api/jobs/"+pending["id"],session=planner)
                if current["status"]=="needs_attention": break
                time.sleep(.05)
            assert current["status"]=="needs_attention"
            payload={"plan_digest":current["plan_digest"],"revision":current["revision"],"cancel_pending":True}
            assert api("POST","/api/jobs/"+current["id"]+"/reconcile",payload,planner)[0]==403
            status,closed=api("POST","/api/jobs/"+current["id"]+"/reconcile",payload,approver)
            assert status==200 and closed["status"]==("completed" if execute_remotely else "resolved"),closed
            remote=client.call("get_job",{"plan_id":target["agent_plan_id"]})
            assert remote["status"]==("succeeded" if execute_remotely else "cancelled")
            assert sum(event["event"]=="started" for event in remote["events"])==int(execute_remotely)
            assert KIT.Install.load(directory).container()["Id"]==before
            reconciliation_results.append(closed["id"])
        assert smoke.request(install,"/api/dashboard/api-keys",token=gateway_token) is not None
        receipt={"format":"siftgate-control-smoke-v1","platform":"linux/"+install.meta["engine_arch"],"image_id":install.meta["image"],
                 "jobs":[result["id"],restarted["id"]],"checks":["separate_control_identity","gateway_token_refused","proposer_cannot_self_approve",
                 "host_agent_transport","control_http_during_gateway_stop","request_connection_independent","durable_queued_job_across_control_restart",
                 "single_agent_execution","gateway_session_preserved","reconciliation_cancels_remote_queued_plan",
                 "reconciliation_recovers_completed_receipt","reconciliation_never_reexecutes","host_review_before_maintenance",
                 "reviewed_agent_plan_not_executable","review_receipt_survives_control_restart","gateway_bridge_understands_control_reviews"],"reconciliation_jobs":reconciliation_results,
                 "fault_injection":"control dispatch journal boundary; real agent operations, no OS crash simulation"}
        KIT.write_json(folder/"result.json",receipt); print(json.dumps(receipt,indent=2))
    finally:
        stop_control()
        if install: install.compose("down","--timeout","45",timeout=90)
        print("Synthetic control evidence: "+str(folder),file=sys.stderr)


if __name__=="__main__": main()
