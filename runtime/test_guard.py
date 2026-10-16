"""Offline adapter contract tests. Mock child start; no AWS, model or Docker calls."""
import importlib.util
import io
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from http.server import ThreadingHTTPServer
from guard import install, MAX_BODY
ROOT = Path(__file__).resolve().parent

class GuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="docintel-runtime-test-")
        spec = importlib.util.spec_from_file_location("offline_adapter", ROOT / "vendor/control_plane.py")
        self.runtime = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.runtime)
        r = self.runtime
        base = Path(self.tmp.name)
        r.WORKSPACE_DIR = base / "workspace"
        r.MOUNT_PATH = base / "input"
        r.OUTPUTS_MOUNT_PATH = base / "output"
        r.SKILLS_DIR = r.MOUNT_PATH / "skills"
        r.WORKSPACE_SKILLS_DIR = r.WORKSPACE_DIR / "skills"
        r.STATE_DIR = r.WORKSPACE_DIR / ".ac-bma"
        r.STATE_FILE = r.STATE_DIR / "state.json"
        for p in [r.WORKSPACE_DIR, r.MOUNT_PATH, r.OUTPUTS_MOUNT_PATH]: p.mkdir()
        self.start = Mock(return_value=True)
        r.ExecServer._start_locked = self.start
        r.ExecServer.binary_ready = lambda _: True
        install(r)
        self.addCleanup(self.tmp.cleanup)

    def ready_server(self):
        r = self.runtime
        r.SKILLS_DIR.mkdir()
        (r.SKILLS_DIR / "document-analysis").mkdir()
        (r.SKILLS_DIR / "document-analysis/SKILL.md").write_text("reviewed fixture skill")
        server = r.Server()
        self.assertTrue(server.storage.verify())
        server.activated = True
        r.SERVER = server
        return server

    def activation(self, **fields):
        r = self.runtime
        return {"action": "activate", "protocol_version": r.PROTOCOL_VERSION,
                "environment_id": "env-synthetic", "attachment_generation": 1,
                "workspace": {"directory": str(r.WORKSPACE_DIR), "capability_directories": [str(r.WORKSPACE_SKILLS_DIR)]}, **fields}

    def test_activation_lease_and_generation_contract(self):
        server = self.ready_server()
        self.assertEqual(server.dispatch(self.activation())[0], 200)
        self.start.assert_called_once()
        self.assertEqual(server.exec_server.spec["service"], "bedrock-mantle")
        self.assertEqual(server.dispatch(self.activation(attachment_generation=0))[0], 409)
        self.assertEqual(server.dispatch(self.activation(environment_id="another", force=True))[0], 409)
        lease = {"action": "renew_turn_lease", "protocol_version": self.runtime.PROTOCOL_VERSION,
                 "environment_id": "env-synthetic", "attachment_generation": 1, "turn_id": "turn-synthetic", "lease_duration_seconds": 30}
        self.assertEqual(server.dispatch(lease)[0], 200)
        self.assertEqual(server.turn_leases.status()["health"], "HealthyBusy")
        self.assertEqual(server.dispatch({**lease, "action": "release_turn_lease"})[0], 200)
        self.assertEqual(server.turn_leases.status()["health"], "Healthy")

    def test_callback_and_identity_overrides_rejected(self):
        server = self.ready_server()
        for fields in [{"endpoint": "https://attacker.example"}, {"region": "eu-west-2"}, {"service": "sts"}, {"remote_transport": "other"}, {"credentials": {}}, {"awsProfile": "sat"}, {"aws_profile": "sat"}, {"workspace": {"directory": str(self.runtime.WORKSPACE_DIR), "capability_directories": ["/tmp/evil"]}}]:
            self.assertEqual(server.dispatch(self.activation(**fields))[0], 400)
        for action in ["connect", "logs"]:
            self.assertEqual(server.dispatch({"action": action})[0], 400)
        self.start.assert_not_called()

    def test_restored_spec_cannot_bypass_start_validation(self):
        server = self.ready_server()
        self.assertEqual(server.dispatch(self.activation())[0], 200)
        valid = dict(server.exec_server.spec)
        self.start.reset_mock()
        for changed in [{**valid, "endpoint": "https://attacker.example"}, {k: v for k, v in valid.items() if k != "service"}, {**valid, "credentials": {}}]:
            self.runtime.STATE_DIR.mkdir(exist_ok=True)
            self.runtime.STATE_FILE.write_text(json.dumps({"spec": changed, "desired": "connected"}))
            child = self.runtime.ExecServer(server.storage)
            child.load_state()
            self.assertIsNone(child.spec)
            child.spec = changed
            self.assertFalse(child._start_locked())
        self.start.assert_not_called()
        self.runtime.STATE_FILE.write_text(json.dumps({"spec": valid, "desired": "connected"}))
        restored = self.runtime.ExecServer(server.storage)
        restored.load_state()
        self.assertTrue(restored.resume_from_state())
        self.start.assert_called_once()

    def test_mismatched_defaults_rejected(self):
        for key, value in [("DEFAULT_SERVICE", "sts"), ("DEFAULT_REMOTE_TRANSPORT", "other"), ("DEFAULT_REGION", "eu-west-2")]:
            with patch.object(self.runtime, key, value):
                with self.assertRaises(ValueError): install(self.runtime)

    def test_missing_skills_fail_readiness_and_existing_skill_refreshes(self):
        server = self.runtime.Server()
        self.assertFalse(server.storage.verify())
        self.assertIn("skills source does not exist", server.storage.last_error)
        server = self.ready_server()
        destination = self.runtime.WORKSPACE_SKILLS_DIR / "document-analysis/SKILL.md"
        destination.write_text("stale content")
        self.assertTrue(server.storage.sync_skills())
        self.assertEqual(destination.read_text(), "reviewed fixture skill")

    def test_http_adapter_routes_bound_payloads_and_preserve_health(self):
        self.ready_server()
        http = ThreadingHTTPServer(("127.0.0.1", 0), self.runtime.Handler)
        worker = threading.Thread(target=http.serve_forever, daemon=True)
        worker.start()
        self.addCleanup(http.server_close)
        self.addCleanup(http.shutdown)
        url = f"http://127.0.0.1:{http.server_port}"
        with urlopen(url + "/ping", timeout=3) as response:
            self.assertEqual(json.load(response)["status"], "Healthy")
        with urlopen(Request(url + "/invocations", data=json.dumps(self.activation()).encode(), headers={"Content-Type": "application/json"}), timeout=3) as response:
            self.assertEqual(json.load(response)["environment_id"], "env-synthetic")
        for payload in [b"x" * (MAX_BODY + 1), b"[1,2]", b"invalid"]:
            with self.assertRaises(HTTPError) as failure:
                urlopen(Request(url + "/invocations", data=payload), timeout=3)
            self.assertEqual(failure.exception.code, 400)
            failure.exception.close()
        fake = SimpleNamespace(headers={"Content-Length": "5", "Transfer-Encoding": "chunked"}, rfile=io.BytesIO(b"{}"), close_connection=False)
        self.assertIsNone(self.runtime.Handler.read_json(fake)[0])
        self.assertTrue(fake.close_connection)

if __name__ == "__main__": unittest.main()
