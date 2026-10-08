#!/usr/bin/env python3
"""SiftGate customer kit. Python 3.9+, Docker/Compose; no pip or host Node needed."""
import argparse
import contextlib
import datetime
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import selectors
import signal
import socket
import stat
import subprocess
import sys
import time
import urllib.request
import uuid
from zoneinfo import ZoneInfo

FORMAT = "siftgate-install-v1"
BACKUP_FORMAT = "siftgate-customer-backup-v1"
HERE = Path(__file__).resolve().parent
KIT_FILES = ("siftgate.py", "compose.yaml", "container-ops.cjs", "siftgate_operator.py", "siftgate_release.py", "siftgate_releases.py", "siftgate_vault.py", "siftgate_tools.py", "siftgate_control_store.py", "siftgate_control_service.py", "siftgate_control.py", "siftgate_transport.py", "siftgate_agent.py", "control.html", "control.js", "control.css", "control-i18n.json", "favicon.svg", "siftgate-control.service", "compose.operator-status.yaml", "siftgate-operator.service")


class OperatorError(Exception):
    pass


def require(value, message):
    if not value:
        raise OperatorError(message)


def write_json(path, value):
    temporary = path.with_name(path.name + ".tmp-" + uuid.uuid4().hex)
    with temporary.open("x") as stream:
        os.chmod(temporary, 0o600)
        json.dump(value, stream, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def bounded_run(args, env, timeout, output_limit):
    process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env, start_new_session=True)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    parts, size, deadline = [], 0, time.monotonic() + timeout
    try:
        while selector.get_map():
            require(time.monotonic() < deadline, "Operation timed out; no raw command output printed")
            for key, _ in selector.select(min(0.25, max(0, deadline - time.monotonic()))):
                chunk = os.read(key.fileobj.fileno(), 65536)
                if not chunk:
                    selector.unregister(key.fileobj); continue
                size += len(chunk)
                require(size <= output_limit, "Operation exceeded its output limit; no raw command output printed")
                parts.append(chunk)
        require(process.wait(timeout=max(0.1, deadline - time.monotonic())) == 0, "Operation failed; no raw command output printed")
        return b"".join(parts).decode("utf-8", "replace").strip()
    finally:
        selector.close()
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)  # Only this newly-created CLI process group.
            process.wait(timeout=5)
        process.stdout.close()


def run(args, env=None, timeout=180, output_limit=None):
    if output_limit is not None:
        return bounded_run(args, env, timeout, output_limit)
    result = subprocess.run(args, text=True, capture_output=True, env=env, timeout=timeout)
    require(result.returncode == 0,
            f"Operation failed (exit {result.returncode}); inspect local Docker logs. No credentials printed.")
    return result.stdout.strip()


def check_image_ref(ref):
    require(isinstance(ref, str) and bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._/:@-]*", ref)),
            "Invalid image reference")
    require(ref.startswith("sha256:") or "@sha256:" in ref or
            (":" in ref.rsplit("/", 1)[-1] and not ref.endswith(":latest")),
            "Select an explicit version/digest, not an unversioned image or latest")
    if "sha256:" in ref:
        require(bool(re.fullmatch(r"[a-f0-9]{64}", ref.split("sha256:")[-1])), "Invalid SHA-256 image digest")


def safe_root(value):
    path = Path(value).expanduser().absolute()
    require(not any(p.is_symlink() for p in [path, *path.parents]), "Installation path must not contain symlinks")
    require(path != Path("/") and path != Path.home(), "Select a dedicated installation directory")
    return path


def tool_directory(root, metadata):
    if metadata.get("host_tools") is None: return root / "kit"
    from siftgate_tools import resolve
    return resolve(root, metadata["host_tools"])


def inventory(root):
    result = {}
    for path in sorted(root.rglob("*")):
        require(not path.is_symlink(), "Snapshots refuse symbolic links")
        if path.is_dir():
            continue
        require(path.is_file() and path.stat().st_nlink == 1, "Snapshots refuse special files and hard links")
        if path.name == "manifest.json" and path.parent == root:
            continue
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        result[path.relative_to(root).as_posix()] = digest.hexdigest()
    return result


def verified_snapshot(path):
    require(path.is_dir() and not path.is_symlink(), "Backup must be a regular directory")
    manifest = json.loads((path / "manifest.json").read_text())
    require(manifest.get("format") == BACKUP_FORMAT, "Unsupported backup format")
    require(isinstance(manifest.get("files"), dict) and manifest["files"] == inventory(path),
            "Backup hash mismatch, missing file, or unexpected file")
    require({"data/gateway.db", "config/gateway.config.yaml", "provider.env"} <= manifest["files"].keys(),
            "Incomplete backup")
    require(all(name == "provider.env" or name.startswith(("config/", "data/", "state/", "kit/"))
                for name in manifest["files"]), "Unexpected backup path")
    image_binding=manifest.get("image_binding")
    if image_binding is not None:
        require(type(image_binding) is dict and set(image_binding)=={"format","runtime_image_id","config_digest","architecture"} and
                image_binding["format"]=="siftgate-backup-image-v1" and image_binding["architecture"] in ("amd64","arm64") and
                image_binding["runtime_image_id"]==manifest["installation"].get("image") and
                all(isinstance(image_binding[key],str) and re.fullmatch(r"sha256:[a-f0-9]{64}",image_binding[key]) for key in ("runtime_image_id","config_digest")),
                "Invalid backup image binding")
    kit_files={name[4:]:value for name,value in manifest["files"].items() if name.startswith("kit/")}
    recovery_kit=manifest.get("recovery_kit")
    if recovery_kit is not None or kit_files:
        require(type(recovery_kit) is dict and set(recovery_kit)=={"format","files_digest"} and
                recovery_kit["format"]=="siftgate-backup-kit-v1" and
                set(kit_files)==set(KIT_FILES)|{"gateway.config.example.yaml"},"Incomplete backup tool kit")
        from siftgate_release import canonical
        require(hashlib.sha256(canonical(kit_files)).hexdigest()==recovery_kit["files_digest"],"Backup tool kit mismatch")
    return manifest


def check_restore_image(install, manifest, image, scratch):
    """Check before mounting/copying customer data; old backups stay strict-ID only."""
    binding=manifest.get("image_binding")
    if binding is None:
        original=manifest["installation"]
        require(image==original["image"] and isinstance(original.get("engine_id"),str) and original["engine_id"]==install.meta.get("engine_id") and
                original.get("engine_arch") in ("amd64","arm64") and original["engine_arch"]==install.meta.get("engine_arch"),
                "Legacy backup requires its original engine, architecture and runtime image; portable identity is unproven")
        return
    from siftgate_release import inspect_local_image
    actual=inspect_local_image(install,image,scratch)
    require(actual["runtime_image_id"]==image and actual["config_digest"]==binding["config_digest"] and
            actual["architecture"]==binding["architecture"],"Restore image configuration differs from backup; no customer files mounted or copied")


def recovery_identity_evidence(value):
    from siftgate_release import json_bytes
    require(isinstance(value,str) and len(value)<=65536,"Recovery identity evidence missing")
    result=json_bytes(value.encode())
    require(type(result) is dict and result.get("ok") is True and result.get("action")=="restore-identity" and
            result.get("identity_mode") in ("managed","legacy_session_secret"),"Recovery toolkit did not prove session revocation")
    if result["identity_mode"]=="legacy_session_secret":
        require(result.get("only_session_secret_changed") is True and all(isinstance(result.get(key),str) and re.fullmatch(r"[a-f0-9]{64}",result[key])
            for key in ("stable_config_sha256","original_config_sha256","restored_config_sha256")),"Invalid legacy recovery evidence")
    return result


def prune_snapshots(directory, installation_id, keep, newest):
    require(1 <= keep <= 365, "keep must be between 1 and 365")
    candidates = []
    for path in directory.glob("backup-*"):
        if path == newest:
            continue
        try:
            manifest = verified_snapshot(path)
            if manifest["installation"]["id"] == installation_id and manifest["purpose"] == "routine":
                candidates.append((manifest["created_at"], path))
        except (OSError, ValueError, KeyError, OperatorError):
            continue  # Unknown, partial, foreign and damaged backups are never removed.
    for _, path in sorted(candidates, reverse=True)[keep - 1:]:
        shutil.rmtree(path)


def local_probe(port, endpoint):
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(f"http://127.0.0.1:{port}/{endpoint}", timeout=5) as response:
            chunks, size, deadline = [], 0, time.monotonic() + 5
            while time.monotonic() < deadline:
                chunk = response.read1(min(8192, 65537 - size))
                if not chunk: break
                chunks.append(chunk); size += len(chunk)
                if size > 65536: return False
            if time.monotonic() >= deadline: return False
            body = json.loads(b"".join(chunks))
            return response.status == 200 and (endpoint != "live" or body.get("status") == "alive")
    except (OSError, ValueError):
        return False


class Install:
    def __init__(self, root, metadata):
        self.root, self.meta = root, metadata

    @classmethod
    def load(cls, value):
        root = safe_root(value)
        meta = json.loads((root / "installation.json").read_text())
        require(meta.get("format") == FORMAT and meta.get("home") == str(root),
                "Unknown or moved installation; use restore into an empty directory")
        require(re.fullmatch(r"[a-f0-9]{32}", meta.get("id", "")), "Invalid installation identity")
        require(meta.get("project") == "siftgate-" + meta["id"][:12], "Invalid project identity")
        require(meta.get("uid") == os.getuid() and meta.get("gid") == os.getgid(),
                "Run kit commands as the original installation owner")
        check_image_ref(meta["image"])
        return cls(root, meta)

    def save(self):
        write_json(self.root / "installation.json", self.meta)

    def docker(self, *args, timeout=180, output_limit=None):
        env = dict(os.environ)
        for key in ("DOCKER_HOST", "DOCKER_CONTEXT", "COMPOSE_FILE", "COMPOSE_PROJECT_NAME"):
            env.pop(key, None)
        endpoint = ["--host", self.meta["docker_host"]] if self.meta.get("docker_host") else [
            "--context", self.meta["docker_context"]]
        return run(["docker", *endpoint, *args], env=env, timeout=timeout, **({"output_limit": output_limit} if output_limit is not None else {}))

    def compose(self, *args, image=None, timeout=180):
        tools = tool_directory(self.root, self.meta)
        env = dict(os.environ)
        for key in list(env):
            if key.startswith(("DOCKER_", "COMPOSE_", "SIFTGATE_")):
                env.pop(key)
        # Preserve Docker authentication configuration, never change the user's context.
        if "DOCKER_CONFIG" in os.environ:
            env["DOCKER_CONFIG"] = os.environ["DOCKER_CONFIG"]
        env.update({
            "SIFTGATE_HOME": str(self.root), "SIFTGATE_IMAGE": image or self.meta["image"],
            "SIFTGATE_INSTALLATION_ID": self.meta["id"],
            "SIFTGATE_KIT_HOME": str(tools),
            "SIFTGATE_UID": str(os.getuid()), "SIFTGATE_GID": str(os.getgid()),
            "SIFTGATE_BIND_ADDRESS": self.meta["bind"], "SIFTGATE_PORT": str(self.meta["port"]),
            "SIFTGATE_TIMEZONE": self.meta["timezone"],
            "SIFTGATE_NODE_ENV": "production" if self.meta["mode"] == "https" else "",
        })
        endpoint = ["--host", self.meta["docker_host"]] if self.meta.get("docker_host") else [
            "--context", self.meta["docker_context"]]
        overlays = []
        if self.meta.get("operator_status") is True:
            public = self.root / "operator/public"
            require(public.is_dir() and not public.is_symlink(), "Enroll the operator before enabling its read-only status bridge")
            overlays = ["-f", str(tools / "compose.operator-status.yaml")]
        return run(["docker", *endpoint, "compose", "--project-name", self.meta["project"],
                    "--project-directory", str(self.root), "--env-file", str(self.root / "compose.env"),
                    "-f", str(tools / "compose.yaml"), *overlays, *args], env=env, timeout=timeout)

    def check_engine(self):
        info = json.loads(self.docker("info", "--format", "{{json .}}"))
        require(info["OSType"] == "linux", "Linux containers are required")
        if self.meta.get("engine_id"):
            require(info["ID"] == self.meta["engine_id"], "Docker engine changed; refusing to target another daemon")
        self.meta["engine_id"] = info["ID"]
        self.meta["engine_arch"] = {"x86_64": "amd64", "aarch64": "arm64"}.get(info["Architecture"], info["Architecture"])
        version = self.docker("compose", "version", "--short").lstrip("v")
        parts = tuple(int(v) for v in version.split("-")[0].split(".")[:2])
        require(parts >= (2, 30), "Docker Compose 2.30+ is required for raw secret env files")

    def resolve_image(self, ref, local=False):
        check_image_ref(ref)
        if not local:
            self.docker("pull", ref, timeout=1200)
        value = json.loads(self.docker("image", "inspect", ref))[0]
        require(value["Os"] == "linux", "Image must contain Linux binaries")
        require(value["Architecture"] == self.meta["engine_arch"], "Select a native image for this engine architecture")
        # Immutable runtime handle. Modern stores may return an index/manifest ID,
        # not the config digest used to verify portable offline content.
        return value["Id"]

    def container(self):
        ids = self.compose("ps", "--all", "--quiet", "siftgate").splitlines()
        require(len(ids) <= 1, "Ambiguous gateway container")
        if not ids:
            return None
        obj = json.loads(self.docker("inspect", ids[0]))[0]
        labels = obj["Config"].get("Labels", {})
        require(labels.get("com.docker.compose.project") == self.meta["project"] and
                labels.get("com.docker.compose.service") == "siftgate", "Container ownership mismatch")
        return obj

    def check_disk(self):
        size = 0
        for section in ("data", "config", "state"):
            for path in (self.root / section).rglob("*"):
                value = path.lstat()
                require(stat.S_ISDIR(value.st_mode) or (stat.S_ISREG(value.st_mode) and value.st_nlink == 1), "Unsafe filesystem entry; snapshot refused before maintenance")
                if stat.S_ISREG(value.st_mode): size += value.st_size
        require(shutil.disk_usage(self.root).free >= max(512 * 1024**2, size * 2 + 128 * 1024**2),
                "Insufficient disk space for a verified snapshot")

    def check_port(self):
        with socket.socket() as sock:
            try:
                sock.bind((self.meta["bind"], self.meta["port"]))
            except OSError as error:
                raise OperatorError("Selected host port is occupied/unavailable; existing services were not stopped") from error

    def helper(self, action, *args, image=None):
        # Recovery snapshots are not mounted into the long-running application.
        volumes = ["--volume", str(self.root / "backups") + ":/backups"] if action == "backup" else []
        return self.compose("run", "--rm", "--no-deps", *volumes, "--entrypoint", "node", "siftgate",
                            "/opt/siftgate-kit/container-ops.cjs", action, *args, image=image, timeout=900)

    def wait_ready(self):
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            if local_probe(self.meta["port"], "live") and local_probe(self.meta["port"], "ready"):
                return
            time.sleep(2)
        raise OperatorError("Gateway did not become live/ready within 120 seconds; inspect local logs")

    def up(self):
        require(not (self.root / "maintenance").exists(), "Maintenance marker present; inspect the last operation before removing it")
        current = self.container()
        # Desktop VM forwarders may retain a stopped container's host mapping.
        # Ownership is checked above; let Docker restart that exact container.
        if not current:
            self.check_port()
        self.helper("check")
        self.compose("up", "-d", "--no-build", "--pull", "never", "siftgate")
        self.wait_ready()

    def stop(self):
        self.compose("stop", "--timeout", "45", "siftgate", timeout=90)
        obj = self.container()
        require(not obj or not obj["State"]["Running"], "Gateway is still running; no snapshot was taken")
        require(not obj or obj["State"]["ExitCode"] == 0,
                "Unclean shutdown; inspect retained accounting before backup/upgrade (maintenance remains active)")

    def snapshot(self, purpose):
        self.check_disk()
        name = "backup-" + uuid.uuid4().hex
        self.helper("backup", name)
        target = self.root / "backups" / name
        # Container output is untrusted: verify topology BEFORE any host write.
        require(target.is_dir() and not target.is_symlink(), "Snapshot target must be a regular directory")
        inventory(target)
        from siftgate_release import inspect_local_image, canonical
        actual=inspect_local_image(self,self.meta["image"],self.root)
        require(actual["runtime_image_id"]==self.meta["image"] and actual["architecture"]==self.meta["engine_arch"],"Snapshot runtime image changed")
        tools=tool_directory(self.root,self.meta)
        (target/"kit").mkdir(mode=0o700)
        for filename in (*KIT_FILES,"gateway.config.example.yaml"):
            from siftgate_releases import copy_regular
            copy_regular(tools/filename,target/"kit"/filename,16*1024*1024)
        destination = os.open(target / "provider.env", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(destination, "wb", closefd=False) as output, (self.root / "provider.env").open("rb") as source:
                shutil.copyfileobj(source, output)
                output.flush(); os.fsync(destination)
        finally:
            os.close(destination)
        for file in target.rglob("*"):
            if file.is_file():
                with file.open("rb") as stream:
                    os.fsync(stream.fileno())
        manifest = {"format": BACKUP_FORMAT, "purpose": purpose,
                    "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    "installation": dict(self.meta), "files": inventory(target),
                    "image_binding":{"format":"siftgate-backup-image-v1",**{key:actual[key] for key in ("runtime_image_id","config_digest","architecture")}},
                    "recovery_kit":{"format":"siftgate-backup-kit-v1","files_digest":hashlib.sha256(canonical(inventory(target/"kit"))).hexdigest()}}
        write_json(target / "manifest.json", manifest)
        verified_snapshot(target)
        return target

    def backup(self, keep):
        current = self.container()
        require(current is not None, "Start the installation before its first backup")
        was_running = current["State"]["Running"]
        require(not (self.root / "maintenance").exists(), "Maintenance already active")
        self.check_disk()
        (self.root / "maintenance").touch(mode=0o600, exist_ok=False)
        self.stop()
        # On failure keep the service stopped and the marker present: never hide an unsafe backup.
        target = self.snapshot("routine")
        (self.root / "maintenance").unlink()
        if was_running:
            self.up()
        if keep is not None:
            prune_snapshots(self.root / "backups", self.meta["id"], keep, target)
        return {"backup": str(target), "verified": True}

    def upgrade(self, ref, local):
        require(not (self.root/"operator/policy.json").exists(),
                "Enrolled installations require a verified Operator/Control plan; legacy manual upgrade is disabled")
        require(not (self.root / "maintenance").exists(), "Maintenance already active")
        current = self.container()
        require(current and current["State"]["Running"], "Upgrade requires a running installation")
        image = self.resolve_image(ref, local)
        require(image != self.meta["image"], "Target image is already installed")
        self.helper("check", image=image)  # No application boot/migration at this stage.
        self.check_disk()
        (self.root / "maintenance").touch(mode=0o600, exist_ok=False)
        self.stop()
        backup = self.snapshot("upgrade")  # Upgrade checkpoints are NEVER automatically pruned.
        old = dict(self.meta)
        self.meta.update(image=image, image_source=ref, previous_image=old["image"], upgrade_backup=str(backup))
        self.save()
        try:
            self.compose("up", "-d", "--no-build", "--pull", "never", "siftgate")
            self.wait_ready()
        except Exception:
            # The candidate may already have accepted writes: do NOT boot old code on its schema,
            # and do NOT automatically copy an old snapshot over newly accepted business data.
            self.compose("stop", "--timeout", "45", "siftgate", timeout=90)
            raise OperatorError(f"Upgrade failed. Candidate stopped; maintenance retained. Restore {backup} into a NEW directory for diagnosis/reconciliation.")
        (self.root / "maintenance").unlink()
        return {"image": image, "rollback_checkpoint": str(backup), "ready": True}

    def watchdog(self, recover=False):
        if (self.root / "maintenance").exists():
            return {"status": "maintenance"}
        obj = self.container()
        if not obj or not obj["State"]["Running"] or obj["State"].get("Paused"):
            return {"status": "not-running", "restarted": False}
        state_path = self.root / "watchdog.json"
        state = json.loads(state_path.read_text()) if state_path.exists() else {"failures": 0, "restarts": []}
        require(type(state.get("failures")) is int and 0 <= state["failures"] <= 100000 and
                isinstance(state.get("restarts"), list) and
                all(type(t) in (int, float) and t >= 0 for t in state["restarts"]), "Invalid watchdog state; restart suppressed")
        now = time.time()
        state["restarts"] = [t for t in state["restarts"] if now - t < 900]
        healthy = local_probe(self.meta["port"], "live")
        state["failures"] = 0 if healthy else min(state["failures"] + 1, 100000)
        outcome = "healthy" if healthy else "probe-failed"
        if state["failures"] >= 3 and recover:
            if len(state["restarts"]) >= 3 or any(now - t < 120 for t in state["restarts"]):
                outcome = "rate-limited"
            else:
                state["restarts"].append(now)
                state["failures"] = 0
                write_json(state_path, state)  # Reserve attempt before invoking Docker.
                self.docker("restart", "--time", "45", obj["Id"], timeout=90)
                outcome = "restart-attempted"
        write_json(state_path, state)
        return {"status": outcome, "failures": state["failures"], "restarts_in_window": len(state["restarts"])}


@contextlib.contextmanager
def operator_lock(root):
    with (root / "operator.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise OperatorError("Another installer/watchdog operation is active") from error
        yield


def prepare(args, image, prior=None, expected_image=None, backup_manifest=None):
    root = safe_root(args.directory)
    require(not root.exists(), "Refusing to overwrite an existing directory (including failed/partial installs)")
    require(1024 <= args.port <= 65535, "Use an unprivileged port between 1024 and 65535")
    require(args.bind in ("127.0.0.1", "0.0.0.0"), "Supported bind addresses: 127.0.0.1 or 0.0.0.0")
    require(args.mode == "https" or ipaddress.ip_address(args.bind).is_loopback,
            "Plain HTTP mode is loopback-only; use HTTPS mode behind a trusted TLS proxy for remote access")
    ZoneInfo(args.timezone)  # Reject misspelled/missing timezone database before writing files.
    identity = uuid.uuid4().hex
    docker_host = args.docker_host or os.environ.get("DOCKER_HOST")
    require(not docker_host or docker_host.startswith("unix://"),
            "This bind-mount kit requires a local Unix Docker socket; remote engines are not supported")
    context = None if docker_host else run(["docker", "context", "show"])
    if context:
        endpoint = json.loads(run(["docker", "context", "inspect", context]))[0]["Endpoints"]["docker"]["Host"]
        require(endpoint.startswith("unix://"), "Use a local Docker context for bind mounts")
    meta = {"format": FORMAT, "id": identity, "project": "siftgate-" + identity[:12], "home": str(root),
            "image": image, "image_source": image, "docker_host": docker_host, "docker_context": context,
            "timezone": args.timezone, "port": args.port, "bind": args.bind, "mode": args.mode,
            "uid": os.getuid(), "gid": os.getgid()}
    install = Install(root, meta)
    install.check_engine()
    install.check_port()
    ancestor = next(path for path in root.parents if path.exists())
    require(shutil.disk_usage(ancestor).free >= 512 * 1024**2, "At least 512 MiB free disk is required")
    meta["image"] = install.resolve_image(image, args.local_image)
    if backup_manifest:
        check_restore_image(install,backup_manifest,meta["image"],ancestor)
    else:
        require(expected_image is None or meta["image"] == expected_image,
                "Restore image identity differs from backup; no customer files mounted or copied")
    root.mkdir(parents=True, mode=0o700)
    os.chmod(root, 0o700)
    for name in ("kit", "config", "data", "state", "backups"):
        (root / name).mkdir(mode=0o700)
    source_kit=prior/"kit" if prior and backup_manifest and backup_manifest.get("recovery_kit") else HERE
    for name in KIT_FILES:
        shutil.copyfile(source_kit / name, root / "kit" / name)
    example = source_kit / "gateway.config.example.yaml"
    if not example.exists():
        example = HERE.parent.parent / "gateway.config.example.yaml"
    shutil.copyfile(example, root / "kit/gateway.config.example.yaml")
    (root / "compose.env").write_text("# Installer-owned Compose substitution is supplied explicitly.\n")
    (root / "provider.env").write_text("# Optional provider secrets; raw KEY=value syntax. Never commit this file.\n")
    os.chmod(root / "provider.env", 0o600)
    install.save()
    if prior:
        for section in ("config", "data", "state"):
            shutil.copytree(prior / section, root / section, dirs_exist_ok=True)
        shutil.copyfile(prior / "provider.env", root / "provider.env")
        recovery_identity_evidence(install.helper("restore-identity"))  # No restored management session may survive.
    else:
        install.helper("init")
    install.helper("check")
    return install


def main(argv=None):
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", required=True, help="Dedicated absolute installation directory")
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("init", "restore"):
        sub = commands.add_parser(command)
        sub.add_argument("--port", type=int, default=2099)
        sub.add_argument("--bind", default="127.0.0.1")
        sub.add_argument("--docker-host", help="Local Unix socket (Rancher Desktop is supported)")
        sub.add_argument("--mode", choices=("local", "https"), default="local")
        sub.add_argument("--local-image", action="store_true", help="Use an already loaded image; do not pull")
        if command == "init":
            sub.add_argument("--timezone", required=True, help="Explicit IANA timezone, e.g. UTC or Asia/Shanghai")
            sub.add_argument("--image", help="Versioned image; defaults to the bundle's immutable release image")
        else:
            sub.add_argument("--backup", required=True)
            sub.add_argument("--image",help="Optional loaded image handle/reference; must match the backup's recorded config digest (legacy backups require exact runtime ID)")
    for command in ("doctor", "up", "status", "stop"):
        commands.add_parser(command)
    sub = commands.add_parser("backup")
    sub.add_argument("--accept-downtime", action="store_true", required=True)
    sub.add_argument("--keep", type=int, help="Opt-in verified routine backup rotation (1..365)")
    sub = commands.add_parser("upgrade")
    sub.add_argument("--image", required=True)
    sub.add_argument("--local-image", action="store_true")
    sub.add_argument("--accept-downtime", action="store_true", required=True)
    sub = commands.add_parser("watchdog")
    sub.add_argument("--recover", action="store_true", help="Permit rate-limited recovery of this running container only")
    sub = commands.add_parser("access-code")
    sub.add_argument("--purpose", choices=("activate", "recover"), required=True)
    sub.add_argument("--confirm", action="store_true", required=True, help="Issue a short-lived local access code; replaces any previous code")
    args = parser.parse_args(argv)
    if args.command not in ("init", "restore") and argv is None:
        from siftgate_tools import delegate
        delegate(args.directory, "siftgate.py", sys.argv[1:])
    if args.command == "init":
        image = args.image
        if not image and (HERE / "release.json").exists():
            image = json.loads((HERE / "release.json").read_text())["image"]
        require(image, "Pass --image; this source checkout does not imply a published registry image")
        install = prepare(args, image)
        result = {"initialized": str(install.root), "started": False,
                  "activation_code_file": str(install.root / "config/activate-code.txt"),
                  "next": "Start the gateway, open its Dashboard and set your administrator password using this 15-minute single-use code."}
    elif args.command == "restore":
        source = safe_root(args.backup)
        manifest = verified_snapshot(source)
        args.timezone = manifest["installation"]["timezone"]
        original = manifest["installation"]
        image = args.image or (original["image"] if args.local_image else original["image_source"])
        # Tags can move; a restored image must match the recorded immutable identity below.
        install = prepare(args, image, prior=source, expected_image=original["image"],backup_manifest=manifest)
        result = {"restored": str(install.root), "started": False, "timezone": args.timezone,
                  "image_identity":"verified_config_digest" if manifest.get("image_binding") else "legacy_same_engine_runtime",
                  "tool_kit":"frozen_backup_kit" if manifest.get("recovery_kit") else "invoked_legacy_recovery_kit"}
    else:
        install = Install.load(args.directory)
        with operator_lock(install.root):
            install.check_engine()
            if args.command == "doctor":
                install.check_disk()
                install.helper("check")
                result = {"configuration": "valid", "engine": "matched", "timezone": install.meta["timezone"]}
            elif args.command == "up":
                install.up()
                result = {"ready": True, "port": install.meta["port"]}
            elif args.command == "stop":
                install.stop()
                result = {"stopped": True}
            elif args.command == "backup":
                require(args.keep is None or 1 <= args.keep <= 365, "keep must be between 1 and 365")
                result = install.backup(args.keep)
            elif args.command == "upgrade":
                result = install.upgrade(args.image, args.local_image)
            elif args.command == "watchdog":
                result = install.watchdog(args.recover)
            elif args.command == "access-code":
                require(not (install.root / "maintenance").exists(), "Maintenance active; resolve it before issuing access")
                install.helper(args.purpose + "-code")
                result = {"code_file": str(install.root / ("config/" + args.purpose + "-code.txt")),
                          "expires_in_minutes": 15, "restarted": False}
            else:
                obj = install.container()
                result = {"image": install.meta["image"], "running": bool(obj and obj["State"]["Running"]),
                          "live": local_probe(install.meta["port"], "live") if obj else False,
                          "ready": local_probe(install.meta["port"], "ready") if obj else False,
                          "maintenance": (install.root / "maintenance").exists(),
                          "container": obj["Id"] if obj else None}
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (OperatorError, OSError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
        print(f"SiftGate: {error}", file=sys.stderr)
        sys.exit(1)
