#!/usr/bin/env python3
"""Host-owned release cache, optional discovery and verified offline transport.

No method starts, stops, upgrades or enrolls a gateway. Fetch/import only stages
publisher-verified bytes and may preload an immutable image into the bound engine.
"""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import time
import urllib.parse
import urllib.request
import urllib.error
import xml.etree.ElementTree as ET

import siftgate as kit
import siftgate_release as trust

BASE = "https://api.github.com/repos/" + trust.REPOSITORY
DOWNLOAD = "https://github.com/" + trust.REPOSITORY + "/releases/download/"
MAX_BUNDLE = 4 * 1024 * 1024
OFFLINE_FILES = {"release.json", "release.sigstore.jsonl", "installer.tar.gz", "image.tar", "offline.json"}


def private_directory(path, create=False):
    path = kit.safe_root(path)
    if create: path.mkdir(mode=0o700, parents=False, exist_ok=True)
    info = path.stat()
    trust.require(path.is_dir() and info.st_uid == os.getuid() and info.st_mode & 0o077 == 0, "private_release_directory_required")
    return path


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        check_url(newurl)
        return super().redirect_request(request, fp, code, message, headers, newurl)


def check_url(url):
    try:
        parsed = urllib.parse.urlsplit(url)
        port = parsed.port
    except ValueError:
        raise trust.ReleaseError("release_download_origin_refused")
    trust.require(parsed.scheme == "https" and not parsed.username and not parsed.password and
                  port in (None, 443) and parsed.hostname in
                  ("api.github.com", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"), "release_download_origin_refused")


def download(url, destination, limit):
    check_url(url)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), SafeRedirect())
    request = urllib.request.Request(url, headers={"User-Agent": "SiftGate-release-client", "Accept": "application/octet-stream"})
    start = time.monotonic(); count = 0
    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "wb") as output, opener.open(request, timeout=10) as response:
        check_url(response.geturl())
        while True:
            trust.require(time.monotonic() - start < 180, "release_download_timeout")
            chunk = response.read1(min(1024 * 1024, limit + 1 - count))
            if not chunk: break
            count += len(chunk); trust.require(count <= limit, "release_download_too_large")
            output.write(chunk)
        output.flush(); os.fsync(output.fileno())


def copy_regular(source, destination, limit):
    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    count = 0
    with os.fdopen(descriptor, "wb") as output, trust.regular_file(source, limit) as stream:
        while True:
            chunk = stream.read(min(1024 * 1024, limit + 1 - count))
            if not chunk: break
            count += len(chunk); trust.require(count <= limit, "release_file_too_large")
            output.write(chunk)
        output.flush(); os.fsync(output.fileno())


class ReleaseCache:
    def __init__(self, directory, *, runner=kit.run, fetcher=download):
        self.root = private_directory(directory, create=True)
        self.runner, self.fetcher = runner, fetcher

    def trust_policy(self):
        policy_path = self.root / "trust.json"
        if not policy_path.exists(): return {}
        policy = trust.json_bytes(trust.read_bytes(policy_path, 4096))
        trust.keys(policy, ("format", "sha256"))
        trust.require(policy["format"] == "siftgate-pinned-trust-v1" and isinstance(policy["sha256"], str) and
                      trust.SHA.fullmatch(policy["sha256"]), "invalid_trust_policy")
        return {"trusted_root": self.root / "trusted-root.jsonl", "trusted_root_sha256": policy["sha256"]}

    def pin_trusted_root(self, path, expected_sha256, *, confirmed=False):
        trust.require(confirmed is True, "host_trust_confirmation_required")
        trust.require(isinstance(expected_sha256, str) and trust.SHA.fullmatch(expected_sha256), "out_of_band_trust_pin_required")
        raw = trust.read_bytes(path, 2 * 1024 * 1024)
        trust.require(hashlib.sha256(raw).hexdigest() == expected_sha256, "trusted_root_changed")
        # Rotation is deliberately not an implicit import operation.
        with kit.operator_lock(self.root):
            trust.require(not (self.root / "trusted-root.jsonl").exists() and not (self.root / "trust.json").exists(), "trust_already_initialized")
            descriptor = os.open(self.root / "trusted-root.jsonl", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(raw); stream.flush(); os.fsync(stream.fileno())
            kit.write_json(self.root / "trust.json", {"format": "siftgate-pinned-trust-v1", "sha256": expected_sha256})
        return {"pinned": True, "sha256": expected_sha256, "restarted": False}

    def discover(self, current_version):
        trust.version(current_version)
        with tempfile.TemporaryDirectory(prefix=".discover-", dir=self.root) as temporary:
            file = Path(temporary) / "releases.json"
            # Unauthenticated, public metadata only. No deployment token/API Key is sent.
            try:
                self.fetcher(BASE + "/releases?per_page=20", file, 2 * 1024 * 1024)
                records = trust.json_bytes(trust.read_bytes(file, 2 * 1024 * 1024))
            except urllib.error.HTTPError as error:
                if error.code not in (403,429): raise trust.ReleaseError("release_discovery_unavailable")
                # GitHub's public feed avoids requiring a customer account when
                # unauthenticated REST quota is shared/exhausted. It is discovery,
                # NEVER signature verification or evidence that an asset exists.
                feed=Path(temporary)/"releases.atom"
                try: self.fetcher("https://github.com/"+trust.REPOSITORY+"/releases.atom",feed,2*1024*1024)
                except Exception: raise trust.ReleaseError("release_discovery_rate_limited")
                content=trust.read_bytes(feed,2*1024*1024)
                trust.require(b"<!DOCTYPE" not in content.upper() and b"<!ENTITY" not in content.upper(),"invalid_release_feed")
                try: document=ET.fromstring(content)
                except ET.ParseError: raise trust.ReleaseError("invalid_release_feed")
                atom="{http://www.w3.org/2005/Atom}"
                trust.require(document.tag==atom+"feed","invalid_release_feed")
                matches=[]
                for entry in document.findall(atom+"entry")[:20]:
                    for link in entry.findall(atom+"link"):
                        if link.get("rel")!="alternate": continue
                        match=re.fullmatch(r'https://github\.com/seanbabalala/(?:SiftGate|ai-gateway)/releases/tag/v(\d+\.\d+\.\d+)',link.get("href",""),re.IGNORECASE)
                        if match: matches.append(match[1])
                versions=[]
                for candidate in matches:
                    try: trust.version(candidate)
                    except trust.ReleaseError: continue
                    if candidate not in versions: versions.append(candidate)
                trust.require(versions,"release_discovery_unavailable")
                return {"checked_at":dt.datetime.now(dt.timezone.utc).isoformat(),"discovery_source":"public_feed",
                        "releases":[{"version":candidate,"newer":trust.version(candidate)>trust.version(current_version),
                                     "managed_metadata_available":None,"publisher_verified":False,"automatic_install":False} for candidate in versions[:20]],
                        "automatic_install":False}
            except Exception:
                raise trust.ReleaseError("release_discovery_unavailable")
        trust.require(type(records) is list and len(records) <= 20, "invalid_release_listing")
        output = []
        for record in records:
            if type(record) is not dict or record.get("draft") is not False or record.get("prerelease") is not False: continue
            tag = record.get("tag_name", "")
            if not isinstance(tag, str) or not tag.startswith("v"): continue
            try: newer = trust.version(tag[1:]) > trust.version(current_version)
            except trust.ReleaseError: continue
            assets = record.get("assets", [])
            if type(assets) is not list or len(assets) > 100: continue
            names = {asset.get("name") for asset in assets if type(asset) is dict and isinstance(asset.get("name"), str)}
            required = {"siftgate-" + tag + suffix for suffix in ("-release.json", "-release.sigstore.jsonl", "-install.tar.gz")}
            output.append({"version": tag[1:], "newer": newer, "managed_metadata_available": required <= names,
                           "publisher_verified": False, "automatic_install": False})
        return {"checked_at": dt.datetime.now(dt.timezone.utc).isoformat(), "releases": output, "discovery_source":"public_api", "automatic_install": False}

    def verify_directory(self, directory, *, offline=False):
        directory = private_directory(directory)
        policy = self.trust_policy()
        trust.require(not offline or policy, "offline_trust_not_initialized")
        verified = trust.verify_release(directory / "release.json", directory / "release.sigstore.jsonl", runner=self.runner, **policy)
        installer = verified.manifest["installer"]
        raw = trust.read_bytes(directory / "installer.tar.gz", trust.MAX_INSTALLER)
        trust.require(len(raw) == installer["bytes"] and hashlib.sha256(raw).hexdigest() == installer["sha256"], "installer_integrity_mismatch")
        return verified

    def _commit(self, temporary, verified):
        destination = self.root / verified.digest
        with kit.operator_lock(self.root):
            if destination.exists():
                existing = self.verify_directory(destination)
                trust.require(existing.digest == verified.digest, "cached_release_changed")
                return destination
            kit.write_json(temporary / "observation.json", {"format": "siftgate-release-observation-v1",
                           "manifest_sha256": verified.digest, "version": verified.manifest["version"],
                           "verified_at": dt.datetime.now(dt.timezone.utc).isoformat()})
            os.rename(temporary, destination)
            trust.sync_directory(destination.parent)
        return destination

    def fetch(self, version):
        trust.version(version)
        temporary = Path(tempfile.mkdtemp(prefix=".fetch-", dir=self.root))
        try:
            prefix = "siftgate-v" + version
            for filename, suffix, limit in (("release.json", "-release.json", trust.MAX_MANIFEST),
                                           ("release.sigstore.jsonl", "-release.sigstore.jsonl", MAX_BUNDLE)):
                try: self.fetcher(DOWNLOAD + "v" + version + "/" + prefix + suffix, temporary / filename, limit)
                except urllib.error.HTTPError as error:
                    raise trust.ReleaseError("release_metadata_unavailable" if error.code==404 else "release_download_unavailable")
            verified = trust.verify_release(temporary / "release.json", temporary / "release.sigstore.jsonl", runner=self.runner, **self.trust_policy())
            trust.require(verified.manifest["version"] == version, "requested_release_mismatch")
            self.fetcher(DOWNLOAD + "v" + version + "/" + prefix + "-install.tar.gz", temporary / "installer.tar.gz", trust.MAX_INSTALLER)
            verified = self.verify_directory(temporary)
            return self._commit(temporary, verified)
        finally:
            if temporary.exists(): shutil.rmtree(temporary)

    def get(self, digest, *, offline=False):
        trust.require(isinstance(digest, str) and trust.SHA.fullmatch(digest), "invalid_release_digest")
        path = self.root / digest
        verified = self.verify_directory(path, offline=offline)
        trust.require(verified.digest == digest, "cached_release_changed")
        return verified, path

    def _bind_image(self, verified, install, identity):
        directory=self.root/verified.digest
        architecture=install.meta["engine_arch"]
        trust.require(identity["config_digest"]==verified.manifest["platforms"]["linux/"+architecture]["config_digest"],"image_config_not_attested")
        binding={"format":"siftgate-local-image-binding-v1","release_digest":verified.digest,"engine_id":install.meta["engine_id"],
                 "architecture":architecture,"runtime_image_id":identity["runtime_image_id"],"config_digest":identity["config_digest"]}
        kit.write_json(directory/("image-"+architecture+".json"),binding)
        return binding

    def prepare_image(self, digest, install, *, offline=False):
        verified,directory=self.get(digest,offline=offline)
        install.check_engine(); architecture=install.meta["engine_arch"]
        target=verified.manifest["platforms"].get("linux/"+architecture)
        trust.require(target is not None,"unsupported_architecture")
        if offline:
            binding=trust.json_bytes(trust.read_bytes(directory/("image-"+architecture+".json"),8192))
            trust.keys(binding,("format","release_digest","engine_id","architecture","runtime_image_id","config_digest"))
            trust.require(binding["format"]=="siftgate-local-image-binding-v1" and binding["release_digest"]==digest and
                binding["engine_id"]==install.meta["engine_id"] and binding["architecture"]==architecture and
                binding["config_digest"]==target["config_digest"] and isinstance(binding["runtime_image_id"],str) and
                trust.IMAGE_ID.fullmatch(binding["runtime_image_id"]),"offline_image_binding_changed")
            reference=binding["runtime_image_id"]
        else:
            reference=install.resolve_image(target["image"])
        identity=trust.inspect_local_image(install,reference,self.root)
        self._bind_image(verified,install,identity)
        return identity

    def export_offline(self, digest, install, destination, *, local=False):
        verified, source = self.get(digest)
        destination = kit.safe_root(destination)
        private_directory(destination.parent)
        trust.require(not destination.exists(), "offline_destination_exists")
        install.check_engine()
        architecture = install.meta["engine_arch"]
        target = verified.manifest["platforms"].get("linux/" + architecture)
        trust.require(target is not None, "unsupported_architecture")
        # Explicit local mode uses a previously verified engine-bound image;
        # it is not permission to export an arbitrary unverified image handle.
        actual = self.prepare_image(digest,install,offline=True)["runtime_image_id"] if local else install.resolve_image(target["image"])
        image = json.loads(install.docker("image", "inspect", actual))[0]
        trust.require(shutil.disk_usage(destination.parent).free >= 2 * image["Size"] + 512 * 1024 * 1024, "offline_export_disk_space")
        temporary = Path(tempfile.mkdtemp(prefix=".offline-", dir=destination.parent))
        try:
            for name, limit in (("release.json", trust.MAX_MANIFEST), ("release.sigstore.jsonl", MAX_BUNDLE), ("installer.tar.gz", trust.MAX_INSTALLER)):
                copy_regular(source / name, temporary / name, limit)
            raw = temporary / "docker-export.tar"
            install.docker("image", "save", "--output", str(raw), actual, timeout=1200)
            os.chmod(raw, 0o600)
            trust.normalize_offline_image(verified, raw, temporary / "image.tar", architecture)
            raw.unlink()
            kit.write_json(temporary / "offline.json", {"format": "siftgate-offline-v1", "architecture": architecture, "release_digest": verified.digest})
            os.rename(temporary, destination)
            trust.sync_directory(destination.parent)
        finally:
            if temporary.exists(): shutil.rmtree(temporary)
        return {"version": verified.manifest["version"], "platform": "linux/" + architecture, "release_digest": digest,
                "restarted": False, "contains_trust_root": False}

    def import_offline(self, source, install):
        source = kit.safe_root(source)
        trust.require(source.is_dir() and {item.name for item in source.iterdir()} == OFFLINE_FILES, "invalid_offline_members")
        policy = self.trust_policy()
        trust.require(policy, "offline_trust_not_initialized")
        sizes = {}
        limits = {"release.json": trust.MAX_MANIFEST, "release.sigstore.jsonl": MAX_BUNDLE,
                  "installer.tar.gz": trust.MAX_INSTALLER, "image.tar": trust.MAX_IMAGE, "offline.json": 4096}
        for name, limit in limits.items():
            with trust.regular_file(source / name, limit) as file: sizes[name] = os.fstat(file.fileno()).st_size
        trust.require(shutil.disk_usage(self.root).free >= sum(sizes.values()) + 512 * 1024 * 1024, "offline_import_disk_space")
        temporary = Path(tempfile.mkdtemp(prefix=".import-", dir=self.root))
        try:
            # Copy into owner-private storage first; never load a mutable shared USB/network file.
            for name in limits: copy_regular(source / name, temporary / name, sizes[name])
            offline = trust.json_bytes(trust.read_bytes(temporary / "offline.json", 4096))
            trust.keys(offline, ("format", "architecture", "release_digest"))
            trust.require(offline["format"] == "siftgate-offline-v1", "unsupported_offline_format")
            verified = self.verify_directory(temporary, offline=True)
            trust.require(offline["release_digest"] == verified.digest, "offline_release_mismatch")
            install.check_engine()
            trust.require(offline["architecture"] == install.meta["engine_arch"], "offline_architecture_mismatch")
            observation = trust.verify_offline_image(verified, temporary / "image.tar", install.meta["engine_arch"])
            loaded = install.docker("image", "load", "--input", str(temporary / "image.tar"), timeout=1200, output_limit=65536)
            handles = re.findall(r"^Loaded image ID: (sha256:[a-f0-9]{64})\s*$", loaded, re.MULTILINE)
            trust.require(len(handles) == 1, "loaded_image_identity_unavailable")
            identity = trust.inspect_local_image(install, handles[0], self.root)
            trust.require(identity["config_digest"] == observation["config_digest"], "loaded_image_mismatch")
            # Images now live by immutable config ID in the bound engine; cache small verified artifacts.
            (temporary / "image.tar").unlink(); (temporary / "offline.json").unlink()
            self._commit(temporary, verified)
            self._bind_image(verified,install,identity)
            return {**observation, "runtime_image_id": identity["runtime_image_id"],
                    "version": verified.manifest["version"], "restarted": False, "approved": False}
        finally:
            if temporary.exists(): shutil.rmtree(temporary)
