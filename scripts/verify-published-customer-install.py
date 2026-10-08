#!/usr/bin/env python3
"""Cold anonymous signed install on a fresh native runner; never existing2099."""
import argparse
import json
import os
from pathlib import Path
import platform
import socket
import subprocess
import sys
import tempfile

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"deploy/customer"))
import siftgate as kit
import siftgate_release as release
from siftgate_releases import ReleaseCache


def main():
    os.umask(0o077)
    parser=argparse.ArgumentParser(description=__doc__); parser.add_argument("--version",required=True); parser.add_argument("--expected-commit",required=True)
    args=parser.parse_args(); release.version(args.version)
    (ROOT/".local-dev").mkdir(exist_ok=True)
    root=Path(tempfile.mkdtemp(prefix="published-install-",dir=ROOT/".local-dev")).resolve()
    environment=dict(os.environ)
    for key in ("GH_TOKEN","GITHUB_TOKEN","GH_ENTERPRISE_TOKEN","GITHUB_ENTERPRISE_TOKEN"): environment.pop(key,None)
    for key,name in (("GH_CONFIG_DIR","gh-empty"),("DOCKER_CONFIG","docker-empty")):
        folder=root/name; folder.mkdir(mode=0o700); environment[key]=str(folder)
    os.environ.update({key:environment[key] for key in ("GH_CONFIG_DIR","DOCKER_CONFIG")})
    cache=ReleaseCache(root/"releases",runner=lambda args,**kwargs:kit.run(args,env=environment,**kwargs))
    path=cache.fetch(args.version); verified,_=cache.get(path.name)
    manifest=verified.manifest
    release.require(manifest["source_commit"]==args.expected_commit,"published_commit_mismatch")
    tools=release.extract_installer(verified,path/"installer.tar.gz",root/"verified-kit")
    # Empty Docker auth; no registry login and a fresh runner's cold image cache.
    kit.run(["docker","pull",manifest["image"]],env=environment,timeout=1200,output_limit=2*1024*1024)
    with socket.socket() as sock: sock.bind(("127.0.0.1",0)); port=sock.getsockname()[1]
    release.require(port!=2099,"reserved_production_port")
    directory=root/"installation"; install=None
    def cli(*arguments):
        result=subprocess.run([sys.executable,str(tools/"siftgate.py"),"--directory",str(directory),*arguments],env=environment,capture_output=True,text=True,timeout=1200)
        release.require(result.returncode==0,"published_installer_failed")
        return json.loads(result.stdout)
    try:
        cli("init","--timezone","UTC","--port",str(port))
        install=kit.Install.load(directory)
        arch={"x86_64":"amd64","aarch64":"arm64"}.get(platform.machine(),platform.machine())
        release.require(install.meta["engine_arch"]==arch,"native_runner_required")
        identity=release.inspect_local_image(install,install.meta["image"],root)
        release.require(identity["config_digest"]==manifest["platforms"]["linux/"+arch]["config_digest"],"published_image_not_attested")
        cli("up")
        release.require(kit.local_probe(port,"live") and kit.local_probe(port,"ready"),"published_instance_not_ready")
        release.require((directory/"config/activate-code.txt").is_file() and (directory/"config/activate-code.txt").stat().st_mode&0o077==0,"private_first_activation_required")
        print(json.dumps({"published_install_verified":True,"publisher_verified":True,"anonymous_layers_pulled":True,
            "version":args.version,"platform":"linux/"+arch,"config_digest":identity["config_digest"],"existing_instances_changed":False}))
    finally:
        if install: install.compose("down","--timeout","45",timeout=90)


if __name__=="__main__": main()
