"""Transport bounds and pinned SSH command construction; no external hosts."""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[2]/"deploy/customer"))
import siftgate_agent as agent
import siftgate_transport as transport


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.root=Path(self.temp.name).resolve()
        self.key=self.root/"identity"; self.key.write_text("synthetic not-a-key"); self.key.chmod(0o600)
        self.known=self.root/"known_hosts"; self.known.write_text("synthetic pinned host fixture"); self.known.chmod(0o600)
    def tearDown(self): self.temp.cleanup()
    def ssh(self):
        return transport.ssh_configuration("example.invalid","gateway","/srv/gateway space's","/opt/kit space's/agent.py",self.key,self.known)

    def test_ssh_uses_pinned_host_identity_and_quotes_fixed_remote_paths(self):
        config=self.ssh(); command=transport.command_for(config)
        self.assertIn("StrictHostKeyChecking=yes",command); self.assertIn("BatchMode=yes",command)
        self.assertIn("ForwardAgent=no",command); self.assertIn("ClearAllForwardings=yes",command)
        self.assertEqual(command[command.index("-F")+1],"/dev/null")
        self.assertIn("'\"'\"'",command[-1]); self.assertNotIn("accept-new"," ".join(command))
        self.known.write_text("host identity changed")
        with self.assertRaisesRegex(transport.TransportError,"ssh_host_keys_changed"): transport.command_for(config)

    def test_untrusted_local_files_and_ssh_flags_are_not_commands(self):
        self.key.chmod(0o644)
        with self.assertRaises(transport.TransportError): self.ssh()
        self.key.chmod(0o600)
        for host in ("-oProxyCommand=bad","host;echo bad","localhost\nother"):
            with self.assertRaises(transport.TransportError): transport.ssh_configuration(host,"gateway","/srv/gateway","/opt/agent.py",self.key,self.known)

    def test_bounded_rpc_roundtrip_has_no_shell_and_preserves_structured_errors(self):
        script="import json,sys; p=json.load(sys.stdin); print(json.dumps({'format':p['format'],'ok':True,'result':{'command':p['command']}}))"
        payload={"format":agent.PROTOCOL,"command":"observe","arguments":{}}
        result=transport.bounded_rpc([sys.executable,"-c",script],payload,3)
        self.assertEqual(result,{"command":"observe"})
        error="import json; print(json.dumps({'format':'siftgate-agent-rpc-v1','ok':False,'error_code':'verified_release_required'})); raise SystemExit(1)"
        with self.assertRaises(transport.TransportError) as raised: transport.bounded_rpc([sys.executable,"-c",error],payload,3)
        self.assertEqual(raised.exception.code,"verified_release_required"); self.assertFalse(raised.exception.uncertain)
        version_error=error.replace("verified_release_required","github_verifier_2_86_required")
        with self.assertRaises(transport.TransportError) as version:
            transport.bounded_rpc([sys.executable,"-c",version_error],payload,3)
        self.assertEqual(version.exception.code,"github_verifier_2_86_required"); self.assertFalse(version.exception.uncertain)

    def test_timeout_output_flood_and_malformed_response_are_uncertain_not_safe_retries(self):
        for program,timeout in (("import time;time.sleep(3)",.1),("print('x'*3000000)",3),("print('{}')",3)):
            with self.subTest(program=program),self.assertRaises(transport.TransportError) as raised:
                transport.bounded_rpc([sys.executable,"-c",program],{"format":agent.PROTOCOL},timeout)
            self.assertTrue(raised.exception.uncertain)


if __name__=="__main__": unittest.main()
