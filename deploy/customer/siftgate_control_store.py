#!/usr/bin/env python3
"""Independent control-plane identities, approvals and durable batch ledger.

This database is never mounted into the gateway. Dashboard credentials/roles are
not accepted here. Only the executor calls worker methods; HTTP clients cannot
set operation state or attest that an installation has been upgraded.
"""
import contextlib
import hashlib
import hmac
import json
import math
import os
from pathlib import Path
import re
import secrets
import sqlite3
import stat
import threading
import time
import uuid

import siftgate as kit
import siftgate_release as release
from siftgate_releases import private_directory

ROLES = {"viewer", "planner", "approver", "admin"}
RESERVED_USERS = {"executor", "host-owner", "host_owner", "system"}
USERNAME = re.compile(r"[a-z][a-z0-9._-]{2,63}\Z")
SITE_ID = re.compile(r"site-[a-f0-9]{32}\Z")
JOB_ID = re.compile(r"job-[a-f0-9]{32}\Z")
TOKEN = re.compile(r"sgc_[A-Za-z0-9_-]{43}\Z")
HASH_SLOTS = threading.BoundedSemaphore(2)
TERMINAL = {"completed", "completed_with_failures", "cancelled", "rejected", "resolved"}


class ControlError(Exception):
    def __init__(self, code, status=400):
        super().__init__(code)
        self.code, self.status = code, status


def require(value, code, status=400):
    if not value: raise ControlError(code, status)


def digest(value): return hashlib.sha256(release.canonical(value)).hexdigest()
def token_digest(value): return hashlib.sha256(value.encode()).hexdigest()


def password_bytes(value):
    require(isinstance(value, str) and 12 <= len(value) <= 128, "password_policy")
    encoded = value.encode("utf8")
    require(len(encoded) <= 512, "password_policy")
    return encoded


def password_hash(password, salt=None):
    encoded = password_bytes(password)
    require(HASH_SLOTS.acquire(blocking=False), "authentication_busy", 429)
    try:
        salt = salt or secrets.token_bytes(16)
        value = hashlib.pbkdf2_hmac("sha256", encoded, salt, 600000, dklen=32)
        return {"algorithm": "pbkdf2-sha256-600000", "salt": salt.hex(), "hash": value.hex()}
    finally: HASH_SLOTS.release()


def verify_password(password, stored):
    require(type(stored) is dict and stored.get("algorithm") == "pbkdf2-sha256-600000" and
            isinstance(stored.get("salt"), str) and re.fullmatch(r"[a-f0-9]{32}", stored["salt"]) and
            isinstance(stored.get("hash"), str) and re.fullmatch(r"[a-f0-9]{64}", stored["hash"]), "identity_unavailable", 503)
    try: calculated = password_hash(password, bytes.fromhex(stored["salt"]))
    except ControlError as error:
        if error.code == "password_policy": return False
        raise
    return hmac.compare_digest(calculated["hash"], stored["hash"])


def finite(value): return type(value) in (float, int) and math.isfinite(value)


class ControlStore:
    def __init__(self, root, now=time.time):
        self.root, self.now = private_directory(root), now
        self.db = self.root / "control.sqlite"
        with self.connection() as connection:
            metadata = connection.execute("SELECT value FROM metadata WHERE key='format'").fetchone()
            require(metadata and metadata[0] == "siftgate-control-v1", "control_not_initialized", 503)

    @classmethod
    def initialize(cls, root, owner, *, confirmed=False, now=time.time):
        require(confirmed is True, "host_initialization_confirmation_required")
        require(isinstance(owner, str) and USERNAME.fullmatch(owner) and owner not in RESERVED_USERS, "invalid_username")
        root = kit.safe_root(root)
        require(not root.exists(), "control_directory_exists", 409)
        root.mkdir(mode=0o700, parents=False)
        database = root / "control.sqlite"
        descriptor = os.open(database, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        os.close(descriptor)
        connection = sqlite3.connect(str(database))
        try:
            connection.executescript("""
              PRAGMA journal_mode=WAL;
              PRAGMA synchronous=FULL;
              CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
              INSERT INTO metadata VALUES ('format','siftgate-control-v1');
              CREATE TABLE users (name TEXT PRIMARY KEY, roles TEXT NOT NULL, enabled INTEGER NOT NULL,
                password TEXT, epoch INTEGER NOT NULL, created REAL NOT NULL,
                code_hash TEXT, code_issued REAL, code_expires REAL);
              CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, username TEXT NOT NULL, epoch INTEGER NOT NULL,
                csrf TEXT NOT NULL, created REAL NOT NULL, expires REAL NOT NULL);
              CREATE INDEX sessions_user ON sessions(username);
              CREATE TABLE auth_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, since REAL NOT NULL);
              CREATE TABLE sites (id TEXT PRIMARY KEY, installation_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
                group_name TEXT NOT NULL, enabled INTEGER NOT NULL, config TEXT NOT NULL, config_hash TEXT NOT NULL);
              CREATE TABLE jobs (id TEXT PRIMARY KEY, requester TEXT NOT NULL, request_key TEXT NOT NULL,
                request_hash TEXT NOT NULL, status TEXT NOT NULL, created REAL NOT NULL, document TEXT NOT NULL,
                UNIQUE(requester,request_key));
              CREATE TABLE active_resources (installation_id TEXT PRIMARY KEY, job_id TEXT NOT NULL);
              CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, previous TEXT NOT NULL,
                digest TEXT NOT NULL, document TEXT NOT NULL);
            """)
            code = "sg_control_" + secrets.token_urlsafe(32)
            connection.execute("INSERT INTO users VALUES (?,?,?,?,?,?,?,?,?)", (owner, json.dumps(sorted(ROLES)), 1, None, 1, now(),
                token_digest(code), now(), now()+900))
            connection.commit()
        finally: connection.close()
        with (root / "activate-code.txt").open("x") as file:
            os.chmod(file.name, 0o600); file.write(code + "\n"); file.flush(); os.fsync(file.fileno())
        release.sync_directory(root)
        return cls(root, now)

    @contextlib.contextmanager
    def connection(self, transaction=False):
        with release.regular_file(self.db, 256 * 1024 * 1024) as file:
            info = os.fstat(file.fileno())
            require(info.st_uid == os.getuid() and info.st_mode & 0o077 == 0, "unsafe_control_database", 503)
        connection = sqlite3.connect(str(self.db), isolation_level=None, timeout=5)
        connection.row_factory = sqlite3.Row
        try:
            connection.execute("PRAGMA journal_mode=WAL"); connection.execute("PRAGMA synchronous=FULL")
            if transaction: connection.execute("BEGIN IMMEDIATE")
            yield connection
            if transaction: connection.commit()
        finally:
            connection.close()  # An unfinished transaction rolls back, including its audit event.

    def _audit(self, connection, actor, action, target, details=None):
        row = connection.execute("SELECT digest FROM audit ORDER BY id DESC LIMIT 1").fetchone()
        previous = row[0] if row else "0" * 64
        document = {"actor": actor, "actor_kind": "executor" if actor=="executor" else "host_owner" if actor=="host-owner" else "user",
                    "action": action, "target": target, "at": self.now(), "details": details or {}}
        require(connection.execute("SELECT count(*) FROM audit").fetchone()[0] < 100000, "audit_retention_review_required", 503)
        connection.execute("INSERT INTO audit(previous,digest,document) VALUES (?,?,?)", (previous,
            digest({"previous": previous, "event": document}), release.canonical(document).decode()))

    def authorize(self, actor, role, connection=None):
        if connection is None:
            with self.connection() as conn: return self.authorize(actor, role, conn)
        require(role in ROLES, "invalid_role")
        row = connection.execute("SELECT * FROM users WHERE name=?", (actor,)).fetchone()
        require(row and row["enabled"] and row["password"], "control_permission_denied", 403)
        roles = json.loads(row["roles"])
        require(role == "viewer" or role in roles, "control_permission_denied", 403)
        return {"name": row["name"], "roles": roles, "epoch": row["epoch"]}

    def setup_required(self):
        with self.connection() as connection:
            return connection.execute("SELECT count(*) FROM users WHERE password IS NOT NULL AND enabled=1").fetchone()[0] == 0

    def _rate_check(self, connection, username, failure=False):
        key = token_digest("auth:" + str(username)[:256])
        now = self.now()
        connection.execute("DELETE FROM auth_attempts WHERE since < ?", (now - 600,))
        row = connection.execute("SELECT * FROM auth_attempts WHERE key=?", (key,)).fetchone()
        require(not row or now >= row["since"], "clock_moved_backwards", 503)
        require(not row or row["count"] < 5 or now-row["since"] > 300, "authentication_rate_limited", 429)
        if failure:
            require(connection.execute("SELECT count(*) FROM auth_attempts").fetchone()[0] < 10000, "authentication_busy", 429)
            count = row["count"]+1 if row and now-row["since"] <= 300 else 1
            since = row["since"] if count > 1 else now
            connection.execute("INSERT OR REPLACE INTO auth_attempts VALUES (?,?,?)", (key,count,since))
        return key

    def activate(self, username, code, password):
        require(isinstance(username, str) and USERNAME.fullmatch(username), "invalid_credentials", 401)
        require(isinstance(code, str) and len(code) <= 100, "invalid_credentials", 401)
        with self.connection(transaction=True) as connection:
            # Reserve an attempt before doing any expensive hashing. Wrong/replayed
            # codes stay bounded even across process restarts.
            self._rate_check(connection, username, failure=True)
            row = connection.execute("SELECT * FROM users WHERE name=?", (username,)).fetchone()
        require(row and row["enabled"] and row["code_hash"] and row["code_issued"] <= self.now() <= row["code_expires"] and
                hmac.compare_digest(row["code_hash"], token_digest(code)), "invalid_credentials", 401)
        hashed = password_hash(password)
        with self.connection(transaction=True) as connection:
            current = connection.execute("SELECT * FROM users WHERE name=?", (username,)).fetchone()
            require(current and current["enabled"] and current["code_hash"] == row["code_hash"] and current["epoch"] == row["epoch"] and
                    current["code_issued"] <= self.now() <= current["code_expires"], "activation_already_consumed", 409)
            connection.execute("UPDATE users SET password=?,epoch=epoch+1,code_hash=NULL,code_issued=NULL,code_expires=NULL WHERE name=?",
                               (release.canonical(hashed).decode(),username))
            connection.execute("DELETE FROM sessions WHERE username=?",(username,))
            connection.execute("DELETE FROM auth_attempts WHERE key=?",(token_digest("auth:"+username),))
            self._audit(connection,username,"identity.activated",username)
        # The initial host code is single-use even if removing its hint fails.
        try: (self.root/"activate-code.txt").unlink()
        except FileNotFoundError: pass
        return {"activated": True}

    def login(self, username, password):
        require(isinstance(username,str) and USERNAME.fullmatch(username),"invalid_credentials",401)
        with self.connection(transaction=True) as connection:
            self._rate_check(connection,username,failure=True)
            row=connection.execute("SELECT * FROM users WHERE name=?",(username,)).fetchone()
        stored=json.loads(row["password"]) if row and row["password"] else {
            "algorithm":"pbkdf2-sha256-600000","salt":"0"*32,"hash":"0"*64}
        valid=verify_password(password,stored)
        require(valid and row and row["enabled"] and self.now() >= row["created"],"invalid_credentials",401)
        token="sgc_"+secrets.token_urlsafe(32); csrf=secrets.token_urlsafe(32)
        with self.connection(transaction=True) as connection:
            current=connection.execute("SELECT * FROM users WHERE name=?",(username,)).fetchone()
            require(current and current["enabled"] and current["epoch"]==row["epoch"] and current["password"]==row["password"],"identity_changed",401)
            connection.execute("DELETE FROM sessions WHERE expires<?",(self.now(),))
            require(connection.execute("SELECT count(*) FROM sessions").fetchone()[0]<10000,"session_capacity",503)
            connection.execute("INSERT INTO sessions VALUES (?,?,?,?,?,?)",(token_digest(token),username,row["epoch"],csrf,self.now(),self.now()+8*3600))
            connection.execute("DELETE FROM auth_attempts WHERE key=?",(token_digest("auth:"+username),))
            self._audit(connection,username,"session.created",username)
        return {"token":token,"csrf":csrf,"user":self.authorize(username,"viewer"),"expires_in":8*3600}

    def session(self, token):
        require(isinstance(token,str) and TOKEN.fullmatch(token),"authentication_required",401)
        with self.connection() as connection:
            row=connection.execute("SELECT * FROM sessions WHERE token_hash=?",(token_digest(token),)).fetchone()
            require(row and row["created"] <= self.now() < row["expires"],"authentication_required",401)
            user=self.authorize(row["username"],"viewer",connection)
            require(user["epoch"]==row["epoch"],"authentication_required",401)
            return {"user":user,"csrf":row["csrf"],"expires_at":row["expires"]}

    def logout(self, token):
        with self.connection(transaction=True) as connection:
            connection.execute("DELETE FROM sessions WHERE token_hash=?",(token_digest(token),))

    def invite(self, actor, username, roles):
        require(isinstance(username,str) and USERNAME.fullmatch(username) and username not in RESERVED_USERS,"invalid_username")
        require(type(roles) is list and roles and all(isinstance(role,str) and role in ROLES for role in roles) and len(roles)==len(set(roles)),"invalid_roles")
        code="sg_control_"+secrets.token_urlsafe(32)
        with self.connection(transaction=True) as connection:
            self.authorize(actor,"admin",connection)
            require(connection.execute("SELECT count(*) FROM users").fetchone()[0]<256,"user_capacity",409)
            require(not connection.execute("SELECT 1 FROM users WHERE name=?",(username,)).fetchone(),"user_exists",409)
            connection.execute("INSERT INTO users VALUES (?,?,?,?,?,?,?,?,?)",(username,json.dumps(sorted(roles)),1,None,1,self.now(),token_digest(code),self.now(),self.now()+900))
            self._audit(connection,actor,"identity.invited",username,{"roles":sorted(roles)})
        return {"name":username,"code":code,"expires_in":900}

    def users(self, actor):
        with self.connection() as connection:
            self.authorize(actor,"admin",connection)
            return [{"name":row["name"],"roles":json.loads(row["roles"]),"enabled":bool(row["enabled"]),"activated":bool(row["password"])}
                    for row in connection.execute("SELECT * FROM users ORDER BY name")]

    def set_user(self, actor, username, roles, enabled):
        require(type(roles) is list and roles and all(isinstance(role,str) and role in ROLES for role in roles) and len(roles)==len(set(roles)) and type(enabled) is bool,"invalid_roles")
        with self.connection(transaction=True) as connection:
            self.authorize(actor,"admin",connection)
            old=connection.execute("SELECT * FROM users WHERE name=?",(username,)).fetchone()
            require(old,"user_not_found",404)
            if not enabled or "admin" not in roles:
                others=connection.execute("SELECT * FROM users WHERE name!=? AND enabled=1 AND password IS NOT NULL",(username,)).fetchall()
                require(any("admin" in json.loads(row["roles"]) for row in others),"last_administrator_required",409)
            connection.execute("UPDATE users SET roles=?,enabled=?,epoch=epoch+1 WHERE name=?",(json.dumps(sorted(roles)),int(enabled),username))
            connection.execute("DELETE FROM sessions WHERE username=?",(username,))
            self._audit(connection,actor,"identity.permissions_changed",username,{"roles":sorted(roles),"enabled":enabled})

    def host_recovery_code(self, username, *, confirmed=False):
        require(confirmed is True,"host_recovery_confirmation_required")
        code="sg_control_"+secrets.token_urlsafe(32)
        with self.connection(transaction=True) as connection:
            row=connection.execute("SELECT * FROM users WHERE name=?",(username,)).fetchone()
            require(row and row["enabled"],"user_not_found",404)
            connection.execute("UPDATE users SET code_hash=?,code_issued=?,code_expires=? WHERE name=?",(token_digest(code),self.now(),self.now()+900,username))
            self._audit(connection,"host-owner","identity.recovery_code_issued",username)
        return code

    def change_password(self, actor, current_password, new_password):
        with self.connection() as connection:
            self.authorize(actor,"viewer",connection)
            row=connection.execute("SELECT * FROM users WHERE name=?",(actor,)).fetchone()
        require(verify_password(current_password,json.loads(row["password"])),"invalid_credentials",401)
        changed=password_hash(new_password)
        with self.connection(transaction=True) as connection:
            current=connection.execute("SELECT * FROM users WHERE name=?",(actor,)).fetchone()
            require(current and current["enabled"] and current["epoch"]==row["epoch"],"identity_changed",409)
            connection.execute("UPDATE users SET password=?,epoch=epoch+1,code_hash=NULL,code_issued=NULL,code_expires=NULL WHERE name=?",(release.canonical(changed).decode(),actor))
            connection.execute("DELETE FROM sessions WHERE username=?",(actor,))
            self._audit(connection,actor,"identity.password_changed",actor)
        return {"changed":True,"sessions_revoked":True}

    def register_site(self, name, installation_id, configuration, group="default", *, confirmed=False):
        require(confirmed is True,"host_enrollment_confirmation_required")
        require(isinstance(name,str) and 1 <= len(name) <= 80 and all(ord(c)>=32 for c in name),"invalid_site_name")
        require(isinstance(group,str) and re.fullmatch(r"[a-zA-Z0-9_-]{1,40}",group),"invalid_site_group")
        require(isinstance(installation_id,str) and re.fullmatch(r"[a-f0-9]{32}",installation_id),"invalid_installation_id")
        require(type(configuration) is dict and configuration.get("transport") in ("local","ssh"),"invalid_site_transport")
        require(len(release.canonical(configuration))<=16384,"site_config_too_large")
        identifier="site-"+uuid.uuid4().hex
        with self.connection(transaction=True) as connection:
            require(connection.execute("SELECT count(*) FROM sites").fetchone()[0]<1000,"fleet_capacity",409)
            require(not connection.execute("SELECT 1 FROM sites WHERE installation_id=?",(installation_id,)).fetchone(),"installation_already_enrolled",409)
            connection.execute("INSERT INTO sites VALUES (?,?,?,?,?,?,?)",(identifier,installation_id,name,group,1,release.canonical(configuration).decode(),digest(configuration)))
            self._audit(connection,"host-owner","site.enrolled",identifier,{"installation_id":installation_id,"transport":configuration["transport"]})
        return identifier

    def sites(self, actor):
        with self.connection() as connection:
            self.authorize(actor,"viewer",connection)
            return [{"id":row["id"],"installation_id":row["installation_id"],"name":row["name"],"group":row["group_name"],"enabled":bool(row["enabled"]),
                     "transport":json.loads(row["config"])["transport"]} for row in connection.execute("SELECT * FROM sites ORDER BY name")]

    def site_private(self, site_id):
        require(isinstance(site_id,str) and SITE_ID.fullmatch(site_id),"invalid_site_id")
        with self.connection() as connection:
            row=connection.execute("SELECT * FROM sites WHERE id=? AND enabled=1",(site_id,)).fetchone()
            require(row,"site_not_found",404)
            value=dict(row); value["config"]=json.loads(row["config"])
            require(digest(value["config"])==row["config_hash"],"site_configuration_changed",503)
            return value

    def propose(self, actor, request_id, targets, *, canary=1, wave_size=1, failure_threshold=1, client_digest=None):
        self.authorize(actor,"planner")
        require(client_digest is None or isinstance(client_digest,str) and release.SHA.fullmatch(client_digest),"invalid_client_digest")
        require(isinstance(request_id,str) and re.fullmatch(r"[a-zA-Z0-9_-]{8,80}",request_id),"invalid_request_id")
        require(type(targets) is list and 1 <= len(targets) <= 100,"invalid_targets")
        require(all(type(n) is int for n in (canary,wave_size,failure_threshold)) and 1 <= canary <= len(targets) and
                1 <= wave_size <= 10 and 1 <= failure_threshold <= len(targets),"invalid_batch_policy")
        sites=set(); installations=set(); bound_targets=[]
        for target in targets:
            require(type(target) is dict and set(target) in ({"site_id","installation_id","operation","agent_plan_id","agent_plan_digest","summary"},
                    {"site_id","installation_id","operation","agent_plan_id","agent_plan_digest","summary","approve_before"}),"invalid_target_fields")
            require(target.get("approve_before") is None or finite(target["approve_before"]),"invalid_agent_deadline")
            site=self.site_private(target["site_id"])
            require(target["installation_id"]==site["installation_id"] and target["site_id"] not in sites and target["installation_id"] not in installations,"duplicate_or_foreign_target")
            require(target["operation"] in ("backup","upgrade","verify_restore") and isinstance(target["agent_plan_id"],str) and
                    re.fullmatch(r"(?:op|rv)-[a-f0-9]{32}",target["agent_plan_id"]) and isinstance(target["agent_plan_digest"],str) and
                    release.SHA.fullmatch(target["agent_plan_digest"]),"invalid_agent_plan")
            require(type(target["summary"]) is dict and len(release.canonical(target["summary"]))<=8192,"invalid_target_summary")
            allowed_summary={"source_version","target_version","source_image","target_image","release_digest","backup_id","downtime_required","publisher_verified","compatibility"}
            require(set(target["summary"]) <= allowed_summary,"invalid_target_summary")
            for key,value in target["summary"].items():
                if key in ("source_version","target_version"):
                    require(isinstance(value,str) and (value=="unknown" or re.fullmatch(r"\d{1,6}\.\d{1,6}\.\d{1,6}",value)),"invalid_target_summary")
                elif key in ("source_image","target_image"): require(isinstance(value,str) and release.IMAGE_ID.fullmatch(value),"invalid_target_summary")
                elif key=="release_digest": require(isinstance(value,str) and release.SHA.fullmatch(value),"invalid_target_summary")
                elif key=="backup_id": require(isinstance(value,str) and re.fullmatch(r"backup-[a-f0-9]{32}",value),"invalid_target_summary")
                elif key in ("downtime_required","publisher_verified"): require(type(value) is bool,"invalid_target_summary")
                else: require(type(value) is list and len(value)<=20 and all(isinstance(item,str) and re.fullmatch(r"[a-z_]{1,64}",item) for item in value),"invalid_target_summary")
            sites.add(target["site_id"]); installations.add(target["installation_id"])
            bound_targets.append({**target,"transport_digest":site["config_hash"]})
        spec={"targets":bound_targets,"canary":canary,"wave_size":wave_size,"failure_threshold":failure_threshold,"client_digest":client_digest}
        request_hash=digest(spec)
        with self.connection(transaction=True) as connection:
            self.authorize(actor,"planner",connection)
            old=connection.execute("SELECT * FROM jobs WHERE requester=? AND request_key=?",(actor,request_id)).fetchone()
            if old:
                require(old["request_hash"]==request_hash,"idempotency_conflict",409)
                return self._job_row(old)
            require(connection.execute("SELECT count(*) FROM jobs").fetchone()[0]<10000,"job_retention_review_required",409)
            deadline=min([self.now()+900]+[target["approve_before"] for target in targets if target.get("approve_before") is not None])
            require(deadline>=self.now(),"agent_preflight_expired",409)
            plan={**spec,"requester":actor,"created_at":self.now(),"approve_before":deadline}
            job={"id":"job-"+uuid.uuid4().hex,"plan":plan,"plan_digest":digest(plan),"status":"planned","revision":1,"approval":None,
                 "cursor":0,"wave_end":canary,"inflight":None,"results":[],"pause_requested":False,"cancel_requested":False,
                 "events":[{"event":"proposed","at":self.now(),"actor":actor}],"updated_at":self.now(),"error_code":None}
            connection.execute("INSERT INTO jobs VALUES (?,?,?,?,?,?,?)",(job["id"],actor,request_id,request_hash,"planned",self.now(),release.canonical(job).decode()))
            self._audit(connection,actor,"operation.proposed",job["id"],{"plan_digest":job["plan_digest"],"targets":len(targets)})
            return job

    def _job_row(self, row):
        require(row,"job_not_found",404)
        job=json.loads(row["document"])
        require(job["id"]==row["id"] and job["status"]==row["status"] and digest(job["plan"])==job["plan_digest"],"job_integrity_error",503)
        return job

    def _job(self, connection, identifier):
        require(isinstance(identifier,str) and JOB_ID.fullmatch(identifier),"invalid_job_id")
        return self._job_row(connection.execute("SELECT * FROM jobs WHERE id=?",(identifier,)).fetchone())

    def _save(self, connection, job, actor, event, details=None):
        require(len(job["events"])<1000,"job_event_limit",503)
        job["revision"]+=1; job["updated_at"]=self.now(); job["events"].append({"event":event,"at":self.now(),"actor":actor,**({"details":details} if details else {})})
        connection.execute("UPDATE jobs SET status=?,document=? WHERE id=?",(job["status"],release.canonical(job).decode(),job["id"]))
        if job["status"] in TERMINAL: connection.execute("DELETE FROM active_resources WHERE job_id=?",(job["id"],))
        self._audit(connection,actor,"operation."+event,job["id"],{"plan_digest":job["plan_digest"],"status":job["status"]})
        return job

    def get_job(self, actor, identifier):
        with self.connection() as connection:
            self.authorize(actor,"viewer",connection); return self._job(connection,identifier)

    def find_request(self, actor, request_id):
        with self.connection() as connection:
            self.authorize(actor,"planner",connection)
            row=connection.execute("SELECT * FROM jobs WHERE requester=? AND request_key=?",(actor,request_id)).fetchone()
            return self._job_row(row) if row else None

    def worker_job(self, identifier):
        with self.connection() as connection: return self._job(connection,identifier)

    def jobs(self, actor):
        with self.connection() as connection:
            self.authorize(actor,"viewer",connection)
            return [self._job_row(row) for row in connection.execute("SELECT * FROM jobs ORDER BY CASE WHEN status IN ('approval_pending','queued','running','paused','awaiting_promotion','needs_attention') THEN 0 ELSE 1 END,created DESC LIMIT 100")]

    def approve(self, actor, identifier, plan_digest, not_before, not_after, *, accept_downtime=False):
        require(finite(not_before) and finite(not_after) and self.now()-5 <= not_before <= self.now()+7*86400 and
                not_before < not_after and not_after-not_before <= 3600,"invalid_start_window")
        with self.connection(transaction=True) as connection:
            self.authorize(actor,"approver",connection)
            job=self._job(connection,identifier)
            require(job["status"]=="planned" and job["plan_digest"]==plan_digest,"approval_plan_mismatch",409)
            require(actor != job["plan"]["requester"],"independent_approver_required",403)
            self.authorize(job["plan"]["requester"],"planner",connection)
            require(job["plan"]["created_at"] <= self.now() <= job["plan"]["approve_before"],"plan_expired",409)
            disruptive=any(target["operation"] in ("backup","upgrade") for target in job["plan"]["targets"])
            require(not disruptive or accept_downtime is True,"downtime_confirmation_required")
            for target in job["plan"]["targets"]:
                site=connection.execute("SELECT * FROM sites WHERE id=? AND enabled=1",(target["site_id"],)).fetchone()
                require(site and site["installation_id"]==target["installation_id"] and site["config_hash"]==target["transport_digest"],"site_changed",409)
                require(not connection.execute("SELECT 1 FROM active_resources WHERE installation_id=?",(target["installation_id"],)).fetchone(),"installation_busy",409)
                connection.execute("INSERT INTO active_resources VALUES (?,?)",(target["installation_id"],identifier))
            job["approval"]={"actor":actor,"at":self.now(),"not_before":not_before,"not_after":not_after,"accepted_downtime":bool(accept_downtime)}
            job.update(status="approval_pending",host_reviews={})
            return self._save(connection,job,actor,"approved")

    def _permission_live(self, connection, job):
        self.authorize(job["plan"]["requester"],"planner",connection)
        self.authorize(job["approval"]["actor"],"approver",connection)

    def pending_reviews(self):
        with self.connection() as connection:
            return [self._job_row(row) for row in connection.execute("SELECT * FROM jobs WHERE status='approval_pending' ORDER BY created LIMIT 100")]

    def review_target(self, identifier, site_id):
        with self.connection() as connection:
            job=self._job(connection,identifier)
            require(job["status"]=="approval_pending","host_review_state_changed",409)
            self._permission_live(connection,job)
            require(job["approval"]["at"]<=self.now()<=job["approval"]["not_after"],"start_window_expired",409)
            target=next((target for target in job["plan"]["targets"] if target["site_id"]==site_id),None)
            require(target,"invalid_review_target")
            site=connection.execute("SELECT * FROM sites WHERE id=? AND enabled=1",(site_id,)).fetchone()
            require(site and site["installation_id"]==target["installation_id"] and site["config_hash"]==target["transport_digest"],"site_changed",409)
            return job

    def record_host_review(self, identifier, site_id, receipt):
        with self.connection(transaction=True) as connection:
            job=self._job(connection,identifier)
            require(job["status"]=="approval_pending","host_review_state_changed",409)
            self._permission_live(connection,job)
            require(type(receipt) is dict and len(release.canonical(receipt))<=4096,"invalid_host_review")
            target=next((target for target in job["plan"]["targets"] if target["site_id"]==site_id),None)
            require(target and receipt["plan_id"]==target["agent_plan_id"] and receipt["plan_digest"]==target["agent_plan_digest"],"invalid_host_review")
            previous=job["host_reviews"].get(site_id)
            if previous:
                require(previous==receipt,"host_review_changed",409)
                return job
            job["host_reviews"][site_id]=receipt
            return self._save(connection,job,"executor","host_review_recorded",{"site_id":site_id})

    def finish_host_reviews(self, identifier):
        with self.connection(transaction=True) as connection:
            job=self._job(connection,identifier)
            require(job["status"]=="approval_pending","host_review_state_changed",409)
            self._permission_live(connection,job)
            require(set(job.get("host_reviews",{}))=={target["site_id"] for target in job["plan"]["targets"]},"host_approval_receipts_missing",409)
            job["status"]="queued"
            return self._save(connection,job,"executor","all_host_reviews_recorded")

    def reject_host_review(self, identifier, code):
        with self.connection(transaction=True) as connection:
            job=self._job(connection,identifier)
            if job["status"]!="approval_pending": return job
            # Reviews never enqueue an Agent job. Even a lost review response
            # cannot start a gateway mutation, so no uncertain dispatch is hidden.
            job.update(status="rejected",error_code=code)
            return self._save(connection,job,"executor","host_review_failed")

    def claim_next(self):
        with self.connection(transaction=True) as connection:
            for row in connection.execute("SELECT * FROM jobs WHERE status='queued' ORDER BY created"):
                job=self._job_row(row); approval=job["approval"]
                if self.now()<approval["not_before"]: continue
                error=None
                if set(job.get("host_reviews",{}))!={target["site_id"] for target in job["plan"]["targets"]}: error="host_approval_receipts_missing"
                elif self.now()<approval["at"]: error="clock_moved_backwards"
                elif self.now()>approval["not_after"]: error="start_window_expired"
                else:
                    try: self._permission_live(connection,job)
                    except ControlError: error="approval_authority_revoked"
                if error:
                    job.update(status="rejected",error_code=error); self._save(connection,job,"executor","rejected"); continue
                job["status"]="running"
                return self._save(connection,job,"executor","started")
        return None

    def begin_target(self, identifier):
        with self.connection(transaction=True) as connection:
            job=self._job(connection,identifier)
            require(job["status"]=="running" and job["inflight"] is None,"job_not_executable",409)
            self._permission_live(connection,job)
            require(job["approval"]["at"] <= self.now() <= job["approval"]["not_after"],"start_window_expired",409)
            require(job["cursor"] < job["wave_end"],"wave_approval_required",409)
            target=job["plan"]["targets"][job["cursor"]]
            site=connection.execute("SELECT * FROM sites WHERE id=? AND enabled=1",(target["site_id"],)).fetchone()
            require(site and site["installation_id"]==target["installation_id"] and site["config_hash"]==target["transport_digest"],"site_changed",409)
            job["inflight"]={"index":job["cursor"],"site_id":target["site_id"],"agent_plan_id":target["agent_plan_id"],"stage":"dispatch_intent"}
            self._save(connection,job,"executor","dispatch_intent_recorded")
            return target

    def observe_target(self, identifier, stage):
        require(isinstance(stage,str) and re.fullmatch(r"[a-z_]{1,64}",stage),"invalid_observed_stage")
        with self.connection(transaction=True) as connection:
            job=self._job(connection,identifier)
            require(job["status"]=="running" and job["inflight"],"job_not_running",409)
            if job["inflight"]["stage"]==stage: return job
            job["inflight"]["stage"]=stage
            return self._save(connection,job,"executor","stage_observed",{"stage":stage,"site_id":job["inflight"]["site_id"]})

    def finish_target(self, identifier, status, receipt):
        require(status in ("succeeded","rejected","needs_attention","failed","cancelled") and type(receipt) is dict and
                len(release.canonical(receipt))<=65536,"invalid_target_receipt")
        with self.connection(transaction=True) as connection:
            job=self._job(connection,identifier)
            require(job["status"]=="running" and job["inflight"],"job_not_running",409)
            job["results"].append({"site_id":job["inflight"]["site_id"],"agent_plan_id":job["inflight"]["agent_plan_id"],"status":status,"receipt":receipt,"at":self.now()})
            job["cursor"]+=1; job["inflight"]=None
            failures=sum(result["status"]!="succeeded" for result in job["results"])
            if status=="needs_attention": job.update(status="needs_attention",error_code="agent_reconciliation_required")
            elif job["cancel_requested"]: job["status"]="cancelled"
            elif job["cursor"]==len(job["plan"]["targets"]): job["status"]="completed_with_failures" if failures else "completed"
            elif failures>=job["plan"]["failure_threshold"]: job.update(status="paused",error_code="failure_threshold_reached")
            elif job["pause_requested"]: job["status"]="paused"
            elif job["cursor"]>=job["wave_end"]: job["status"]="awaiting_promotion"
            return self._save(connection,job,"executor","target_finished")

    def promote(self, actor, identifier, plan_digest, *, acknowledge_failures=0):
        with self.connection(transaction=True) as connection:
            self.authorize(actor,"approver",connection)
            job=self._job(connection,identifier)
            require(actor!=job["plan"]["requester"],"independent_approver_required",403)
            require(job["status"] in ("awaiting_promotion","paused") and job["inflight"] is None and job["plan_digest"]==plan_digest,"promotion_plan_mismatch",409)
            failures=sum(item["status"]!="succeeded" for item in job["results"])
            require(not job["error_code"] and failures<job["plan"]["failure_threshold"],"replan_after_failure",409)
            require(type(acknowledge_failures) is int and acknowledge_failures==failures,"review_failed_targets_required",409)
            self._permission_live(connection,job)
            require(job["approval"]["at"] <= self.now() <= job["approval"]["not_after"],"start_window_expired",409)
            reviewed=set(job.get("host_reviews",{}))=={target["site_id"] for target in job["plan"]["targets"]}
            job.update(status="queued" if reviewed else "approval_pending",pause_requested=False,
                       wave_end=min(len(job["plan"]["targets"]),job["cursor"]+job["plan"]["wave_size"]))
            return self._save(connection,job,actor,"next_wave_approved")

    def request_stop(self, actor, identifier, *, cancel=False):
        with self.connection(transaction=True) as connection:
            user=self.authorize(actor,"viewer",connection); job=self._job(connection,identifier)
            require("approver" in user["roles"] or ("planner" in user["roles"] and actor==job["plan"]["requester"]),"control_permission_denied",403)
            require(job["status"] not in TERMINAL | {"needs_attention"},"job_not_stoppable",409)
            require(cancel or job["status"]!="planned","job_not_approved",409)
            if job["status"]=="running" and job["inflight"]:
                job["cancel_requested" if cancel else "pause_requested"]=True
            else: job["status"]="cancelled" if cancel else "paused"
            return self._save(connection,job,actor,"cancel_requested" if cancel else "pause_requested")

    def reconcile_interrupted(self):
        # Call under the OS worker lock after a fresh process starts. Never turn
        # an uncertain dispatch into a second upgrade attempt.
        with self.connection(transaction=True) as connection:
            for row in connection.execute("SELECT * FROM jobs WHERE status='running'"):
                job=self._job_row(row); job.update(status="needs_attention",error_code="control_executor_interrupted")
                self._save(connection,job,"executor","reconciliation_required")

    def reconciliation_job(self, actor, identifier, plan_digest, revision, connection=None):
        if connection is None:
            with self.connection() as conn:
                return self.reconciliation_job(actor, identifier, plan_digest, revision, conn)
        self.authorize(actor,"approver",connection)
        job=self._job(connection,identifier)
        require(actor!=job["plan"]["requester"],"independent_approver_required",403)
        require(type(revision) is int and job["status"]=="needs_attention" and job["plan_digest"]==plan_digest and
                job["revision"]==revision,"reconciliation_state_changed",409)
        return job

    @staticmethod
    def uncertain_targets(job):
        indices=[index for index,result in enumerate(job["results"]) if result["status"]=="needs_attention"]
        if job["inflight"]: indices.append(job["inflight"]["index"])
        return indices

    def record_reconciliation(self, actor, identifier, plan_digest, revision, observations):
        # Only the service supplies observations. There is no HTTP endpoint that
        # accepts a client's declaration of success or a hand-edited receipt.
        with self.connection(transaction=True) as connection:
            job=self.reconciliation_job(actor,identifier,plan_digest,revision,connection)
            indices=self.uncertain_targets(job)
            require(type(observations) is list and len(observations)==len(indices) and
                    len(release.canonical(observations))<=256*1024,"invalid_reconciliation_observations")
            for index,observation in zip(indices,observations):
                target=job["plan"]["targets"][index]
                require(observation.get("site_id")==target["site_id"] and observation.get("agent_plan_id")==target["agent_plan_id"] and
                        type(observation.get("confirmed")) is bool,"invalid_reconciliation_target")
            confirmed=all(item["confirmed"] for item in observations)
            if confirmed:
                for index,observation in zip(indices,observations):
                    require(observation["status"] in ("succeeded","rejected","cancelled","failed","resolved"),"nonterminal_reconciliation")
                    result={key:observation[key] for key in ("site_id","agent_plan_id","status","receipt")}
                    result.update(at=self.now(),reconciled_by=actor)
                    if index<len(job["results"]): job["results"][index]=result
                    else:
                        require(index==len(job["results"])==job["cursor"],"reconciliation_cursor_mismatch",503)
                        job["results"].append(result); job["cursor"]+=1
                # Close, never silently resume the remaining wave. A fresh plan
                # and independent approval are required for any further work.
                job.update(inflight=None,error_code=None,pause_requested=False,cancel_requested=False)
                job["status"]="completed" if job["cursor"]==len(job["plan"]["targets"]) and all(
                    result["status"]=="succeeded" for result in job["results"]) else "resolved"
            job["reconciliation"]={"actor":actor,"at":self.now(),"confirmed":confirmed,
                "observations":observations,"remaining_targets_cancelled":confirmed,
                "unexecuted_targets":len(job["plan"]["targets"])-job["cursor"] if confirmed else None}
            return self._save(connection,job,actor,"reconciliation_completed" if confirmed else "reconciliation_incomplete")

    def worker_reject_before_dispatch(self, identifier, code):
        require(isinstance(code,str) and re.fullmatch(r"[a-z_]{1,64}",code),"invalid_error_code")
        with self.connection(transaction=True) as connection:
            job=self._job(connection,identifier)
            require(job["status"]=="running" and job["inflight"] is None,"dispatch_state_uncertain",409)
            job.update(status="rejected",error_code=code)
            return self._save(connection,job,"executor","rejected_before_dispatch")

    def audit(self, actor, limit=100):
        require(type(limit) is int and 1<=limit<=1000,"invalid_audit_limit")
        with self.connection() as connection:
            self.authorize(actor,"admin",connection)
            return [{"id":row["id"],"previous":row["previous"],"digest":row["digest"],"event":json.loads(row["document"])}
                    for row in connection.execute("SELECT * FROM audit ORDER BY id DESC LIMIT ?",(limit,))]
