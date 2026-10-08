#!/usr/bin/env python3
"""Verified release/compatibility primitives. Never starts or stops a gateway.

Cryptographic verification is delegated to the official GitHub CLI. A checksum,
an unsigned JSON receipt, or a trust root supplied inside an offline package is
never a replacement for publisher identity verification.
"""
import datetime as dt
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import tarfile
import tempfile

import siftgate as kit

# GitHub's current canonical repository is SiftGate. Preserve the existing
# container namespace: renaming a repository must not silently move customers.
REPOSITORY = "seanbabalala/SiftGate"
REGISTRY = "ghcr.io/seanbabalala/ai-gateway"
WORKFLOW = "github.com/" + REPOSITORY + "/.github/workflows/customer-release.yml"
FORMAT = "siftgate-release-v2"
KIT_PROTOCOL = 2
OPERATOR_PROTOCOL = 1
MAX_MANIFEST = 256 * 1024
MAX_INSTALLER = 64 * 1024 * 1024
MAX_IMAGE = 20 * 1024 * 1024 * 1024
SHA = re.compile(r"[a-f0-9]{64}\Z")
IMAGE_ID = re.compile(r"sha256:[a-f0-9]{64}\Z")
VERSION = re.compile(r"(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\Z")


class ReleaseError(Exception):
    """Fixed public codes only; never parser contents or filesystem paths."""


def require(condition, code):
    if not condition:
        raise ReleaseError(code)


def version(value):
    require(isinstance(value, str), "invalid_version")
    match = VERSION.fullmatch(value)
    require(match is not None, "stable_version_required")
    return tuple(int(part) for part in match.groups())


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try: os.fsync(descriptor)
    finally: os.close(descriptor)


def sha256(path):
    digest = hashlib.sha256()
    size = 0
    with regular_file(path, MAX_IMAGE) as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            size += len(chunk)
            require(size <= MAX_IMAGE, "release_file_too_large")
            digest.update(chunk)
    return digest.hexdigest()


def regular_file(path, limit):
    """No symlink ancestors, FIFO waits or hardlinks, including supplied bundles."""
    path = Path(path).absolute()
    require(not any(item.is_symlink() for item in (path, *path.parents)), "unsafe_release_path")
    parent = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for component in path.parts[1:-1]:
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            os.close(parent); parent = child
        descriptor = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    finally:
        os.close(parent)
    try:
        info = os.fstat(descriptor)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= limit, "unsafe_release_file")
        return os.fdopen(descriptor, "rb")
    except BaseException:
        os.close(descriptor)
        raise


def read_bytes(path, limit):
    with regular_file(path, limit) as stream:
        data = stream.read(limit + 1)
    require(len(data) <= limit, "release_file_too_large")
    return data


def json_bytes(data):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "duplicate_json_key")
            result[key] = value
        return result
    try:
        return json.loads(data, object_pairs_hook=unique, parse_constant=lambda _: require(False, "nonfinite_json"))
    except (ValueError, UnicodeError):
        raise ReleaseError("invalid_release_json")


def keys(value, expected):
    require(type(value) is dict and set(value) == set(expected), "invalid_release_fields")


def validate_manifest(value):
    keys(value, ("format", "repository", "version", "tag", "source_commit", "built_at", "image", "platforms", "installer", "compatibility", "changes"))
    require(value["format"] == FORMAT and value["repository"] == REPOSITORY, "publisher_mismatch")
    version(value["version"])
    require(value["tag"] == "v" + value["version"], "release_tag_mismatch")
    require(isinstance(value["source_commit"], str) and re.fullmatch(r"[a-f0-9]{40}", value["source_commit"]), "invalid_source_commit")
    try:
        built = dt.datetime.fromisoformat(value["built_at"].replace("Z", "+00:00"))
        require(built.utcoffset() == dt.timedelta(0), "release_time_must_be_utc")
    except (AttributeError, TypeError, ValueError):
        raise ReleaseError("invalid_release_time")
    reference = re.compile(re.escape(REGISTRY) + r"@sha256:[a-f0-9]{64}\Z")
    require(isinstance(value["image"], str) and reference.fullmatch(value["image"]), "immutable_publisher_image_required")
    keys(value["platforms"], ("linux/amd64", "linux/arm64"))
    for platform in value["platforms"].values():
        keys(platform, ("image", "config_digest"))
        require(isinstance(platform["image"], str) and reference.fullmatch(platform["image"]), "immutable_platform_required")
        require(isinstance(platform["config_digest"], str) and IMAGE_ID.fullmatch(platform["config_digest"]), "invalid_platform_image_id")
    installer = value["installer"]
    keys(installer, ("name", "sha256", "bytes"))
    require(installer["name"] == "siftgate-" + value["tag"] + "-install.tar.gz", "installer_name_mismatch")
    require(isinstance(installer["sha256"], str) and SHA.fullmatch(installer["sha256"]), "invalid_installer_digest")
    require(type(installer["bytes"]) is int and 0 < installer["bytes"] <= MAX_INSTALLER, "invalid_installer_size")
    contract = value["compatibility"]
    keys(contract, ("source_versions", "source_config_digests", "source_kit_protocols", "target_kit_protocol", "operator_protocol", "database", "downtime_required"))
    require(type(contract["source_versions"]) is list and 1 <= len(contract["source_versions"]) <= 100 and
            all(isinstance(item, str) for item in contract["source_versions"]), "source_versions_required")
    require(len(set(contract["source_versions"])) == len(contract["source_versions"]), "duplicate_source_version")
    for source in contract["source_versions"]:
        require(version(source) < version(value["version"]), "unsupported_source_version")
    keys(contract["source_config_digests"], contract["source_versions"])
    for source_images in contract["source_config_digests"].values():
        keys(source_images, ("linux/amd64", "linux/arm64"))
        require(all(isinstance(item, str) and IMAGE_ID.fullmatch(item) for item in source_images.values()), "invalid_source_image_identity")
    require(type(contract["source_kit_protocols"]) is list and contract["source_kit_protocols"] and
            all(type(item) is int and item in (1, KIT_PROTOCOL) for item in contract["source_kit_protocols"]), "unsupported_source_kit")
    require(type(contract["target_kit_protocol"]) is int and contract["target_kit_protocol"] == KIT_PROTOCOL and
            type(contract["operator_protocol"]) is int and contract["operator_protocol"] == OPERATOR_PROTOCOL, "newer_control_tools_required")
    keys(contract["database"], ("type", "migration", "reversible"))
    require(contract["database"] == {"type": "sqlite", "migration": "startup_schema_sync", "reversible": False}, "database_native_plan_required")
    require(contract["downtime_required"] is True, "unverified_zero_downtime_claim")
    require(type(value["changes"]) is list and 1 <= len(value["changes"]) <= 80, "release_changes_required")
    for change in value["changes"]:
        keys(change, ("kind", "summary"))
        require(change["kind"] in ("feature", "fix", "security", "breaking"), "invalid_change_kind")
        require(isinstance(change["summary"], str) and 1 <= len(change["summary"]) <= 500 and
                all(char in "\t\n" or ord(char) >= 32 for char in change["summary"]), "invalid_change_summary")
    return value


class VerifiedRelease:
    """Only produced after the external verifier succeeds; reverify before apply."""
    def __init__(self, manifest, manifest_digest):
        self._bytes = canonical(manifest)
        self.digest = manifest_digest

    @property
    def manifest(self):
        return json.loads(self._bytes)

    def compatibility(self, current_version, architecture, source_kit=KIT_PROTOCOL, database="sqlite", current_config_digest=None):
        manifest = self.manifest
        reasons = []
        if version(current_version) >= version(manifest["version"]): reasons.append("not_an_upgrade")
        if current_version not in manifest["compatibility"]["source_versions"]: reasons.append("source_version_not_tested")
        expected_image = manifest["compatibility"]["source_config_digests"].get(current_version, {}).get("linux/" + architecture)
        if not current_config_digest or current_config_digest != expected_image: reasons.append("source_image_not_tested")
        if architecture not in ("amd64", "arm64"): reasons.append("unsupported_architecture")
        if type(source_kit) is not int or source_kit not in manifest["compatibility"]["source_kit_protocols"]: reasons.append("source_kit_not_supported")
        if database != manifest["compatibility"]["database"]["type"]: reasons.append("database_native_plan_required")
        return {"compatible": not reasons, "reasons": reasons, "source_version": current_version,
                "target_version": manifest["version"], "release_digest": self.digest,
                "downtime_required": True, "automatic_rollback": False,
                "target": manifest["platforms"].get("linux/" + architecture)}


def verify_release(manifest_path, bundle_path, *, trusted_root=None, trusted_root_sha256=None, runner=kit.run):
    raw = read_bytes(manifest_path, MAX_MANIFEST)
    manifest = validate_manifest(json_bytes(raw))
    read_bytes(bundle_path, 4 * 1024 * 1024)
    # Minimum is a capability contract, not a request to install/upgrade a host CLI.
    try:
        gh_version = runner(["gh", "version"], timeout=10, output_limit=8192)
        match = re.search(r"gh version (\d+)\.(\d+)\.(\d+)", gh_version)
        require(match and tuple(map(int, match.groups())) >= (2, 86, 0), "github_verifier_2_86_required")
        arguments = ["gh", "attestation", "verify", str(Path(manifest_path).absolute()),
                     "--hostname", "github.com", "--repo", REPOSITORY, "--signer-workflow", WORKFLOW,
                     "--cert-identity", "https://" + WORKFLOW + "@refs/tags/" + manifest["tag"],
                     "--cert-oidc-issuer", "https://token.actions.githubusercontent.com",
                     "--source-ref", "refs/tags/" + manifest["tag"], "--source-digest", manifest["source_commit"],
                     "--deny-self-hosted-runners", "--predicate-type", "https://slsa.dev/provenance/v1",
                     "--bundle", str(Path(bundle_path).absolute()), "--format", "json"]
        if trusted_root is not None:
            # Trust is pinned by the installation owner OUTSIDE the received bundle.
            require(isinstance(trusted_root_sha256, str) and SHA.fullmatch(trusted_root_sha256), "out_of_band_trust_pin_required")
            require(hashlib.sha256(read_bytes(trusted_root, 2 * 1024 * 1024)).hexdigest() == trusted_root_sha256, "trusted_root_changed")
            arguments += ["--custom-trusted-root", str(Path(trusted_root).absolute())]
        else:
            require(trusted_root_sha256 is None, "trusted_root_path_required")
        result = json_bytes(runner(arguments, timeout=120, output_limit=4 * 1024 * 1024))
    except (OSError, kit.OperatorError):
        raise ReleaseError("publisher_verification_failed")
    artifact_sha = hashlib.sha256(raw).hexdigest()
    require(type(result) is list and result, "publisher_verification_failed")
    try:
        matched = any(item["verificationResult"]["statement"]["predicateType"] == "https://slsa.dev/provenance/v1" and
                      any(subject.get("digest", {}).get("sha256") == artifact_sha
                          for subject in item["verificationResult"]["statement"]["subject"]) for item in result)
    except (KeyError, TypeError, AttributeError):
        matched = False
    require(matched, "attestation_subject_mismatch")
    require(read_bytes(manifest_path, MAX_MANIFEST) == raw, "release_changed_during_verification")
    return VerifiedRelease(manifest, artifact_sha)


def safe_member(name):
    require(isinstance(name, str) and name and len(name) <= 240 and not name.startswith("/") and
            "\\" not in name and all(part not in ("", ".", "..") for part in name.split("/")) and
            all(ord(char) >= 32 for char in name), "unsafe_archive_path")
    return name


def extract_installer(release, archive_path, destination):
    manifest = release.manifest
    archive = read_bytes(archive_path, MAX_INSTALLER)
    require(len(archive) == manifest["installer"]["bytes"] and hashlib.sha256(archive).hexdigest() == manifest["installer"]["sha256"], "installer_integrity_mismatch")
    destination = kit.safe_root(destination)
    require(not destination.exists(), "staging_destination_exists")
    require(destination.parent.is_dir() and destination.parent.stat().st_uid == os.getuid() and
            destination.parent.stat().st_mode & 0o077 == 0, "private_staging_parent_required")
    temporary = Path(tempfile.mkdtemp(prefix=".release-", dir=destination.parent))
    try:
        import io
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as bundle:
            seen = set(); size = 0
            for member in bundle:
                safe_member(member.name)
                parts = member.name.split("/")
                require(len(parts) == 2 and parts[0] == "siftgate-" + manifest["tag"] and member.isfile() and
                        member.name not in seen and 0 <= member.size <= 16 * 1024 * 1024, "unsafe_installer_member")
                seen.add(member.name); size += member.size
                require(len(seen) <= 128 and size <= MAX_INSTALLER, "installer_extract_limit")
                path = temporary / parts[1]
                descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(descriptor, "wb") as output, bundle.extractfile(member) as source:
                    shutil.copyfileobj(source, output, length=1024 * 1024)
                    output.flush(); os.fsync(output.fileno())
        nested = json_bytes(read_bytes(temporary / "release.json", MAX_MANIFEST))
        require(nested == {"format": "siftgate-customer-release-v1", "version": manifest["tag"],
                           "commit": manifest["source_commit"], "image": manifest["image"]}, "installer_release_pair_mismatch")
        for name in kit.KIT_FILES:
            require((temporary / name).is_file(), "installer_tools_missing")
        kit.write_json(temporary / ".verified-release.json", {"manifest_sha256": release.digest,
                       "installer_sha256": manifest["installer"]["sha256"],
                       "files": {item.name: sha256(item) for item in sorted(temporary.iterdir())}})
        os.rename(temporary, destination)
        sync_directory(destination.parent)
    except BaseException:
        shutil.rmtree(temporary)
        raise
    return destination


def verify_offline_image(release, archive_path, architecture):
    """Accept a tag-free Docker archive bound to an attested configuration digest.

    RepoTags/OCI aliases are not permitted: importing an offline image must not
    overwrite unrelated local tags. Config digest binds the ordered uncompressed
    layer digests; every layer is hashed before any Docker load is allowed.
    """
    target = release.manifest["platforms"].get("linux/" + architecture)
    require(target is not None, "unsupported_architecture")
    try:
        with regular_file(archive_path, MAX_IMAGE) as raw, tarfile.open(fileobj=raw, mode="r:") as archive:
            members = {}; total = 0
            for member in archive:
                safe_member(member.name)
                require(member.isfile() and member.name not in members and member.size >= 0 and len(members) < 256, "unsafe_image_archive")
                total += member.size
                require(total <= MAX_IMAGE, "image_extract_limit")
                members[member.name] = member
            def read(name, maximum):
                require(name in members and members[name].size <= maximum, "image_member_missing_or_large")
                with archive.extractfile(members[name]) as source:
                    return source.read(maximum + 1)
            index = json_bytes(read("manifest.json", MAX_MANIFEST))
            require(type(index) is list and len(index) == 1, "single_image_required")
            entry = index[0]
            keys(entry, ("Config", "RepoTags", "Layers"))
            require(entry["RepoTags"] is None, "offline_image_tags_forbidden")
            config_name = target["config_digest"][7:] + ".json"
            require(entry["Config"] == config_name, "offline_config_identity_mismatch")
            config_bytes = read(config_name, 4 * 1024 * 1024)
            require("sha256:" + hashlib.sha256(config_bytes).hexdigest() == target["config_digest"], "offline_config_digest_mismatch")
            config = json_bytes(config_bytes)
            require(config.get("os") == "linux" and config.get("architecture") == architecture, "offline_architecture_mismatch")
            rootfs = config.get("rootfs", {})
            diffs = rootfs.get("diff_ids")
            require(rootfs.get("type") == "layers" and type(diffs) is list and len(diffs) <= 200 and
                    all(isinstance(item, str) and IMAGE_ID.fullmatch(item) for item in diffs), "invalid_image_layers")
            expected_layers = ["layer-" + str(index).zfill(4) + ".tar" for index in range(len(diffs))]
            require(entry["Layers"] == expected_layers and set(members) == {"manifest.json", config_name, *expected_layers}, "unexpected_image_archive_members")
            for name, expected in zip(expected_layers, diffs):
                digest = hashlib.sha256()
                with archive.extractfile(members[name]) as stream:
                    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                        digest.update(chunk)
                require("sha256:" + digest.hexdigest() == expected, "offline_layer_digest_mismatch")
    except (tarfile.TarError, KeyError, ValueError, AttributeError):
        raise ReleaseError("invalid_offline_image")
    return {"config_digest": target["config_digest"], "platform": "linux/" + architecture,
            "release_digest": release.digest, "verified_layers": len(diffs), "local_tags_created": False}


def normalize_offline_image(release, docker_archive, destination, architecture):
    """Export only the attested image contents, stripping all registry tag aliases."""
    import io
    target = release.manifest["platforms"].get("linux/" + architecture)
    require(target is not None, "unsupported_architecture")
    destination = kit.safe_root(destination)
    require(not destination.exists() and destination.parent.is_dir() and
            destination.parent.stat().st_uid == os.getuid() and destination.parent.stat().st_mode & 0o077 == 0,
            "private_new_export_required")
    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as output, regular_file(docker_archive, MAX_IMAGE) as source, \
                tarfile.open(fileobj=source, mode="r:") as archive:
            members = {}; total = 0
            for member in archive:
                name = member.name.rstrip("/") if member.isdir() else member.name
                safe_member(name)
                require((member.isfile() or member.isdir()) and name not in members and len(members) < 2048 and member.size >= 0, "unsafe_docker_export")
                total += member.size; require(total <= MAX_IMAGE, "image_extract_limit")
                members[name] = member
            def read(name, limit):
                require(name in members and members[name].isfile() and members[name].size <= limit, "docker_export_member_missing")
                with archive.extractfile(members[name]) as stream:
                    return stream.read(limit + 1)
            manifests = json_bytes(read("manifest.json", MAX_MANIFEST))
            require(type(manifests) is list and len(manifests) == 1, "single_image_required")
            image = manifests[0]
            require(type(image) is dict and isinstance(image.get("Config"), str) and type(image.get("Layers")) is list, "invalid_docker_export")
            config_path = safe_member(image["Config"])
            config = read(config_path, 4 * 1024 * 1024)
            require("sha256:" + hashlib.sha256(config).hexdigest() == target["config_digest"], "offline_config_digest_mismatch")
            require(len(image["Layers"]) <= 200 and all(isinstance(item, str) for item in image["Layers"]), "invalid_image_layers")
            renamed = ["layer-" + str(index).zfill(4) + ".tar" for index in range(len(image["Layers"]))]
            config_name = target["config_digest"][7:] + ".json"
            index = canonical([{"Config": config_name, "RepoTags": None, "Layers": renamed}])
            extracted_size = 0
            with tarfile.open(fileobj=output, mode="w:", format=tarfile.USTAR_FORMAT) as result:
                for name, data in (("manifest.json", index), (config_name, config)):
                    header = tarfile.TarInfo(name); header.size = len(data); header.mode = 0o600
                    result.addfile(header, io.BytesIO(data))
                for name, renamed_name in zip(image["Layers"], renamed):
                    safe_member(name)
                    require(name in members and members[name].isfile(), "docker_layer_missing")
                    # containerd-backed Docker exports compressed OCI blobs, while
                    # the classic store exports uncompressed layer tarballs.
                    with archive.extractfile(members[name]) as layer, tempfile.TemporaryFile(dir=destination.parent) as uncompressed:
                        magic = layer.read(4); layer.seek(0)
                        require(magic != b"\x28\xb5\x2f\xfd", "zstd_export_requires_supported_decoder")
                        reader = gzip.GzipFile(fileobj=layer) if magic[:2] == b"\x1f\x8b" else layer
                        size = 0
                        try:
                            while True:
                                chunk = reader.read(1024 * 1024)
                                if not chunk: break
                                size += len(chunk); extracted_size += len(chunk)
                                require(extracted_size <= MAX_IMAGE, "image_extract_limit")
                                require(shutil.disk_usage(destination.parent).free >= 128 * 1024 * 1024, "offline_export_disk_space")
                                uncompressed.write(chunk)
                        finally:
                            if reader is not layer: reader.close()
                        uncompressed.seek(0)
                        header = tarfile.TarInfo(renamed_name); header.size = size; header.mode = 0o600
                        result.addfile(header, uncompressed)
            output.flush(); os.fsync(output.fileno())
        return verify_offline_image(release, destination, architecture)
    except BaseException:
        destination.unlink()  # Only the newly-created export, never an input or existing file.
        raise


def saved_image_identity(path):
    """Read immutable configuration identity from Docker's own export, not .Id.

    Newer Docker stores can return an index/manifest digest as inspect.Id. That
    value remains the local runtime handle but must not be called a config digest.
    """
    with regular_file(path, MAX_IMAGE) as raw, tarfile.open(fileobj=raw, mode="r:") as archive:
        members = {}; size = 0
        for member in archive:
            name = member.name.rstrip("/") if member.isdir() else member.name
            safe_member(name)
            require(name not in members and len(members) < 2048 and (member.isfile() or member.isdir()) and member.size >= 0, "unsafe_docker_export")
            members[name] = member; size += member.size
            require(size <= MAX_IMAGE, "image_extract_limit")
        def read(name, limit):
            require(name in members and members[name].isfile() and members[name].size <= limit, "docker_export_member_missing")
            with archive.extractfile(members[name]) as stream: return stream.read(limit + 1)
        manifests = json_bytes(read("manifest.json", MAX_MANIFEST))
        require(type(manifests) is list and len(manifests) == 1 and type(manifests[0]) is dict, "single_image_required")
        name = manifests[0].get("Config")
        safe_member(name)
        config = read(name, 4 * 1024 * 1024)
        parsed = json_bytes(config)
        require(type(parsed) is dict and parsed.get("os") == "linux" and parsed.get("architecture") in ("amd64", "arm64"), "unsupported_architecture")
        root = parsed.get("rootfs")
        require(type(root) is dict and root.get("type") == "layers" and type(root.get("diff_ids")) is list and
                len(root["diff_ids"]) <= 200 and all(isinstance(item, str) and IMAGE_ID.fullmatch(item) for item in root["diff_ids"]), "invalid_image_layers")
        return {"config_digest": "sha256:" + hashlib.sha256(config).hexdigest(), "architecture": parsed["architecture"], "diff_ids": root["diff_ids"]}


def inspect_local_image(install, reference, scratch):
    info = json_bytes(install.docker("image", "inspect", reference))[0]
    require(isinstance(info["Id"], str) and IMAGE_ID.fullmatch(info["Id"]) and info["Os"] == "linux", "invalid_local_image")
    require(type(info["Size"]) is int and info["Size"] >= 0 and shutil.disk_usage(scratch).free >= info["Size"] + 256 * 1024 * 1024,
            "image_identity_disk_space")
    folder = Path(tempfile.mkdtemp(prefix=".image-identity-", dir=scratch))
    try:
        archive = folder / "image.tar"
        install.docker("image", "save", "--output", str(archive), info["Id"], timeout=1200)
        os.chmod(archive, 0o600)
        identity = saved_image_identity(archive)
        require(identity["architecture"] == install.meta["engine_arch"], "image_architecture_mismatch")
        return {**identity, "runtime_image_id": info["Id"]}
    finally:
        shutil.rmtree(folder)
