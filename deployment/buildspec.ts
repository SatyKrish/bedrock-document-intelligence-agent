// One trusted build, no deployment/model permissions. Build inputs are hash-pinned.
export const buildSpec = {
  version: "0.2",
  phases: {
    install: {
      "runtime-versions": { python: "3.13", nodejs: "24" },
      commands: [
        "set -euo pipefail",
        "python3 deployment/verify-source.py",
        "python3 scripts/prepare-runtime.py --download",
      ],
    },
    pre_build: {
      commands: [
        "python3 -m unittest discover -s runtime/vendor -p test_control_plane.py",
        "python3 -m unittest discover -s runtime -p test_guard.py",
        "python3 -m unittest discover -s scripts -p test_runtime_prepare.py",
        'aws ecr get-login-password --region "$AWS_DEFAULT_REGION" | docker login --username AWS --password-stdin "$REGISTRY"',
      ],
    },
    build: { commands: ["bash deployment/cloud-build.sh"] },
  },
};
