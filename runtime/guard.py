"""Application policy around the byte-pinned AWS adapter; no custom agent loop."""
import json
from http import HTTPStatus

MAX_BODY = 32768
SUPPORTED_REGIONS = {"us-east-1", "us-east-2", "us-west-2"}
IDENTITY_OVERRIDES = ("credentials", "awsProfile", "aws_profile")


def install(runtime):
    expected = {
        "endpoint": runtime.DEFAULT_ENDPOINT,
        "region": runtime.DEFAULT_REGION,
        "service": "bedrock-mantle",
        "remoteTransport": "direct",
    }
    if (
        expected["region"] not in SUPPORTED_REGIONS
        or expected["endpoint"] != f"https://bedrock-mantle.{expected['region']}.api.aws"
        or runtime.DEFAULT_SERVICE != expected["service"]
        or runtime.DEFAULT_REMOTE_TRANSPORT != expected["remoteTransport"]
    ):
        raise ValueError("Runtime endpoint/service/transport must match a supported region")

    connect = runtime.ExecServer.connect
    activate = runtime.Server.activate_environment
    dispatch = runtime.Server.dispatch
    load_state = runtime.ExecServer.load_state
    start = runtime.ExecServer._start_locked

    def valid_target(request):
        return (
            all(request.get(key) in (None, value) for key, value in expected.items())
            and not any(key in request for key in IDENTITY_OVERRIDES)
        )

    def valid_spec(spec):
        return (
            isinstance(spec, dict)
            and all(spec.get(key) == value for key, value in expected.items())
            and valid_target(spec)
            and isinstance(spec.get("environmentId"), str)
            and 0 < len(spec["environmentId"]) <= 1024
        )

    def guarded_connect(self, request):
        if not valid_target(request):
            return HTTPStatus.BAD_REQUEST, {"error": "runtime target/identity override rejected"}
        if self.spec and self.spec.get("environmentId") != request.get("environmentId"):
            return HTTPStatus.CONFLICT, {"error": "runtime session is bound to another environment"}
        return connect(self, request)

    def guarded_activation(self, request):
        target = {**request, "remoteTransport": request.get("remote_transport", "direct")}
        if not valid_target(target):
            return HTTPStatus.BAD_REQUEST, {"error": "runtime target/identity override rejected"}
        workspace = request.get("workspace")
        paths = workspace.get("capability_directories", []) if isinstance(workspace, dict) else None
        if paths != [str(runtime.WORKSPACE_SKILLS_DIR)]:
            return HTTPStatus.BAD_REQUEST, {"error": "capability directories must match the configured skills path"}
        return activate(self, request)

    def guarded_dispatch(self, request):
        if request.get("action") in {"connect", "logs"}:
            return HTTPStatus.BAD_REQUEST, {"error": "manual connection/log actions are disabled"}
        return dispatch(self, request)

    def guarded_load(self):
        load_state(self)
        if self.spec and not valid_spec(self.spec):
            self.spec = None
            self.desired = "disconnected"
            self.last_error = "persisted runtime target rejected"

    def guarded_start(self):
        # Also covers resume/monitor paths and a state file changed after loading.
        if not valid_spec(self.spec):
            self.last_error = "runtime connection specification rejected"
            return False
        return start(self)

    def bounded_read(self):
        raw = self.headers.get("Content-Length", "0")
        try:
            size = int(raw)
        except ValueError:
            return None, "invalid Content-Length"
        if size < 0 or size > MAX_BODY or self.headers.get("Transfer-Encoding"):
            self.close_connection = True
            return None, "request body exceeds runtime contract"
        if not size:
            return {}, None
        try:
            value = json.loads(self.rfile.read(size))
        except (ValueError, UnicodeDecodeError):
            return None, "invalid JSON"
        return (value, None) if isinstance(value, dict) else (None, "JSON object required")

    original_setup = runtime.Handler.setup

    def bounded_setup(self):
        original_setup(self)
        self.connection.settimeout(10)

    runtime.ExecServer.connect = guarded_connect
    runtime.ExecServer.load_state = guarded_load
    runtime.ExecServer._start_locked = guarded_start
    runtime.Server.activate_environment = guarded_activation
    runtime.Server.dispatch = guarded_dispatch
    runtime.Handler.read_json = bounded_read
    runtime.Handler.setup = bounded_setup
