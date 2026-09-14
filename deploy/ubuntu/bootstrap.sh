#!/usr/bin/env bash
set -Eeuo pipefail

APP_USER="warmletter"
APP_DIR="/opt/warm-letter-ai-family"
DATA_DIR="/var/lib/warm-letter"
ENV_FILE="/etc/warm-letter/api.env"
REPO_URL="https://github.com/KamiZackJ/warm-letter-ai-family.git"
BRANCH="${WARM_LETTER_BRANCH:-master}"
NODE_VERSION="22.23.2"
PNPM_VERSION="11.19.0"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script as root." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl debian-archive-keyring debian-keyring git gnupg xz-utils

if [[ ! -x "/opt/node-v${NODE_VERSION}-linux-x64/bin/node" ]]; then
  work_dir="$(mktemp -d)"
  trap 'rm -rf "${work_dir}"' EXIT
  archive="node-v${NODE_VERSION}-linux-x64.tar.xz"
  curl --fail --location --silent --show-error \
    "https://nodejs.org/dist/v${NODE_VERSION}/${archive}" \
    --output "${work_dir}/${archive}"
  curl --fail --location --silent --show-error \
    "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" \
    --output "${work_dir}/SHASUMS256.txt"
  (
    cd "${work_dir}"
    grep " ${archive}$" SHASUMS256.txt | sha256sum --check --strict -
  )
  tar --extract --xz --file "${work_dir}/${archive}" --directory /opt
fi

ln -sfn "/opt/node-v${NODE_VERSION}-linux-x64/bin/node" /usr/local/bin/node
ln -sfn "/opt/node-v${NODE_VERSION}-linux-x64/bin/npm" /usr/local/bin/npm
ln -sfn "/opt/node-v${NODE_VERSION}-linux-x64/bin/npx" /usr/local/bin/npx
ln -sfn "/opt/node-v${NODE_VERSION}-linux-x64/bin/corepack" /usr/local/bin/corepack
corepack enable --install-directory /usr/local/bin
corepack prepare "pnpm@${PNPM_VERSION}" --activate

if ! command -v caddy >/dev/null 2>&1; then
  curl --fail --location --silent --show-error \
    "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" \
    | gpg --dearmor --yes --output /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl --fail --location --silent --show-error \
    "https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt" \
    --output /etc/apt/sources.list.d/caddy-stable.list
  chmod 0644 /usr/share/keyrings/caddy-stable-archive-keyring.gpg \
    /etc/apt/sources.list.d/caddy-stable.list
  apt-get update
  apt-get install -y caddy
fi

if ! id "${APP_USER}" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "${DATA_DIR}" --shell /usr/sbin/nologin "${APP_USER}"
fi

if [[ "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" -lt 1500000 ]] \
  && [[ "$(swapon --show --noheadings | wc -l)" -eq 0 ]]; then
  fallocate -l 2G /swapfile
  chmod 0600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

install -d -o "${APP_USER}" -g "${APP_USER}" "${APP_DIR}"
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"

if [[ ! -d "${APP_DIR}/.git" ]]; then
  runuser -u "${APP_USER}" -- env HOME="${DATA_DIR}" \
    git clone --branch "${BRANCH}" --depth 1 "${REPO_URL}" "${APP_DIR}"
else
  runuser -u "${APP_USER}" -- env HOME="${DATA_DIR}" \
    git -C "${APP_DIR}" fetch --depth 1 origin \
      "+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}"
  runuser -u "${APP_USER}" -- env HOME="${DATA_DIR}" \
    git -C "${APP_DIR}" checkout -B "${BRANCH}" "origin/${BRANCH}"
fi

install -d -o "${APP_USER}" -g "${APP_USER}" "${DATA_DIR}/uploads"
(
  cd "${APP_DIR}"
  runuser -u "${APP_USER}" -- env HOME="${DATA_DIR}" \
    /usr/local/bin/pnpm --filter '@warm-letter/api...' install --frozen-lockfile
  runuser -u "${APP_USER}" -- env HOME="${DATA_DIR}" NODE_OPTIONS=--max-old-space-size=512 \
    /usr/local/bin/pnpm --filter @warm-letter/api build
)

install -d -m 0750 /etc/warm-letter
if [[ ! -f "${ENV_FILE}" ]]; then
  install -m 0600 "${APP_DIR}/deploy/ubuntu/api.env.example" "${ENV_FILE}.example"
  echo "Missing ${ENV_FILE}. Install the secret environment file before enabling the service." >&2
  exit 2
fi

chown root:root "${ENV_FILE}"
chmod 0600 "${ENV_FILE}"
install -m 0644 "${APP_DIR}/deploy/ubuntu/warm-letter-api.service" \
  /etc/systemd/system/warm-letter-api.service
install -m 0644 "${APP_DIR}/deploy/ubuntu/Caddyfile" /etc/caddy/Caddyfile

systemctl daemon-reload
systemctl enable warm-letter-api.service
systemctl restart warm-letter-api.service
caddy validate --config /etc/caddy/Caddyfile
systemctl enable --now caddy
systemctl reload caddy

systemctl --no-pager --full status warm-letter-api.service
for attempt in $(seq 1 30); do
  if curl --fail --silent --show-error http://127.0.0.1:8787/health; then
    exit 0
  fi
  sleep 1
done

journalctl -u warm-letter-api.service -n 100 --no-pager >&2
exit 1
