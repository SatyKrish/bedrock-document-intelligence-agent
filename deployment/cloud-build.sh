#!/usr/bin/env bash
set -euo pipefail
trap 'docker logout "$REGISTRY" >/dev/null 2>&1 || true' EXIT
[[ "$(uname -m)" == "aarch64" ]]
docker build --platform linux/arm64 -t docintel-runtime:test .runtime-build/context
docker run --rm --network none --read-only --tmpfs /tmp --entrypoint /opt/bma/bin/codex docintel-runtime:test --version
docker run --rm --network none --read-only --tmpfs /tmp --entrypoint /opt/bma/bin/codex docintel-runtime:test exec-server --help >/dev/null
docker run --rm --network none --read-only --tmpfs /tmp --entrypoint python3 docintel-runtime:test -c 'import subprocess,time,urllib.request,json; p=subprocess.Popen(["python3","-u","/app/entrypoint.py"]); time.sleep(1); assert json.load(urllib.request.urlopen("http://127.0.0.1:8080/ping",timeout=5))["status"]=="Healthy";p.terminate();p.wait(timeout=5)'
tag="source-${SOURCE_DIGEST}"
docker tag docintel-runtime:test "${REGISTRY}/${RUNTIME_REPO}:${tag}"
docker push "${REGISTRY}/${RUNTIME_REPO}:${tag}"
runtime_digest="$(aws ecr describe-images --repository-name "$RUNTIME_REPO" --image-ids imageTag="$tag" --query 'imageDetails[0].imageDigest' --output text)"
app_digest=""
if [[ "$DEPLOY_MODE" == "hosted" ]]; then
  docker build --platform linux/arm64 -t docintel-app:test -f deployment/App.Dockerfile .
  docker run --rm --network none --read-only --tmpfs /tmp --tmpfs /app/.state:uid=1000,gid=1000,mode=0700 --entrypoint node docintel-app:test deployment/container-smoke.mjs
  docker tag docintel-app:test "${REGISTRY}/${APP_REPO}:${tag}"
  docker push "${REGISTRY}/${APP_REPO}:${tag}"
  app_digest="$(aws ecr describe-images --repository-name "$APP_REPO" --image-ids imageTag="$tag" --query 'imageDetails[0].imageDigest' --output text)"
fi
export runtime_digest app_digest
python3 -c 'import json,os;json.dump({"sourceDigest":os.environ["SOURCE_DIGEST"],"runtime":os.environ["runtime_digest"],"app":os.environ["app_digest"]},open("image-result.json","w"))'
aws s3 cp image-result.json "s3://${SOURCE_BUCKET}/results/${RESULT_SOURCE_DIGEST:-$SOURCE_DIGEST}.json" --sse AES256
