#!/usr/bin/env python3
"""Independent control service and sequential, approval-gated fleet waves."""
import concurrent.futures
import datetime as dt
import re
import threading
import time

import siftgate_operator as operator
from siftgate_control_store import ControlError, ControlStore, digest, require
from siftgate_transport import AgentClient, TransportError

AGENT_TERMINAL={"succeeded","rejected","failed","needs_attention","cancelled","resolved"}


def iso(value): return dt.datetime.fromtimestamp(value,dt.timezone.utc).isoformat()


class ControlService:
    def __init__(self, store, client_factory=AgentClient):
        self.store=store; self.client_factory=client_factory

    def client(self, site_id):
        site=self.store.site_private(site_id)
        return self.client_factory(site["config"],site["installation_id"])

    def enroll(self,name,configuration,group="default",*,confirmed=False):
        require(confirmed is True,"host_enrollment_confirmation_required")
        client=self.client_factory(configuration,None)
        observed=client.observe()
        require(observed["operator_enrolled"] and not observed["requires_host_bootstrap"],"agent_bootstrap_and_enrollment_required",409)
        return self.store.register_site(name,observed["installation_id"],configuration,group,confirmed=True)

    def observe(self,actor,site_id):
        self.store.authorize(actor,"viewer")
        return self.client(site_id).observe()

    def read_agent(self,actor,site_id,command,arguments=None):
        self.store.authorize(actor,"viewer")
        require(command in ("list_releases","list_offline_packages","vault_catalog","vault_records","get_job"),"unsupported_observation")
        return self.client(site_id).call(command,arguments,timeout=120)

    def discover(self,actor,site_id,current_version):
        self.store.authorize(actor,"viewer")
        return self.client(site_id).call("discover_releases",{"current_version":current_version},timeout=210)

    def fetch_release(self,actor,site_id,version):
        self.store.authorize(actor,"planner")
        return self.client(site_id).call("fetch_release",{"version":version},timeout=600)

    def inspect_release(self,actor,site_id,release_digest,offline):
        self.store.authorize(actor,"viewer")
        require(type(offline) is bool,"invalid_offline_mode")
        return self.client(site_id).call("inspect_release",{"release_digest":release_digest,"offline":offline},timeout=150)

    def import_offline(self,actor,site_id,package_id):
        self.store.authorize(actor,"planner")
        return self.client(site_id).call("import_offline",{"package_id":package_id},timeout=1800)

    def prepare(self,actor,body):
        self.store.authorize(actor,"planner")
        require(type(body) is dict and set(body)=={"request_id","operation","targets","canary","wave_size","failure_threshold"},"invalid_proposal_fields")
        require(body["operation"] in ("backup","upgrade","verify_restore") and type(body["targets"]) is list and 1<=len(body["targets"])<=100,"invalid_proposal")
        client_digest=digest(body)
        old=self.store.find_request(actor,body["request_id"])
        if old:
            require(old["plan"].get("client_digest")==client_digest,"idempotency_conflict",409)
            return {"proposal":old,"preflight":[],"replayed":True}
        identifiers=[]
        for target in body["targets"]:
            expected={"site_id"} | ({"release_digest","offline"} if body["operation"]=="upgrade" else {"backup_id","manifest_digest"} if body["operation"]=="verify_restore" else set())
            require(type(target) is dict and set(target)==expected,"invalid_proposal_target")
            require(isinstance(target["site_id"],str) and re.fullmatch(r"site-[a-f0-9]{32}",target["site_id"]),"invalid_site_id")
            identifiers.append(target["site_id"])
        require(len(identifiers)==len(set(identifiers)),"duplicate_target")
        def preflight(selection):
            site_id=selection["site_id"]
            try:
                client=self.client(site_id); observed=client.observe()
                require(observed["operator_enrolled"] and not observed["requires_host_bootstrap"],"agent_not_ready",409)
                key="ctl-"+digest({"actor":actor,"request":body["request_id"],"site":site_id,"operation":body["operation"]})[:60]
                arguments={key:value for key,value in selection.items() if key!="site_id"}
                command={"backup":"plan_backup","upgrade":"plan_upgrade","verify_restore":"plan_restore_verification"}[body["operation"]]
                job=client.call(command,arguments,request_id=key,timeout=1200)
                require(type(job) is dict and job.get("status")=="planned" and job.get("operation")==body["operation"],"agent_plan_not_available",409)
                summary={"downtime_required":body["operation"]!="verify_restore"}
                if body["operation"]=="upgrade":
                    require(job.get("publisher_verified") is True and job["release"]["digest"]==selection["release_digest"],"publisher_verification_required",409)
                    summary.update(source_version=job["release"]["source_version"],target_version=job["release"]["target_version"],
                                   source_image=job["source_image"],target_image=job["target_image"],release_digest=job["release"]["digest"],publisher_verified=True)
                elif body["operation"]=="backup": summary.update(source_version=observed["app_version"],source_image=job["source_image"])
                else: summary["backup_id"]=job["backup_id"]
                target={"site_id":site_id,"installation_id":observed["installation_id"],"operation":body["operation"],
                        "agent_plan_id":job["id"],"agent_plan_digest":job["plan_digest"],"summary":summary}
                if job.get("approve_before"): target["approve_before"]=operator.parse_time(job["approve_before"])
                return {"site_id":site_id,"passed":True,"target":target}
            except (ControlError,TransportError) as error:
                return {"site_id":site_id,"passed":False,"error_code":str(error)}
            except Exception:
                return {"site_id":site_id,"passed":False,"error_code":"agent_preflight_invalid"}
        with concurrent.futures.ThreadPoolExecutor(max_workers=min(4,len(body["targets"]))) as pool:
            results=list(pool.map(preflight,body["targets"]))
        if not all(item["passed"] for item in results): return {"proposal":None,"preflight":results,"replayed":False}
        proposal=self.store.propose(actor,body["request_id"],[item["target"] for item in results],canary=body["canary"],
                                   wave_size=body["wave_size"],failure_threshold=body["failure_threshold"],client_digest=client_digest)
        return {"proposal":proposal,"preflight":results,"replayed":False}

    def approve(self,actor,identifier,body):
        require(type(body) is dict and set(body)=={"plan_digest","not_before","not_after","accept_downtime"},"invalid_approval_fields")
        require(type(body["accept_downtime"]) is bool,"invalid_approval")
        start,end=operator.parse_time(body["not_before"]),operator.parse_time(body["not_after"])
        return self.store.approve(actor,identifier,body["plan_digest"],start,end,accept_downtime=body["accept_downtime"])

    def reconcile(self,actor,identifier,body):
        require(type(body) is dict and set(body)=={"plan_digest","revision","cancel_pending"} and
                body["cancel_pending"] is True,"reconciliation_confirmation_required")
        job=self.store.reconciliation_job(actor,identifier,body["plan_digest"],body["revision"])
        observations=[]; worker=ControlWorker(self)
        for index in self.store.uncertain_targets(job):
            target=job["plan"]["targets"][index]
            observation={"site_id":target["site_id"],"agent_plan_id":target["agent_plan_id"],"confirmed":False}
            try:
                site=self.store.site_private(target["site_id"])
                require(site["installation_id"]==target["installation_id"] and site["config_hash"]==target["transport_digest"],"site_changed",409)
                client=self.client(target["site_id"]); client.observe()
                result=worker.validate_job(target,client.call("reconcile_job",{
                    "plan_id":target["agent_plan_id"],"plan_digest":target["agent_plan_digest"],"cancel_pending":True},timeout=180))
                observation["status"]=result["status"]
                require(result["status"] in AGENT_TERMINAL-{"needs_attention"},"agent_host_reconciliation_required",409)
                if result["status"]=="succeeded": worker.verify_completed(client,target,result)
                elif target["operation"]=="verify_restore" and result["status"] in ("failed","resolved"):
                    require(result.get("cleanup_confirmed") is True,"drill_cleanup_unconfirmed",409)
                observation.update(confirmed=True,receipt=result)
            except (ControlError,TransportError) as error: observation["error_code"]=str(error)
            except Exception: observation["error_code"]="reconciliation_observation_unavailable"
            observations.append(observation)
        return self.store.record_reconciliation(actor,identifier,job["plan_digest"],job["revision"],observations)


class ControlWorker:
    def __init__(self, service, poll_interval=2, operation_timeout=2400):
        self.service=service; self.store=service.store; self.poll_interval=poll_interval; self.operation_timeout=operation_timeout

    def validate_job(self,target,result):
        require(type(result) is dict and result.get("id")==target["agent_plan_id"] and result.get("plan_digest")==target["agent_plan_digest"] and
                result.get("operation")==target["operation"],"agent_job_identity_changed",503)
        return result

    def deliver_host_reviews(self):
        try:
            with operator.file_lock(self.store.root/"review.lock"):
                self._deliver_host_reviews()
        except operator.OperatorFailure as error:
            if str(error)!="operator_busy": raise

    def _deliver_host_reviews(self):
        for pending in self.store.pending_reviews():
            try:
                for target in pending["plan"]["targets"]:
                    job=self.store.review_target(pending["id"],target["site_id"])
                    if target["site_id"] in job["host_reviews"]: continue
                    client=self.service.client(target["site_id"]); client.observe()
                    approval=job["approval"]
                    spec={"control_job_id":job["id"],"requester":job["plan"]["requester"],"approver":approval["actor"],
                          "not_before":iso(approval["not_before"]),"not_after":iso(approval["not_after"]),"accept_downtime":approval["accepted_downtime"]}
                    result=self.validate_job(target,client.call("review_job",{"plan_id":target["agent_plan_id"],
                        "plan_digest":target["agent_plan_digest"],"review":spec},timeout=600))
                    receipt=result.get("control_review")
                    require(result["status"]=="planned" and type(receipt) is dict and set(receipt)==set(spec)|{"recorded_at"} and
                            all(receipt[key]==value for key,value in operator.control_review_spec(spec).items()),"host_review_receipt_mismatch",503)
                    recorded=operator.parse_time(receipt["recorded_at"])
                    require(job["approval"]["at"]-5<=recorded<=job["plan"]["approve_before"]+5 and recorded<=self.store.now()+5,
                            "host_review_time_mismatch",503)
                    self.store.record_host_review(job["id"],target["site_id"],{"plan_id":target["agent_plan_id"],
                        "plan_digest":target["agent_plan_digest"],"review":receipt})
                self.store.finish_host_reviews(pending["id"])
            except (ControlError,TransportError,operator.OperatorFailure) as error:
                self.store.reject_host_review(pending["id"],str(error))
            except Exception:
                self.store.reject_host_review(pending["id"],"host_review_delivery_failed")

    def verify_completed(self,client,target,result):
        if target["operation"]=="verify_restore":
            require(result.get("restore_drill_verified") is True and result.get("cleanup_confirmed") is True and result.get("evidence",{}).get("isolated_http_ready") is True,"restore_evidence_missing",503)
        else:
            observation=client.observe()
            expected=result["target_image"] if target["operation"]=="upgrade" else result["source_image"]
            require(observation["runtime_image_id"]==expected and observation["ready"] and observation["live"],"final_runtime_mismatch",503)
            if target["operation"]=="upgrade":
                require(result.get("publisher_verified") is True and result["release"]["digest"]==target["summary"]["release_digest"],"release_receipt_mismatch",503)

    def target(self,job,target):
        client=self.service.client(target["site_id"])
        try: client.observe()  # Fresh authenticated instance/clock observation before approval.
        except Exception:
            return "rejected",{"error_code":"agent_pre_dispatch_unavailable","mutation_dispatched":False}
        approval=job["approval"]
        arguments={"plan_id":target["agent_plan_id"],"plan_digest":target["agent_plan_digest"],"control_job_id":job["id"]}
        if target["operation"]=="verify_restore":
            command="execute_restore_verification"
        else:
            command="execute_job"
            try:
                self.validate_job(target,client.call("approve_job",{**arguments,"not_before":iso(approval["not_before"]),
                    "not_after":iso(approval["not_after"]),"accept_downtime":approval["accepted_downtime"]},timeout=600))
            except Exception as error:
                try: current=self.validate_job(target,client.call("get_job",{"plan_id":target["agent_plan_id"]},timeout=30))
                except Exception: return "needs_attention",{"error_code":"approval_delivery_uncertain"}
                if current["status"]=="planned":
                    uncertain=not isinstance(error,TransportError) or error.uncertain
                    return ("needs_attention" if uncertain else "rejected"),{"error_code":"approval_delivery_uncertain" if uncertain else error.code}
                if current["status"] in AGENT_TERMINAL:
                    return ("failed" if current["status"]=="resolved" else current["status"]),current
        # The executor is not tied to an HTTP request or browser lifetime. A
        # failed observation never restarts a gateway or repeats an in-flight job.
        pool=concurrent.futures.ThreadPoolExecutor(max_workers=1)
        future=pool.submit(client.call,command,arguments,timeout=self.operation_timeout)
        deadline=time.monotonic()+self.operation_timeout+30
        next_queued_retry=time.monotonic()+3
        try:
            while time.monotonic()<deadline:
                try:
                    current=self.validate_job(target,client.call("get_job",{"plan_id":target["agent_plan_id"]},timeout=30))
                    self.store.observe_target(job["id"],current["stage"])
                    if current["status"] in AGENT_TERMINAL:
                        if current["status"]=="succeeded":
                            try: self.verify_completed(client,target,current)
                            except Exception: return "needs_attention",{"error_code":"final_evidence_not_confirmed","agent_receipt":current}
                        return ("failed" if current["status"]=="resolved" else current["status"]),current
                    if future.done() and current["status"]=="queued" and time.monotonic()>=next_queued_retry:
                        # Re-observed queued state plus the agent's OS lock/CAS
                        # permits delivery retry; a running operation is NEVER retried.
                        future=pool.submit(client.call,command,arguments,timeout=self.operation_timeout)
                        next_queued_retry=time.monotonic()+5
                    elif future.done() and current["status"]=="planned":
                        try: future.result()
                        except TransportError as error:
                            if not error.uncertain: return "rejected",{"error_code":error.code}
                        except Exception: pass
                        return "needs_attention",{"error_code":"execution_delivery_uncertain"}
                except Exception:
                    self.store.observe_target(job["id"],"observation_unavailable")
                time.sleep(self.poll_interval)
            return "needs_attention",{"error_code":"execution_observation_deadline","may_still_be_running":True}
        finally:
            # Do not kill an agent because observation timed out. Its own bounded
            # transport handle and durable per-installation ledger remain authoritative.
            pool.shutdown(wait=False)

    def run_once(self):
        self.deliver_host_reviews()
        job=self.store.claim_next()
        if not job: return None
        while True:
            current=self.store.worker_job(job["id"])
            if current["status"]!="running": return current
            try: target=self.store.begin_target(job["id"])
            except ControlError as error:
                current=self.store.worker_job(job["id"])
                if current["status"]!="running": return current
                return self.store.worker_reject_before_dispatch(job["id"],error.code)
            try: status,receipt=self.target(current,target)
            except Exception: status,receipt="needs_attention",{"error_code":"control_execution_uncertain"}
            job=self.store.finish_target(job["id"],status,receipt)
            if job["status"]!="running": return job

    def serve(self,stop):
        with operator.file_lock(self.store.root/"worker.lock"):
            self.store.reconcile_interrupted()
            # Review delivery must not sit behind a long migration on another
            # host: the review deadline is short while the maintenance may be days away.
            def reviews():
                try:
                    while not stop.is_set():
                        self.deliver_host_reviews(); stop.wait(1)
                except Exception: stop.set()
            reviewer=threading.Thread(target=reviews,daemon=True,name="siftgate-control-reviewer")
            reviewer.start()
            try:
                while not stop.is_set():
                    self.run_once()
                    stop.wait(1)
            finally:
                stop.set(); reviewer.join(timeout=2)
