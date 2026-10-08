"""Independent host identities and durable multi-installation approval state."""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[2]/"deploy/customer"))
import siftgate_control_store as control

PASSWORD="synthetic control passphrase"


class AuthTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.root=Path(self.temp.name).resolve()/"control"
        self.clock=[1791460800.0]
        self.store=control.ControlStore.initialize(self.root,"owner",confirmed=True,now=lambda:self.clock[0])
        self.code=(self.root/"activate-code.txt").read_text().strip()
    def tearDown(self): self.temp.cleanup()
    def activate_owner(self): self.store.activate("owner",self.code,PASSWORD)

    def test_explicit_initialization_single_use_activation_and_private_files(self):
        self.assertTrue(self.store.setup_required())
        self.assertEqual((self.root/"control.sqlite").stat().st_mode&0o777,0o600)
        self.assertEqual((self.root/"activate-code.txt").stat().st_mode&0o777,0o600)
        with self.assertRaises(control.ControlError): control.ControlStore.initialize(self.root,"owner",confirmed=True)
        self.activate_owner(); self.assertFalse(self.store.setup_required())
        self.assertFalse((self.root/"activate-code.txt").exists())
        with self.assertRaises(control.ControlError): self.store.activate("owner",self.code,PASSWORD)

    def test_no_shared_dashboard_jwt_or_plaintext_secret_in_database_or_audit(self):
        self.activate_owner(); login=self.store.login("owner",PASSWORD)
        self.assertEqual(self.store.session(login["token"])["user"]["name"],"owner")
        with self.assertRaises(control.ControlError): self.store.session("eyJhbGciOiJIUzI1NiJ9.dashboard.jwt")
        with self.store.connection() as connection:
            dump="\n".join(connection.iterdump())
        for secret in (PASSWORD,self.code,login["token"]): self.assertNotIn(secret,dump)
        events=self.store.audit("owner")
        self.assertNotIn(PASSWORD,json.dumps(events))
        self.store.logout(login["token"])
        with self.assertRaises(control.ControlError): self.store.session(login["token"])

    def test_password_change_and_host_recovery_revoke_control_sessions_only(self):
        self.activate_owner(); first=self.store.login("owner",PASSWORD)
        self.store.change_password("owner",PASSWORD,"replacement control password")
        with self.assertRaises(control.ControlError): self.store.session(first["token"])
        second=self.store.login("owner","replacement control password")
        code=self.store.host_recovery_code("owner",confirmed=True)
        self.store.activate("owner",code,"another recovery passphrase")
        with self.assertRaises(control.ControlError): self.store.session(second["token"])
        self.assertEqual(self.store.login("owner","another recovery passphrase")["user"]["name"],"owner")

    def test_expired_activation_and_clock_rollback_fail_closed(self):
        self.clock[0]+=901
        with self.assertRaises(control.ControlError): self.activate_owner()
        self.clock[0]-=902
        with self.assertRaises(control.ControlError): self.activate_owner()

    def test_login_attempt_limit_survives_store_reconstruction(self):
        self.activate_owner()
        for _ in range(5):
            with self.assertRaises(control.ControlError): self.store.login("owner","wrong synthetic passphrase")
        fresh=control.ControlStore(self.root,now=lambda:self.clock[0])
        with self.assertRaisesRegex(control.ControlError,"authentication_rate_limited"): fresh.login("owner",PASSWORD)
        self.clock[0]+=301
        token=fresh.login("owner",PASSWORD)["token"]
        self.clock[0]-=1000
        with self.assertRaises(control.ControlError): fresh.session(token)

    def test_activation_race_allows_one_identity_write(self):
        def activate():
            try: return self.store.activate("owner",self.code,PASSWORD)
            except control.ControlError as error: return error.code
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results=list(pool.map(lambda _:activate(),range(2)))
        self.assertEqual(sum(type(result) is dict for result in results),1)

    def test_unicode_passphrase_and_limits_are_not_truncated(self):
        password="网关的独立运维口令🔐"*2
        hashed=control.password_hash(password)
        self.assertTrue(control.verify_password(password,hashed))
        self.assertFalse(control.verify_password(password+"x",hashed))
        for value in ("short", "x"*129, None):
            with self.assertRaises(control.ControlError): control.password_hash(value)


class LedgerTests(unittest.TestCase):
    def setUp(self):
        # Crypto itself is exercised above. Keep large state-machine matrices fast
        # without weakening the implementation or adding a public bypass flag.
        def fixture_hash(password,salt=None):
            encoded=control.password_bytes(password); salt=salt or b"s"*16
            return {"algorithm":"pbkdf2-sha256-600000","salt":salt.hex(),"hash":hashlib.sha256(salt+encoded).hexdigest()}
        self.crypto=patch.object(control,"password_hash",side_effect=fixture_hash); self.crypto.start()
        self.temp=tempfile.TemporaryDirectory(); self.root=Path(self.temp.name).resolve()/"control"; self.clock=[1791460800.0]
        self.store=control.ControlStore.initialize(self.root,"owner",confirmed=True,now=lambda:self.clock[0])
        self.store.activate("owner",(self.root/"activate-code.txt").read_text().strip(),PASSWORD)
        for name,roles in (("planner",["planner"]),("approver",["approver"]),("viewer",["viewer"])):
            invite=self.store.invite("owner",name,roles); self.store.activate(name,invite["code"],PASSWORD)
        self.sites=[]
        for index in range(3):
            installation=str(index+1)*32
            site=self.store.register_site("Synthetic site "+str(index),installation,{"transport":"local","directory":"/synthetic/site-"+str(index)},confirmed=True)
            self.sites.append((site,installation))
    def tearDown(self): self.crypto.stop(); self.temp.cleanup()
    def targets(self, count=1):
        return [{"site_id":site,"installation_id":installation,"operation":"upgrade","agent_plan_id":"op-"+str(index+1)*32,
                 "agent_plan_digest":str(index+1)*64,"summary":{"source_version":"2.11.7","target_version":"2.12.0","downtime_required":True}}
                for index,(site,installation) in enumerate(self.sites[:count])]
    def propose(self,count=1,**kwargs): return self.store.propose("planner","request-"+str(count),self.targets(count),**kwargs)
    def approve(self,job):
        self.store.approve("approver",job["id"],job["plan_digest"],self.clock[0],self.clock[0]+1800,accept_downtime=True)
        # This fixture isolates the Control ledger. Real host-review validation
        # belongs to service/RPC/native tests, not these fabricated unit receipts.
        for target in job["plan"]["targets"]:
            self.store.record_host_review(job["id"],target["site_id"],{"plan_id":target["agent_plan_id"],"plan_digest":target["agent_plan_digest"],"review":{}})
        return self.store.finish_host_reviews(job["id"])
    def start_target(self,job):
        self.store.claim_next(); return self.store.begin_target(job["id"])

    def test_roles_are_independent_and_self_approval_is_refused(self):
        with self.assertRaises(control.ControlError): self.store.propose("viewer","viewer-request",self.targets())
        job=self.propose()
        with self.assertRaises(control.ControlError): self.store.approve("planner",job["id"],job["plan_digest"],self.clock[0],self.clock[0]+600,accept_downtime=True)
        owner_job=self.store.propose("owner","owner-request",self.targets())
        with self.assertRaisesRegex(control.ControlError,"independent_approver_required"):
            self.store.approve("owner",owner_job["id"],owner_job["plan_digest"],self.clock[0],self.clock[0]+600,accept_downtime=True)
        self.assertIsNone(self.store.claim_next())

    def test_idempotence_digest_downtime_and_resource_locks(self):
        job=self.propose(); self.assertEqual(job["id"],self.propose()["id"])
        with self.assertRaisesRegex(control.ControlError,"idempotency_conflict"): self.store.propose("planner","request-1",self.targets(2))
        with self.assertRaises(control.ControlError): self.store.approve("approver",job["id"],"0"*64,self.clock[0],self.clock[0]+600,accept_downtime=True)
        with self.assertRaisesRegex(control.ControlError,"downtime_confirmation_required"): self.store.approve("approver",job["id"],job["plan_digest"],self.clock[0],self.clock[0]+600)
        self.approve(job)
        other=self.store.propose("owner","other-request",self.targets())
        with self.assertRaisesRegex(control.ControlError,"installation_busy"): self.approve(other)

    def test_start_window_expiry_and_revocation_prevent_dispatch(self):
        job=self.propose(); self.approve(job)
        self.clock[0]+=1801; self.assertIsNone(self.store.claim_next())
        self.assertEqual(self.store.get_job("viewer",job["id"])["error_code"],"start_window_expired")
        job=self.store.propose("planner","different-request",self.targets()); self.approve(job)
        token=self.store.login("approver",PASSWORD)["token"]
        self.store.set_user("owner","approver",["viewer"],True)
        with self.assertRaises(control.ControlError): self.store.session(token)
        self.assertIsNone(self.store.claim_next())
        self.assertEqual(self.store.get_job("viewer",job["id"])["error_code"],"approval_authority_revoked")

    def test_canary_and_waves_require_distinct_manual_promotions(self):
        job=self.propose(3,canary=1,wave_size=1); self.approve(job); self.start_target(job)
        result=self.store.finish_target(job["id"],"succeeded",{"ready":True})
        self.assertEqual(result["status"],"awaiting_promotion"); self.assertIsNone(self.store.claim_next())
        with self.assertRaises(control.ControlError): self.store.promote("planner",job["id"],job["plan_digest"])
        for expected in ("awaiting_promotion","completed"):
            self.store.promote("approver",job["id"],job["plan_digest"])
            self.start_target(job); result=self.store.finish_target(job["id"],"succeeded",{"ready":True})
            self.assertEqual(result["status"],expected)
        self.assertEqual(len(result["results"]),3)

    def test_pause_or_cancel_waits_for_inflight_work_instead_of_killing_gateway(self):
        job=self.propose(3); self.approve(job); self.start_target(job)
        paused=self.store.request_stop("planner",job["id"])
        self.assertEqual(paused["status"],"running"); self.assertTrue(paused["pause_requested"])
        result=self.store.finish_target(job["id"],"succeeded",{})
        self.assertEqual(result["status"],"paused")
        self.store.promote("approver",job["id"],job["plan_digest"]); self.start_target(job)
        self.store.request_stop("planner",job["id"],cancel=True)
        result=self.store.finish_target(job["id"],"succeeded",{})
        self.assertEqual(result["status"],"cancelled"); self.assertEqual(len(result["results"]),2)

    def test_failure_threshold_stops_further_dispatch_and_does_not_greenwash(self):
        job=self.propose(3,canary=3,wave_size=1,failure_threshold=1); self.approve(job); self.start_target(job)
        result=self.store.finish_target(job["id"],"rejected",{"error_code":"preflight_failed"})
        self.assertEqual(result["status"],"paused"); self.assertEqual(result["error_code"],"failure_threshold_reached")
        with self.assertRaises(control.ControlError): self.store.begin_target(job["id"])
        with self.assertRaises(control.ControlError): self.store.promote("approver",job["id"],job["plan_digest"])
        self.assertEqual(len(result["results"]),1)

    def test_partial_failures_need_explicit_review_below_approved_threshold(self):
        job=self.propose(3,failure_threshold=2); self.approve(job); self.start_target(job)
        result=self.store.finish_target(job["id"],"failed",{})
        self.assertEqual(result["status"],"awaiting_promotion")
        with self.assertRaisesRegex(control.ControlError,"review_failed_targets_required"): self.store.promote("approver",job["id"],job["plan_digest"])
        self.store.promote("approver",job["id"],job["plan_digest"],acknowledge_failures=1)
        self.start_target(job); self.store.finish_target(job["id"],"succeeded",{})
        self.store.promote("approver",job["id"],job["plan_digest"],acknowledge_failures=1)
        self.start_target(job); result=self.store.finish_target(job["id"],"succeeded",{})
        self.assertEqual(result["status"],"completed_with_failures")

    def test_dispatch_intent_survives_restart_and_is_never_blindly_replayed(self):
        job=self.propose(); self.approve(job); self.start_target(job)
        fresh=control.ControlStore(self.root,now=lambda:self.clock[0]); fresh.reconcile_interrupted()
        saved=fresh.get_job("viewer",job["id"])
        self.assertEqual(saved["status"],"needs_attention"); self.assertIsNotNone(saved["inflight"])
        self.assertIsNone(fresh.claim_next())
        with self.assertRaises(control.ControlError): fresh.request_stop("approver",job["id"],cancel=True)

    def test_site_transport_and_summary_cannot_be_replaced_after_review(self):
        job=self.propose()
        with self.store.connection(transaction=True) as connection:
            connection.execute("UPDATE sites SET config_hash=? WHERE id=?",("f"*64,self.sites[0][0]))
        with self.assertRaisesRegex(control.ControlError,"site_changed"): self.approve(job)
        target=self.targets(); target[0]["summary"]={"password":"must-not-store"}
        with self.assertRaises(control.ControlError): self.store.propose("planner","private-request",target)

    def test_audit_chain_records_actions_without_private_transport_or_passwords(self):
        job=self.propose(); self.approve(job)
        events=list(reversed(self.store.audit("owner",limit=100)))
        previous="0"*64
        for event in events:
            self.assertEqual(event["previous"],previous)
            self.assertEqual(event["digest"],control.digest({"previous":previous,"event":event["event"]}))
            previous=event["digest"]
        self.assertNotIn(PASSWORD,json.dumps(events))
        self.assertNotIn("/synthetic/",json.dumps(self.store.sites("viewer")))
        with self.assertRaises(control.ControlError): self.store.audit("viewer")

    def test_last_admin_cannot_be_disabled_and_invites_do_not_grant_gateway_rights(self):
        with self.assertRaisesRegex(control.ControlError,"last_administrator_required"): self.store.set_user("owner","owner",["viewer"],False)
        with self.assertRaises(control.ControlError): self.store.invite("planner","extra",["admin"])
        self.assertEqual(self.store.authorize("planner","viewer")["roles"],["planner"])
        for reserved in control.RESERVED_USERS:
            with self.assertRaises(control.ControlError): self.store.invite("owner",reserved,["admin"])


if __name__=="__main__": unittest.main()
