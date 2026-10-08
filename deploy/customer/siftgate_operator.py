#!/usr/bin/env python3
"""Opt-in host operator. Python 3.9+, local Docker. No writable network API."""
import argparse
import contextlib
import datetime as dt
import fcntl
import hashlib
import http.server
import json
import os
from pathlib import Path
import re
import signal
import socket
import socketserver
import sqlite3
import stat
import subprocess
import sys
import threading
import time
import uuid

import siftgate as kit

PROTOCOL = "siftgate-operator-v1"
PLAN_FORMAT = "siftgate-operator-plan-v1"
PUBLIC_FORMAT = "siftgate-operator-status-v1"
REGISTRY = "ghcr.io/seanbabalala/ai-gateway"
ACTIVE = ("queued", "running", "needs_attention")
TERMINAL = ("succeeded", "rejected", "cancelled", "resolved")
STAGES = ("planned", "queued", "preflight", "candidate_check", "maintenance", "stopping", "snapshot", "switching", "starting", "verifying", "complete", "interrupted")
PRIVATE_FILES = kit.KIT_FILES
IMAGE_ID = re.compile(r"sha256:[a-f0-9]{64}\Z")
JOB_ID = re.compile(r"op-[a-f0-9]{32}\Z")


class OperatorFailure(Exception):
    """Only fixed, non-secret codes cross CLI/socket/public-status boundaries."""


def require(value, code):
    if not value:
        raise OperatorFailure(code)


def timestamp(value=None):
    return dt.datetime.fromtimestamp(time.time() if value is None else value, dt.timezone.utc).isoformat()


def parse_time(value):
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        require(parsed.tzinfo is not None, "timezone_required")
        return parsed.timestamp()
    except (ValueError, AttributeError):
        raise OperatorFailure("invalid_time")


def control_review_spec(value):
    """A review binds authority and a window, but grants NO execution by itself."""
    require(type(value) is dict and set(value)=={"control_job_id","requester","approver","not_before","not_after","accept_downtime"}, "invalid_control_review")
    require(isinstance(value["control_job_id"],str) and re.fullmatch(r"job-[a-f0-9]{32}",value["control_job_id"]), "invalid_control_review")
    require(all(isinstance(value[key],str) and re.fullmatch(r"[a-z][a-z0-9._-]{2,63}",value[key]) for key in ("requester","approver")) and
            value["requester"]!=value["approver"] and type(value["accept_downtime"]) is bool, "invalid_control_review")
    start,end=parse_time(value["not_before"]),parse_time(value["not_after"])
    require(start<end and end-start<=3600, "invalid_start_window")
    return {**value,"not_before":timestamp(start),"not_after":timestamp(end)}


def fresh_control_review(spec, created_at, approve_before, now):
    require(parse_time(created_at)<=now<=parse_time(approve_before), "plan_expired")
    # A window can open while preflight/signature checks are running. Record
    # the real current approval time; never backdate it or reject merely because
    # the window began >5 seconds ago. Its end and original review TTL still bind.
    require(parse_time(spec["not_before"])<=now+7*86400 and now<=parse_time(spec["not_after"]), "invalid_start_window")
    return {**spec,"recorded_at":timestamp(now)}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def open_without_links(path):
    path = Path(path)
    require(path.is_absolute(), "absolute_path_required")
    parent = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for component in path.parts[1:-1]:
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            os.close(parent); parent = child
        return os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    finally:
        os.close(parent)


def read_file(path, limit=32 * 1024 * 1024, private=False):
    fd = open_without_links(path)
    try:
        value = os.fstat(fd)
        require(stat.S_ISREG(value.st_mode) and value.st_nlink == 1 and value.st_size <= limit, "unsafe_file")
        if private:
            require(value.st_uid == os.getuid() and value.st_mode & 0o077 == 0, "unsafe_private_file")
        with os.fdopen(fd, "rb", closefd=False) as stream:
            data = stream.read(limit + 1)
        require(len(data) <= limit, "file_too_large")
        return data
    finally:
        os.close(fd)


def directory(path, create=False):
    if create:
        path.mkdir(mode=0o700, parents=False, exist_ok=True)
    value = path.lstat()
    require(stat.S_ISDIR(value.st_mode) and value.st_uid == os.getuid() and value.st_mode & 0o077 == 0, "unsafe_private_directory")


@contextlib.contextmanager
def file_lock(path, blocking=False):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    try:
        value = os.fstat(fd)
        require(stat.S_ISREG(value.st_mode) and value.st_uid == os.getuid() and value.st_nlink == 1 and value.st_mode & 0o077 == 0, "unsafe_lock")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        except BlockingIOError:
            raise OperatorFailure("operator_busy")
        yield
    finally:
        os.close(fd)  # Kernel releases locks after exit/crash; no PID-based stale-lock deletion.


def private_database_file(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        value = os.fstat(fd)
        require(stat.S_ISREG(value.st_mode) and value.st_uid == os.getuid() and value.st_mode & 0o077 == 0 and value.st_nlink == 1 and value.st_size <= 64 * 1024 * 1024, "unsafe_private_database")
    finally:
        os.close(fd)


class Store:
    def __init__(self, root, now=time.time):
        self.root, self.now = root, now
        self.home = root / "operator"
        directory(self.home)
        self.db = self.home / "jobs.sqlite"
        if not self.db.exists():
            fd = os.open(self.db, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            os.close(fd)
        private_database_file(self.db)
        with self.connection() as conn:
            conn.executescript("""
              CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
                status TEXT NOT NULL, revision INTEGER NOT NULL, document TEXT NOT NULL
              );
              CREATE UNIQUE INDEX IF NOT EXISTS one_active_operation ON jobs((1))
                WHERE status IN ('queued','running','needs_attention');
              CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            """)

    @contextlib.contextmanager
    def connection(self):
        # State is never mounted into the gateway and is private to the installation owner.
        private_database_file(self.db)
        conn = sqlite3.connect(str(self.db), timeout=5, isolation_level=None)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=FULL")
            yield conn
        finally:
            conn.close()

    def create(self, request_key, request_hash, plan):
        require(re.fullmatch(r"[a-zA-Z0-9_-]{8,80}", request_key), "invalid_request_key")
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            existing = conn.execute("SELECT * FROM jobs WHERE request_key=?", (request_key,)).fetchone()
            if existing:
                require(existing["request_hash"] == request_hash, "idempotency_conflict")
                conn.commit()
                return json.loads(existing["document"])
            require(conn.execute("SELECT count(*) FROM jobs").fetchone()[0] < 10000, "history_limit")
            job = {"id": "op-" + uuid.uuid4().hex, "status": "planned", "stage": "planned", "revision": 1,
                   "plan": plan, "plan_digest": digest(plan), "created_at": timestamp(self.now()),
                   "updated_at": timestamp(self.now()), "approval": None, "checkpoint": None,
                   "error_code": None, "events": [{"stage": "planned", "at": timestamp(self.now()), "event": "created"}]}
            conn.execute("INSERT INTO jobs VALUES (?,?,?,?,?,?)", (job["id"], request_key, request_hash, job["status"], 1, canonical(job)))
            conn.commit()
            return job

    def existing(self, request_key, request_hash):
        with self.connection() as conn:
            row = conn.execute("SELECT * FROM jobs WHERE request_key=?", (request_key,)).fetchone()
            if not row:
                return None
            require(row["request_hash"] == request_hash, "idempotency_conflict")
            return json.loads(row["document"])

    def get(self, job_id):
        require(JOB_ID.fullmatch(job_id or ""), "invalid_job_id")
        with self.connection() as conn:
            row = conn.execute("SELECT document FROM jobs WHERE id=?", (job_id,)).fetchone()
        require(row is not None, "job_not_found")
        value = json.loads(row[0])
        require(value["plan_digest"] == digest(value["plan"]), "plan_integrity_error")
        return value

    def jobs(self, active=False):
        with self.connection() as conn:
            rows = conn.execute("SELECT document FROM jobs " + ("WHERE status IN ('queued','running','needs_attention') " if active else "") + "ORDER BY CASE WHEN status IN ('queued','running','needs_attention') THEN 0 ELSE 1 END, rowid DESC LIMIT 20").fetchall()
        return [json.loads(row[0]) for row in rows]

    def change(self, job_id, expected, stage=None, event=None, **values):
        with self.connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            require(row is not None and row["status"] in expected, "job_state_conflict")
            job = json.loads(row["document"])
            require(job["plan_digest"] == digest(job["plan"]), "plan_integrity_error")
            require(not ({"id", "plan", "plan_digest", "revision", "events"} & values.keys()), "immutable_plan")
            if stage:
                require(stage in STAGES, "invalid_stage")
                job["stage"] = stage
            job.update(values)
            job["revision"] += 1
            job["updated_at"] = timestamp(self.now())
            if event:
                require(len(job["events"]) < 128, "event_limit")
                job["events"].append({"stage": job["stage"], "at": timestamp(self.now()), "event": event})
            try:
                conn.execute("UPDATE jobs SET status=?,revision=?,document=? WHERE id=?", (job["status"], job["revision"], canonical(job), job_id))
                conn.commit()
            except sqlite3.IntegrityError:
                raise OperatorFailure("another_operation_active")
            return job

    def heartbeat(self):
        with self.connection() as conn:
            conn.execute("INSERT OR REPLACE INTO metadata VALUES ('worker',?)", (canonical({"pid": os.getpid(), "at": timestamp(self.now())}),))

    def worker(self):
        with self.connection() as conn:
            row = conn.execute("SELECT value FROM metadata WHERE key='worker'").fetchone()
        return json.loads(row[0]) if row else None

    def offline(self):
        with self.connection() as conn:
            conn.execute("DELETE FROM metadata WHERE key='worker'")


def inputs_fingerprint(install):
    files = {}
    total = 0
    for name in ("installation.json", "provider.env", "compose.env"):
        body = read_file(install.root / name)
        total += len(body); files[name] = hashlib.sha256(body).hexdigest()
    for section in ("config", "kit", "state"):
        parent = install.root / section
        require(parent.is_dir() and not parent.is_symlink(), "unsafe_inputs")
        for path in sorted(parent.rglob("*")):
            require(not path.is_symlink(), "unsafe_inputs")
            if path.is_dir():
                continue
            # Temporary credential writers must finish before approval/execution.
            require(not path.name.endswith((".lock", ".tmp")), "inputs_busy")
            body = read_file(path)
            total += len(body); require(total <= 64 * 1024 * 1024, "inputs_too_large")
            files[path.relative_to(install.root).as_posix()] = hashlib.sha256(body).hexdigest()
    # Business DB bytes are allowed to change until the graceful stop, but links/special files are not.
    for path in (install.root / "data").rglob("*"):
        value = path.lstat()
        require(stat.S_ISDIR(value.st_mode) or (stat.S_ISREG(value.st_mode) and value.st_nlink == 1), "unsafe_data_topology")
    return digest(files)


def bundle_fingerprint(install):
    home=kit.tool_directory(install.root,install.meta)
    return digest({name: hashlib.sha256(read_file(home / name)).hexdigest() for name in PRIVATE_FILES})


def public_job(job):
    plan = job["plan"]
    return {"id": job["id"], "operation": plan["operation"], "status": job["status"], "stage": job["stage"],
            "revision": job["revision"], "plan_digest": job["plan_digest"], "created_at": job["created_at"],
            "updated_at": job["updated_at"], "source_image": plan["source_image"],
            "target_image": plan["target"]["image_id"] if plan["target"] else None,
            "trust": plan["target"]["trust"] if plan["target"] else "installed_image",
            "control_job_id":job.get("control_review",{}).get("control_job_id"),
            "approval": job["approval"], "checkpoint": job["checkpoint"], "error_code": job["error_code"],
            "events": job["events"][-32:]}


class Operator:
    def __init__(self, root, now=time.time, install=None):
        self.install = install or kit.Install.load(root)
        self.root, self.now = self.install.root, now
        self.home = self.root / "operator"
        directory(self.home)
        self.policy = json.loads(read_file(self.home / "policy.json", private=True, limit=16384))
        require(self.policy.get("format") == PROTOCOL and type(self.policy.get("development")) is bool and
                re.fullmatch(r"[a-f0-9]{32}", self.policy.get("installation_id", "")) and
                re.fullmatch(r"[a-f0-9]{64}", self.policy.get("bundle_digest", "")) and
                isinstance(self.policy.get("engine_id"), str) and self.policy["engine_id"], "unsupported_operator")
        self.store = Store(self.root, now)
        self.check_identity()

    @classmethod
    def enroll(cls, root, development=False, install=None, now=time.time):
        install = install or kit.Install.load(root)
        require(not any(char in str(install.root) for char in ("\n", "\r", ":", ",")), "unsupported_installation_path")
        install.check_engine()
        directory(install.root)
        home = install.root / "operator"
        require(not home.exists(), "operator_already_initialized")
        # Require the matching copied bundle; never silently replace a customer's old host tools.
        tools=kit.tool_directory(install.root,install.meta)
        for name in PRIVATE_FILES:
            require(read_file(tools / name) == read_file(Path(__file__).resolve().parent / name), "matching_kit_required")
        directory(home, create=True)
        directory(home / "public", create=True)
        policy = {"format": PROTOCOL, "installation_id": install.meta["id"], "home": str(install.root),
                  "uid": os.getuid(), "gid": os.getgid(), "engine_id": install.meta["engine_id"],
                  "bundle_digest": bundle_fingerprint(install), "development": development,
                  "bootstrap_directory":tools.relative_to(install.root).as_posix(),
                  "bootstrap_files":{name:hashlib.sha256(read_file(tools/name)).hexdigest() for name in PRIVATE_FILES}}
        kit.write_json(home / "policy.json", policy)
        operator = cls(root, now, install)
        operator.publish()
        return operator

    def check_identity(self):
        require(self.policy["installation_id"] == self.install.meta["id"] and self.policy["home"] == str(self.root) and
                self.policy["uid"] == os.getuid() and self.policy["gid"] == os.getgid(), "installation_identity_changed")
        directory_name=self.policy.get("bootstrap_directory","kit")
        require(directory_name=="kit" or bool(re.fullmatch(r"host-kits/(?:boot|release)-[a-f0-9]{64}",directory_name)),"invalid_bootstrap_directory")
        files=self.policy.get("bootstrap_files")
        if files is None: files={name:hashlib.sha256(read_file(self.root/"kit"/name)).hexdigest() for name in PRIVATE_FILES}
        require(type(files) is dict and files and all(isinstance(name,str) and re.fullmatch(r"[a-zA-Z0-9_.-]{1,128}",name) and
                isinstance(value,str) and re.fullmatch(r"[a-f0-9]{64}",value) for name,value in files.items()),"invalid_bootstrap_files")
        require(digest(files)==self.policy["bundle_digest"] and all(hashlib.sha256(read_file(self.root/directory_name/name)).hexdigest()==value
                for name,value in files.items()),"host_bundle_changed")
        kit.tool_directory(self.root,self.install.meta)  # Verify the independently selected active bundle.

    def check_runtime(self):
        self.check_identity()
        self.install.check_engine()
        require(self.install.meta["engine_id"] == self.policy["engine_id"], "engine_changed")
        require(not self.install.docker("ps", "--filter", "label=siftgate.operator.installation=" + self.policy["installation_id"],
                                        "--filter", "label=siftgate.operator.purpose=check", "--quiet").strip(), "sandbox_cleanup_required")
        current = self.install.container()
        require(current and current["State"]["Running"] and not current["State"].get("Paused"), "running_installation_required")
        require(current["Image"] == self.install.meta["image"], "runtime_image_mismatch")
        require(kit.local_probe(self.install.meta["port"], "live") and kit.local_probe(self.install.meta["port"], "ready"), "runtime_not_ready")
        return current

    def plan(self, operation, request_key, image=None, _verified=None, _request_hash=None):
        require(operation in ("backup", "upgrade"), "unsupported_operation")
        require((operation == "upgrade") == bool(image), "target_image_required")
        require(operation!="upgrade" or _verified or self.policy["development"],"verified_release_required")
        request_hash = _request_hash or digest({"operation": operation, "image": image, "installation": self.policy["installation_id"]})
        existing = self.store.existing(request_key, request_hash)
        if existing:
            return existing
        with file_lock(self.root / "operator.lock"):
            current = self.check_runtime()
            require(not (self.root / "maintenance").exists(), "maintenance_active")
            self.install.check_disk()
            fingerprint = inputs_fingerprint(self.install)
            target = None
            if image:
                local = bool(IMAGE_ID.fullmatch(image))
                require((local and (self.policy["development"] or _verified)) or bool(re.fullmatch(re.escape(REGISTRY) + r"@sha256:[a-f0-9]{64}", image)), "immutable_allowed_image_required")
                image_id = self.install.resolve_image(image, local=local)  # Pull/inspect only. Do not execute candidate code before host approval.
                require(image_id != current["Image"], "already_installed")
                self.install.check_disk()
                target = {"reference": _verified["target_image_reference"] if _verified else image, "image_id": image_id,
                          "trust": "publisher_attested" if _verified else "local_development" if local else "digest_only_manual_publisher_review",
                          "compatibility": "signed_exact_source_config" if _verified else "current_kit_manual_review_required"}
            plan = {"format": PLAN_FORMAT, "installation_id": self.policy["installation_id"], "operation": operation,
                    "source_image": current["Image"], "source_container_id": current["Id"], "source_started_at": current["State"]["StartedAt"],
                    "engine_id": self.policy["engine_id"], "inputs_digest": fingerprint, "bundle_digest": bundle_fingerprint(self.install),
                    "target": target, "created_at": timestamp(self.now()), "approve_before": timestamp(self.now() + 900)}
            if _verified: plan["verified_release"]=_verified
            job = self.store.create(request_key, request_hash, plan)
        self.publish()
        return job

    def plan_verified(self, release_digest, request_key, offline=False):
        from siftgate_release import SHA, inspect_local_image
        from siftgate_releases import ReleaseCache
        from siftgate_tools import stage_release
        require(isinstance(release_digest,str) and SHA.fullmatch(release_digest) and type(offline) is bool,"invalid_release_digest")
        request_hash=digest({"operation":"verified_upgrade","release_digest":release_digest,"offline":offline,"installation":self.policy["installation_id"]})
        existing=self.store.existing(request_key,request_hash)
        if existing: return existing
        cache=ReleaseCache(self.home/"releases")
        verified,location=cache.get(release_digest,offline=offline)
        current=self.check_runtime()
        source=inspect_local_image(self.install,current["Image"],self.home)
        versions=[version for version,images in verified.manifest["compatibility"]["source_config_digests"].items()
                  if images.get("linux/"+source["architecture"])==source["config_digest"]]
        require(len(versions)==1,"source_image_not_tested")
        check=verified.compatibility(versions[0],source["architecture"],current_config_digest=source["config_digest"])
        require(check["compatible"],"release_incompatible")
        target=cache.prepare_image(release_digest,self.install,offline=offline)
        pointer=stage_release(self.install,verified,location/"installer.tar.gz")
        context={"digest":release_digest,"version":verified.manifest["version"],"source_version":versions[0],
                 "source_config_digest":source["config_digest"],"target_config_digest":target["config_digest"],
                 "target_image_reference":verified.manifest["platforms"]["linux/"+source["architecture"]]["image"],
                 "host_tools":pointer,"offline":offline}
        # The signed target is already pulled/loaded. Pin its engine-local immutable
        # handle rather than a tag; verification below binds it to the config digest.
        return self.plan("upgrade",request_key,target["runtime_image_id"],_verified=context,_request_hash=request_hash)

    def record_control_review(self, job_id, plan_digest, specification):
        spec=control_review_spec(specification)
        require(spec["accept_downtime"], "downtime_confirmation_required")
        with file_lock(self.root / "operator.lock"):
            job=self.store.get(job_id)
            require(job["status"]=="planned" and job["plan_digest"]==plan_digest, "review_plan_mismatch")
            old=job.get("control_review")
            if old:
                require({key:value for key,value in old.items() if key!="recorded_at"}==spec, "review_replay_conflict")
                return job
            fresh_control_review(spec,job["plan"]["created_at"],job["plan"]["approve_before"],self.now())
            self.recheck(job)
            review=fresh_control_review(spec,job["plan"]["created_at"],job["plan"]["approve_before"],self.now())
            # Keep status=planned: neither run_once nor a standalone daemon can
            # execute a reviewed canary/later-wave target before dispatch.
            job=self.store.change(job_id,("planned",),event="control_review_recorded",control_review=review)
        self.publish()
        return job

    def approve(self, job_id, plan_digest, not_before, not_after, accept_downtime=False, accept_image_risk=False, *, control_job_id=None):
        require(accept_downtime, "downtime_confirmation_required")
        job = self.store.get(job_id)
        require(job["status"] == "planned" and job["plan_digest"] == plan_digest, "approval_plan_mismatch")
        review=job.get("control_review")
        if control_job_id is not None:
            require(review and review["control_job_id"]==control_job_id and review["not_before"]==timestamp(not_before) and
                    review["not_after"]==timestamp(not_after) and review["accept_downtime"]==accept_downtime, "recorded_control_review_required")
            require(parse_time(job["plan"]["created_at"])<=parse_time(review["recorded_at"])<=parse_time(job["plan"]["approve_before"]) and
                    parse_time(review["recorded_at"])<=self.now()<=not_after, "recorded_review_expired")
        else:
            require(not review, "control_dispatch_required")
            require(parse_time(job["plan"]["created_at"]) <= self.now() <= parse_time(job["plan"]["approve_before"]), "plan_expired")
            require(self.now() - 5 <= not_before <= self.now() + 7 * 86400 and not_before < not_after and not_after - not_before <= 3600, "invalid_start_window")
        require(not job["plan"]["target"] or job["plan"].get("verified_release") or accept_image_risk, "image_trust_and_compatibility_confirmation_required")
        with file_lock(self.root / "operator.lock"):
            self.recheck(job)
            approval = {"uid": os.getuid(), "approved_at": timestamp(self.now()), "not_before": timestamp(not_before),
                        "not_after": timestamp(not_after), "accepted_downtime": True,
                        "accepted_manual_image_review": bool(accept_image_risk), "control_job_id":control_job_id}
            job = self.store.change(job_id, ("planned",), stage="queued", event="approved_by_control" if control_job_id else "approved_by_host_owner", status="queued", approval=approval)
        self.publish()
        return job

    def recheck(self, job):
        plan = job["plan"]
        require(plan["format"] == PLAN_FORMAT and plan["installation_id"] == self.policy["installation_id"], "plan_identity_mismatch")
        current = self.check_runtime()
        require(current["Id"] == plan["source_container_id"] and current["State"]["StartedAt"] == plan["source_started_at"] and current["Image"] == plan["source_image"], "runtime_changed_after_plan")
        require(not (self.root / "maintenance").exists(), "maintenance_active")
        require(inputs_fingerprint(self.install) == plan["inputs_digest"], "configuration_changed_after_plan")
        require(bundle_fingerprint(self.install)==plan["bundle_digest"],"host_bundle_changed")
        self.install.check_disk()
        if plan["target"]:
            require(self.install.resolve_image(plan["target"]["image_id"], local=True) == plan["target"]["image_id"], "target_image_changed")
        if plan.get("verified_release"):
            self.recheck_release(plan)

    def recheck_release(self, plan):
        from siftgate_releases import ReleaseCache
        from siftgate_release import inspect_local_image
        from siftgate_tools import stage_release, resolve
        bound=plan["verified_release"]
        cache=ReleaseCache(self.home/"releases")
        verified,location=cache.get(bound["digest"],offline=bound["offline"])
        require(verified.manifest["version"]==bound["version"],"release_identity_changed")
        source=inspect_local_image(self.install,plan["source_image"],self.home)
        target=inspect_local_image(self.install,plan["target"]["image_id"],self.home)
        require(source["config_digest"]==bound["source_config_digest"] and target["config_digest"]==bound["target_config_digest"],"image_config_changed")
        require(verified.compatibility(bound["source_version"],source["architecture"],current_config_digest=source["config_digest"])["compatible"],"release_incompatible")
        require(verified.manifest["platforms"]["linux/"+source["architecture"]]["config_digest"]==target["config_digest"],"target_config_not_attested")
        require(verified.manifest["platforms"]["linux/"+source["architecture"]]["image"]==plan["target"]["reference"],"target_reference_not_attested")
        require(stage_release(self.install,verified,location/"installer.tar.gz")==bound["host_tools"],"target_host_tools_changed")
        resolve(self.root,bound["host_tools"])

    def sandbox_check(self, image, tools=None):
        sandbox = "siftgate-check-" + uuid.uuid4().hex
        args = ["run", "--rm", "--name", sandbox, "--log-driver", "none", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
                "--label", "siftgate.operator.installation=" + self.policy["installation_id"], "--label", "siftgate.operator.purpose=check",
                "--memory", "512m", "--cpus", "1", "--pids-limit", "128",
                "--user", str(os.getuid()) + ":" + str(os.getgid()), "--tmpfs", "/tmp:rw,noexec,nosuid,size=16777216",
                "--env", "NODE_PATH=/app/node_modules", "--env", "GATEWAY_CONFIG_PATH=/config/gateway.config.yaml",
                "--env-file", str(self.root / "provider.env")]
        for source, target in (("config", "/config"), ("data", "/app/data"), ("state", "/app/.siftgate")):
            args += ["--volume", str(self.root / source) + ":" + target + ":ro"]
        args += ["--volume",str(tools or kit.tool_directory(self.root,self.install.meta))+":/opt/siftgate-kit:ro"]
        try:
            self.install.docker(*args, "--entrypoint", "node", image, "/opt/siftgate-kit/container-ops.cjs", "check", timeout=180, output_limit=256 * 1024)
        finally:
            try:
                self.install.docker("rm", "--force", sandbox, timeout=30)
            except Exception:
                pass  # --rm already removed a normal completed sandbox.
            require(not self.install.docker("ps", "--filter", "label=siftgate.operator.installation=" + self.policy["installation_id"],
                                            "--filter", "label=siftgate.operator.purpose=check", "--quiet").strip(), "sandbox_cleanup_required")

    def stage(self, job_id, stage):
        self.store.change(job_id, ("running",), stage=stage, event="entered")  # Durable intent before each external side effect.
        self.publish()

    def maintenance_owned(self, job_id):
        try:
            value = json.loads(read_file(self.root / "maintenance", limit=4096, private=True))
            return value == {"operator_job": job_id, "installation_id": self.policy["installation_id"]}
        except (OSError, ValueError, OperatorFailure):
            return False

    def create_maintenance(self, job_id):
        fd = os.open(self.root / "maintenance", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            os.write(fd, canonical({"operator_job": job_id, "installation_id": self.policy["installation_id"]}).encode())
            os.fsync(fd)
        finally:
            os.close(fd)
        directory_fd = os.open(self.root, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)

    def execute(self, job_id):
        job = self.store.get(job_id)
        approval = job["approval"]
        require(job["status"] == "queued" and approval and approval["accepted_downtime"], "job_not_approved")
        if self.now() < parse_time(approval["approved_at"]):
            return self.store.change(job_id, ("queued",), status="rejected", error_code="clock_moved_backwards", event="rejected")
        if self.now() < parse_time(approval["not_before"]):
            return job
        if self.now() > parse_time(approval["not_after"]):
            return self.store.change(job_id, ("queued",), status="rejected", error_code="start_window_expired", event="rejected")
        mutated = False
        try:
            with file_lock(self.root / "operator.lock"):
                # Reload saved install metadata each execution, not a stale in-memory image.
                self.install = kit.Install.load(self.root)
                self.store.change(job_id, ("queued",), stage="preflight", status="running", event="started")
                self.publish()
                self.recheck(job)
                self.stage(job_id, "candidate_check")
                target = job["plan"]["target"]
                bound=job["plan"].get("verified_release")
                target_tools=None
                if bound:
                    from siftgate_tools import resolve
                    target_tools=resolve(self.root,bound["host_tools"])
                self.sandbox_check(target["image_id"] if target else job["plan"]["source_image"],tools=target_tools)
                self.recheck(job)
                require(self.now() <= parse_time(approval["not_after"]), "start_window_expired")
                self.stage(job_id, "maintenance")
                mutated = True  # A crash after marker creation may not have reached the next journal write.
                self.create_maintenance(job_id)
                self.stage(job_id, "stopping")
                self.install.stop()
                require(inputs_fingerprint(self.install) == job["plan"]["inputs_digest"], "configuration_changed_during_drain")
                self.stage(job_id, "snapshot")
                checkpoint = self.install.snapshot("upgrade" if target else "routine")
                kit.verified_snapshot(checkpoint)
                self.store.change(job_id, ("running",), checkpoint={"id": checkpoint.name, "checksums_verified": True, "restore_drill_verified": False}, event="snapshot_verified")
                if target:
                    self.stage(job_id, "switching")
                    self.install.meta.update(previous_image=job["plan"]["source_image"], image=target["image_id"],
                                             image_source=target["reference"], upgrade_backup=str(checkpoint))
                    if bound:
                        self.install.meta.update(host_tools=bound["host_tools"],release_digest=bound["digest"],app_version=bound["version"],kit_protocol=2)
                    self.install.save()
                self.stage(job_id, "starting")
                self.install.check_engine()
                require(self.install.meta["engine_id"] == self.policy["engine_id"], "engine_changed")
                self.install.compose("up", "-d", "--no-build", "--pull", "never", "siftgate")
                self.stage(job_id, "verifying")
                self.install.wait_ready()
                self.check_runtime()
                require(self.maintenance_owned(job_id), "maintenance_ownership_changed")
                (self.root / "maintenance").unlink()
                job = self.store.change(job_id, ("running",), stage="complete", status="succeeded", event="completed")
        except Exception as failure:
            current = self.store.get(job_id)
            if current["status"] not in ("queued", "running"):
                raise
            from siftgate_release import ReleaseError
            code = str(failure) if isinstance(failure, (OperatorFailure,ReleaseError)) else "external_operation_failed"
            if mutated:
                # A candidate may have accepted writes. Stop only an observed owned
                # candidate, never restore an old DB or boot old code on a new schema.
                if current["stage"] in ("starting", "verifying"):
                    try:
                        owned = self.install.container()
                        expected = job["plan"]["target"]["image_id"] if job["plan"]["target"] else job["plan"]["source_image"]
                        if owned and owned["Image"] == expected and owned["State"]["Running"]:
                            self.install.docker("stop", "--time", "45", owned["Id"], timeout=90)
                    except Exception:
                        pass  # Status remains uncertain, not "candidate safely stopped".
                job = self.store.change(job_id, ("queued", "running"), status="needs_attention", error_code=code, event="manual_reconciliation_required")
            else:
                job = self.store.change(job_id, ("queued", "running"), status="rejected", error_code=code, event="rejected_before_maintenance")
        self.publish()
        return job

    def reconcile_interrupted(self):
        # Called only after acquiring the exclusive worker lock. Never replay an
        # uncertain operation just because a lease/PID timestamp is old.
        for job in self.store.jobs(active=True):
            if job["status"] == "running":
                self.store.change(job["id"], ("running",), stage="interrupted", status="needs_attention", error_code="operator_interrupted", event="manual_reconciliation_required")

    def cancel(self, job_id):
        result = self.store.change(job_id, ("planned", "queued"), status="cancelled", event="cancelled_before_execution")
        self.publish()
        return result

    def reconcile_for_control(self, job_id, plan_digest):
        # The worker lock proves no executor is still using this plan. A terminal
        # cancellation fences late approval/execute deliveries through their CAS.
        # Never repair a gateway or dismiss a post-mutation failure from an RPC.
        with file_lock(self.home / "worker.lock"):
            self.reconcile_interrupted()
            job = self.store.get(job_id)
            require(job["plan_digest"] == plan_digest, "reconciliation_plan_mismatch")
            if job["status"] in ("planned", "queued"):
                job = self.cancel(job_id)
            return job

    def resolve(self, job_id, confirm_reconciled=False):
        require(confirm_reconciled, "owner_reconciliation_confirmation_required")
        with file_lock(self.root / "operator.lock"):
            self.install = kit.Install.load(self.root)
            self.check_runtime()
            require(not (self.root / "maintenance").exists(), "maintenance_active")
            helpers = self.install.docker("ps", "--filter", "label=com.docker.compose.project=" + self.install.meta["project"], "--filter", "label=com.docker.compose.oneoff=True", "--quiet")
            require(not helpers.strip(), "helper_still_running")
            result = self.store.change(job_id, ("needs_attention",), status="resolved", event="host_owner_confirmed_reconciliation")
        self.publish()
        return result

    def snapshot(self):
        worker = self.store.worker()
        age = self.now() - parse_time(worker["at"]) if worker else None
        return {"format": PUBLIC_FORMAT, "generated_at": timestamp(self.now()), "installation_id": self.policy["installation_id"],
                "executor": {"online": age is not None and -5 <= age <= 30, "heartbeat_at": worker["at"] if worker else None},
                "approval_channel": "host_owner_or_independent_control", "image_verification": "attestation_for_managed_upgrades_manual_development_only",
                "jobs": [public_job(job) for job in self.store.jobs()]}

    def publish(self):
        directory(self.home / "public")
        with file_lock(self.home / "export.lock", blocking=True):
            kit.write_json(self.home / "public" / "status.json", self.snapshot())

    def heartbeat_loop(self, stop):
        while not stop.is_set():
            try:
                self.store.heartbeat(); self.publish()
            except Exception:
                stop.set()
            stop.wait(5)

    def run_once(self, job_id=None):
        with file_lock(self.home / "worker.lock"):
            self.reconcile_interrupted()
            self.store.heartbeat(); self.publish()
            stop = threading.Event()
            reporter = threading.Thread(target=self.heartbeat_loop, args=(stop,), daemon=True)
            reporter.start()
            try:
                for job in self.store.jobs(active=True):
                    if job["status"] == "queued" and (job_id is None or job["id"]==job_id):
                        return self.execute(job["id"])
                return None
            finally:
                stop.set(); reporter.join(timeout=6)
                self.store.offline(); self.publish()

    def bridge(self, enabled):
        with file_lock(self.root / "operator.lock"):
            self.install = kit.Install.load(self.root)
            self.check_identity()
            self.install.meta["operator_status"] = bool(enabled)
            self.install.save()
        return {"status_bridge_saved": bool(enabled), "restarted": False, "requires_approved_container_recreation": True}

    def socket_path(self):
        # Short enough for macOS sockaddr_un; no writable network service.
        base = Path("/tmp") / ("siftgate-op-" + str(os.getuid()))
        directory(base, create=True)
        return base / (self.policy["installation_id"] + ".sock")

    def serve(self, stop):
        with file_lock(self.home / "worker.lock"):
            self.reconcile_interrupted()
            address = self.socket_path()
            if address.exists() or address.is_symlink():
                value = address.lstat()
                require(stat.S_ISSOCK(value.st_mode) and value.st_uid == os.getuid(), "unsafe_socket_path")
                address.unlink()  # Exclusive worker lock proves this is not a live peer's socket.
            server = StatusServer(str(address), status_handler(self))
            os.chmod(address, 0o600)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            reporter = threading.Thread(target=self.heartbeat_loop, args=(stop,), daemon=True)
            reporter.start()
            try:
                while not stop.is_set():
                    for job in self.store.jobs(active=True):
                        if job["status"] == "queued" and self.now() >= parse_time(job["approval"]["not_before"]):
                            self.execute(job["id"])
                    stop.wait(1)
            finally:
                stop.set(); reporter.join(timeout=6)
                server.shutdown(); server.server_close(); thread.join(timeout=3)
                self.store.offline(); self.publish()
                if address.exists() and stat.S_ISSOCK(address.lstat().st_mode):
                    address.unlink()


class StatusServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    def get_request(self):
        client, address = super().get_request()
        client.settimeout(3)
        return client, address


def status_handler(operator):
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def respond(self, status, value):
            body = canonical(value).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers(); self.wfile.write(body)
        def do_GET(self):
            try:
                if self.path == "/status":
                    return self.respond(200, operator.snapshot())
                if re.fullmatch(r"/jobs/op-[a-f0-9]{32}", self.path):
                    return self.respond(200, public_job(operator.store.get(self.path.rsplit("/", 1)[1])))
                self.respond(404, {"error": "not_found"})
            except Exception:
                self.respond(503, {"error": "operator_status_unavailable"})
        def do_POST(self): self.respond(405, {"error": "read_only_channel"})
        do_PUT = do_POST
        do_DELETE = do_POST
        do_PATCH = do_POST
    return Handler


def main(argv=None):
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", required=True)
    sub = parser.add_subparsers(dest="command", required=True)
    init = sub.add_parser("init"); init.add_argument("--development", action="store_true"); init.add_argument("--confirm", action="store_true", required=True)
    plan = sub.add_parser("plan"); plan.add_argument("operation", choices=("backup", "upgrade")); plan.add_argument("--request-id", required=True)
    target = plan.add_mutually_exclusive_group(); target.add_argument("--image"); target.add_argument("--release-digest")
    plan.add_argument("--offline", action="store_true")
    approve = sub.add_parser("approve"); approve.add_argument("job_id"); approve.add_argument("--plan-digest", required=True)
    approve.add_argument("--accept-downtime", action="store_true", required=True)
    approve.add_argument("--accept-image-trust-and-current-kit-compatibility", action="store_true")
    approve.add_argument("--not-before"); approve.add_argument("--not-after")
    for name in ("cancel", "show"):
        sub.add_parser(name).add_argument("job_id")
    resolve = sub.add_parser("resolve"); resolve.add_argument("job_id"); resolve.add_argument("--confirm-reconciled", action="store_true", required=True)
    bridge = sub.add_parser("bridge"); bridge.add_argument("--confirm", action="store_true", required=True)
    mode = bridge.add_mutually_exclusive_group(required=True); mode.add_argument("--enable", action="store_true"); mode.add_argument("--disable", action="store_true")
    for name in ("status", "run-once", "serve", "socket-path"):
        sub.add_parser(name)
    args = parser.parse_args(argv)
    if args.command!="init" and argv is None:
        from siftgate_tools import delegate
        delegate(args.directory,"siftgate_operator.py",sys.argv[1:])
    if args.command == "init":
        operator = Operator.enroll(args.directory, args.development)
        result = {"initialized": True, "started": False, "approval_channel": "host_owner_or_independent_control"}
    else:
        operator = Operator(args.directory)
        if args.command == "plan":
            require(not args.offline or args.release_digest, "offline_requires_verified_release")
            require(not args.release_digest or args.operation == "upgrade", "release_requires_upgrade")
            require(not args.image or args.operation == "upgrade", "image_requires_upgrade")
            result = public_job(operator.plan_verified(args.release_digest, args.request_id, offline=args.offline)
                                if args.release_digest else operator.plan(args.operation, args.request_id, args.image))
        elif args.command == "approve":
            start = parse_time(args.not_before) if args.not_before else time.time()
            end = parse_time(args.not_after) if args.not_after else start + 1800
            result = public_job(operator.approve(args.job_id, args.plan_digest, start, end, args.accept_downtime,
                                                args.accept_image_trust_and_current_kit_compatibility))
        elif args.command == "cancel": result = public_job(operator.cancel(args.job_id))
        elif args.command == "resolve": result = public_job(operator.resolve(args.job_id, args.confirm_reconciled))
        elif args.command == "show": result = public_job(operator.store.get(args.job_id))
        elif args.command == "bridge": result = operator.bridge(args.enable)
        elif args.command == "status": result = operator.snapshot()
        elif args.command == "socket-path": result = {"socket": str(operator.socket_path()), "read_only": True}
        elif args.command == "run-once":
            job = operator.run_once(); result = public_job(job) if job else {"due_job": False}
        else:
            stop = threading.Event()
            for signal_number in (signal.SIGINT, signal.SIGTERM):
                signal.signal(signal_number, lambda *_: stop.set())
            operator.serve(stop); result = {"stopped": True}
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    try:
        main()
    except OperatorFailure as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr); sys.exit(1)
    except Exception:
        print(json.dumps({"error": "operator_operation_failed", "detail": "Inspect the private installation locally; no raw configuration or command output was published."}), file=sys.stderr); sys.exit(1)
