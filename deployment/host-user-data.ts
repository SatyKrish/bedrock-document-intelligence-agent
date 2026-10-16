import type { Config } from "./config.js";
export function hostUserData(
  c: Config,
  volumeId: string,
  image: string,
  silos: Record<string, unknown>,
) {
  const encode = (x: unknown) =>
    Buffer.from(JSON.stringify(x)).toString("base64");
  const acl = Object.fromEntries(
    c.principals.map((p) => [p.subject, p.documents]),
  );
  const environment = {
    MODE: "bedrock",
    LIVE_AWS_CALLS: "approved",
    HOST: "0.0.0.0",
    LOCAL_PROXY_CLIENT_IP: "enabled",
    PORT: "3000",
    PUBLIC_ORIGIN: c.publicOrigin,
    OIDC_ISSUER: c.identity.issuer,
    OIDC_JWKS_URL: c.identity.jwksUrl,
    OIDC_AUDIENCE: c.identity.audience,
    OIDC_CLIENT_ID: c.identity.spaClientId,
    OIDC_CONNECT_ORIGINS: c.identity.connectOrigins.join(","),
    AWS_REGION: c.region,
    SILOS_FILE: "/config/silos.json",
    CATALOG_ACL_FILE: "/config/acl.json",
    STATE_FILE: "/state/bedrock.sqlite",
  };
  return `set -euo pipefail
# No shell trace or private request/access logging.
volume='${volumeId}'
serial="$(printf '%s' "$volume" | tr -d '-')"
device="/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_$serial"
for i in $(seq 1 60); do [ -b "$device" ] && break; sleep 5; done
[ -b "$device" ] || { echo 'Expected state volume missing; refusing ephemeral state'; exit 1; }
dnf install -y docker nginx awscli2 python3
command -v aws >/dev/null; command -v python3 >/dev/null
systemctl enable --now docker
mkdir -p /var/lib/docintel /etc/docintel
fstype="$(blkid -s TYPE -o value "$device" || true)"
new_fs=false
if [ -z "$fstype" ]; then
  [ -z "$(wipefs --no-act --noheadings "$device")" ] || { echo 'Unexpected disk signature'; exit 1; }
  # This ID refers only to the new stack-owned volume, never an imported disk.
  mkfs.ext4 "$device" >/dev/null
  new_fs=true
elif [ "$fstype" != ext4 ]; then echo 'Unexpected state filesystem'; exit 1; fi
if mountpoint -q /var/lib/docintel; then
  [ "$(readlink -f "$(findmnt -n -o SOURCE --target /var/lib/docintel)")" = "$(readlink -f "$device")" ] || exit 1
else mount "$device" /var/lib/docintel; fi
if [ "$new_fs" = true ]; then printf '%s' '${c.deploymentId}' > /var/lib/docintel/.deployment-id; fi
[ "$(cat /var/lib/docintel/.deployment-id)" = '${c.deploymentId}' ] || { echo 'State ownership marker mismatch'; exit 1; }
mkdir -p /var/lib/docintel/state
chown 1000:1000 /var/lib/docintel/state
chmod 700 /var/lib/docintel/state
aws ssm get-parameter --region '${c.region}' --name '/docintel/${c.deploymentId}/silos' --query Parameter.Value --output text > /etc/docintel/silos.json
printf '%s' '${encode(acl)}' | base64 -d > /etc/docintel/acl.json
printf '%s' '${encode(environment)}' | base64 -d > /etc/docintel/env.json
python3 -c 'import json;d=json.load(open("/etc/docintel/env.json"));open("/etc/docintel/env","w").write("".join(k+"="+v+"\\n" for k,v in d.items()))'
chmod 644 /etc/docintel/silos.json /etc/docintel/acl.json
chmod 600 /etc/docintel/env /etc/docintel/env.json
aws ecr get-login-password --region '${c.region}' | docker login --username AWS --password-stdin '${c.account}.dkr.ecr.${c.region}.amazonaws.com'
docker pull '${image}'
docker logout '${c.account}.dkr.ecr.${c.region}.amazonaws.com' >/dev/null
cat > /etc/nginx/conf.d/docintel.conf <<'NGINX'
server {
 listen 8080;
 access_log off;
 # Only the ALB security group can reach this listener; use its last appended address.
 set_real_ip_from ${c.network.kind === "existing" ? c.network.vpcCidr : "10.0.0.0/16"};
 real_ip_header X-Forwarded-For;
 real_ip_recursive off;
 client_max_body_size 32k;
 location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_set_header Host $http_host;
  proxy_set_header X-Docintel-Client-IP $remote_addr;
  proxy_set_header Authorization $http_authorization;
  proxy_set_header Connection "";
  proxy_http_version 1.1;
  proxy_buffering off;
  proxy_request_buffering off;
  proxy_read_timeout 75s;
 }
}
NGINX
cat > /etc/systemd/system/docintel.service <<'UNIT'
[Unit]
After=docker.service local-fs.target
RequiresMountsFor=/var/lib/docintel
Requires=docker.service
[Service]
Restart=on-failure
RestartSec=5
ExecStartPre=/usr/bin/mountpoint -q /var/lib/docintel
ExecStartPre=/usr/bin/test -f /var/lib/docintel/.deployment-id
ExecStartPre=/bin/sh -c 'test "$(cat /var/lib/docintel/.deployment-id)" = "${c.deploymentId}"'
ExecStart=/usr/bin/docker run --rm --name docintel-app --read-only --tmpfs /tmp -p 127.0.0.1:3000:3000 --env-file /etc/docintel/env -v /etc/docintel:/config:ro -v /var/lib/docintel/state:/state '${image}'
ExecStop=/usr/bin/docker stop --time 20 docintel-app
TimeoutStopSec=30
[Install]
WantedBy=multi-user.target
UNIT
# Reboot must mount the exact retained disk before starting the application.
# Use filesystem UUID in fstab to avoid depending on dynamic device numbering.
uuid="$(blkid -s UUID -o value "$device")"
grep -q "UUID=$uuid " /etc/fstab || printf 'UUID=%s /var/lib/docintel ext4 defaults,nofail 0 2\\n' "$uuid" >> /etc/fstab
systemctl daemon-reload
systemctl enable --now docintel.service nginx
`;
}
