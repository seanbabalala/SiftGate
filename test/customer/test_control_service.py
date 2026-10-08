"""Control orchestration tests with deterministic simulated agent transports."""
import copy
import hashlib
import threading
import time
import unittest

import test_control_store as fixtures
import siftgate_control_service as service
import siftgate_control_store as control
from siftgate_transport import TransportError


class Agents:
    def __init__(self,store):
        self.store=store; self.jobs={}; self.calls=[]; self.release=threading.Event(); self.release.set()
        self.started=threading.Event(); self.unsafe=False; self.fail_site=None
        self.runtime={str(i+1)*32:"sha256:"+"a"*64 for i in range(3)}
    def client(self,configuration,installation_id):
        parent=self
        class Client:
            def observe(self):
                return {"protocol":"siftgate-agent-rpc-v1","installation_id":installation_id,"operator_enrolled":True,"requires_host_bootstrap":False,
                        "app_version":"2.11.7","runtime_image_id":parent.runtime[installation_id],"ready":True,"live":True}
            def call(self,command,arguments=None,request_id=None,timeout=180):
                arguments=arguments or {}; parent.calls.append((installation_id,command,copy.deepcopy(arguments)))
                if command in ("plan_backup","plan_upgrade","plan_restore_verification"):
                    if parent.fail_site==installation_id: raise TransportError("source_image_not_tested")
                    identity=("rv-" if command=="plan_restore_verification" else "op-")+hashlib.sha256((installation_id+request_id).encode()).hexdigest()[:32]
                    if identity not in parent.jobs:
                        operation={"plan_backup":"backup","plan_upgrade":"upgrade","plan_restore_verification":"verify_restore"}[command]
                        parent.jobs[identity]={"id":identity,"operation":operation,"plan_digest":"c"*64,"status":"planned","stage":"planned",
                            "source_image":parent.runtime[installation_id],"target_image":"sha256:"+"b"*64 if operation=="upgrade" else None,
                            "publisher_verified":not parent.unsafe,"release":{"digest":arguments.get("release_digest"),"source_version":"2.11.7","target_version":"2.12.0"}}
                    return copy.deepcopy(parent.jobs[identity])
                identity=arguments["plan_id"]; job=parent.jobs[identity]
                if command=="review_job":
                    if not job.get("control_review"):
                        job["control_review"]={**arguments["review"],"recorded_at":service.iso(parent.store.now())}
                    return copy.deepcopy(job)
                if command=="approve_job": job.update(status="queued",stage="queued"); return copy.deepcopy(job)
                if command=="get_job": return copy.deepcopy(job)
                if command=="reconcile_job":
                    if job["status"] in ("planned","queued"): job.update(status="cancelled",stage="cancelled")
                    return copy.deepcopy(job)
                if command=="execute_job":
                    job.update(status="running",stage="snapshot"); parent.started.set(); parent.release.wait(5)
                    if job["target_image"]: parent.runtime[installation_id]=job["target_image"]
                    job.update(status="succeeded",stage="complete"); return copy.deepcopy(job)
                raise AssertionError(command)
        return Client()


class ControlServiceTests(unittest.TestCase):
    def setUp(self):
        self.fixture=fixtures.LedgerTests(); self.fixture.setUp(); self.store=self.fixture.store
        self.agents=Agents(self.store); self.service=service.ControlService(self.store,self.agents.client)
    def tearDown(self): self.agents.release.set(); self.fixture.tearDown()
    def body(self,operation="backup",count=1):
        return {"request_id":"service-request-001","operation":operation,"targets":[{"site_id":site,
            **({"release_digest":"d"*64,"offline":True} if operation=="upgrade" else {})} for site,_ in self.fixture.sites[:count]],
            "canary":1,"wave_size":1,"failure_threshold":1}

    def test_preflight_is_all_or_nothing_and_replayed_request_does_not_contact_agents(self):
        body=self.body(count=2); self.agents.fail_site=self.fixture.sites[1][1]
        result=self.service.prepare("planner",body)
        self.assertIsNone(result["proposal"]); self.assertEqual(len(self.store.jobs("viewer")),0)
        self.agents.fail_site=None; result=self.service.prepare("planner",body)
        before=len(self.agents.calls); second=self.service.prepare("planner",body)
        self.assertEqual(result["proposal"]["id"],second["proposal"]["id"]); self.assertEqual(len(self.agents.calls),before)

    def test_unsigned_upgrade_is_not_a_control_proposal(self):
        self.agents.unsafe=True
        result=self.service.prepare("planner",self.body("upgrade"))
        self.assertIsNone(result["proposal"])
        self.assertEqual(result["preflight"][0]["error_code"],"publisher_verification_required")

    def test_worker_observes_actual_stage_and_continues_without_http_client(self):
        result=self.service.prepare("planner",self.body()); job=result["proposal"]
        self.fixture.approve(job); self.agents.release.clear()
        worker=service.ControlWorker(self.service,poll_interval=.01,operation_timeout=5)
        result_box=[]
        thread=threading.Thread(target=lambda:result_box.append(worker.run_once())); thread.start()
        try:
            self.assertTrue(self.agents.started.wait(2))
            deadline=time.monotonic()+2
            while time.monotonic()<deadline:
                observed=self.store.get_job("viewer",job["id"])
                if observed["inflight"] and observed["inflight"]["stage"]=="snapshot": break
                time.sleep(.01)
            self.assertEqual(observed["status"],"running"); self.assertEqual(observed["inflight"]["stage"],"snapshot")
            self.agents.release.set(); thread.join(3)
            self.assertFalse(thread.is_alive()); self.assertEqual(result_box[0]["status"],"completed")
            self.assertEqual(sum(command=="execute_job" for _,command,_ in self.agents.calls),1)
        finally: self.agents.release.set(); thread.join(3)

    def test_multi_site_canary_waits_for_promotion_then_advances_next_wave(self):
        job=self.service.prepare("planner",self.body("upgrade",3))["proposal"]
        self.fixture.approve(job); worker=service.ControlWorker(self.service,poll_interval=.01,operation_timeout=5)
        result=worker.run_once(); self.assertEqual(result["status"],"awaiting_promotion")
        self.assertEqual(sum(command=="execute_job" for _,command,_ in self.agents.calls),1)
        for expected in ("awaiting_promotion","completed"):
            self.store.promote("approver",job["id"],job["plan_digest"])
            result=worker.run_once(); self.assertEqual(result["status"],expected)
        self.assertEqual(sum(command=="execute_job" for _,command,_ in self.agents.calls),3)

    def interrupted(self,count=1,finished_uncertain=False):
        job=self.service.prepare("planner",self.body(count=count))["proposal"]
        self.fixture.approve(job); self.store.claim_next(); target=self.store.begin_target(job["id"])
        if finished_uncertain: self.store.finish_target(job["id"],"needs_attention",{"error_code":"delivery_uncertain"})
        else: self.store.reconcile_interrupted()
        return self.store.get_job("viewer",job["id"]),self.agents.jobs[target["agent_plan_id"]]

    def reconcile(self,job,actor="approver"):
        return self.service.reconcile(actor,job["id"],{"plan_digest":job["plan_digest"],"revision":job["revision"],"cancel_pending":True})

    def test_reconciliation_cancels_undispatched_plan_and_fences_remaining_wave(self):
        job,agent=self.interrupted(count=3)
        closed=self.reconcile(job)
        self.assertEqual(agent["status"],"cancelled"); self.assertEqual(closed["status"],"resolved")
        self.assertEqual(closed["reconciliation"]["unexecuted_targets"],2)
        self.assertFalse(any(command in ("execute_job","approve_job") for _,command,_ in self.agents.calls))
        self.assertIsNone(self.store.claim_next())
        with self.store.connection() as connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM active_resources").fetchone()[0],0)

    def test_finished_uncertain_receipt_is_replaced_only_with_verified_final_result(self):
        job,agent=self.interrupted(finished_uncertain=True); agent.update(status="succeeded",stage="complete")
        closed=self.reconcile(job)
        self.assertEqual(closed["status"],"completed"); self.assertEqual(len(closed["results"]),1)
        self.assertEqual(closed["results"][0]["status"],"succeeded")

    def test_running_or_host_attention_cannot_be_cleared_or_unlock_resource(self):
        job,agent=self.interrupted()
        for status in ("running","needs_attention"):
            agent["status"]=status; job=self.reconcile(job)
            self.assertEqual(job["status"],"needs_attention")
            self.assertFalse(job["reconciliation"]["confirmed"])
            with self.store.connection() as connection:
                self.assertEqual(connection.execute("SELECT count(*) FROM active_resources").fetchone()[0],1)
        agent.update(status="resolved",stage="interrupted")
        job=self.reconcile(job)
        self.assertEqual(job["status"],"resolved"); self.assertNotEqual(job["results"][0]["status"],"succeeded")

    def test_reconciliation_checks_roles_exact_revision_and_matching_runtime(self):
        job,agent=self.interrupted()
        for actor in ("planner","viewer"):
            with self.assertRaises(control.ControlError): self.reconcile(job,actor)
        # Even a combined-role proposer cannot reconcile their own dispatch.
        self.store.set_user("owner","planner",["planner","approver"],True)
        with self.assertRaisesRegex(control.ControlError,"independent_approver_required"): self.reconcile(job,"planner")
        agent.update(status="succeeded",stage="complete")
        self.agents.runtime[self.fixture.sites[0][1]]="sha256:"+"f"*64
        current=self.reconcile(job)
        self.assertEqual(current["status"],"needs_attention")
        self.assertEqual(current["reconciliation"]["observations"][0]["error_code"],"final_runtime_mismatch")
        calls=len(self.agents.calls)
        with self.assertRaisesRegex(control.ControlError,"reconciliation_state_changed"): self.reconcile(job)
        self.assertEqual(len(self.agents.calls),calls)

    def test_reconciliation_does_not_trust_wrong_plan_or_changed_site(self):
        job,agent=self.interrupted(); agent["plan_digest"]="f"*64
        current=self.reconcile(job)
        self.assertEqual(current["reconciliation"]["observations"][0]["error_code"],"agent_job_identity_changed")
        with self.store.connection(transaction=True) as connection:
            connection.execute("UPDATE sites SET config_hash=? WHERE id=?",("f"*64,self.fixture.sites[0][0]))
        calls=len(self.agents.calls); current=self.reconcile(current)
        self.assertFalse(current["reconciliation"]["confirmed"]); self.assertEqual(len(self.agents.calls),calls)

    def test_reconciliation_does_not_replay_after_interruption_between_targets(self):
        job=self.service.prepare("planner",self.body(count=3))["proposal"]
        self.fixture.approve(job); self.store.claim_next(); self.store.reconcile_interrupted()
        current=self.store.get_job("viewer",job["id"]); calls=len(self.agents.calls)
        closed=self.reconcile(current)
        self.assertEqual(closed["status"],"resolved"); self.assertEqual(len(self.agents.calls),calls)
        self.assertEqual(closed["reconciliation"]["unexecuted_targets"],3)


if __name__=="__main__": unittest.main()
