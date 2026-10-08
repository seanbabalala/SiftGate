"""Restore verification tests. Private synthetic DBs and fake isolated containers only."""
import json
import os
from pathlib import Path
import sqlite3
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "deploy/customer"))
import siftgate as kit
import siftgate_vault as vault


class FakeInstall:
    def __init__(self, root):
        self.root=root; self.meta={"id":"a"*32,"image":"sha256:"+"b"*64,"timezone":"Asia/Shanghai","engine_arch":"arm64","engine_id":"synthetic-vault-engine"}
        self.actions=[]; self.containers={}; self.fail=None
    def check_engine(self): self.actions.append(("check_engine",))
    def resolve_image(self, image, local=False):
        assert local; return image
    def docker(self,*args,**kwargs):
        self.actions.append(args)
        if args[0]=="run":
            name=args[args.index("--name")+1]
            labels={args[i+1].split("=",1)[0]:args[i+1].split("=",1)[1] for i,arg in enumerate(args) if arg=="--label"}
            copy=Path(args[args.index("--volume")+1].split(":")[0]).parent
            helper=args[-1]=="restore-identity"
            if helper:
                path=copy/"config/dashboard-identity.json"; identity=json.loads(path.read_text())
                identity.update(session_secret="new-synthetic-session",access=None,revision=identity["revision"]+1)
                path.write_text(json.dumps(identity))
            identifier=str(len(self.containers)+1)*64
            self.containers[identifier]={"Id":identifier,"Name":"/"+name,"Config":{"Labels":labels},
                "HostConfig":{"NetworkMode":"none","PortBindings":{}},"State":{"Running":not helper and self.fail!="boot","ExitCode":0},"copy":copy}
            return json.dumps({"ok":True,"action":"restore-identity","identity_mode":"managed"}) if helper else identifier
        if args[0]=="ps":
            name=args[args.index("--filter")+1].removeprefix("name=^/").removesuffix("$")
            return "\n".join(key for key,value in self.containers.items() if value["Name"]=="/"+name)
        if args[0]=="inspect": return json.dumps([{key:value for key,value in self.containers[args[1]].items() if key!="copy"}])
        if args[0]=="exec":
            if self.fail=="warming":
                self.fail=None; raise RuntimeError("probe not ready during startup")
            return "ready"
        if args[0]=="stop":
            item=self.containers[args[-1]]; item["State"]["Running"]=False
            if self.fail=="data":
                connection=sqlite3.connect(item["copy"]/"data/gateway.db")
                connection.execute("delete from gateway_api_keys"); connection.commit(); connection.close()
            if self.fail=="unclean": item["State"]["ExitCode"]=137
            return ""
        if args[0]=="rm":
            if self.fail=="cleanup": raise kit.OperatorError("synthetic private failure")
            del self.containers[args[1]]; return ""
        raise AssertionError("Unexpected action: "+args[0])


class VaultTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.root=Path(self.temp.name).resolve(); os.chmod(self.root,0o700)
        self.install=FakeInstall(self.root)
        (self.root/"kit").mkdir(mode=0o700); (self.root/"backups").mkdir(mode=0o700)
        for name in kit.KIT_FILES: shutil.copyfile(Path(kit.__file__).parent/name,self.root/"kit"/name)
        shutil.copyfile(Path(kit.__file__).resolve().parents[2]/"gateway.config.example.yaml",self.root/"kit/gateway.config.example.yaml")
        self.backup_id="backup-"+"c"*32; self.backup=self.root/"backups"/self.backup_id
        self.backup.mkdir(mode=0o700)
        for section in ("config","data","state"): (self.backup/section).mkdir(mode=0o700)
        (self.backup/"config/gateway.config.yaml").write_text("synthetic config and provider secrets")
        (self.backup/"config/dashboard-identity.json").write_text(json.dumps({"password_hash":"synthetic-hash","session_secret":"old-synthetic-session","revision":1,"access":None}))
        (self.backup/"state/pricing.json").write_text('{"price":"123.000000000001"}')
        (self.backup/"provider.env").write_text("FIXTURE=not-a-real-provider-key")
        connection=sqlite3.connect(self.backup/"data/gateway.db")
        for table in sorted(vault.REQUIRED_TABLES):
            connection.execute(f'CREATE TABLE "{table}" (id text primary key, value text)')
            connection.execute(f'INSERT INTO "{table}" VALUES (?,?)',("fixture","do-not-print-row"))
        connection.commit(); connection.close()
        kit.write_json(self.backup/"manifest.json",{"format":kit.BACKUP_FORMAT,"purpose":"upgrade","created_at":vault.timestamp(),
                       "installation":dict(self.install.meta),"files":kit.inventory(self.backup)})
        self.vault=vault.Vault(self.install)
    def tearDown(self): self.temp.cleanup()
    def plan(self, request="vault-request-001"):
        return self.vault.plan(self.backup_id,self.vault.backup(self.backup_id)[2],request)
    def execute(self,job): return self.vault.execute(job["id"],job["plan_digest"],confirmed=True)

    def test_plan_and_approval_bind_backup_digest_and_never_touch_live_data(self):
        job=self.plan(); self.assertEqual(job["id"],self.plan()["id"])
        self.assertEqual(self.install.actions,[])
        with self.assertRaises(vault.VaultError): self.vault.execute(job["id"],job["plan_digest"])
        with self.assertRaises(vault.VaultError): self.vault.execute(job["id"],"wrong",confirmed=True)
        self.assertEqual(self.install.actions,[])

    def test_success_requires_actual_copy_http_data_and_cleanup_evidence(self):
        original=vault.database_evidence(self.backup/"data/gateway.db")
        result=self.execute(self.plan())
        self.assertEqual(result["status"],"succeeded"); self.assertTrue(result["restore_drill_verified"])
        self.assertTrue(result["evidence"]["managed_sessions_revoked"])
        self.assertTrue(result["cleanup_confirmed"]); self.assertFalse(result["evidence"]["cutover_selected"])
        self.assertEqual(original,vault.database_evidence(self.backup/"data/gateway.db"))
        self.assertEqual(len(self.install.containers),0)
        self.assertNotIn("do-not-print-row",json.dumps(result))
        self.assertNotIn("not-a-real-provider-key",json.dumps(result))
        for command in self.install.actions:
            self.assertNotIn("restart",command)
            if command[0]=="run":
                self.assertIn("--read-only",command); self.assertIn("none",command)
                self.assertNotIn("--publish",command); self.assertNotIn("docker.sock"," ".join(command))
                self.assertNotIn(str(self.backup)+":"," ".join(command))
        calls=len(self.install.actions); self.assertEqual(self.execute(result)["id"],result["id"])
        self.assertEqual(len(self.install.actions),calls)

    def test_corrupt_backup_refuses_before_any_container_creation(self):
        job=self.plan(); (self.backup/"data/gateway.db").write_bytes(b"corrupted")
        result=self.execute(job)
        self.assertEqual(result["status"],"failed"); self.assertFalse(result["restore_drill_verified"])
        self.assertFalse(any(action[0]=="run" for action in self.install.actions))

    def test_transient_readonly_probe_failure_does_not_repeat_container_start(self):
        self.install.fail="warming"
        with patch.object(vault.time,"sleep"):
            result=self.execute(self.plan())
        self.assertEqual(result["status"],"succeeded")
        self.assertEqual(sum(action[0]=="run" for action in self.install.actions),2)
        self.assertEqual(sum(action[0]=="exec" for action in self.install.actions),2)

    def test_failed_boot_data_drift_or_unclean_stop_never_claims_restored(self):
        for failure in ("boot","data","unclean"):
            self.install.fail=failure
            result=self.execute(self.plan("request-failure-"+failure))
            with self.subTest(failure=failure):
                self.assertEqual(result["status"],"failed"); self.assertFalse(result["restore_drill_verified"])
                self.assertIsNone(result["evidence"]); self.assertTrue(result["cleanup_confirmed"])
                self.assertNotIn("private",json.dumps(result))

    def test_unconfirmed_cleanup_is_manual_attention_not_success(self):
        self.install.fail="cleanup"
        result=self.execute(self.plan())
        self.assertEqual(result["status"],"needs_attention"); self.assertFalse(result["restore_drill_verified"])

    def test_interrupted_drill_never_replays(self):
        job=self.plan(); self.vault.update(job["id"],"copying_backup",status="running")
        self.vault.reconcile_interrupted()
        self.assertEqual(self.vault.get(job["id"])["status"],"needs_attention")
        with self.assertRaises(vault.VaultError): self.execute(job)
        self.assertEqual(self.install.actions,[])

    def test_reconciliation_cancels_planned_drill_and_never_replays_it(self):
        job=self.plan()
        result=self.vault.reconcile_for_control(job["id"],job["plan_digest"])
        self.assertEqual(result["status"],"cancelled")
        with self.assertRaises(vault.VaultError): self.execute(job)
        self.assertEqual(self.install.actions,[])

    def test_reconciliation_cleans_only_owned_isolation_without_claiming_success(self):
        self.install.fail="cleanup"; job=self.plan(); result=self.execute(job)
        self.assertEqual(result["status"],"needs_attention")
        self.install.fail=None; before=len(self.install.actions)
        result=self.vault.reconcile_for_control(job["id"],job["plan_digest"])
        self.assertEqual(result["status"],"resolved"); self.assertTrue(result["cleanup_confirmed"])
        self.assertFalse(result["restore_drill_verified"]); self.assertEqual(self.install.containers,{})
        self.assertFalse(any(action[0]=="run" for action in self.install.actions[before:]))

    def test_busy_or_foreign_drill_cleanup_never_unlocks_attention(self):
        import siftgate_operator as operator
        job=self.plan()
        with operator.file_lock(self.vault.root/"worker.lock"):
            with self.assertRaises(operator.OperatorFailure): self.vault.reconcile_for_control(job["id"],job["plan_digest"])
        self.install.fail="cleanup"; self.execute(job)
        for container in self.install.containers.values(): container["Config"]["Labels"]["siftgate.vault.installation"]="d"*32
        before=len(self.install.actions)
        result=self.vault.reconcile_for_control(job["id"],job["plan_digest"])
        self.assertEqual(result["status"],"needs_attention"); self.assertFalse(result["cleanup_confirmed"])
        self.assertFalse(any(action[0] in ("stop","rm") for action in self.install.actions[before:]))

    def test_catalog_distinguishes_past_drill_from_current_integrity(self):
        catalog=self.vault.catalog(); self.assertIsNone(catalog["items"][0]["last_verified_drill"])
        result=self.execute(self.plan()); item=self.vault.catalog()["items"][0]
        self.assertEqual(item["last_verified_drill"],result["id"])
        self.assertEqual(item["integrity"],"not_rechecked_by_catalog")
        self.assertFalse(item["cutover_selected"])

    def test_existing_backups_visible_before_first_vault_initialization(self):
        self.vault.drills.rmdir(); self.vault.root.rmdir()
        reader=vault.Vault(self.install,create=False)
        self.assertEqual(reader.catalog()["items"][0]["id"],self.backup_id)
        self.assertFalse(reader.root.exists())

    def test_wal_or_missing_key_tables_cannot_pass_immutable_database_check(self):
        wal=Path(str(self.backup/"data/gateway.db")+"-wal"); wal.write_bytes(b"uncheckpointed")
        with self.assertRaises(vault.VaultError): vault.database_evidence(self.backup/"data/gateway.db")
        wal.unlink()
        connection=sqlite3.connect(self.backup/"data/gateway.db"); connection.execute("DROP TABLE gateway_api_keys"); connection.commit(); connection.close()
        with self.assertRaises(vault.VaultError): vault.database_evidence(self.backup/"data/gateway.db")

    def test_only_declared_boot_timestamps_are_excluded_not_business_data(self):
        file=self.backup/"data/gateway.db"
        connection=sqlite3.connect(file)
        connection.execute("ALTER TABLE workspaces ADD COLUMN updated_at text default 'before'")
        connection.commit(); connection.close()
        before=vault.database_evidence(file)
        connection=sqlite3.connect(file); connection.execute("UPDATE workspaces SET updated_at='after'"); connection.commit(); connection.close()
        self.assertEqual(before,vault.database_evidence(file))
        self.assertEqual(before["tables"]["workspaces"]["ignored_operational_columns"],["updated_at"])
        connection=sqlite3.connect(file); connection.execute("UPDATE call_logs SET value='changed billing receipt'"); connection.commit(); connection.close()
        self.assertNotEqual(before,vault.database_evidence(file))


if __name__ == "__main__": unittest.main()
