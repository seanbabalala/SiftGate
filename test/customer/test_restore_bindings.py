"""Portable image and frozen-tool checks must happen before mounting customer data."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

import test_vault as vault_fixtures
import siftgate as kit
import siftgate_release as release


class RestoreBindingTests(unittest.TestCase):
    def setUp(self):
        self.fixture=vault_fixtures.VaultTests(); self.fixture.setUp()
        self.root=self.fixture.root; self.backup=self.fixture.backup
        shutil.copytree(self.root/"kit",self.backup/"kit")
        self.manifest=json.loads((self.backup/"manifest.json").read_text())
        self.manifest.update(image_binding={"format":"siftgate-backup-image-v1","runtime_image_id":"sha256:"+"b"*64,
            "config_digest":"sha256:"+"d"*64,"architecture":"arm64"},
            recovery_kit={"format":"siftgate-backup-kit-v1","files_digest":hashlib.sha256(release.canonical(kit.inventory(self.backup/"kit"))).hexdigest()},
            files=kit.inventory(self.backup))
        kit.write_json(self.backup/"manifest.json",self.manifest)
        self.loaded="sha256:"+"f"*64
    def tearDown(self): self.fixture.tearDown()
    def args(self):
        return argparse.Namespace(directory=str(self.root/"new-restore"),port=12345,bind="127.0.0.1",mode="local",
            timezone="UTC",docker_host="unix:///synthetic/docker.sock",local_image=True)

    def test_config_digest_is_portable_but_legacy_runtime_id_is_not_reinterpreted(self):
        kit.verified_snapshot(self.backup)
        identity={"runtime_image_id":self.loaded,"config_digest":"sha256:"+"d"*64,"architecture":"arm64"}
        with patch.object(release,"inspect_local_image",return_value=identity) as inspect:
            kit.check_restore_image(self.fixture.install,self.manifest,self.loaded,self.root)
            self.assertEqual(inspect.call_count,1)
            legacy={key:value for key,value in self.manifest.items() if key!="image_binding"}
            with self.assertRaisesRegex(kit.OperatorError,"Legacy backup"):
                kit.check_restore_image(self.fixture.install,legacy,self.loaded,self.root)

    def test_wrong_configuration_is_rejected_before_copying_or_mounting_files(self):
        with patch.object(kit.Install,"check_engine"),patch.object(kit.Install,"check_port"), \
                patch.object(kit.Install,"resolve_image",return_value=self.loaded),patch.object(kit.Install,"helper") as helper, \
                patch.object(release,"inspect_local_image",return_value={"runtime_image_id":self.loaded,"config_digest":"sha256:"+"e"*64,"architecture":"arm64"}):
            with self.assertRaisesRegex(kit.OperatorError,"configuration differs"):
                kit.prepare(self.args(),self.loaded,prior=self.backup,backup_manifest=self.manifest)
            helper.assert_not_called(); self.assertFalse((self.root/"new-restore").exists())

    def test_legacy_manifest_id_cannot_be_reused_on_another_engine_or_architecture(self):
        legacy={key:value for key,value in self.manifest.items() if key!="image_binding"}
        for change in ({"engine_id":"another-engine"},{"engine_arch":"amd64"}):
            original=dict(self.fixture.install.meta); self.fixture.install.meta.update(change)
            with self.assertRaisesRegex(kit.OperatorError,"original engine"):
                kit.check_restore_image(self.fixture.install,legacy,legacy["installation"]["image"],self.root)
            self.fixture.install.meta=original

    def test_restore_uses_frozen_kit_not_new_invoking_checkout(self):
        identity={"runtime_image_id":self.loaded,"config_digest":"sha256:"+"d"*64,"architecture":"arm64"}
        with patch.object(kit.Install,"check_engine"),patch.object(kit.Install,"check_port"), \
                patch.object(kit.Install,"resolve_image",return_value=self.loaded),patch.object(kit.Install,"helper",return_value='{"ok":true,"action":"restore-identity","identity_mode":"managed"}'), \
                patch.object(release,"inspect_local_image",return_value=identity),patch.object(kit,"HERE",self.root/"nonexistent-newer-kit"):
            restored=kit.prepare(self.args(),self.loaded,prior=self.backup,backup_manifest=self.manifest)
        self.assertEqual(restored.meta["image"],self.loaded)
        self.assertEqual(kit.inventory(restored.root/"kit"),kit.inventory(self.backup/"kit"))
        self.assertEqual((restored.root/"provider.env").read_bytes(),(self.backup/"provider.env").read_bytes())

    def test_missing_or_unbound_tools_and_inconsistent_image_evidence_fail(self):
        for change in ({"recovery_kit":None},{"recovery_kit":{"format":"siftgate-backup-kit-v1","files_digest":"0"*64}},
                       {"image_binding":{**self.manifest["image_binding"],"runtime_image_id":self.loaded}}):
            kit.write_json(self.backup/"manifest.json",{**self.manifest,**change})
            with self.assertRaises(kit.OperatorError): kit.verified_snapshot(self.backup)

    def test_vault_mounts_backup_kit_even_if_installed_kit_was_replaced(self):
        job=self.fixture.plan()
        (self.root/"kit/container-ops.cjs").write_text("different active tools after upgrade")
        identity={"runtime_image_id":job["plan"]["image"],"config_digest":"sha256:"+"d"*64,"architecture":"arm64"}
        with patch.object(release,"inspect_local_image",return_value=identity): result=self.fixture.execute(job)
        self.assertEqual(result["status"],"succeeded")
        for command in self.fixture.install.actions:
            if command[0]=="run": self.assertIn(str(self.backup/"kit")+":/opt/siftgate-kit:ro",command)
        self.assertTrue(result["evidence"]["frozen_backup_kit"])

    def test_changed_toolkit_refuses_drill_before_customer_copy(self):
        job=self.fixture.plan()
        (self.backup/"kit/container-ops.cjs").write_text("changed")
        result=self.fixture.execute(job)
        self.assertEqual(result["status"],"failed")
        self.assertFalse((self.fixture.vault.drills/job["id"]/"restored").exists())
        self.assertFalse(any(command[0]=="run" for command in self.fixture.install.actions))


if __name__=="__main__": unittest.main()
