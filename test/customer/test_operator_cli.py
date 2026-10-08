"""CLI flag contracts without a real install, daemon or publisher verifier."""
import contextlib
import io
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0,str(Path(__file__).resolve().parents[2]/"deploy/customer"))
import siftgate_operator as operator


class OperatorCLITests(unittest.TestCase):
    def call(self,*args):
        with contextlib.redirect_stdout(io.StringIO()):
            operator.main(["--directory","/synthetic/not-a-live-install",*args])

    def test_release_digest_and_offline_are_forwarded_without_manual_image_approval(self):
        instance=Mock()
        with patch.object(operator,"Operator",return_value=instance), patch.object(operator,"public_job",return_value={}):
            self.call("plan","upgrade","--request-id","cli-release-001","--release-digest","a"*64,"--offline")
        instance.plan_verified.assert_called_once_with("a"*64,"cli-release-001",offline=True)
        instance.plan.assert_not_called()

    def test_invalid_flag_combinations_fail_without_creating_plans(self):
        instance=Mock()
        for flags in (("plan","backup","--request-id","cli-invalid-001","--offline"),
                      ("plan","backup","--request-id","cli-invalid-001","--release-digest","a"*64),
                      ("plan","backup","--request-id","cli-invalid-001","--image","sha256:"+"b"*64)):
            with patch.object(operator,"Operator",return_value=instance), self.assertRaises(operator.OperatorFailure): self.call(*flags)
        instance.plan.assert_not_called(); instance.plan_verified.assert_not_called()

    def test_image_and_release_digest_are_mutually_exclusive(self):
        with contextlib.redirect_stderr(io.StringIO()), patch.object(operator,"Operator") as constructor, self.assertRaises(SystemExit):
            self.call("plan","upgrade","--request-id","cli-invalid-002","--release-digest","a"*64,"--image","sha256:"+"b"*64)
        constructor.assert_not_called()


if __name__=="__main__": unittest.main()
