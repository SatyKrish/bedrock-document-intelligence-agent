FROM public.ecr.aws/lambda/microvms@sha256:9628f96011ba10d4b672e18301ce67807db9cb88027e5da892b1ca7169effe1e

# OS setup
RUN dnf install -y tar gzip findutils shadow-utils ca-certificates \
 && dnf clean all \
 && useradd -m -u 1000 app

# Codex
RUN curl -fsSL https://chatgpt.com/codex/install.sh -o /tmp/install-codex.sh \
 && CODEX_NON_INTERACTIVE=1 CODEX_RELEASE=0.154.0 CODEX_INSTALL_DIR=/opt/bma/bin CODEX_HOME=/opt/bma/codex \
    sh /tmp/install-codex.sh \
 && chmod -R a+rX /opt/bma \
 && rm /tmp/install-codex.sh

# CloudWatch agent
RUN arch=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/') \
 && curl -fsSL -o /tmp/cwagent.rpm \
    https://amazoncloudwatch-agent.s3.amazonaws.com/amazon_linux/${arch}/latest/amazon-cloudwatch-agent.rpm \
 && echo "d35a72c2265760238745e02d88d71fbc2f2b2733ccb9c7a38283722a7e8ce83a  /tmp/cwagent.rpm" | sha256sum -c - \
 && rpm -i /tmp/cwagent.rpm \
 && rm /tmp/cwagent.rpm

# uv and Python
COPY --from=ghcr.io/astral-sh/uv@sha256:c4ca260ce2a921fb9ea59c6619d4c88c34990b4272524115ab61a70b647d2755 /uv /bin/
ARG UV_DEFAULT_INDEX
ARG UV_INDEX
ENV UV_PYTHON_INSTALL_DIR=/opt/python UV_PYTHON_BIN_DIR=/usr/local/bin
RUN uv python install 3.13.16 --default

# Application. The layout of /opt/bma is the same as the layout of this directory.
WORKDIR /opt/bma
ENV UV_COMPILE_BYTECODE=1 UV_NO_PROGRESS=1 \
    UV_DEFAULT_INDEX=${UV_DEFAULT_INDEX} UV_INDEX=${UV_INDEX}
COPY pyproject.toml uv.lock* ./
RUN uv sync --no-dev
COPY lifecycle/ lifecycle/
COPY otel/ otel/
COPY plugins/ plugins/
USER app

EXPOSE 8080
CMD ["uv", "run", "--no-sync", "opentelemetry-instrument", "python", "-u", "lifecycle/server.py"]
