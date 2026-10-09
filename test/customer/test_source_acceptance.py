"""Native source-matrix helpers must exercise real legacy/managed identity flows."""
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location("matrix_upgrade",ROOT/"scripts/smoke-customer-upgrade.py")
upgrade=importlib.util.module_from_spec(spec); spec.loader.exec_module(upgrade)


class SourceAcceptanceTests(unittest.TestCase):
    def test_current_and_legacy_public_images_are_both_in_the_release_contract(self):
        contract=json.loads((ROOT/"deploy/customer/release-contract.json").read_text())
        records={r["version"]:r for r in contract["source_releases"]}
        self.assertEqual(set(records),{"2.11.7","2.12.0"})
        self.assertEqual(records["2.12.0"]["source_commit"],"94a141528c19908a7acd419a9cbd22be7db5f4d8")
        self.assertEqual(records["2.12.0"]["installer_sha256"],"18441230c819a2ff346f4f50dfe752442a1a339814b30eda44d1e14b27ae0f92")
        self.assertEqual(records["2.12.0"]["image"],upgrade.release.REGISTRY+"@sha256:12bf52e23f65b7cdd940a3adfac8075cfad1f3c98c8b74134aec93549d91ac03")

    def test_managed_baseline_uses_one_time_activation_and_never_legacy_password_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); (root/"config").mkdir(); code=root/"config/activate-code.txt";code.write_text("synthetic-code")
            calls=[]
            def request(install,path,body=None):
                calls.append((path,body))
                if path=="/api/auth/status":return {"identity":{"mode":"managed","setupRequired":code.exists()}}
                if path=="/api/auth/identity/activate":self.assertEqual(body["code"],"synthetic-code");code.unlink();return {"ok":True}
                self.assertEqual(path,"/api/auth/login");return {"token":"synthetic-token"}
            with patch.object(upgrade.smoke,"request",side_effect=request):
                password,token,mode=upgrade.source_session(SimpleNamespace(root=root),"2.12.0")
            self.assertEqual((token,mode),("synthetic-token","managed"));self.assertIn("synthetic",password)
            self.assertEqual([p for p,b in calls],["/api/auth/status","/api/auth/identity/activate","/api/auth/status","/api/auth/login"])
            with patch.object(upgrade.smoke,"request",return_value={"identity":{"mode":"legacy","setupRequired":False}}),self.assertRaises(AssertionError):
                upgrade.source_session(SimpleNamespace(root=root),"2.12.0")

    def test_legacy_baseline_keeps_its_original_login_protocol(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/"config").mkdir();(root/"config/initial-admin-password.txt").write_text("synthetic legacy password")
            with patch.object(upgrade.smoke,"request",side_effect=[{}, {"token":"legacy-token"}]) as request:
                value=upgrade.source_session(SimpleNamespace(root=root),"2.11.7")
            self.assertEqual(value,("synthetic legacy password","legacy-token","legacy"))
            self.assertEqual(request.call_count,2)

    def test_source_recovery_and_new_notice_endpoint_remain_native_acceptance_gates(self):
        collector=(ROOT/"scripts/run-customer-acceptance.py").read_text()
        self.assertIn('for record in contract["source_releases"]',collector)
        for check in ('source_recovery_version_mismatch','source_identity_receipt_mismatch','release_notice_api_available'):
            self.assertIn(check,collector)
        self.assertIn('"docs/release-updates.md": "release-updates.md"',(ROOT/"scripts/package-customer-release.py").read_text())
