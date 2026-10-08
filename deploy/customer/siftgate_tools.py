#!/usr/bin/env python3
"""Content-bound, versioned host tools; no live gateway restart during bootstrap."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile

import siftgate as kit
import siftgate_release as release
from siftgate_releases import private_directory, copy_regular

POINTER_FORMAT = "siftgate-host-tools-v1"


def files_in(directory):
    result = {}
    for item in directory.iterdir():
        if item.name in (".host-tools.json", ".verified-release.json", "__pycache__"): continue
        release.require(re.fullmatch(r"[a-zA-Z0-9_.-]{1,128}", item.name) and item.is_file() and not item.is_symlink(), "unsafe_host_tool")
        result[item.name] = release.sha256(item)
    release.require(set(kit.KIT_FILES) <= result.keys(), "host_tools_incomplete")
    return result


def seal(directory, origin, release_digest=None):
    directory = private_directory(directory)
    release.require(origin in ("owner_bootstrap", "verified_release"), "invalid_host_tool_origin")
    release.require((origin == "verified_release") == (isinstance(release_digest,str) and bool(release.SHA.fullmatch(release_digest))), "invalid_host_tool_release")
    files = files_in(directory)
    if origin == "verified_release":
        verified = release.json_bytes(release.read_bytes(directory / ".verified-release.json", 1024 * 1024))
        release.require(verified.get("manifest_sha256") == release_digest and verified.get("files") == files, "staged_release_changed")
    marker = {"format": POINTER_FORMAT, "origin": origin, "release_digest": release_digest, "files": files}
    if (directory / ".host-tools.json").exists():
        release.require(release.json_bytes(release.read_bytes(directory / ".host-tools.json",1024*1024)) == marker, "sealed_host_tools_changed")
    else: kit.write_json(directory / ".host-tools.json", marker)
    return {"format": POINTER_FORMAT, "origin": origin, "release_digest": release_digest,
            "files_digest": hashlib.sha256(release.canonical(files)).hexdigest()}


def resolve(root, pointer):
    release.keys(pointer, ("format", "origin", "release_digest", "files_digest", "directory"))
    release.require(pointer["format"] == POINTER_FORMAT and isinstance(pointer["directory"],str) and
                    re.fullmatch(r"host-kits/(?:boot|release)-[a-f0-9]{64}",pointer["directory"]), "invalid_host_tool_pointer")
    release.require(pointer["origin"] in ("owner_bootstrap","verified_release") and isinstance(pointer["files_digest"],str) and
                    release.SHA.fullmatch(pointer["files_digest"]),"invalid_host_tool_pointer")
    expected="release-"+str(pointer["release_digest"]) if pointer["origin"]=="verified_release" else "boot-"+pointer["files_digest"]
    release.require(pointer["directory"]=="host-kits/"+expected and
                    (pointer["release_digest"] is None if pointer["origin"]=="owner_bootstrap" else isinstance(pointer["release_digest"],str) and bool(release.SHA.fullmatch(pointer["release_digest"]))),"invalid_host_tool_pointer")
    directory = private_directory(root / pointer["directory"])
    marker = release.json_bytes(release.read_bytes(directory / ".host-tools.json",1024*1024))
    release.keys(marker,("format","origin","release_digest","files"))
    release.require(marker["format"] == POINTER_FORMAT and marker["origin"] == pointer["origin"] and
                    marker["release_digest"] == pointer["release_digest"] and type(marker["files"]) is dict,
                    "host_tool_identity_changed")
    release.require(hashlib.sha256(release.canonical(marker["files"])).hexdigest() == pointer["files_digest"], "host_tool_identity_changed")
    release.require(files_in(directory) == marker["files"], "host_tool_contents_changed")
    return directory


def bootstrap(install, *, confirmed=False, source=None):
    release.require(confirmed is True, "host_bootstrap_confirmation_required")
    release.require(not (install.root / "operator/policy.json").exists(), "enrolled_operator_requires_approved_tool_upgrade")
    source = Path(source or Path(__file__).resolve().parent)
    with kit.operator_lock(install.root):
        release.require(not (install.root / "maintenance").exists(), "maintenance_active")
        parent = private_directory(install.root / "host-kits",create=True)
        temporary = Path(tempfile.mkdtemp(prefix=".bootstrap-",dir=parent))
        try:
            for name in kit.KIT_FILES: copy_regular(source/name,temporary/name,16*1024*1024)
            example=source/"gateway.config.example.yaml"
            if not example.exists(): example=source.parent.parent/"gateway.config.example.yaml"
            copy_regular(example,temporary/example.name,16*1024*1024)
            pointer=seal(temporary,"owner_bootstrap")
            target=parent/("boot-"+pointer["files_digest"])
            pointer["directory"]=target.relative_to(install.root).as_posix()
            if target.exists(): resolve(install.root,pointer)
            else:
                os.rename(temporary,target); release.sync_directory(parent)
            install.meta["host_tools"]=pointer
            install.save()  # Existing container/mounts are deliberately left untouched.
        finally:
            if temporary.exists(): shutil.rmtree(temporary)
    return {"bootstrapped":True,"restarted":False,"origin":"owner_bootstrap","tool_directory":pointer["directory"]}


def stage_release(install, verified, archive):
    parent=private_directory(install.root/"host-kits",create=True)
    destination=parent/("release-"+verified.digest)
    if not destination.exists(): release.extract_installer(verified,archive,destination)
    pointer=seal(destination,"verified_release",verified.digest)
    pointer["directory"]=destination.relative_to(install.root).as_posix()
    resolve(install.root,pointer)
    return pointer


def delegate(directory, filename, argv):
    """A stable entry point forwards to the atomically selected, verified tool set."""
    install=kit.Install.load(directory)
    if not install.meta.get("host_tools"): return
    target=resolve(install.root,install.meta["host_tools"])/filename
    release.require(filename in kit.KIT_FILES and target.is_file(),"unsupported_host_entrypoint")
    if Path(sys.argv[0]).resolve() == target: return
    os.execv(sys.executable,[sys.executable,"-B",str(target),*argv])
