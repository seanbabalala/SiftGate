"""Host-operator regression tests. All installations and Docker actions are synthetic."""
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import sys

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "deploy/customer"
sys.path.insert(0, str(SOURCE))
import siftgate as kit
import siftgate_operator as op

IMAGE = "sha256:" + "a" * 64
TARGET = "sha256:" + "b" * 64


class FakeInstall:
    def __init__(self, root):
        self.root = root
        self.meta = {"id": "c" * 32, "project": "siftgate-" + "c" * 12, "engine_id": "synthetic-engine", "image": IMAGE,
                     "engine_arch": "arm64", "port": 54321, "uid": os.getuid(), "gid": os.getgid()}
        self.current = {"Id": "synthetic-container", "Image": IMAGE, "State": {"Running": True, "StartedAt": "2026-10-08T00:00:00Z", "ExitCode": 0}}
        self.actions = []; self.fail = None
    def check_engine(self): self.actions.append("engine")
    def container(self): return self.current
    def check_disk(self):
        if self.fail == "disk": raise kit.OperatorError("synthetic private path and secret must never escape")
    def resolve_image(self, value, local=False): self.actions.append("inspect"); return value if value.startswith("sha256:") else TARGET
    def docker(self, *args, **kwargs):
        self.actions.append(("docker", args))
        if args[0] == "run" and self.fail == "candidate": raise RuntimeError("secret fixture")
        if args[0] == "stop": self.current["State"]["Running"] = False
        return ""
    def stop(self):
        self.actions.append("stop")
        if self.fail == "stop": raise RuntimeError("private fixture error")
        self.current["State"]["Running"] = False
    def snapshot(self, purpose):
        self.actions.append("snapshot")
        if self.fail == "snapshot": raise RuntimeError("synthetic WAL failure")
        target = self.root / "backups" / ("backup-" + "d" * 32)
        target.mkdir(); return target
    def save(self):
        self.actions.append("save")
        (self.root / "installation.json").write_text(json.dumps(self.meta))
    def compose(self, *args, **kwargs):
        self.actions.append("start")
        self.current.update(Id="synthetic-replacement", Image=self.meta["image"])
        self.current["State"]["Running"] = True
    def wait_ready(self):
        self.actions.append("ready")
        if self.fail == "ready": raise RuntimeError("secret fixture from provider")


class OperatorTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve(); os.chmod(self.root, 0o700)
        for section in ("kit", "config", "state", "data", "backups"):
            (self.root / section).mkdir(mode=0o700)
        for name in op.PRIVATE_FILES: shutil.copyfile(SOURCE / name, self.root / "kit" / name)
        for name in ("installation.json", "provider.env", "compose.env"):
            (self.root / name).write_text("{}")
        (self.root / "config/gateway.config.yaml").write_text("synthetic private configuration")
        (self.root / "data/gateway.db").write_bytes(b"synthetic business data")
        self.install = FakeInstall(self.root)
        self.clock = [1780000000.0]
        self.probe = patch.object(kit, "local_probe", return_value=True); self.probe.start()
        self.load = patch.object(kit.Install, "load", return_value=self.install); self.load.start()
        self.snapshot = patch.object(kit, "verified_snapshot", return_value={}); self.snapshot.start()
        self.operator = op.Operator.enroll(self.root, development=True, install=self.install, now=lambda: self.clock[0])
    def tearDown(self):
        self.snapshot.stop(); self.load.stop(); self.probe.stop(); self.temporary.cleanup()
    def plan(self, operation="backup", request="request-1"):
        return self.operator.plan(operation, request, TARGET if operation == "upgrade" else None)
    def approve(self, job):
        return self.operator.approve(job["id"], job["plan_digest"], self.clock[0], self.clock[0]+600, True, True)
    def run_job(self, job):
        self.approve(job); return self.operator.run_once()

    def test_enrollment_does_not_start_or_restart_gateway(self):
        self.assertNotIn("stop", self.install.actions); self.assertNotIn("start", self.install.actions)
        self.assertFalse(self.operator.snapshot()["executor"]["online"])
        self.assertEqual((self.root / "operator/jobs.sqlite").stat().st_mode & 0o777, 0o600)
        with self.assertRaises(op.OperatorFailure): op.Operator.enroll(self.root, install=self.install)

    def test_plan_is_read_only_idempotent_and_immutable(self):
        job = self.plan(); again = self.plan()
        self.assertEqual(job["id"], again["id"])
        self.assertNotIn("stop", self.install.actions); self.assertNotIn("snapshot", self.install.actions)
        self.assertEqual(job["plan_digest"], op.digest(job["plan"]))
        with self.assertRaises(op.OperatorFailure): self.operator.plan("upgrade", "request-1", TARGET)
        with self.assertRaises(op.OperatorFailure): self.operator.store.change(job["id"], ("planned",), plan={})

    def test_no_action_without_exact_host_approval(self):
        job = self.plan()
        self.assertIsNone(self.operator.run_once())
        with self.assertRaises(op.OperatorFailure): self.operator.approve(job["id"], "wrong", self.clock[0], self.clock[0]+600, True)
        with self.assertRaises(op.OperatorFailure): self.operator.approve(job["id"], job["plan_digest"], self.clock[0], self.clock[0]+600)
        self.assertNotIn("stop", self.install.actions)

    def test_reconciliation_seals_pending_plan_against_late_approval_and_execution(self):
        for approved in (False, True):
            job=self.plan(request="reconciliation-"+str(approved))
            if approved: self.approve(job)
            result=self.operator.reconcile_for_control(job["id"],job["plan_digest"])
            self.assertEqual(result["status"],"cancelled")
            with self.assertRaises(op.OperatorFailure): self.approve(job)
            self.assertIsNone(self.operator.run_once(job["id"]))
            self.assertEqual(self.operator.reconcile_for_control(job["id"],job["plan_digest"])["status"],"cancelled")
        self.assertNotIn("stop",self.install.actions)

    def test_reconciliation_requires_worker_lock_and_does_not_dismiss_mutation(self):
        job=self.plan(); self.approve(job)
        self.operator.store.change(job["id"],("queued",),status="running",stage="snapshot")
        with op.file_lock(self.operator.home/"worker.lock"):
            with self.assertRaisesRegex(op.OperatorFailure,"operator_busy"):
                self.operator.reconcile_for_control(job["id"],job["plan_digest"])
        result=self.operator.reconcile_for_control(job["id"],job["plan_digest"])
        self.assertEqual(result["status"],"needs_attention")
        self.assertEqual(result["error_code"],"operator_interrupted")
        self.assertNotIn("stop",self.install.actions)

    def test_reconciliation_with_changed_digest_cannot_cancel_plan(self):
        job=self.plan()
        with self.assertRaisesRegex(op.OperatorFailure,"reconciliation_plan_mismatch"):
            self.operator.reconcile_for_control(job["id"],"f"*64)
        self.assertEqual(self.operator.store.get(job["id"])["status"],"planned")

    def test_upgrade_requires_explicit_image_trust_and_compatibility_ack(self):
        job = self.plan("upgrade")
        self.assertFalse(any(isinstance(value, tuple) and value[1][0] == "run" for value in self.install.actions))
        with self.assertRaises(op.OperatorFailure): self.operator.approve(job["id"], job["plan_digest"], self.clock[0], self.clock[0]+600, True, False)

    def test_native_immutable_image_boundary(self):
        for image in ("image:latest", "image:tag", "https://attacker.invalid/image", "ghcr.io/other/project@sha256:"+"b"*64):
            with self.subTest(image=image), self.assertRaises(op.OperatorFailure): self.operator.plan("upgrade", "bad-image-key", image)
        self.operator.policy["development"] = False
        with self.assertRaises(op.OperatorFailure): self.operator.plan("upgrade", "local-dev-key", TARGET)

    def test_approval_expiration_clock_rollback_and_explicit_timezones(self):
        job = self.plan(); self.clock[0] += 901
        with self.assertRaises(op.OperatorFailure): self.approve(job)
        self.clock[0] -= 902
        with self.assertRaises(op.OperatorFailure): self.approve(job)
        with self.assertRaises(op.OperatorFailure): op.parse_time("2026-10-08T12:00:00")
        self.assertEqual(op.parse_time("2026-10-08T12:00:00+08:00"), op.parse_time("2026-10-08T04:00:00Z"))

    def test_active_job_is_not_hidden_by_newer_draft_plans(self):
        first = self.plan(request="first-active"); self.approve(first)
        for number in range(21): self.plan(request="new-draft-" + str(number))
        self.assertEqual(self.operator.snapshot()["jobs"][0]["id"], first["id"])
        self.assertEqual(len(self.operator.snapshot()["jobs"]), 20)

    def test_nested_parent_symlinks_are_never_followed(self):
        nested = self.root / "config/link"
        nested.symlink_to(self.root / "data", target_is_directory=True)
        with self.assertRaises(OSError): op.read_file(nested / "gateway.db")

    def test_window_is_start_window_and_does_not_run_early(self):
        job = self.plan()
        self.operator.approve(job["id"], job["plan_digest"], self.clock[0]+60, self.clock[0]+120, True)
        self.assertEqual(self.operator.run_once()["status"], "queued")
        self.clock[0] += 121
        self.assertEqual(self.operator.run_once()["error_code"], "start_window_expired")
        self.assertNotIn("stop", self.install.actions)

    def test_only_one_active_job_can_be_approved(self):
        a, b = self.plan(request="request-a"), self.plan(request="request-b")
        self.approve(a)
        with self.assertRaisesRegex(op.OperatorFailure, "another_operation_active"): self.approve(b)
        self.assertEqual(self.operator.store.get(b["id"])["status"], "planned")
        self.operator.cancel(a["id"]); self.approve(b)

    def test_changed_configuration_or_runtime_rejects_before_stop(self):
        for change in ("config", "runtime", "disk"):
            job = self.plan(request="change-"+change); self.approve(job)
            if change == "config": (self.root / "config/gateway.config.yaml").write_text("changed fixture")
            elif change == "runtime": self.install.current["State"]["StartedAt"] = "changed"
            else: self.install.fail = "disk"
            result = self.operator.run_once()
            self.assertEqual(result["status"], "rejected")
            self.assertNotIn("stop", self.install.actions)

    def test_backup_has_durable_stages_and_does_not_claim_restore_drill(self):
        result = self.run_job(self.plan())
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual([value for value in self.install.actions if isinstance(value,str) and value in ("stop","snapshot","start","ready")], ["stop","snapshot","start","ready"])
        self.assertEqual([e["stage"] for e in result["events"] if e["event"] == "entered"], ["candidate_check","maintenance","stopping","snapshot","starting","verifying"])
        self.assertTrue(result["checkpoint"]["checksums_verified"])
        self.assertFalse(result["checkpoint"]["restore_drill_verified"])
        self.assertFalse((self.root / "maintenance").exists())
        restored = op.Operator(self.root, now=lambda:self.clock[0], install=self.install)
        self.assertEqual(restored.store.get(result["id"])["status"], "succeeded")

    def test_candidate_check_is_networkless_readonly_and_before_stop(self):
        self.run_job(self.plan("upgrade"))
        args = next(value[1] for value in self.install.actions if isinstance(value,tuple) and value[1][0]=="run")
        self.assertIn("--read-only", args); self.assertIn("none", args); self.assertIn("--cap-drop", args)
        mounts = [args[i+1] for i,value in enumerate(args) if value=="--volume"]
        self.assertEqual(len(mounts), 4); self.assertTrue(all(value.endswith(":ro") for value in mounts))
        self.assertEqual(self.install.meta["image"], TARGET)
        self.assertNotIn("docker.sock", " ".join(mounts))

    def test_failed_candidate_check_never_enters_maintenance(self):
        self.install.fail="candidate"
        result=self.run_job(self.plan("upgrade"))
        self.assertEqual(result["status"],"rejected"); self.assertNotIn("stop",self.install.actions)
        self.assertFalse((self.root/"maintenance").exists())
        self.assertNotIn("secret fixture", json.dumps(op.public_job(result)))

    def test_failure_after_stop_keeps_marker_and_never_restores_old_data(self):
        self.install.fail="snapshot"
        result=self.run_job(self.plan("upgrade"))
        self.assertEqual(result["status"],"needs_attention")
        self.assertTrue(self.operator.maintenance_owned(result["id"]))
        self.assertNotIn("start",self.install.actions)
        self.assertEqual((self.root/"data/gateway.db").read_bytes(),b"synthetic business data")
        self.assertIsNone(self.operator.run_once())

    def test_failed_candidate_readiness_does_not_rollback_new_database(self):
        self.install.fail="ready"
        result=self.run_job(self.plan("upgrade"))
        self.assertEqual(result["status"],"needs_attention"); self.assertEqual(self.install.meta["image"],TARGET)
        self.assertEqual(sum(value=="start" for value in self.install.actions),1)
        self.assertTrue(self.operator.maintenance_owned(result["id"]))
        self.assertNotIn("secret fixture",json.dumps(op.public_job(result)))

    def test_crash_reconciliation_never_blindly_replays_side_effects(self):
        job=self.plan(); self.approve(job)
        self.operator.store.change(job["id"],("queued",),status="running",stage="stopping",event="entered")
        self.operator.create_maintenance(job["id"])
        self.operator.run_once()
        saved=self.operator.store.get(job["id"])
        self.assertEqual(saved["status"],"needs_attention"); self.assertEqual(saved["error_code"],"operator_interrupted")
        self.assertNotIn("stop",self.install.actions)
        with self.assertRaises(op.OperatorFailure): self.operator.cancel(job["id"])

    def test_private_policy_links_and_bundle_changes_fail_closed(self):
        job=self.plan()
        (self.root/"kit/compose.yaml").write_text("tampered")
        with self.assertRaises(op.OperatorFailure): self.approve(job)
        self.assertNotIn("stop",self.install.actions)

    def test_data_symlinks_are_rejected_before_maintenance(self):
        (self.root/"data/link").symlink_to(self.root/"provider.env")
        with self.assertRaises(op.OperatorFailure): self.plan()
        self.assertNotIn("stop",self.install.actions)

    def test_fifo_readers_and_locks_fail_without_waiting_for_a_peer(self):
        fifo = self.root / "unsafe-fifo"
        os.mkfifo(fifo, 0o600)
        for expression in ("op.read_file(path)", "op.private_database_file(path)",
                           "with op.file_lock(path):\n        raise AssertionError('FIFO accepted')"):
            code = ("import sys\nfrom pathlib import Path\nsys.path.insert(0, sys.argv[1])\n"
                    "import siftgate_operator as op\npath = Path(sys.argv[2])\ntry:\n    " + expression +
                    "\nexcept (OSError, op.OperatorFailure):\n    sys.exit(0)\nsys.exit(2)\n")
            with self.subTest(expression=expression):
                result = subprocess.run([sys.executable, "-c", code, str(SOURCE), str(fifo)],
                                        capture_output=True, timeout=3)
                self.assertEqual(result.returncode, 0, result.stderr.decode())

    def test_both_operator_and_legacy_cli_locks_are_respected(self):
        job=self.plan(); self.approve(job)
        with op.file_lock(self.root/"operator/worker.lock"):
            with self.assertRaises(op.OperatorFailure): self.operator.run_once()
        with op.file_lock(self.root/"operator.lock"):
            result=self.operator.run_once()
        self.assertEqual(result["status"],"rejected"); self.assertNotIn("stop",self.install.actions)

    def test_public_snapshot_is_allowlisted_and_separates_offline(self):
        self.plan("upgrade")
        value=json.dumps(self.operator.snapshot())
        for private in (str(self.root),"synthetic private configuration","inputs_digest","request_key"):
            self.assertNotIn(private,value)
        self.operator.store.heartbeat(); self.assertTrue(self.operator.snapshot()["executor"]["online"])
        self.clock[0]+=31; self.assertFalse(self.operator.snapshot()["executor"]["online"])

    def test_socket_is_read_only_and_survives_gateway_state_changes(self):
        stop=threading.Event()
        thread=threading.Thread(target=self.operator.serve,args=(stop,)); thread.start()
        address=self.operator.socket_path()
        try:
            deadline=time.monotonic()+3
            while not address.exists() and time.monotonic()<deadline: time.sleep(.01)
            def request(method, path):
                with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as client:
                    client.settimeout(3); client.connect(str(address)); client.sendall(f"{method} {path} HTTP/1.0\r\nHost: localhost\r\n\r\n".encode())
                    chunks=[]
                    while True:
                        chunk=client.recv(65536)
                        if not chunk: break
                        chunks.append(chunk)
                    return b"".join(chunks)
            self.assertEqual(address.stat().st_mode & 0o777,0o600)
            self.install.current["State"]["Running"]=False
            self.assertIn(b"200 OK",request("GET","/status"))
            self.assertIn(b"405",request("POST","/approve"))
            self.assertEqual(len(self.operator.store.jobs()),0)
        finally:
            stop.set(); thread.join(timeout=5)
        self.assertFalse(thread.is_alive())


if __name__=="__main__": unittest.main()
