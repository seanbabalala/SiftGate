"""Versioned host-tool integrity and explicit bootstrap without Docker actions."""
import json
from pathlib import Path
import tempfile
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[2]/"deploy/customer"))

import siftgate as kit
import siftgate_tools as tools
import siftgate_release as release
import test_release as fixtures


class HostToolTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.root=Path(self.temp.name).resolve()
        (self.root/"kit").mkdir(mode=0o700); (self.root/"kit/old-marker").write_text("old tools stay intact")
        self.install=kit.Install(self.root,{"id":"a"*32,"image":"sha256:"+"b"*64})
    def tearDown(self): self.temp.cleanup()

    def test_bootstrap_requires_owner_and_preserves_original_tools_and_runtime(self):
        with self.assertRaises(release.ReleaseError): tools.bootstrap(self.install)
        with patch.object(self.install,"docker") as docker,patch.object(self.install,"compose") as compose:
            result=tools.bootstrap(self.install,confirmed=True)
        docker.assert_not_called(); compose.assert_not_called(); self.assertFalse(result["restarted"])
        self.assertEqual((self.root/"kit/old-marker").read_text(),"old tools stay intact")
        selected=kit.tool_directory(self.root,self.install.meta)
        self.assertNotEqual(selected,self.root/"kit"); self.assertTrue((selected/"siftgate_agent.py").is_file())
        before=dict(self.install.meta)
        tools.bootstrap(self.install,confirmed=True)
        self.assertEqual(self.install.meta,before)

    def test_pointer_and_file_tampering_fail_closed_without_fallback(self):
        tools.bootstrap(self.install,confirmed=True)
        pointer=self.install.meta["host_tools"]
        directory=tools.resolve(self.root,pointer)
        (directory/"siftgate_agent.py").write_text("tampered")
        with self.assertRaises(release.ReleaseError): kit.tool_directory(self.root,self.install.meta)
        pointer["directory"]="../../elsewhere"
        with self.assertRaises(release.ReleaseError): tools.resolve(self.root,pointer)

    def test_enrolled_installation_cannot_bypass_approved_kit_switch(self):
        (self.root/"operator").mkdir(mode=0o700); (self.root/"operator/policy.json").write_text("{}")
        with self.assertRaisesRegex(release.ReleaseError,"enrolled_operator_requires_approved_tool_upgrade"):
            tools.bootstrap(self.install,confirmed=True)

    def test_verified_staging_checks_all_extracted_bytes_and_does_not_activate(self):
        fixture=fixtures.ReleaseFilesTests(); fixture.setUp()
        try:
            verified,archive=fixture.installer()
            old=dict(self.install.meta)
            pointer=tools.stage_release(self.install,verified,archive)
            self.assertEqual(self.install.meta,old)
            self.assertEqual(pointer["origin"],"verified_release")
            path=tools.resolve(self.root,pointer)
            (path/"compose.yaml").write_text("changed")
            with self.assertRaises(release.ReleaseError): tools.stage_release(self.install,verified,archive)
        finally: fixture.tearDown()

    def test_delegation_uses_exact_validated_entrypoint_and_never_a_shell(self):
        tools.bootstrap(self.install,confirmed=True)
        with patch.object(kit.Install,"load",return_value=self.install),patch.object(tools.os,"execv") as execute:
            tools.delegate(self.root,"siftgate_agent.py",["--directory",str(self.root),"rpc"])
            args=execute.call_args.args[1]
            self.assertEqual(args[1],"-B"); self.assertEqual(args[-1],"rpc")
            self.assertTrue(args[2].endswith("/siftgate_agent.py"))


if __name__=="__main__": unittest.main()
