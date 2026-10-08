"""Two-phase host review: real ledgers, synthetic clocks/transports, no gateway."""
import copy
import threading
import time
import unittest
from unittest.mock import patch

import test_operator as operations
import test_control_service as controls
import siftgate_operator as operator
import siftgate_control_service as service
import siftgate_control_store as store


class HostReviewTests(unittest.TestCase):
    def setUp(self):
        self.fixture=operations.OperatorTests(); self.fixture.setUp()
        self.op=self.fixture.operator; self.clock=self.fixture.clock
        self.job=self.fixture.plan()
        self.start=self.clock[0]+2*86400
        self.spec={"control_job_id":"job-"+"b"*32,"requester":"planner","approver":"approver",
                   "not_before":operator.timestamp(self.start),"not_after":operator.timestamp(self.start+600),"accept_downtime":True}
    def tearDown(self): self.fixture.tearDown()
    def record(self,spec=None): return self.op.record_control_review(self.job["id"],self.job["plan_digest"],spec or self.spec)
    def dispatch(self,identifier=None):
        return self.op.approve(self.job["id"],self.job["plan_digest"],self.start,self.start+600,True,
                               control_job_id=identifier or self.spec["control_job_id"])

    def test_review_is_persistent_but_not_executable_by_an_independent_daemon(self):
        recorded=self.record()
        self.assertEqual(recorded["status"],"planned"); self.assertIsNone(self.op.run_once())
        self.assertNotIn("stop",self.fixture.install.actions)
        # Fresh Operator process, two days later, well after the 15-minute
        # review deadline and >5 seconds after the window originally started.
        self.clock[0]=self.start+30
        self.op=operator.Operator(self.fixture.root,now=lambda:self.clock[0],install=self.fixture.install)
        self.assertEqual(self.record()["control_review"],recorded["control_review"])
        self.assertIsNone(self.op.run_once())
        self.dispatch(); result=self.op.run_once(self.job["id"])
        self.assertEqual(result["status"],"succeeded")

    def test_late_first_review_cannot_be_backdated_or_accepted(self):
        with self.assertRaisesRegex(operator.OperatorFailure,"invalid_control_review"):
            self.record({**self.spec,"recorded_at":operator.timestamp(self.clock[0])})
        self.clock[0]+=901
        with self.assertRaisesRegex(operator.OperatorFailure,"plan_expired"): self.record()
        with self.assertRaisesRegex(operator.OperatorFailure,"recorded_control_review_required"): self.dispatch()
        self.assertIsNone(self.op.run_once()); self.assertNotIn("stop",self.fixture.install.actions)

    def test_review_can_finish_after_window_opens_without_backdating(self):
        start=self.clock[0]+1
        spec={**self.spec,"not_before":operator.timestamp(start),"not_after":operator.timestamp(start+600)}
        self.clock[0]+=40
        recorded=self.record(spec)["control_review"]
        self.assertEqual(recorded["recorded_at"],operator.timestamp(self.clock[0]))
        self.assertGreater(operator.parse_time(recorded["recorded_at"])-start,5)
        self.assertIsNone(self.op.run_once())

    def test_review_cannot_change_authority_window_or_plan_after_recording(self):
        original=self.record()
        for spec in ({**self.spec,"control_job_id":"job-"+"f"*32},
                     {**self.spec,"not_after":operator.timestamp(self.start+900)}):
            with self.assertRaisesRegex(operator.OperatorFailure,"review_replay_conflict"): self.record(spec)
        with self.assertRaisesRegex(operator.OperatorFailure,"recorded_control_review_required"): self.dispatch("job-"+"f"*32)
        with self.assertRaisesRegex(operator.OperatorFailure,"control_dispatch_required"):
            self.op.approve(self.job["id"],self.job["plan_digest"],self.start,self.start+600,True)
        self.assertEqual(self.op.store.get(self.job["id"])["control_review"],original["control_review"])

    def test_runtime_and_configuration_are_rechecked_on_late_dispatch(self):
        self.record(); self.clock[0]=self.start+20
        (self.fixture.root/"config/gateway.config.yaml").write_text("changed during the two-day wait")
        with self.assertRaisesRegex(operator.OperatorFailure,"configuration_changed_after_plan"): self.dispatch()
        self.assertNotIn("stop",self.fixture.install.actions)

    def test_expired_window_clock_rollback_and_cancel_all_fail_closed(self):
        self.record(); self.clock[0]=self.start+601
        with self.assertRaisesRegex(operator.OperatorFailure,"recorded_review_expired"): self.dispatch()
        self.clock[0]=self.start-2*86400-1
        with self.assertRaisesRegex(operator.OperatorFailure,"recorded_review_expired"): self.dispatch()
        self.op.cancel(self.job["id"]); self.clock[0]=self.start
        with self.assertRaises(operator.OperatorFailure): self.dispatch()
        self.assertIsNone(self.op.run_once())


class ControlReviewTests(unittest.TestCase):
    def setUp(self):
        self.fixture=controls.ControlServiceTests(); self.fixture.setUp()
        self.service=self.fixture.service; self.store=self.fixture.store; self.agents=self.fixture.agents
        self.clock=self.fixture.fixture.clock
    def tearDown(self): self.fixture.tearDown()
    def proposal(self,count=1): return self.service.prepare("planner",self.fixture.body(count=count))["proposal"]
    def approve(self,job):
        return self.service.approve("approver",job["id"],{"plan_digest":job["plan_digest"],"not_before":service.iso(self.clock[0]+2*86400),
            "not_after":service.iso(self.clock[0]+2*86400+1800),"accept_downtime":True})
    def worker(self): return service.ControlWorker(self.service,poll_interval=.01,operation_timeout=3)

    def test_control_waits_for_all_host_receipts_without_early_agent_approval(self):
        job=self.proposal(3); pending=self.approve(job)
        self.assertEqual(pending["status"],"approval_pending"); self.assertIsNone(self.store.claim_next())
        self.assertIsNone(self.worker().run_once())
        queued=self.store.worker_job(job["id"])
        self.assertEqual(queued["status"],"queued"); self.assertEqual(len(queued["host_reviews"]),3)
        self.assertEqual(sum(command=="review_job" for _,command,_ in self.agents.calls),3)
        self.assertFalse(any(command in ("approve_job","execute_job") for _,command,_ in self.agents.calls))
        self.clock[0]+=2*86400+30
        result=self.worker().run_once(); self.assertEqual(result["status"],"awaiting_promotion")
        self.assertEqual(sum(command=="execute_job" for _,command,_ in self.agents.calls),1)
        self.clock[0]+=300
        self.store.promote("approver",job["id"],job["plan_digest"])
        result=self.worker().run_once(); self.assertEqual(result["status"],"awaiting_promotion")
        self.assertEqual(sum(command=="execute_job" for _,command,_ in self.agents.calls),2)

    def test_interruption_after_host_recording_resumes_without_backdating_or_execution(self):
        job=self.proposal(); self.approve(job)
        with patch.object(self.store,"record_host_review",side_effect=KeyboardInterrupt), self.assertRaises(KeyboardInterrupt):
            self.worker().deliver_host_reviews()
        original=copy.deepcopy(next(iter(self.agents.jobs.values()))["control_review"])
        self.assertEqual(self.store.worker_job(job["id"])["status"],"approval_pending")
        self.clock[0]+=901
        self.assertIsNone(self.worker().run_once())
        self.assertEqual(next(iter(self.agents.jobs.values()))["control_review"],original)
        self.assertEqual(self.store.worker_job(job["id"])["status"],"queued")
        self.assertFalse(any(command in ("approve_job","execute_job") for _,command,_ in self.agents.calls))

    def test_cancel_during_review_cannot_requeue_and_pause_requires_review_before_resume(self):
        job=self.proposal(); self.approve(job)
        self.store.request_stop("planner",job["id"])
        self.worker().deliver_host_reviews()
        self.assertEqual(sum(command=="review_job" for _,command,_ in self.agents.calls),0)
        result=self.store.promote("approver",job["id"],job["plan_digest"])
        self.assertEqual(result["status"],"approval_pending")
        original=self.store.record_host_review
        def cancel_then_record(*args):
            self.store.request_stop("planner",job["id"],cancel=True)
            return original(*args)
        with patch.object(self.store,"record_host_review",side_effect=cancel_then_record): self.worker().deliver_host_reviews()
        self.assertEqual(self.store.worker_job(job["id"])["status"],"cancelled")
        self.assertIsNone(self.store.claim_next())

    def test_revoked_role_stops_host_review_and_pending_approval_survives_restart(self):
        job=self.proposal(); self.approve(job)
        reopened=store.ControlStore(self.store.root,now=lambda:self.clock[0]); reopened.reconcile_interrupted()
        self.assertEqual(reopened.worker_job(job["id"])["status"],"approval_pending")
        reopened.set_user("owner","approver",["viewer"],True)
        self.worker().deliver_host_reviews()
        self.assertEqual(reopened.worker_job(job["id"])["status"],"rejected")
        self.assertFalse(any(command=="review_job" for _,command,_ in self.agents.calls))

    def test_review_delivery_is_not_blocked_by_another_hosts_long_running_operation(self):
        job=self.proposal()
        self.service.approve("approver",job["id"],{"plan_digest":job["plan_digest"],"not_before":service.iso(self.clock[0]),
            "not_after":service.iso(self.clock[0]+1800),"accept_downtime":True})
        self.agents.release.clear(); stop=threading.Event()
        thread=threading.Thread(target=self.worker().serve,args=(stop,)); thread.start()
        try:
            self.assertTrue(self.agents.started.wait(3))
            body=self.fixture.body(); body["request_id"]="second-host-review"
            body["targets"]=[{"site_id":self.fixture.fixture.sites[1][0]}]
            second=self.service.prepare("planner",body)["proposal"]; self.approve(second)
            deadline=time.monotonic()+3
            while time.monotonic()<deadline and self.store.worker_job(second["id"])["status"]!="queued": time.sleep(.02)
            self.assertEqual(self.store.worker_job(second["id"])["status"],"queued")
            self.assertEqual(self.store.worker_job(job["id"])["status"],"running")
            self.assertEqual(sum(command=="execute_job" for _,command,_ in self.agents.calls),1)
        finally:
            stop.set(); self.agents.release.set(); thread.join(5)
        self.assertFalse(thread.is_alive())


if __name__=="__main__": unittest.main()
