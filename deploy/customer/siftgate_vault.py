#!/usr/bin/env python3
"""Recovery verification on an isolated copy. Never restores over live data."""
import base64
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import time
import uuid

import siftgate as kit
import siftgate_operator as operator
import siftgate_release as release
from siftgate_releases import private_directory, copy_regular

BACKUP_ID = re.compile(r"backup-[a-f0-9]{32}\Z")
DRILL_ID = re.compile(r"rv-[a-f0-9]{32}\Z")
REQUIRED_TABLES = {"gateway_api_keys", "call_logs", "workspaces", "workspace_memberships"}
BUSINESS_TABLES = REQUIRED_TABLES | {"organizations", "local_teams", "budget_rules", "config_versions", "agent_profiles",
                                    "prompt_templates", "batch_jobs", "video_jobs", "eval_datasets", "eval_sample_results"}
# Existing releases touch these initialization timestamps on every boot. Never
# ignore call-log/billing timestamps, key fields, roles, names or business values.
OPERATIONAL_COLUMNS = {name: {"updated_at"} for name in ("organizations", "workspaces", "workspace_memberships")}
PROBE = "Promise.all(['live','ready'].map(async p=>{const r=await fetch('http://127.0.0.1:2099/'+p,{signal:AbortSignal.timeout(3000)});if(!r.ok)throw Error('not ready');const b=await r.json();if(p==='live'&&b.status!=='alive')throw Error('not live')})).then(()=>console.log('ready')).catch(()=>process.exit(1))"


class VaultError(Exception):
    pass


def require(value, code):
    if not value: raise VaultError(code)


def timestamp(): return dt.datetime.now(dt.timezone.utc).isoformat()


def database_evidence(path):
    # immutable is safe only for a stopped, fully checkpointed private snapshot.
    path = Path(path)
    for suffix in ("-wal", "-journal"):
        extra = Path(str(path) + suffix)
        require(not extra.exists() or extra.stat().st_size == 0, "database_not_checkpointed")
    with release.regular_file(path, release.MAX_IMAGE) as stream:
        require(stream.read(16) == b"SQLite format 3\0", "sqlite_backup_required")
    connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro&immutable=1", uri=True, timeout=5)
    deadline = time.monotonic() + 600
    connection.set_progress_handler(lambda: int(time.monotonic() >= deadline), 10000)
    try:
        require(connection.execute("PRAGMA quick_check").fetchall() == [("ok",)], "database_integrity_failed")
        connection.execute("PRAGMA cache_size=-8192")
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        require(REQUIRED_TABLES <= tables, "incomplete_business_database")
        selected = sorted(table for table in tables if table in BUSINESS_TABLES or table.startswith(("pricing_", "cost_", "ledger_", "metering_", "fx_")))
        evidence = {}
        def quoted(name): return '"' + name.replace('"', '""') + '"'
        def cell(value):
            if isinstance(value, bytes): return {"blob": base64.b64encode(value).decode()}
            return value
        for table in selected:
            require(re.fullmatch(r"[a-zA-Z_][a-zA-Z_0-9]{0,127}", table), "unsupported_database_identifier")
            columns = connection.execute("PRAGMA table_info(" + quoted(table) + ")").fetchall()
            all_names = [row[1] for row in columns]
            ignored = sorted(set(all_names) & OPERATIONAL_COLUMNS.get(table, set()))
            names = [name for name in all_names if name not in ignored]
            primary = [row[1] for row in sorted(columns, key=lambda row: row[5]) if row[5]]
            require(names, "invalid_database_columns")
            digest = hashlib.sha256(release.canonical(names)); count = 0
            cursor = connection.execute("SELECT " + ",".join(quoted(name) for name in names) + " FROM " + quoted(table) + " ORDER BY " + ",".join(quoted(name) for name in (primary or names)))
            for row in cursor:
                digest.update(release.canonical([cell(value) for value in row]) + b"\n"); count += 1
            evidence[table] = {"rows": count, "sha256": digest.hexdigest(), "columns": len(names), "ignored_operational_columns": ignored}
        return {"sqlite_quick_check": True, "tables": evidence}
    except sqlite3.Error:
        raise VaultError("database_verification_failed")
    finally:
        connection.close()


def copied_file_evidence(path):
    result = {}
    for section in ("config", "state"):
        for name, digest in kit.inventory(path / section).items():
            if section == "config" and name == "dashboard-identity.json":
                identity = release.json_bytes(release.read_bytes(path / section / name, 1024 * 1024))
                require(type(identity) is dict, "invalid_restored_identity")
                # Session revocation is required; compare all other identity fields.
                identity = {key: value for key, value in identity.items() if key not in ("session_secret", "revision", "access", "changed_at")}
                digest = hashlib.sha256(release.canonical(identity)).hexdigest()
            result[section + "/" + name] = digest
    result["provider.env"] = release.sha256(path / "provider.env")
    return result


class Vault:
    def __init__(self, install, create=True):
        self.install = install
        self.root = install.root / "vault"
        self.drills = self.root / "drills"
        if create or self.root.exists(): private_directory(self.root,create=create)
        if create or self.drills.exists(): private_directory(self.drills,create=create)

    def backup(self, backup_id, verify=False):
        require(isinstance(backup_id, str) and BACKUP_ID.fullmatch(backup_id), "invalid_backup_id")
        path = self.install.root / "backups" / backup_id
        private_directory(path)
        raw = release.read_bytes(path / "manifest.json", 4 * 1024 * 1024)
        manifest = release.json_bytes(raw)
        require(type(manifest) is dict and manifest.get("format") == kit.BACKUP_FORMAT and
                type(manifest.get("installation")) is dict and manifest["installation"].get("id") == self.install.meta["id"], "foreign_or_invalid_backup")
        require(manifest.get("purpose") in ("routine", "upgrade") and type(manifest.get("files")) is dict and len(manifest["files"]) <= 50000, "invalid_backup_manifest")
        require(isinstance(manifest.get("created_at"), str) and len(manifest["created_at"]) <= 40, "invalid_backup_time")
        try: require(dt.datetime.fromisoformat(manifest["created_at"].replace("Z", "+00:00")).tzinfo is not None, "invalid_backup_time")
        except ValueError: raise VaultError("invalid_backup_time")
        require(isinstance(manifest["installation"].get("image"), str) and release.IMAGE_ID.fullmatch(manifest["installation"]["image"]), "backup_image_not_pinned")
        if verify: kit.verified_snapshot(path)
        return path, manifest, hashlib.sha256(raw).hexdigest()

    def recovery_tools(self, path, manifest):
        tools=path/"kit" if manifest.get("recovery_kit") else kit.tool_directory(self.install.root,manifest["installation"])
        files={name:release.sha256(tools/name) for name in (*kit.KIT_FILES,"gateway.config.example.yaml")}
        return tools,hashlib.sha256(release.canonical(files)).hexdigest()

    def plan(self, backup_id, expected_digest, request_id):
        require(re.fullmatch(r"[a-zA-Z0-9_-]{8,80}", request_id or ""), "invalid_request_id")
        path, manifest, digest = self.backup(backup_id)
        require(digest == expected_digest, "backup_changed_after_selection")
        _,tools_digest=self.recovery_tools(path,manifest)
        job_id = "rv-" + hashlib.sha256((self.install.meta["id"] + ":" + request_id).encode()).hexdigest()[:32]
        with operator.file_lock(self.root / "plan.lock"):
            folder = self.drills / job_id
            if folder.exists():
                existing = self.get(job_id)
                require(existing["plan"]["backup_id"] == backup_id and existing["plan"]["backup_digest"] == digest, "idempotency_conflict")
                return existing
            require(sum(1 for item in self.drills.iterdir() if item.is_dir()) < 20, "vault_retention_review_required")
            private_directory(folder, create=True)
            plan = {"installation_id": self.install.meta["id"], "backup_id": backup_id, "backup_digest": digest,
                    "image": manifest["installation"]["image"], "network": "none", "live_changes": False,
                    "recovery_tools_digest":tools_digest}
            result = {"format": "siftgate-restore-drill-v1", "id": job_id, "plan": plan,
                      "plan_digest": hashlib.sha256(release.canonical(plan)).hexdigest(), "status": "planned", "stage": "planned",
                      "created_at": timestamp(), "updated_at": timestamp(), "events": [], "error_code": None,
                      "restore_drill_verified": False, "cleanup_confirmed": False, "evidence": None}
            kit.write_json(folder / "receipt.json", result)
            return result

    def get(self, job_id):
        require(isinstance(job_id, str) and DRILL_ID.fullmatch(job_id), "invalid_drill_id")
        value = release.json_bytes(release.read_bytes(self.drills / job_id / "receipt.json", 256 * 1024))
        require(value["format"] == "siftgate-restore-drill-v1" and value["id"] == job_id and
                value["plan"]["installation_id"] == self.install.meta["id"] and
                value["plan_digest"] == hashlib.sha256(release.canonical(value["plan"])).hexdigest(), "drill_integrity_error")
        return value

    def update(self, job_id, stage, **changes):
        value = self.get(job_id)
        require(not {"plan", "plan_digest", "id", "format", "events"} & changes.keys(), "immutable_drill_plan")
        value.update(changes); value["stage"] = stage; value["updated_at"] = timestamp()
        require(len(value["events"]) < 32, "drill_event_limit")
        value["events"].append({"stage": stage, "at": value["updated_at"]})
        kit.write_json(self.drills / job_id / "receipt.json", value)
        return value

    def _names(self, job_id):
        return ["siftgate-vault-" + job_id[3:] + suffix for suffix in ("-identity", "-probe")]

    def owned(self, name, job_id):
        identifiers = self.install.docker("ps", "--all", "--filter", "name=^/" + name + "$", "--quiet").splitlines()
        require(len(identifiers) <= 1, "ambiguous_drill_container")
        if not identifiers: return None
        info = json.loads(self.install.docker("inspect", identifiers[0]))[0]
        labels = info["Config"].get("Labels", {})
        require(info["Name"] == "/" + name and labels.get("siftgate.vault.installation") == self.install.meta["id"] and
                labels.get("siftgate.vault.job") == job_id and info["HostConfig"]["NetworkMode"] == "none" and
                not info["HostConfig"].get("PortBindings"), "drill_ownership_mismatch")
        return info

    def cleanup(self, job_id):
        for name in self._names(job_id):
            info = self.owned(name, job_id)
            if not info: continue
            if info["State"]["Running"]:
                self.install.docker("stop", "--time", "45", info["Id"], timeout=90)
            self.install.docker("rm", info["Id"], timeout=30)
        require(not any(self.owned(name, job_id) for name in self._names(job_id)), "drill_cleanup_unconfirmed")

    def arguments(self, name, job_id, copy, tools):
        args = ["run", "--init", "--name", name, "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
                "--label", "siftgate.vault.installation=" + self.install.meta["id"], "--label", "siftgate.vault.job=" + job_id,
                "--user", str(os.getuid()) + ":" + str(os.getgid()), "--memory", "1g", "--cpus", "1", "--pids-limit", "256",
                "--log-driver", "none", "--tmpfs", "/tmp:rw,noexec,nosuid,size=33554432",
                "--env", "NODE_ENV=production", "--env", "NODE_PATH=/app/node_modules",
                "--env", "SIFTGATE_RELEASE_UPDATES_DISABLED=1",
                "--env", "TZ=" + self.install.meta["timezone"], "--env", "GATEWAY_CONFIG_PATH=/config/gateway.config.yaml",
                "--env", "SIFTGATE_PLUGINS_CONFIG=/config/plugins.config.yaml", "--env-file", str(copy / "provider.env")]
        for section, mount in (("config", "/config"), ("data", "/app/data"), ("state", "/app/.siftgate")):
            args += ["--volume", str(copy / section) + ":" + mount]
        args += ["--volume", str(tools) + ":/opt/siftgate-kit:ro", "--entrypoint", "node"]
        return args

    def record_control_review(self, job_id, plan_digest, specification):
        spec=operator.control_review_spec(specification)
        with operator.file_lock(self.root / "worker.lock"):
            job=self.get(job_id)
            require(job["status"]=="planned" and job["plan_digest"]==plan_digest, "review_plan_mismatch")
            old=job.get("control_review")
            if old:
                require({key:value for key,value in old.items() if key!="recorded_at"}==spec, "review_replay_conflict")
                return job
            deadline=operator.timestamp(operator.parse_time(job["created_at"])+900)
            operator.fresh_control_review(spec,job["created_at"],deadline,time.time())
            _,_,digest=self.backup(job["plan"]["backup_id"],verify=True)
            require(digest==job["plan"]["backup_digest"], "backup_changed_after_plan")
            review=operator.fresh_control_review(spec,job["created_at"],deadline,time.time())
            return self.update(job_id,"planned",control_review=review)

    def execute(self, job_id, plan_digest, *, confirmed=False, control_job_id=None):
        require(confirmed is True, "restore_verification_confirmation_required")
        with operator.file_lock(self.root / "worker.lock"):
            job = self.get(job_id)
            require(job["plan_digest"] == plan_digest, "drill_approval_mismatch")
            if job["status"] == "succeeded": return job
            require(job["status"] == "planned", "drill_not_replayable")
            review=job.get("control_review")
            if control_job_id is not None:
                require(review and review["control_job_id"]==control_job_id, "recorded_control_review_required")
                require(operator.parse_time(review["recorded_at"])<=time.time() and
                        operator.parse_time(review["not_before"])<=time.time()<=operator.parse_time(review["not_after"]), "restore_start_window_invalid")
            else: require(not review,"control_dispatch_required")
            plan = job["plan"]
            self.update(job_id, "verifying_backup", status="running")
            folder = self.drills / job_id; copy = folder / "restored"
            error = None; evidence = None; cleanup = False
            try:
                path, manifest, digest = self.backup(plan["backup_id"], verify=True)
                require(digest == plan["backup_digest"], "backup_changed_after_plan")
                self.install.check_engine()
                require(self.install.resolve_image(plan["image"], local=True) == plan["image"], "backup_image_unavailable")
                kit.check_restore_image(self.install,manifest,plan["image"],folder)
                tools,tools_digest=self.recovery_tools(path,manifest)
                require(tools_digest==plan.get("recovery_tools_digest"),"recovery_tools_changed_after_plan")
                files = kit.inventory(path)
                bytes_needed = sum((path / name).stat().st_size for name in files)
                require(shutil.disk_usage(folder).free >= bytes_needed * 2 + 512 * 1024 * 1024, "restore_verification_disk_space")
                before_database = database_evidence(path / "data/gateway.db")
                before_files = copied_file_evidence(path)
                self.update(job_id, "copying_backup")
                private_directory(copy, create=True)
                for section in ("config", "data", "state"):
                    shutil.copytree(path / section, copy / section)
                copy_regular(path / "provider.env", copy / "provider.env", 32 * 1024 * 1024)
                kit.inventory(copy)  # Reject links/special files before mounting the clone.
                identity_name, probe_name = self._names(job_id)
                self.update(job_id, "revoking_copied_sessions")
                identity_result=kit.recovery_identity_evidence(self.install.docker(*self.arguments(identity_name, job_id, copy, tools), plan["image"],
                                    "/opt/siftgate-kit/container-ops.cjs", "restore-identity", timeout=180, output_limit=65536))
                identity = self.owned(identity_name, job_id)
                require(identity and not identity["State"]["Running"] and identity["State"]["ExitCode"] == 0, "restored_identity_check_failed")
                self.install.docker("rm", identity["Id"])
                self.update(job_id, "starting_isolated_copy")
                args = self.arguments(probe_name, job_id, copy, tools); args.insert(1, "--detach")
                self.install.docker(*args, plan["image"], "dist/main.js", timeout=60, output_limit=65536)
                deadline = time.monotonic() + 120
                self.update(job_id, "probing_isolated_copy")
                ready = False
                while time.monotonic() < deadline:
                    info = self.owned(probe_name, job_id)
                    require(info and info["State"]["Running"], "restored_gateway_exited")
                    try:
                        ready = self.install.docker("exec", info["Id"], "node", "-e", PROBE, timeout=10, output_limit=65536) == "ready"
                    except Exception:
                        # A fixed read-only probe may fail while bootstrap is in
                        # progress. Ownership checks outside this block still fail
                        # closed; no failed mutation is retried here.
                        ready = False
                    if ready: break
                    time.sleep(1)
                require(ready, "restored_gateway_not_ready")
                self.update(job_id, "stopping_isolated_copy")
                info = self.owned(probe_name, job_id)
                self.install.docker("stop", "--time", "45", info["Id"], timeout=90)
                stopped = self.owned(probe_name, job_id)
                require(stopped and not stopped["State"]["Running"] and stopped["State"]["ExitCode"] == 0, "restored_gateway_unclean_shutdown")
                self.update(job_id, "comparing_recovery_evidence")
                kit.inventory(copy)
                after_database = database_evidence(copy / "data/gateway.db")
                require(after_database == before_database, "restored_business_data_changed")
                after_files=copied_file_evidence(copy)
                legacy_checked=identity_result["identity_mode"]=="legacy_session_secret"
                if legacy_checked:
                    name="config/gateway.config.yaml"
                    require(identity_result["original_config_sha256"]==before_files[name] and
                            identity_result["restored_config_sha256"]==after_files[name],"restored_legacy_configuration_changed")
                    # The pinned helper proved all parsed values except the signing
                    # secret stayed equal; tie that proof to both actual host files.
                    after_files[name]=before_files[name]
                require(after_files == before_files, "restored_configuration_changed")
                source_identity = path / "config/dashboard-identity.json"
                identity_checked = False
                if source_identity.exists():
                    require(identity_result["identity_mode"]=="managed","restored_identity_mode_changed")
                    a = release.json_bytes(release.read_bytes(source_identity, 1024 * 1024))
                    b = release.json_bytes(release.read_bytes(copy / "config/dashboard-identity.json", 1024 * 1024))
                    require(a["session_secret"] != b["session_secret"] and b["access"] is None and
                            type(b.get("revision")) is int and b["revision"] == a["revision"] + 1, "restored_sessions_not_revoked")
                    identity_checked = True
                require(identity_checked or legacy_checked,"restored_sessions_not_revoked")
                require(self.backup(plan["backup_id"], verify=True)[2] == digest, "source_backup_changed_during_drill")
                evidence = {"backup_checksums_verified": True, "isolated_http_ready": True, "network": "none", "published_ports": False,
                            "image_identity":"verified_config_digest" if manifest.get("image_binding") else "legacy_same_engine_runtime",
                            "recovery_tools_digest":tools_digest,"frozen_backup_kit":bool(manifest.get("recovery_kit")),
                            "database": after_database, "configuration_files_verified": len(before_files),
                            "managed_sessions_revoked": identity_checked, "legacy_sessions_revoked":legacy_checked,
                            "legacy_identity_preserved": legacy_checked, "legacy_session_rotation_required_before_cutover": False,
                            "legacy_identity_changed_fields":["dashboard.session_secret"] if legacy_checked else [],
                            "managed_identity_changed_fields": ["session_secret", "revision", "access", "changed_at"] if identity_checked else [],
                            "live_data_overwritten": False, "cutover_selected": False}
            except Exception as failure:
                error = str(failure) if isinstance(failure, (VaultError, release.ReleaseError)) else "restore_verification_failed"
            finally:
                try: self.cleanup(job_id); cleanup = True
                except Exception: error = "drill_cleanup_unconfirmed"
            return self.update(job_id, "complete" if error is None else "attention",
                status="succeeded" if error is None else "failed" if cleanup else "needs_attention",
                error_code=error, cleanup_confirmed=cleanup, restore_drill_verified=error is None, evidence=evidence if error is None else None)

    def reconcile_interrupted(self):
        with operator.file_lock(self.root / "worker.lock"):
            for folder in self.drills.iterdir():
                if not DRILL_ID.fullmatch(folder.name): continue
                record = self.get(folder.name)
                if record["status"] == "running":
                    self.update(folder.name, "attention", status="needs_attention", error_code="restore_drill_interrupted")

    def reconcile_for_control(self, job_id, plan_digest):
        with operator.file_lock(self.root / "worker.lock"):
            job = self.get(job_id)
            require(job["plan_digest"] == plan_digest, "reconciliation_plan_mismatch")
            if job["status"] == "planned":
                return self.update(job_id, "cancelled", status="cancelled")
            if job["status"] in ("running", "needs_attention"):
                # Only isolated, label-bound, no-network drill containers can be
                # cleaned up here. Source data and the live gateway are untouched.
                self.update(job_id, "attention", status="needs_attention", error_code="restore_drill_interrupted")
                try: self.cleanup(job_id)
                except Exception:
                    return self.update(job_id, "attention", error_code="drill_cleanup_unconfirmed", cleanup_confirmed=False)
                return self.update(job_id, "reconciled", status="resolved", cleanup_confirmed=True,
                                   restore_drill_verified=False, error_code="restore_drill_not_completed")
            return job

    def records(self):
        if not self.drills.exists(): return []
        items = [self.get(folder.name) for folder in self.drills.iterdir() if DRILL_ID.fullmatch(folder.name)]
        return sorted(items, key=lambda item: item["created_at"], reverse=True)[:20]

    def catalog(self):
        records = self.records(); items = []
        for path in (self.install.root / "backups").glob("backup-*"):
            if not BACKUP_ID.fullmatch(path.name): continue
            require(len(items) < 500, "backup_catalog_limit")
            try:
                _, manifest, digest = self.backup(path.name)
                successful = next((record for record in records if record["status"] == "succeeded" and
                    record["plan"]["backup_id"] == path.name and record["plan"]["backup_digest"] == digest), None)
                items.append({"id": path.name, "purpose": manifest["purpose"], "created_at": manifest.get("created_at"), "manifest_digest": digest,
                              "integrity": "not_rechecked_by_catalog", "last_verified_drill": successful["id"] if successful else None,
                              "last_verified_at": successful["updated_at"] if successful else None, "cutover_selected": False})
            except (VaultError, release.ReleaseError, kit.OperatorError, OSError, ValueError):
                items.append({"id": path.name, "integrity": "unavailable", "last_verified_drill": None, "cutover_selected": False})
        return {"scope": "installation", "items": sorted(items, key=lambda item: item.get("created_at") or "", reverse=True), "automatic_restore": False}
