"""Real loopback HTTP policy tests; simulated agent transports and no gateway access."""
import http.client
import json
from pathlib import Path
import threading
import unittest

import test_control_store as fixtures
from test_control_service import Agents
from siftgate_control import ControlServer, origin
from siftgate_control_service import ControlService
from siftgate_control_store import ControlError


class ControlHTTPTests(unittest.TestCase):
    def setUp(self):
        self.fixture=fixtures.LedgerTests(); self.fixture.setUp(); self.store=self.fixture.store
        self.agents=Agents(self.store)
        self.server=ControlServer(("127.0.0.1",0),ControlService(self.store,self.agents.client))
        self.thread=threading.Thread(target=self.server.serve_forever); self.thread.start()
        self.owner=self.store.login("owner",fixtures.PASSWORD)
        self.viewer=self.store.login("viewer",fixtures.PASSWORD)
    def tearDown(self):
        self.server.stop_event.set(); self.server.shutdown(); self.server.server_close(); self.thread.join(3); self.fixture.tearDown()
    def request(self,method,path,body=None,session=None,headers=None):
        connection=http.client.HTTPConnection("127.0.0.1",self.server.server_address[1],timeout=3)
        extra={"Origin":self.server.origin}
        if session: extra.update(Authorization="Bearer "+session["token"],**{"X-SiftGate-CSRF":session["csrf"]})
        if body is not None: extra["Content-Type"]="application/json"
        if headers: extra.update(headers)
        connection.request(method,path,json.dumps(body) if body is not None else None,extra)
        response=connection.getresponse(); raw=response.read(); output=(response.status,dict(response.getheaders()),json.loads(raw))
        connection.close(); return output

    def test_gateway_cookies_and_tokens_are_not_control_authentication(self):
        self.assertEqual(self.request("GET","/api/sites")[0],401)
        self.assertEqual(self.request("GET","/api/sites",headers={"Cookie":"siftgate_control_session="+self.owner["token"]})[0],401)
        self.assertEqual(self.request("GET","/api/sites",headers={"Authorization":"Bearer eyJhbGciOiJIUzI1NiJ9.gateway.jwt"})[0],401)
        status,headers,result=self.request("POST","/api/login",{"username":"owner","password":fixtures.PASSWORD})
        self.assertEqual(status,200); self.assertNotIn("Set-Cookie",headers); self.assertTrue(result["token"].startswith("sgc_"))

    def test_host_origin_and_csrf_all_fail_closed(self):
        for headers in ({"Host":"attacker.invalid"},{"Origin":"http://127.0.0.1:2099"},{"X-SiftGate-CSRF":"wrong"}):
            with self.subTest(headers=headers): self.assertEqual(self.request("POST","/api/logout",{},self.owner,headers)[0],403)
        self.assertEqual(self.request("GET","/api/session",session=self.owner)[0],200)
        self.assertEqual(self.request("POST","/api/logout",{},self.owner)[0],200)
        self.assertEqual(self.request("GET","/api/session",session=self.owner)[0],401)

    def test_role_denial_cannot_create_users_or_proposals(self):
        self.assertEqual(self.request("POST","/api/users/invite",{"username":"hacker","roles":["admin"]},self.viewer)[0],403)
        self.assertEqual(self.request("POST","/api/proposals",{},self.viewer)[0],403)
        self.assertEqual(self.request("GET","/api/audit",session=self.viewer)[0],403)
        status,_,result=self.request("GET","/api/sites",session=self.viewer)
        self.assertEqual(status,200); self.assertNotIn("/synthetic/",json.dumps(result))

    def test_reconciliation_endpoint_cannot_accept_client_receipts_or_self_approval(self):
        job=self.fixture.propose(); self.fixture.approve(job); self.fixture.start_target(job); self.store.reconcile_interrupted()
        current=self.store.get_job("viewer",job["id"])
        path="/api/jobs/"+job["id"]+"/reconcile"
        payload={"plan_digest":job["plan_digest"],"revision":current["revision"],"cancel_pending":True}
        self.assertEqual(self.request("POST",path,payload,self.viewer)[0],403)
        self.assertEqual(self.request("POST",path,{**payload,"receipt":{"status":"succeeded"}},self.owner)[0],400)
        self.assertEqual(self.request("POST",path,{**payload,"cancel_pending":False},self.owner)[0],400)
        self.assertEqual(self.store.get_job("viewer",job["id"])["status"],"needs_attention")

    def test_no_arbitrary_path_exec_route_or_cors_permission(self):
        for path in ("/api/exec","/api/restart","/../../control.sqlite"):
            self.assertEqual(self.request("GET",path,session=self.owner)[0],404)
        status,headers,_=self.request("OPTIONS","/api/proposals",headers={"Origin":"https://attacker.invalid"})
        self.assertEqual(status,403); self.assertNotIn("Access-Control-Allow-Origin",headers)
        self.assertEqual(headers["X-Content-Type-Options"],"nosniff")
        self.assertIn("frame-ancestors 'none'",headers["Content-Security-Policy"])

    def test_remote_http_and_gateway_port_are_not_control_server_options(self):
        with self.assertRaises(ControlError): origin("http://ops.example.com")
        self.assertEqual(origin("https://ops.example.com:443/"),"https://ops.example.com")
        with self.assertRaises(ControlError): ControlServer(("127.0.0.1",2099),self.server.service)
        with self.assertRaises(ControlError): ControlServer(("0.0.0.0",2100),self.server.service)


if __name__=="__main__": unittest.main()
