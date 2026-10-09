"""Release trust boundary unit tests. No registry calls, real signatures or Docker."""
import copy
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "deploy/customer"))
import siftgate_release as release
import siftgate as kit


def fixture():
    return {"format": release.FORMAT, "repository": release.REPOSITORY, "version": "2.12.0", "tag": "v2.12.0",
            "source_commit": "a" * 40, "built_at": "2026-10-08T00:00:00Z", "image": release.REGISTRY + "@sha256:" + "b" * 64,
            "platforms": {"linux/" + arch: {"image": release.REGISTRY + "@sha256:" + digest * 64,
                                           "config_digest": "sha256:" + digest * 64} for arch, digest in (("amd64", "c"), ("arm64", "d"))},
            "installer": {"name": "siftgate-v2.12.0-install.tar.gz", "sha256": "e" * 64, "bytes": 123},
            "compatibility": {"source_versions": ["2.11.7"], "source_config_digests": {"2.11.7": {"linux/amd64": "sha256:" + "e" * 64, "linux/arm64": "sha256:" + "f" * 64}},
                              "source_kit_protocols": [1, 2], "target_kit_protocol": 2,
                              "operator_protocol": 1, "database": {"type": "sqlite", "migration": "startup_schema_sync", "reversible": False},
                              "downtime_required": True},
            "changes": [{"kind": "feature", "summary": "Synthetic lifecycle test release"}]}


class ReleaseContractTests(unittest.TestCase):
    def test_exact_compatibility_and_real_disruption_boundary(self):
        manifest = release.validate_manifest(fixture())
        verified = release.VerifiedRelease(manifest, "f" * 64)
        result = verified.compatibility("2.11.7", "arm64", source_kit=1, current_config_digest="sha256:" + "f" * 64)
        self.assertTrue(result["compatible"])
        self.assertTrue(result["downtime_required"])
        self.assertFalse(result["automatic_rollback"])
        self.assertIn("source_image_not_tested", verified.compatibility("2.11.7", "arm64")["reasons"])
        self.assertIn("source_image_not_tested", verified.compatibility("2.11.7", "arm64", current_config_digest="sha256:"+"0"*64)["reasons"])
        for version, arch, kit, database, reason in (("2.11.5", "arm64", 1, "sqlite", "source_version_not_tested"),
                    ("2.12.0", "arm64", 2, "sqlite", "not_an_upgrade"), ("3.0.0", "arm64", 2, "sqlite", "not_an_upgrade"),
                    ("2.11.7", "ppc64", 2, "sqlite", "unsupported_architecture"), ("2.11.7", "arm64", 9, "sqlite", "source_kit_not_supported"),
                    ("2.11.7", "arm64", 2, "postgres", "database_native_plan_required")):
            with self.subTest(reason=reason):
                result = verified.compatibility(version, arch, kit, database, current_config_digest="sha256:" + "f" * 64)
                self.assertFalse(result["compatible"]); self.assertIn(reason, result["reasons"])
        mutated = verified.manifest; mutated["version"] = "9.0.0"
        self.assertEqual(verified.manifest["version"], "2.12.0")

    def test_rejects_ambiguous_unsupported_or_unsafe_contracts(self):
        cases = [lambda x: x.update(repository="attacker/fork"), lambda x: x.update(tag="v9.0.0"),
                 lambda x: x.update(image=release.REGISTRY + ":latest"), lambda x: x.update(version="2.12.0-beta.1"),
                 lambda x: x.update(source_commit="bad"), lambda x: x["compatibility"].update(downtime_required=False),
                 lambda x: x["compatibility"].update(source_versions=[{}]), lambda x: x["compatibility"].update(source_versions=["2.11.7", "2.11.7"]),
                 lambda x: x["compatibility"].update(source_versions=["2.13.0"]), lambda x: x["compatibility"].update(target_kit_protocol=3),
                 lambda x: x["compatibility"]["database"].update(reversible=True), lambda x: x["installer"].update(bytes=True),
                 lambda x: x["installer"].update(name="../../installer.py"), lambda x: x["changes"][0].update(summary="bad\0text"),
                 lambda x: x["platforms"]["linux/arm64"].update(image="http://127.0.0.1:2099"), lambda x: x.update(extra="unknown")]
        for index, mutate in enumerate(cases):
            with self.subTest(index=index):
                item = fixture(); mutate(item)
                with self.assertRaises(release.ReleaseError): release.validate_manifest(item)

    def test_duplicate_keys_and_nonfinite_json_fail(self):
        for raw in (b'{"version":1,"version":2}', b'{"value":NaN}', b'\xff', b'{'):
            with self.subTest(raw=raw), self.assertRaises(release.ReleaseError): release.json_bytes(raw)


class ReleaseFilesTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve(); os.chmod(self.root, 0o700)
        self.manifest = fixture()
        self.file = self.root / "release.json"; self.file.write_bytes(release.canonical(self.manifest))
        self.bundle = self.root / "attestation.jsonl"; self.bundle.write_text('{"unit_fixture":true}')
        self.calls = []
    def tearDown(self): self.temporary.cleanup()
    def runner(self, args, **kwargs):
        self.calls.append((args, kwargs))
        if args == ["gh", "version"]: return "gh version 2.86.0 (2026-01-21)"
        return json.dumps([{"verificationResult": {"statement": {"predicateType": "https://slsa.dev/provenance/v1",
                     "subject": [{"digest": {"sha256": hashlib.sha256(self.file.read_bytes()).hexdigest()}}]}}}])

    def test_delegates_signature_check_with_exact_publisher_tag_commit_and_workflow(self):
        # Fake runner exercises invocation/policy only, NOT cryptographic acceptance.
        verified = release.verify_release(self.file, self.bundle, runner=self.runner)
        args, options = self.calls[-1]
        for flag, expected in (("--hostname", "github.com"), ("--repo", release.REPOSITORY), ("--source-ref", "refs/tags/v2.12.0"),
                               ("--source-digest", "a" * 40),
                               ("--cert-identity", "https://" + release.WORKFLOW + "@refs/tags/v2.12.0")):
            self.assertEqual(args[args.index(flag)+1], expected)
        self.assertIn("--deny-self-hosted-runners", args)
        for exclusive in ("--signer-workflow", "--signer-repo", "--cert-identity-regex"):
            self.assertNotIn(exclusive, args)
        for name in ("customer-release-quickref.md", "customer-artifact-verification.md",
                     "customer-release.md", "customer-release.zh-cn.md"):
            commands = (Path(__file__).resolve().parents[2] / "docs" / name).read_text()
            self.assertNotIn("--signer-workflow github.com/", commands)
            self.assertIn('--cert-identity "https://', commands)
        self.assertEqual(options["output_limit"], 4*1024*1024)
        self.assertEqual(verified.digest, hashlib.sha256(self.file.read_bytes()).hexdigest())

    def test_verifier_failure_wrong_subject_or_missing_verifier_never_passes(self):
        for outcome in ("failure", "wrong-subject", "empty", "old", "missing"):
            def runner(args, **kwargs):
                if outcome == "missing": raise FileNotFoundError()
                if args == ["gh", "version"]: return "gh version " + ("2.50.0" if outcome == "old" else "2.86.0")
                if outcome == "failure": raise kit.OperatorError("PRIVATE DIAGNOSTIC")
                return "[]" if outcome == "empty" else '[{"verificationResult":{"statement":{"subject":[]}}}]'
            with self.subTest(outcome=outcome), self.assertRaises(release.ReleaseError) as error:
                release.verify_release(self.file, self.bundle, runner=runner)
            self.assertNotIn("PRIVATE", str(error.exception))

    def test_offline_root_requires_an_out_of_band_pin(self):
        root = self.root / "trusted-root.jsonl"; root.write_text("synthetic trust root")
        with self.assertRaises(release.ReleaseError): release.verify_release(self.file, self.bundle, trusted_root=root, runner=self.runner)
        with self.assertRaises(release.ReleaseError): release.verify_release(self.file, self.bundle, trusted_root=root, trusted_root_sha256="0"*64, runner=self.runner)
        digest = hashlib.sha256(root.read_bytes()).hexdigest()
        release.verify_release(self.file, self.bundle, trusted_root=root, trusted_root_sha256=digest, runner=self.runner)
        self.assertIn("--custom-trusted-root", self.calls[-1][0])

    def test_private_file_read_rejects_links_fifo_and_overlimit(self):
        target = self.root / "unsafe"
        target.symlink_to(self.file)
        with self.assertRaises(release.ReleaseError): release.read_bytes(target, 10)
        target.unlink(); os.link(self.file, target)
        with self.assertRaises(release.ReleaseError): release.read_bytes(target, 10000)
        target.unlink(); os.mkfifo(target, 0o600)
        with self.assertRaises(release.ReleaseError): release.read_bytes(target, 10000)
        with self.assertRaises(release.ReleaseError): release.read_bytes(self.file, 10)

    def installer(self, extra=None):
        members = {name: b"synthetic tool" for name in kit.KIT_FILES}
        members["release.json"] = release.canonical({"format":"siftgate-customer-release-v1", "version":self.manifest["tag"],
            "commit":self.manifest["source_commit"], "image":self.manifest["image"]})
        output = self.root / "installer.tar.gz"
        with tarfile.open(output, "w:gz") as archive:
            for name, data in members.items():
                info = tarfile.TarInfo("siftgate-v2.12.0/"+name); info.size=len(data)
                archive.addfile(info, io.BytesIO(data))
            if extra: extra(archive)
        self.manifest["installer"].update(bytes=output.stat().st_size, sha256=hashlib.sha256(output.read_bytes()).hexdigest())
        return release.VerifiedRelease(self.manifest, "f"*64), output

    def test_verified_archive_stages_atomically_without_overwriting(self):
        verified, archive = self.installer(); destination = self.root / "stage"
        release.extract_installer(verified, archive, destination)
        self.assertEqual((destination/"siftgate.py").read_bytes(),b"synthetic tool")
        receipt = json.loads((destination/".verified-release.json").read_text())
        self.assertEqual(receipt["manifest_sha256"],verified.digest)
        self.assertEqual((destination/"siftgate.py").stat().st_mode & 0o777,0o600)
        with self.assertRaises(release.ReleaseError): release.extract_installer(verified, archive, destination)

    def test_archive_integrity_links_traversal_duplicates_and_pairing_fail(self):
        for kind in ("byteflip", "traversal", "symlink", "duplicate", "wrong-pair"):
            def extra(archive):
                name={"traversal":"siftgate-v2.12.0/../../escape", "symlink":"siftgate-v2.12.0/link", "duplicate":"siftgate-v2.12.0/siftgate.py"}.get(kind)
                if name:
                    info=tarfile.TarInfo(name)
                    if kind=="symlink": info.type=tarfile.SYMTYPE; info.linkname="/tmp/escape"
                    archive.addfile(info)
            verified, archive=self.installer(extra)
            if kind=="byteflip": archive.write_bytes(archive.read_bytes()+b"changed")
            if kind=="wrong-pair":
                changed=verified.manifest; changed["source_commit"]="b"*40; verified=release.VerifiedRelease(changed,"f"*64)
            with self.subTest(kind=kind), self.assertRaises(release.ReleaseError):
                release.extract_installer(verified,archive,self.root/"bad-stage")
            self.assertFalse((self.root/"bad-stage").exists())

    def image_archive(self, mode="valid"):
        layer=b"synthetic uncompressed layer content"
        config=release.canonical({"architecture":"arm64","os":"linux","rootfs":{"type":"layers","diff_ids":["sha256:"+hashlib.sha256(layer).hexdigest()]}})
        identity=hashlib.sha256(config).hexdigest()
        manifest=copy.deepcopy(self.manifest); manifest["platforms"]["linux/arm64"]["config_digest"]="sha256:"+identity
        index=[{"Config":identity+".json","RepoTags":None,"Layers":["layer-0000.tar"]}]
        if mode=="tag": index[0]["RepoTags"]=["unrelated:latest"]
        members={"manifest.json":release.canonical(index),identity+".json":config,"layer-0000.tar":layer}
        if mode=="layer": members["layer-0000.tar"]+=b"tampered"
        if mode=="config": members[identity+".json"]+=b" "
        if mode=="extra": members["index.json"]=b"malicious OCI tags"
        if mode=="traversal": members["../escape"]=b"x"
        output=self.root/"image.tar"
        with tarfile.open(output,"w:") as archive:
            for name,data in members.items():
                info=tarfile.TarInfo(name); info.size=len(data); archive.addfile(info,io.BytesIO(data))
        return release.VerifiedRelease(manifest,"f"*64),output

    def test_normalized_offline_image_is_bound_to_config_and_each_layer(self):
        verified,archive=self.image_archive()
        result=release.verify_offline_image(verified,archive,"arm64")
        self.assertEqual(result["verified_layers"],1); self.assertFalse(result["local_tags_created"])
        for mode in ("tag","layer","config","extra","traversal"):
            verified,archive=self.image_archive(mode)
            with self.subTest(mode=mode), self.assertRaises(release.ReleaseError): release.verify_offline_image(verified,archive,"arm64")

    def test_export_strips_tags_and_refuses_corrupt_layers(self):
        verified, archive = self.image_archive("tag")
        destination = self.root / "normalized.tar"
        result = release.normalize_offline_image(verified, archive, destination, "arm64")
        self.assertFalse(result["local_tags_created"])
        with tarfile.open(destination) as tar:
            self.assertIsNone(json.load(tar.extractfile("manifest.json"))[0]["RepoTags"])
        with self.assertRaises(release.ReleaseError): release.normalize_offline_image(verified, archive, destination, "arm64")
        verified, archive = self.image_archive("layer")
        with self.assertRaises(release.ReleaseError): release.normalize_offline_image(verified, archive, self.root / "bad.tar", "arm64")
        self.assertFalse((self.root / "bad.tar").exists())

    def test_containerd_gzip_export_has_the_same_portable_config_and_layers(self):
        verified, source = self.image_archive()
        compressed = self.root / "containerd.tar"
        with tarfile.open(source) as original, tarfile.open(compressed,"w:") as output:
            for member in original:
                data=original.extractfile(member).read()
                if member.name.startswith("layer-"): data=gzip.compress(data,mtime=0)
                header=tarfile.TarInfo(member.name); header.size=len(data); output.addfile(header,io.BytesIO(data))
        identity=release.saved_image_identity(compressed)
        self.assertEqual(identity["config_digest"],verified.manifest["platforms"]["linux/arm64"]["config_digest"])
        result=release.normalize_offline_image(verified,compressed,self.root/"portable.tar","arm64")
        self.assertEqual(result["verified_layers"],1)


class ReleaseGeneratorTests(unittest.TestCase):
    def setUp(self):
        root=Path(__file__).resolve().parents[2]
        spec=importlib.util.spec_from_file_location("release_manifest_builder",root/"scripts/build-customer-release-manifest.py")
        self.builder=importlib.util.module_from_spec(spec); spec.loader.exec_module(self.builder)
        self.contract=json.loads((root/"deploy/customer/release-contract.json").read_text())
        self.temp=tempfile.TemporaryDirectory(); self.root=Path(self.temp.name).resolve()
        self.version=json.loads((root/"package.json").read_text())["version"]
        self.archive=self.root/("siftgate-v"+self.version+"-install.tar.gz"); self.archive.write_bytes(b"unit archive identity")
        self.candidates={arch:{"architecture":arch,"commit":"a"*40,"digest":"sha256:"+d*64,"native_runner":True,
            "config_digest":"sha256:"+d*64,"source_config_digests":{item["version"]:"sha256:"+"f"*64 for item in self.contract["source_releases"]},
            "source_releases":{item["version"]:item["image"] for item in self.contract["source_releases"]},
            "checks":sorted(self.builder.REQUIRED_CHECKS)} for arch,d in (("amd64","b"),("arm64","c"))}
    def tearDown(self): self.temp.cleanup()
    def build(self):
        return self.builder.build_manifest(self.version,"a"*40,1791417600,release.REGISTRY+"@sha256:"+"d"*64,self.archive,self.contract,self.candidates)
    def test_both_native_receipts_bind_platforms_sources_and_installer_bytes(self):
        manifest=self.build()
        self.assertEqual(release.canonical(manifest),release.canonical(self.build()))
        self.assertEqual(manifest["installer"]["sha256"],hashlib.sha256(self.archive.read_bytes()).hexdigest())
        self.assertEqual(manifest["repository"],"seanbabalala/SiftGate")
        self.assertIn("ghcr.io/seanbabalala/ai-gateway@sha256:",manifest["image"])
        self.assertEqual(manifest["compatibility"]["source_config_digests"]["2.11.7"]["linux/arm64"],"sha256:"+"f"*64)
        self.assertEqual(set(manifest["compatibility"]["source_config_digests"]), {r["version"] for r in self.contract["source_releases"]})
    def test_incomplete_or_foreign_native_evidence_cannot_form_a_release(self):
        for field,value in (("checks",[]),("architecture","amd64"),("commit","b"*40),
                            ("source_releases",{}),("source_config_digests",{}),("native_runner",False)):
            original=copy.deepcopy(self.candidates)
            self.candidates["arm64"][field]=value
            with self.subTest(field=field),self.assertRaises(release.ReleaseError): self.build()
            self.candidates=original


if __name__ == "__main__": unittest.main()
