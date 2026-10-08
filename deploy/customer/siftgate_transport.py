#!/usr/bin/env python3
"""Bounded local/SSH transport for the host agent's fixed JSON-RPC protocol."""
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath
import re
import selectors
import shlex
import signal
import subprocess
import sys
import time
import uuid

import siftgate as kit
import siftgate_release as release
from siftgate_agent import PROTOCOL


class TransportError(Exception):
    def __init__(self, code, uncertain=False):
        super().__init__(code)
        self.code, self.uncertain=code,uncertain


def require(value,code):
    if not value: raise TransportError(code)


def local_file(value, secret=False):
    require(isinstance(value,str) and Path(value).is_absolute(),"absolute_transport_path_required")
    path=kit.safe_root(value)
    with release.regular_file(path,16*1024*1024) as file:
        info=os.fstat(file.fileno())
        require(info.st_uid in (0,os.getuid()) and not info.st_mode & (0o077 if secret else 0o022),"unsafe_transport_file")
    return path


def remote_path(value):
    require(isinstance(value,str) and value.startswith("/") and len(value)<=4096 and
            all(ord(c)>=32 for c in value) and ".." not in PurePosixPath(value).parts,"unsafe_remote_path")
    return value


def validate_configuration(config, enrollment=False):
    require(type(config) is dict,"invalid_transport_configuration")
    if config.get("transport")=="local":
        require(set(config)=={"transport","directory","agent_path","agent_sha256"},"invalid_transport_configuration")
        kit.safe_root(config["directory"])
        path=local_file(config["agent_path"])
        require(release.sha256(path)==config["agent_sha256"],"local_agent_changed")
    elif config.get("transport")=="ssh":
        require(set(config)=={"transport","host","port","user","directory","agent_path","python_path","identity_file","known_hosts_file","host_keys_sha256"},"invalid_transport_configuration")
        host=config["host"]
        require(isinstance(host,str) and len(host)<=253 and not host.startswith("-"),"invalid_ssh_host")
        try: ipaddress.ip_address(host)
        except ValueError: require(bool(re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}",host)),"invalid_ssh_host")
        require(type(config["port"]) is int and 1<=config["port"]<=65535,"invalid_ssh_port")
        require(isinstance(config["user"],str) and re.fullmatch(r"[a-zA-Z_][a-zA-Z0-9_-]{0,31}",config["user"]),"invalid_ssh_user")
        for name in ("directory","agent_path","python_path"): remote_path(config[name])
        local_file(config["identity_file"],secret=True)
        known=local_file(config["known_hosts_file"])
        require(release.sha256(known)==config["host_keys_sha256"],"ssh_host_keys_changed")
    else: raise TransportError("unsupported_transport")
    return config


def command_for(config):
    validate_configuration(config)
    if config["transport"]=="local":
        return [sys.executable,"-B",config["agent_path"],"--directory",config["directory"],"rpc"]
    remote=" ".join(shlex.quote(value) for value in (config["python_path"],"-B",config["agent_path"],"--directory",config["directory"],"rpc"))
    return ["ssh","-F","/dev/null","-T","-o","BatchMode=yes","-o","IdentitiesOnly=yes","-o","StrictHostKeyChecking=yes",
            "-o","GlobalKnownHostsFile=/dev/null","-o","UserKnownHostsFile="+config["known_hosts_file"],
            "-o","ConnectTimeout=10","-o","ServerAliveInterval=10","-o","ServerAliveCountMax=3",
            "-o","ClearAllForwardings=yes","-o","ForwardAgent=no","-i",config["identity_file"],"-p",str(config["port"]),
            config["user"]+"@"+config["host"],remote]


def bounded_rpc(command, payload, timeout):
    """Bound stdin, stdout, stderr and time. A killed client is NOT a failed remote job."""
    raw=release.canonical(payload)
    require(len(raw)<=512*1024,"rpc_request_too_large")
    process=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
    selector=selectors.DefaultSelector(); output=bytearray(); written=0; received=0
    for stream,kind,event in ((process.stdin,"input",selectors.EVENT_WRITE),(process.stdout,"output",selectors.EVENT_READ),(process.stderr,"error",selectors.EVENT_READ)):
        os.set_blocking(stream.fileno(),False); selector.register(stream,event,kind)
    deadline=time.monotonic()+timeout
    try:
        while selector.get_map():
            if time.monotonic()>=deadline: raise TransportError("agent_delivery_timeout",uncertain=True)
            for key,_ in selector.select(min(.25,max(0,deadline-time.monotonic()))):
                if key.data=="input":
                    try: count=os.write(key.fileobj.fileno(),raw[written:written+65536])
                    except BlockingIOError: continue
                    except BrokenPipeError: count=0; written=len(raw)
                    written+=count
                    if written>=len(raw): selector.unregister(key.fileobj); key.fileobj.close()
                else:
                    try: chunk=os.read(key.fileobj.fileno(),65536)
                    except BlockingIOError: continue
                    if not chunk: selector.unregister(key.fileobj); key.fileobj.close(); continue
                    received+=len(chunk)
                    if received>2*1024*1024: raise TransportError("agent_output_limit",uncertain=True)
                    if key.data=="output": output.extend(chunk)
        code=process.wait(timeout=max(.1,deadline-time.monotonic()))
        try: envelope=release.json_bytes(output)
        except Exception: raise TransportError("invalid_agent_response",uncertain=True)
        if not (type(envelope) is dict and envelope.get("format")==PROTOCOL and type(envelope.get("ok")) is bool):
            raise TransportError("invalid_agent_response",uncertain=True)
        if envelope["ok"] is False:
            error=envelope.get("error_code")
            if not (isinstance(error,str) and re.fullmatch(r"[a-z0-9_]{1,100}",error)): raise TransportError("invalid_agent_error",uncertain=True)
            raise TransportError(error)
        if code!=0: raise TransportError("agent_exit_uncertain",uncertain=True)
        if set(envelope)!={"format","ok","result"}: raise TransportError("invalid_agent_response",uncertain=True)
        return envelope["result"]
    except subprocess.TimeoutExpired:
        raise TransportError("agent_delivery_timeout",uncertain=True)
    finally:
        selector.close()
        if process.poll() is None:
            try: os.killpg(process.pid,signal.SIGKILL)
            except ProcessLookupError: pass
            process.wait(timeout=5)
        for stream in (process.stdin,process.stdout,process.stderr):
            if not stream.closed: stream.close()


class AgentClient:
    def __init__(self,configuration,installation_id,runner=bounded_rpc):
        self.configuration=validate_configuration(configuration)
        self.installation_id=installation_id; self.runner=runner

    def call(self,command,arguments=None,request_id=None,timeout=180):
        payload={"format":PROTOCOL,"installation_id":self.installation_id,"request_id":request_id or "rpc-"+uuid.uuid4().hex,
                 "command":command,"arguments":arguments or {}}
        return self.runner(command_for(self.configuration),payload,timeout)

    def observe(self):
        before=time.time()
        result=self.call("observe",timeout=30)
        after=time.time()
        require(type(result) is dict and result.get("protocol")==PROTOCOL and
                (self.installation_id is None or result.get("installation_id")==self.installation_id),"agent_identity_mismatch")
        from siftgate_operator import parse_time
        observed=parse_time(result["observed_at"])
        require(before-5 <= observed <= after+5,"agent_clock_skew")
        return result


def local_configuration(directory,agent_path=None):
    path=local_file(str(Path(agent_path or Path(__file__).resolve().parent/"siftgate_agent.py").resolve()))
    return validate_configuration({"transport":"local","directory":str(kit.safe_root(directory)),"agent_path":str(path),"agent_sha256":release.sha256(path)})


def ssh_configuration(host,user,directory,agent_path,identity_file,known_hosts_file,port=22,python_path="/usr/bin/python3"):
    known=local_file(str(Path(known_hosts_file).expanduser().absolute()))
    return validate_configuration({"transport":"ssh","host":host,"user":user,"directory":directory,"agent_path":agent_path,
        "port":port,"python_path":python_path,"identity_file":str(Path(identity_file).expanduser().absolute()),
        "known_hosts_file":str(known),"host_keys_sha256":release.sha256(known)})
