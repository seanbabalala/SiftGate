"""Standard-library regression tests; never contact Docker or a live gateway."""
import importlib.util
import argparse
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2] / "deploy/customer/siftgate.py"
SPEC = importlib.util.spec_from_file_location("customer_kit", SOURCE)
KIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(KIT)


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.install = KIT.Install(self.root, {"id": "a" * 32, "port": 12345, "project": "siftgate-test"})

    def tearDown(self):
        self.temp.cleanup()

    def snapshot(self, name, purpose="routine", installation="a" * 32, date="2026-01-01"):
        path = self.root / name
        for folder in ("config", "data", "state"):
            (path / folder).mkdir(parents=True)
        (path / "config/gateway.config.yaml").write_text("synthetic fixture")
        (path / "data/gateway.db").write_bytes(b"synthetic fixture; not a live DB")
        (path / "provider.env").write_text("# no secrets")
        KIT.write_json(path / "manifest.json", {
            "format": KIT.BACKUP_FORMAT, "installation": {"id": installation}, "purpose": purpose,
            "created_at": date, "files": KIT.inventory(path),
        })
        return path

    def test_image_references_fail_closed(self):
        for value in ("image", "image:latest", "--privileged", "image:tag;bad", "image:tag\n"):
            with self.subTest(value=value), self.assertRaises(KIT.OperatorError):
                KIT.check_image_ref(value)
        KIT.check_image_ref("ghcr.io/example/siftgate:v2.11.6")
        KIT.check_image_ref("sha256:" + "a" * 64)

    def test_backup_checksum_and_unexpected_files(self):
        snapshot = self.snapshot("backup-a")
        KIT.verified_snapshot(snapshot)
        (snapshot / "unexpected.txt").write_text("must reject")
        with self.assertRaises(KIT.OperatorError):
            KIT.verified_snapshot(snapshot)

    def test_changed_backup_rejected(self):
        snapshot = self.snapshot("backup-a")
        (snapshot / "data/gateway.db").write_text("corrupt")
        with self.assertRaises(KIT.OperatorError):
            KIT.verified_snapshot(snapshot)

    def test_symlinks_rejected(self):
        snapshot = self.snapshot("backup-a")
        (snapshot / "data/link").symlink_to(self.root)
        with self.assertRaises(KIT.OperatorError):
            KIT.verified_snapshot(snapshot)

    def test_rotation_preserves_foreign_upgrade_and_incomplete(self):
        old = self.snapshot("backup-old")
        new = self.snapshot("backup-new", date="2026-01-02")
        protected = self.snapshot("backup-upgrade", purpose="upgrade")
        foreign = self.snapshot("backup-foreign", installation="b" * 32)
        partial = self.root / "backup-partial"
        partial.mkdir()
        KIT.prune_snapshots(self.root, "a" * 32, 1, new)
        self.assertFalse(old.exists())
        for path in (new, protected, foreign, partial):
            self.assertTrue(path.exists())

    def test_occupied_port_is_not_killed(self):
        import socket
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            self.install.meta.update(bind="127.0.0.1", port=sock.getsockname()[1])
            with self.assertRaises(KIT.OperatorError):
                self.install.check_port()
            self.assertGreater(sock.fileno(), -1)

    def test_maintenance_suppresses_watchdog(self):
        (self.root / "maintenance").touch()
        with patch.object(self.install, "container") as container:
            self.assertEqual(self.install.watchdog(True)["status"], "maintenance")
            container.assert_not_called()

    def test_watchdog_does_not_start_stopped_container(self):
        with patch.object(self.install, "container", return_value={"State": {"Running": False}}), \
                patch.object(self.install, "docker") as docker:
            self.assertEqual(self.install.watchdog(True)["status"], "not-running")
            docker.assert_not_called()

    def test_watchdog_threshold_cooldown_and_identity(self):
        container = {"Id": "owned-container", "State": {"Running": True}}
        with patch.object(self.install, "container", return_value=container), \
                patch.object(KIT, "local_probe", return_value=False), \
                patch.object(KIT.time, "time", return_value=1000), \
                patch.object(self.install, "docker") as docker:
            self.assertEqual(self.install.watchdog(True)["status"], "probe-failed")
            self.assertEqual(self.install.watchdog(True)["status"], "probe-failed")
            self.assertEqual(self.install.watchdog(True)["status"], "restart-attempted")
            self.install.watchdog(True)
            self.install.watchdog(True)
            self.assertEqual(self.install.watchdog(True)["status"], "rate-limited")
            docker.assert_called_once_with("restart", "--time", "45", "owned-container", timeout=90)

    def test_watchdog_observe_only(self):
        with patch.object(self.install, "container", return_value={"Id": "owned", "State": {"Running": True}}), \
                patch.object(KIT, "local_probe", return_value=False), patch.object(self.install, "docker") as docker:
            for _ in range(5):
                self.install.watchdog(False)
            docker.assert_not_called()

    def test_corrupt_watchdog_state_refuses_recovery(self):
        (self.root / "watchdog.json").write_text(json.dumps({"failures": -1, "restarts": []}))
        with patch.object(self.install, "container", return_value={"State": {"Running": True}}), \
                self.assertRaises(KIT.OperatorError):
            self.install.watchdog(True)

    def test_operator_lock_is_exclusive(self):
        with KIT.operator_lock(self.root):
            with self.assertRaises(KIT.OperatorError), KIT.operator_lock(self.root):
                pass

    def test_restart_reuses_owned_desktop_port_forward(self):
        with patch.object(self.install, "container", return_value={"State": {"Running": False}}), \
                patch.object(self.install, "check_port") as port, \
                patch.object(self.install, "helper"), patch.object(self.install, "compose"), \
                patch.object(self.install, "wait_ready"):
            self.install.up()
            port.assert_not_called()

    def test_failed_upgrade_never_starts_old_code_or_restores_data(self):
        self.install.meta.update(image="sha256:" + "a" * 64, image_source="image:old")
        with patch.object(self.install, "container", return_value={"State": {"Running": True}}), \
                patch.object(self.install, "resolve_image", return_value="sha256:" + "b" * 64), \
                patch.object(self.install, "helper"), patch.object(self.install, "check_disk"), \
                patch.object(self.install, "stop"), patch.object(self.install, "save"), \
                patch.object(self.install, "snapshot", return_value=self.root / "backup-test"), \
                patch.object(self.install, "wait_ready", side_effect=KIT.OperatorError("failed")), \
                patch.object(self.install, "compose") as compose:
            with self.assertRaises(KIT.OperatorError):
                self.install.upgrade("image:new", True)
            self.assertTrue((self.root / "maintenance").exists())
            self.assertEqual(self.install.meta["image"], "sha256:" + "b" * 64)
            self.assertEqual(compose.call_args_list[-1].args[:1], ("stop",))
            self.assertEqual(len(compose.call_args_list), 2)

    def test_init_refuses_existing_directory_before_docker(self):
        args = argparse.Namespace(directory=str(self.root))
        with patch.object(KIT, "run") as run, self.assertRaises(KIT.OperatorError):
            KIT.prepare(args, "image:v1")
        run.assert_not_called()

    def test_restore_checks_image_before_mounting_customer_files(self):
        target = self.root / "new"
        args = argparse.Namespace(directory=str(target), port=12345, bind="127.0.0.1", mode="local",
                                  timezone="UTC", docker_host="unix:///tmp/synthetic.sock", local_image=True)
        with patch.object(KIT.Install, "check_engine"), patch.object(KIT.Install, "check_port"), \
                patch.object(KIT.Install, "resolve_image", return_value="sha256:" + "b" * 64), \
                patch.object(KIT.Install, "helper") as helper:
            with self.assertRaises(KIT.OperatorError):
                KIT.prepare(args, "image:v1", prior=self.root, expected_image="sha256:" + "a" * 64)
            helper.assert_not_called()
            self.assertFalse(target.exists())

    def test_release_archive_uses_only_committed_allowlist_and_is_reproducible(self):
        source = SOURCE.parents[2] / "scripts/package-customer-release.py"
        spec = importlib.util.spec_from_file_location("packager", source)
        package = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(package)
        repo = self.root / "repository"
        repo.mkdir()
        def git(*args):
            return subprocess.check_output(["git", "-C", str(repo), *args], stderr=subprocess.DEVNULL)
        git("init")
        git("config", "user.name", "Synthetic test")
        git("config", "user.email", "test@example.invalid")
        for name in package.FILES:
            path = repo / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("committed fixture " + name)
        git("add", ".")
        git("commit", "-m", "test fixture")
        (repo / "provider.env").write_text("DO_NOT_EXPORT=synthetic")
        (repo / "gateway.config.example.yaml").write_text("DO_NOT_EXPORT=dirty fixture")
        archives = []
        for index in range(2):
            output = self.root / f"output-{index}"
            argv = ["package", "--version", "test-v1", "--image", "ghcr.io/example/siftgate@sha256:" + "a" * 64,
                    "--output", str(output)]
            with patch.object(package, "ROOT", repo), patch.object(sys, "argv", argv), patch("builtins.print"):
                package.main()
            archives.append((output / "siftgate-test-v1-install.tar.gz").read_bytes())
            with tarfile.open(output / "siftgate-test-v1-install.tar.gz") as archive:
                self.assertEqual(len(archive.getnames()), len(package.FILES) + 2)
                for member in archive.getmembers():
                    self.assertNotIn(b"DO_NOT_EXPORT", archive.extractfile(member).read())
        self.assertEqual(archives[0], archives[1])


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        source = SOURCE.parents[2] / "scripts/upload-customer-assets.py"
        spec = importlib.util.spec_from_file_location("release_assets", source)
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.tag = "v1.2.3"
        self.names = ["siftgate-v1.2.3-install.tar.gz", "siftgate-v1.2.3-install.tar.gz.sha256"]
        (self.root / self.names[0]).write_bytes(b"synthetic archive bytes")
        (self.root / self.names[1]).write_text(
            self.module.sha256(self.root / self.names[0]) + "  " + self.names[0] + "\n")
        self.remote = {}
        self.uploaded = []

    def tearDown(self):
        self.temp.cleanup()

    def fake_gh(self, *args):
        operation = args[1]
        if operation == "view":
            return json.dumps({"assets": [{"name": name} for name in self.remote]})
        if operation == "download":
            name = args[args.index("--pattern") + 1]
            directory = Path(args[args.index("--dir") + 1])
            (directory / name).write_bytes(self.remote[name])
        elif operation == "upload":
            self.assertNotIn("--clobber", args)
            file = Path(args[3])
            self.assertNotIn(file.name, self.remote)
            self.remote[file.name] = file.read_bytes()
            self.uploaded.append(file.name)
        else:
            self.fail("Unexpected GitHub mutation: " + operation)
        return ""

    def test_upload_and_download_verification(self):
        with patch.object(self.module, "gh", side_effect=self.fake_gh):
            self.module.synchronize("example/siftgate", self.tag, self.root)
            self.module.synchronize("example/siftgate", self.tag, self.root, verify_only=True)
        self.assertEqual(self.uploaded, self.names)

    def test_partial_upload_resumes_only_missing_asset(self):
        self.remote[self.names[0]] = (self.root / self.names[0]).read_bytes()
        with patch.object(self.module, "gh", side_effect=self.fake_gh):
            self.module.synchronize("example/siftgate", self.tag, self.root)
            self.module.synchronize("example/siftgate", self.tag, self.root)
        self.assertEqual(self.uploaded, [self.names[1]])

    def test_different_existing_bytes_refuse_all_uploads(self):
        self.remote[self.names[1]] = b"different published bytes"
        with patch.object(self.module, "gh", side_effect=self.fake_gh), self.assertRaises(ValueError):
            self.module.synchronize("example/siftgate", self.tag, self.root)
        self.assertFalse(self.uploaded)

    def test_verify_only_cannot_upload_missing_asset(self):
        with patch.object(self.module, "gh", side_effect=self.fake_gh), self.assertRaises(ValueError):
            self.module.synchronize("example/siftgate", self.tag, self.root, verify_only=True)
        self.assertFalse(self.uploaded)

    def test_extra_private_file_never_uploaded(self):
        (self.root / "provider.env").write_text("synthetic private fixture")
        with patch.object(self.module, "gh") as gh, self.assertRaises(ValueError):
            self.module.synchronize("example/siftgate", self.tag, self.root)
        gh.assert_not_called()

    def test_corrupt_local_checksum_refuses_network(self):
        (self.root / self.names[0]).write_bytes(b"modified after checksumming")
        with patch.object(self.module, "gh") as gh, self.assertRaises(ValueError):
            self.module.synchronize("example/siftgate", self.tag, self.root)
        gh.assert_not_called()

    def test_manual_dispatch_even_of_tag_never_publishes(self):
        workflow = (SOURCE.parents[2] / ".github/workflows/customer-release.yml").read_text()
        guards = [line.strip() for line in workflow.splitlines() if line.strip().startswith("if:")]
        self.assertGreaterEqual(len(guards), 4)
        for guard in guards:
            self.assertEqual(guard, "if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/')")
        self.assertIn('"$GITHUB_EVENT_NAME" == push', workflow)
        self.assertIn('customer-image-${{ matrix.arch }}', workflow)
        self.assertIn('actions/workflows/ci.yml/runs', workflow)
        self.assertIn('"$GITHUB_REF_NAME" "${GITHUB_REF_NAME#v}"', workflow)
        self.assertIn('--draft "${flags[@]}"', workflow)
        self.assertIn('--verify-only', workflow)

    def test_customer_checks_survive_merge_and_runtime_changes(self):
        workflow = (SOURCE.parents[2] / ".github/workflows/customer-install.yml").read_text()
        self.assertIn("branches: [main, master, 'codex/**']", workflow)
        self.assertNotIn("codex/v2.11.6-customer-install", workflow)
        for dependency in ("docs/customer-*", ".nvmrc", ".npmrc", "Dockerfile", "test/runtime/**"):
            self.assertEqual(workflow.count("      - " + dependency + "\n"), 2)
        core_ci = (SOURCE.parents[2] / ".github/workflows/ci.yml").read_text()
        self.assertIn("npm run test:runtime && npm run test:customer", core_ci)


if __name__ == "__main__":
    unittest.main()
