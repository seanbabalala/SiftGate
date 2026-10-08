#!/usr/bin/env python3
"""Independent, opt-in Control Room HTTP server. Never runs inside the gateway."""
import argparse
from collections import deque
import http.server
import ipaddress
import json
import os
from pathlib import Path
import re
import signal
import socket
import threading
import time
import urllib.parse

import siftgate as kit
import siftgate_operator as operator
import siftgate_release as release
from siftgate_control_store import ControlError, ControlStore, require
from siftgate_control_service import ControlService, ControlWorker
from siftgate_transport import TransportError, local_configuration, ssh_configuration

ASSETS={"/":("control.html","text/html; charset=utf-8"),"/control.js":("control.js","text/javascript; charset=utf-8"),
        "/control.css":("control.css","text/css; charset=utf-8"),"/control-i18n.json":("control-i18n.json","application/json"),"/favicon.svg":("favicon.svg","image/svg+xml")}


def origin(value):
    try:
        parsed=urllib.parse.urlsplit(value)
        require(parsed.scheme in ("http","https") and parsed.hostname and not parsed.username and not parsed.password and
                parsed.path in ("","/") and not parsed.query and not parsed.fragment,"invalid_control_origin")
        port=parsed.port
        if parsed.scheme=="http":
            try: local=ipaddress.ip_address(parsed.hostname).is_loopback
            except ValueError: local=parsed.hostname=="localhost" or parsed.hostname.endswith(".localhost")
            require(local,"https_required_for_remote_control")
        host=parsed.hostname.lower()
        if ":" in host: host="["+host+"]"
        suffix="" if port is None or port==(443 if parsed.scheme=="https" else 80) else ":"+str(port)
        return parsed.scheme+"://"+host+suffix
    except ValueError: raise ControlError("invalid_control_origin")


class ControlServer(http.server.ThreadingHTTPServer):
    daemon_threads=True
    allow_reuse_address=True
    def __init__(self,address,service,public_origin=None,assets=None):
        require(address[0]=="127.0.0.1" and address[1]!=2099,"independent_loopback_control_port_required")
        self.service=service; self.assets=Path(assets or Path(__file__).resolve().parent)
        self.stop_event=threading.Event(); self.worker_thread=None; self.slots=threading.BoundedSemaphore(16)
        self.auth_requests=deque(); self.auth_lock=threading.Lock()
        super().__init__(address,ControlHandler)
        self.origin=origin(public_origin or "http://127.0.0.1:"+str(self.server_address[1]))
        self.authority=urllib.parse.urlsplit(self.origin).netloc

    def get_request(self):
        connection,address=super().get_request(); connection.settimeout(5); return connection,address

    def process_request(self,request,address):
        if not self.slots.acquire(blocking=False):
            request.close(); return
        try: super().process_request(request,address)
        except BaseException: self.slots.release(); raise

    def process_request_thread(self,request,address):
        try: super().process_request_thread(request,address)
        finally: self.slots.release()

    def handle_error(self,request,address):
        pass  # No raw request bodies, Authorization headers or transport paths in logs.

    def start_worker(self):
        require(self.worker_thread is None,"control_worker_already_started")
        self.worker_thread=threading.Thread(target=ControlWorker(self.service).serve,args=(self.stop_event,),daemon=True,name="siftgate-control-executor")
        self.worker_thread.start()

    def admit_auth(self):
        with self.auth_lock:
            now=time.monotonic()
            while self.auth_requests and self.auth_requests[0]<now-60: self.auth_requests.popleft()
            require(len(self.auth_requests)<60,"authentication_rate_limited",429)
            self.auth_requests.append(now)


class ControlHandler(http.server.BaseHTTPRequestHandler):
    protocol_version="HTTP/1.1"
    server_version="SiftGate-Control"
    sys_version=""

    def log_message(self,*args): pass

    def respond(self,status,value,content_type="application/json; charset=utf-8"):
        body=value if isinstance(value,bytes) else release.canonical(value)
        self.send_response(status)
        for name,val in {"Content-Type":content_type,"Content-Length":str(len(body)),"Cache-Control":"no-store",
                         "Connection":"close","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer",
                         "Cross-Origin-Resource-Policy":"same-origin","X-Frame-Options":"DENY",
                         "Content-Security-Policy":"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"}.items():
            self.send_header(name,val)
        self.end_headers(); self.wfile.write(body); self.close_connection=True

    def validate_request(self,unsafe=False):
        require(self.headers.get_all("Host") and len(self.headers.get_all("Host"))==1 and
                self.headers.get("Host","").lower()==self.server.authority,"control_host_mismatch",403)
        target=urllib.parse.urlsplit(self.path)
        require(not target.scheme and not target.netloc and target.path.startswith("/"),"invalid_request_target")
        if unsafe:
            require(self.headers.get_all("Origin") and len(self.headers.get_all("Origin"))==1 and
                    self.headers.get("Origin")==self.server.origin,"control_origin_mismatch",403)
            require(not self.headers.get_all("Transfer-Encoding") and len(self.headers.get_all("Content-Length") or [])==1,"content_length_required")
        return target

    def authenticate(self,unsafe=False):
        values=self.headers.get_all("Authorization") or []
        require(len(values)==1 and values[0].startswith("Bearer "),"authentication_required",401)
        token=values[0][7:]
        session=self.server.service.store.session(token)
        if unsafe:
            import hmac
            csrf=self.headers.get_all("X-SiftGate-CSRF") or []
            require(len(csrf)==1 and hmac.compare_digest(csrf[0],session["csrf"]),"csrf_required",403)
        return token,session

    def body(self):
        require(self.headers.get_content_type()=="application/json","json_required",415)
        raw_length=self.headers.get("Content-Length","")
        require(re.fullmatch(r"[0-9]{1,8}",raw_length),"invalid_content_length")
        length=int(raw_length); require(0<length<=256*1024,"request_too_large",413)
        remaining=length; chunks=[]; deadline=time.monotonic()+15
        while remaining:
            require(time.monotonic()<deadline,"request_body_timeout",408)
            chunk=self.rfile.read1(min(remaining,16384))
            require(chunk,"incomplete_request")
            chunks.append(chunk); remaining-=len(chunk)
        value=release.json_bytes(b"".join(chunks)); require(type(value) is dict,"json_object_required")
        return value

    def do_OPTIONS(self): self.respond(403,{"error_code":"cross_origin_control_forbidden"})
    def do_PUT(self): self.respond(405,{"error_code":"method_not_allowed"})
    do_DELETE=do_PUT
    do_PATCH=do_PUT

    def do_GET(self):
        try:
            target=self.validate_request(); path=target.path
            if path=="/health":
                return self.respond(200,{"status":"alive","component":"independent_control","executor_running":bool(self.server.worker_thread and self.server.worker_thread.is_alive())})
            if path=="/api/bootstrap": return self.respond(200,{"activation_required":self.server.service.store.setup_required(),"gateway_credentials_accepted":False})
            if path in ASSETS:
                file,kind=ASSETS[path]; asset=self.server.assets/file
                require(asset.is_file() and not asset.is_symlink(),"control_ui_not_packaged",404)
                return self.respond(200,release.read_bytes(asset,4*1024*1024),kind)
            _,session=self.authenticate(); actor=session["user"]["name"]; service=self.server.service; store=service.store
            if path=="/api/session": return self.respond(200,session)
            if path=="/api/sites": return self.respond(200,{"sites":store.sites(actor)})
            if path=="/api/jobs": return self.respond(200,{"jobs":store.jobs(actor)})
            if path=="/api/users": return self.respond(200,{"users":store.users(actor)})
            if path=="/api/audit": return self.respond(200,{"events":store.audit(actor)})
            match=re.fullmatch(r"/api/jobs/(job-[a-f0-9]{32})",path)
            if match: return self.respond(200,store.get_job(actor,match[1]))
            match=re.fullmatch(r"/api/sites/(site-[a-f0-9]{32})/(observation|releases|offline|vault|drills)",path)
            if match:
                commands={"releases":"list_releases","offline":"list_offline_packages","vault":"vault_catalog","drills":"vault_records"}
                result=service.observe(actor,match[1]) if match[2]=="observation" else service.read_agent(actor,match[1],commands[match[2]])
                return self.respond(200,result)
            raise ControlError("not_found",404)
        except (ControlError,TransportError,release.ReleaseError,operator.OperatorFailure) as error:
            self.respond(getattr(error,"status",503),{"error_code":str(error)})
        except Exception: self.respond(500,{"error_code":"control_request_failed"})

    def do_POST(self):
        try:
            path=self.validate_request(unsafe=True).path; body=self.body(); service=self.server.service; store=service.store
            if path=="/api/login":
                require(set(body)=={"username","password"},"invalid_login_fields")
                self.server.admit_auth()
                # Authorization is explicit and origin/port scoped in the client;
                # never emit a host cookie that another local gateway port receives.
                return self.respond(200,store.login(body["username"],body["password"]))
            if path=="/api/activate":
                require(set(body)=={"username","code","password"},"invalid_activation_fields")
                self.server.admit_auth()
                return self.respond(200,store.activate(body["username"],body["code"],body["password"]))
            token,session=self.authenticate(unsafe=True); actor=session["user"]["name"]
            if path=="/api/logout":
                require(not body,"invalid_logout_fields"); store.logout(token); return self.respond(200,{"logged_out":True})
            if path=="/api/password":
                require(set(body)=={"current_password","new_password"},"invalid_password_fields")
                return self.respond(200,store.change_password(actor,body["current_password"],body["new_password"]))
            if path=="/api/users/invite":
                require(set(body)=={"username","roles"},"invalid_invitation_fields")
                return self.respond(201,store.invite(actor,body["username"],body["roles"]))
            match=re.fullmatch(r"/api/users/([a-z][a-z0-9._-]{2,63})",path)
            if match:
                require(set(body)=={"roles","enabled"},"invalid_user_fields"); store.set_user(actor,match[1],body["roles"],body["enabled"])
                return self.respond(200,{"updated":True})
            if path=="/api/proposals":
                result=service.prepare(actor,body); return self.respond(201 if result["proposal"] else 422,result)
            match=re.fullmatch(r"/api/jobs/(job-[a-f0-9]{32})/(approve|promote|pause|cancel|reconcile)",path)
            if match:
                job_id,action=match.groups()
                if action=="approve": result=service.approve(actor,job_id,body)
                elif action=="reconcile": result=service.reconcile(actor,job_id,body)
                elif action=="promote":
                    require(set(body)=={"plan_digest","acknowledge_failures"},"invalid_promotion_fields")
                    result=store.promote(actor,job_id,body["plan_digest"],acknowledge_failures=body["acknowledge_failures"])
                else:
                    require(not body,"invalid_stop_fields"); result=store.request_stop(actor,job_id,cancel=action=="cancel")
                return self.respond(200,result)
            match=re.fullmatch(r"/api/sites/(site-[a-f0-9]{32})/(discover|fetch-release|inspect-release|import-offline)",path)
            if match:
                site_id,action=match.groups()
                if action=="discover":
                    require(set(body)=={"current_version"},"invalid_discovery_fields"); result=service.discover(actor,site_id,body["current_version"])
                elif action=="fetch-release":
                    require(set(body)=={"version"},"invalid_release_fields"); result=service.fetch_release(actor,site_id,body["version"])
                elif action=="inspect-release":
                    require(set(body)=={"release_digest","offline"},"invalid_release_fields"); result=service.inspect_release(actor,site_id,body["release_digest"],body["offline"])
                else:
                    require(set(body)=={"package_id"},"invalid_offline_fields"); result=service.import_offline(actor,site_id,body["package_id"])
                return self.respond(200,result)
            raise ControlError("not_found",404)
        except (ControlError,TransportError,release.ReleaseError,operator.OperatorFailure) as error:
            self.respond(getattr(error,"status",503),{"error_code":str(error)})
        except (socket.timeout,TimeoutError): self.respond(408,{"error_code":"request_body_timeout"})
        except Exception: self.respond(500,{"error_code":"control_request_failed"})


def main():
    os.umask(0o077)
    parser=argparse.ArgumentParser(description=__doc__); parser.add_argument("--home",required=True)
    sub=parser.add_subparsers(dest="command",required=True)
    init=sub.add_parser("init"); init.add_argument("--owner",required=True); init.add_argument("--confirm",action="store_true",required=True)
    serve=sub.add_parser("serve"); serve.add_argument("--port",type=int,default=2100); serve.add_argument("--origin")
    local=sub.add_parser("enroll-local"); local.add_argument("--name",required=True); local.add_argument("--directory",required=True)
    local.add_argument("--agent-path"); local.add_argument("--group",default="default"); local.add_argument("--confirm",action="store_true",required=True)
    ssh=sub.add_parser("enroll-ssh"); ssh.add_argument("--name",required=True); ssh.add_argument("--host",required=True); ssh.add_argument("--user",required=True)
    ssh.add_argument("--directory",required=True); ssh.add_argument("--agent-path",required=True); ssh.add_argument("--identity-file",required=True)
    ssh.add_argument("--known-hosts-file",required=True); ssh.add_argument("--port",type=int,default=22); ssh.add_argument("--python-path",default="/usr/bin/python3")
    ssh.add_argument("--group",default="default"); ssh.add_argument("--confirm",action="store_true",required=True)
    recovery=sub.add_parser("recovery-code"); recovery.add_argument("--username",required=True); recovery.add_argument("--confirm",action="store_true",required=True)
    args=parser.parse_args()
    if args.command=="init":
        home=kit.safe_root(args.home); home.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        store=ControlStore.initialize(home,args.owner,confirmed=args.confirm)
        print(json.dumps({"initialized":True,"activation_code_file":str(store.root/"activate-code.txt"),"restarted_gateway":False})); return
    store=ControlStore(args.home); service=ControlService(store)
    if args.command=="recovery-code":
        code=store.host_recovery_code(args.username,confirmed=args.confirm)
        target=store.root/"recover-code.txt"
        with target.open("w") as file: os.chmod(target,0o600); file.write(code+"\n")
        print(json.dumps({"recovery_code_file":str(target),"expires_in":900})); return
    if args.command in ("enroll-local","enroll-ssh"):
        config=local_configuration(args.directory,args.agent_path) if args.command=="enroll-local" else ssh_configuration(
            args.host,args.user,args.directory,args.agent_path,args.identity_file,args.known_hosts_file,args.port,args.python_path)
        site=service.enroll(args.name,config,args.group,confirmed=args.confirm)
        print(json.dumps({"site_id":site,"restarted_gateway":False})); return
    require(1024<=args.port<=65535 and args.port!=2099,"independent_loopback_control_port_required")
    server=ControlServer(("127.0.0.1",args.port),service,args.origin)
    server.start_worker()
    for signum in (signal.SIGINT,signal.SIGTERM):
        signal.signal(signum,lambda *_:(server.stop_event.set(),threading.Thread(target=server.shutdown,daemon=True).start()))
    print(json.dumps({"control_origin":server.origin,"bind":"127.0.0.1","gateway_restarted":False}),flush=True)
    try: server.serve_forever()
    finally: server.stop_event.set(); server.server_close()


if __name__=="__main__":
    try: main()
    except (ControlError,TransportError,release.ReleaseError,operator.OperatorFailure) as error:
        print(json.dumps({"error_code":str(error)})); raise SystemExit(1)
