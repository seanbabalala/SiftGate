"""RPC envelopes bind the instance and never accept path/command escape hatches."""
import unittest
from pathlib import Path
import sys
from unittest.mock import Mock

sys.path.insert(0,str(Path(__file__).resolve().parents[2]/"deploy/customer"))

import siftgate_agent as agent
import siftgate_operator as operator


class AgentRPCTests(unittest.TestCase):
    def setUp(self):
        self.agent=agent.Agent.__new__(agent.Agent)
        self.agent.install=Mock(); self.agent.install.meta={"id":"a"*32}
        self.agent.operator=Mock()
    def request(self,command,arguments,identity="a"*32):
        return {"format":agent.PROTOCOL,"installation_id":identity,"request_id":"rpc-test-001","command":command,"arguments":arguments}

    def test_wrong_instance_and_unknown_commands_fail_before_actions(self):
        for request in (self.request("plan_backup",{},"b"*32),self.request("shell",{"command":"do-not-run"}),self.request("restart",{})):
            with self.assertRaises(operator.OperatorFailure): self.agent.handle(request)
        self.agent.operator.assert_not_called()

    def test_web_rpc_cannot_supply_image_paths_or_manual_signature_bypass(self):
        for command,arguments in (("plan_upgrade",{"image":"attacker:latest","accept_image_risk":True}),
                                  ("plan_backup",{"directory":"/other"}),
                                  ("import_offline",{"package_id":"../../other"})):
            with self.assertRaises(operator.OperatorFailure): self.agent.handle(self.request(command,arguments))
        self.agent.operator.assert_not_called()

    def test_unverified_upgrade_cannot_be_approved_or_executed_over_rpc(self):
        op=Mock(); op.store.get.return_value={"plan":{"operation":"upgrade"},"plan_digest":"c"*64,"status":"queued"}
        self.agent.operator.return_value=op
        with self.assertRaisesRegex(operator.OperatorFailure,"verified_release_required"):
            self.agent.handle(self.request("execute_job",{"plan_id":"op-"+"d"*32,"plan_digest":"c"*64,"control_job_id":"job-"+"e"*32}))
        op.run_once.assert_not_called()


if __name__=="__main__": unittest.main()
