"""Verified upgrade orchestration; publisher verifier is mocked, never claimed real."""
import copy
from pathlib import Path
import unittest
from unittest.mock import patch

import test_operator as operator_fixtures
import test_release as release_fixtures
import siftgate_operator as operator
import siftgate_release as release
from siftgate_releases import ReleaseCache


class VerifiedUpgradeTests(unittest.TestCase):
    def setUp(self):
        self.fixture=operator_fixtures.OperatorTests(); self.fixture.setUp()
        self.op=self.fixture.operator; self.op.policy["development"]=False
        self.release_fixture=release_fixtures.ReleaseFilesTests(); self.release_fixture.setUp()
        self.verified,self.archive=self.release_fixture.installer()
        # get() returns a verified bundle directory. Its archive name is stable.
        (self.archive.parent/"installer.tar.gz").write_bytes(self.archive.read_bytes())
        self.patches=[patch.object(ReleaseCache,"get",return_value=(self.verified,self.archive.parent)),
            patch.object(ReleaseCache,"prepare_image",return_value={"runtime_image_id":operator_fixtures.TARGET,"config_digest":"sha256:"+"d"*64,"architecture":"arm64"}),
            patch.object(release,"inspect_local_image",side_effect=lambda install,image,scratch:{"runtime_image_id":image,"architecture":"arm64",
                "config_digest":"sha256:"+("f" if image==operator_fixtures.IMAGE else "d")*64})]
        for item in self.patches: item.start()
    def tearDown(self):
        for item in reversed(self.patches): item.stop()
        self.release_fixture.tearDown(); self.fixture.tearDown()
    def plan(self): return self.op.plan_verified(self.verified.digest,"verified-release-request")

    def test_production_manual_image_path_is_not_a_signature_bypass(self):
        with self.assertRaisesRegex(operator.OperatorFailure,"verified_release_required"):
            self.op.plan("upgrade","manual-release-request",release.REGISTRY+"@sha256:"+"d"*64)

    def test_source_config_compatibility_and_atomic_image_kit_selection(self):
        job=self.plan()
        self.assertEqual(job["plan"]["target"]["trust"],"publisher_attested")
        self.assertNotIn("stop",self.fixture.install.actions)
        self.op.approve(job["id"],job["plan_digest"],self.fixture.clock[0],self.fixture.clock[0]+600,True,False)
        saved=[]; original=self.fixture.install.save
        def save(): saved.append(copy.deepcopy(self.fixture.install.meta)); original()
        with patch.object(self.fixture.install,"save",side_effect=save): result=self.op.run_once(job["id"])
        self.assertEqual(result["status"],"succeeded")
        self.assertTrue(saved)
        for metadata in saved:
            if metadata["image"]==operator_fixtures.TARGET:
                self.assertEqual(metadata["host_tools"]["release_digest"],self.verified.digest)
                self.assertEqual(metadata["app_version"],"2.12.0")
        self.assertEqual(self.plan()["id"],job["id"])
        self.op.check_identity()  # Bootstrap remains pinned while active tools change.

    def test_changed_staged_tools_refuse_approval_before_stop(self):
        job=self.plan()
        selected=self.fixture.root/job["plan"]["verified_release"]["host_tools"]["directory"]
        (selected/"compose.yaml").write_text("changed after review")
        with self.assertRaises(release.ReleaseError):
            self.op.approve(job["id"],job["plan_digest"],self.fixture.clock[0],self.fixture.clock[0]+600,True,False)
        self.assertNotIn("stop",self.fixture.install.actions)

    def test_bad_signature_never_creates_an_upgrade_plan(self):
        with patch.object(ReleaseCache,"get",side_effect=release.ReleaseError("publisher_verification_failed")):
            with self.assertRaises(release.ReleaseError): self.plan()
        self.assertEqual(self.op.store.jobs(),[])
        self.assertNotIn("stop",self.fixture.install.actions)


if __name__=="__main__": unittest.main()
