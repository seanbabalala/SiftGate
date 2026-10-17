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
    def test_synthetic_host_policy_preserves_other_environment_bytes_and_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); environment=root/"provider.env"
            previous=b"# Synthetic fixture\nSYNTHETIC_SETTING=preserved\n"
            environment.write_bytes(previous); environment.chmod(0o600)
            install=SimpleNamespace(root=root,meta={"port":32199})
            upgrade.smoke.disable_release_discovery(install)
            self.assertEqual(environment.read_bytes(),previous+b"\nSIFTGATE_RELEASE_UPDATES_DISABLED=1\n")
            self.assertEqual(environment.stat().st_mode & 0o777,0o600)
            self.assertEqual(list(root.iterdir()),[environment])
            with self.assertRaises(AssertionError): upgrade.smoke.disable_release_discovery(install)
            with self.assertRaises(AssertionError): upgrade.smoke.disable_release_discovery(SimpleNamespace(root=root,meta={"port":2099}))

    def test_native_notice_probe_requires_host_policy_and_no_background_attempt(self):
        expected={"host_disabled":True,"enabled":False,"state":"disabled","last_attempt_at":None}
        with patch.object(upgrade.smoke,"request",return_value=expected) as request:
            self.assertEqual(upgrade.assert_release_discovery_disabled(None,"synthetic-token"),expected)
            request.assert_called_once_with(None,"/api/dashboard/release-updates",token="synthetic-token")
        for field,value in (("host_disabled",False),("enabled",True),("state","error"),("last_attempt_at",1)):
            with self.subTest(field=field),patch.object(upgrade.smoke,"request",return_value={**expected,field:value}),self.assertRaises(AssertionError):
                upgrade.assert_release_discovery_disabled(None,"synthetic-token")

    def test_current_and_legacy_public_images_are_both_in_the_release_contract(self):
        contract=json.loads((ROOT/"deploy/customer/release-contract.json").read_text())
        records={r["version"]:r for r in contract["source_releases"]}
        self.assertEqual(set(records),{"2.11.7","2.12.0","2.12.1","2.12.3","2.12.4"})
        self.assertEqual(records["2.12.4"]["source_commit"],"8f9b51bdd4d559a11e9e599397cc07fea0eb9432")
        self.assertEqual(records["2.12.4"]["installer_sha256"],"e813c0d0575dbd075931799f68fb0a67fdfc0f30b040a1cffff91a3034e1b7e1")
        self.assertEqual(records["2.12.4"]["image"],"ghcr.io/seanbabalala/ai-gateway@sha256:2ef931369bff0efebed52c3e84df9a876d79509909eb6154001a9c5093b9977e")
        self.assertEqual(records["2.12.3"]["source_commit"],"b5140f2a7a2e8abd46366ef1212236ba1f297601")
        self.assertEqual(records["2.12.3"]["installer_sha256"],"68a9a1b6309d6aaec9bbfc29c37c0b272345673c2090bcc07405c1ebd271a356")
        self.assertEqual(records["2.12.3"]["image"],"ghcr.io/seanbabalala/ai-gateway@sha256:2a7eb90c3ebf6c0373457777ecb25a06c21925fc1e9346d426004f0bfe123ea3")
        self.assertEqual(records["2.12.0"]["source_commit"],"94a141528c19908a7acd419a9cbd22be7db5f4d8")
        self.assertEqual(records["2.12.1"]["source_commit"],"281316d993990c2fd872f90bf4438918431c6cf6")
        self.assertEqual(records["2.12.1"]["installer_sha256"],"accf019039d4810ecbe25db9c7934077ed8824306593703b309daf6df842bd10")
        self.assertEqual(records["2.12.1"]["image"],upgrade.release.REGISTRY+"@sha256:695cc662caa19a3a9c4c01404b6c0c78268396471a86719be6249fc76ee1f481")
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
        self.assertEqual(collector.count('assert_checks(migrated,{"background_release_checks_disabled"})'),1)
        self.assertEqual(collector.count('assert_checks(fleet,{"background_release_checks_disabled"})'),1)
