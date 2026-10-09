/**
 * What the Nightshift runner image is made of (P10, D-P10-16).
 *
 * EC2 Image Builder components, as the YAML documents Image Builder runs on a
 * build instance, each pinned to a version. The image is Amazon Linux 2023 on
 * arm64 with everything a worker legitimately needs (Node, git, Docker without
 * root, a browser's libraries, build tools, Rust, pnpm, Python, the two harness
 * CLIs) and the Nightshift runner itself, built from this repository at the
 * commit the pipeline was told.
 *
 * The containment D-P10-17 asks for is laid down here too: an `engine` user the
 * runner runs as, sixteen `worker-N` users with rootless Docker, a sudoers rule
 * that lets `engine` run commands as a worker and nothing else, and a boot unit
 * that mounts the workspace volume and closes the instance metadata endpoint to
 * everyone but `engine`.
 *
 * P16 S-01 adds two things. mise, the polyglot version manager, is on the image
 * for the engine alone (D-04): a pinned, checksum-verified binary at
 * `/usr/local/bin/mise` with a system config that reads the projects' idiomatic
 * version files, and never a shell hook or a shim, so projects never see it.
 * The engine installs a dispatch's runtimes with it under `RUNTIMES_DIR`.
 * And every worker's rootless Docker starts on the first connection to its
 * socket (D-05): `dockerd-rootless-setuptool.sh` installs each worker's
 * `docker.service` while the daemon still listens on the conventional
 * `/run/user/<uid>/docker.sock` (the tool smoke-tests exactly that socket), and
 * only then is the daemon moved to a private socket, `docker.service` disabled,
 * and an enabled `docker.socket` put on the conventional path that activates a
 * `systemd-socket-proxyd` service, which pulls the daemon up and forwards to it.
 * An idle worker has the socket listening and no dockerd.
 */

/** Pinned toolchain. Every version is a decision; none is "latest". */
export const RUNNER_TOOLCHAIN = {
  node: "24.11.1",
  pnpm: "10.17.1",
  claude: "2.1.286",
  codex: "0.155.1",
  uv: "0.9.4",
  /** Docker's rootless extras (rootlesskit and the setup tool), from Docker's static builds. */
  dockerRootlessExtras: "27.5.1",
  slirp4netns: "1.3.1",
  /** The polyglot version manager the engine installs a project's runtimes with (D-04). */
  mise: "2026.10.5",
} as const;

/**
 * The sha256 of each architecture's mise binary, from that release's
 * SHASUMS256.txt. Pinned here rather than fetched beside the binary, so a
 * tampered release fails the build instead of vouching for itself.
 */
export const MISE_SHA256: Readonly<Record<"arm64" | "x86_64", string>> = {
  arm64: "a30504fb4fc738cba08a1fe7db7a8b2554af8543748720a138b329eedbf0c19f",
  x86_64: "8a223b5f8ca71100220a3e5bef259614c348e7b1d80e6b15c2a9c9aa3affe5e4",
};

/** Where the engine has mise install a dispatch's runtimes (`MISE_DATA_DIR`), on the warm volume. */
export const RUNTIMES_DIR = "/workspace/stores/runtimes";
/** mise's system config: the only mise configuration on the image. */
export const MISE_SYSTEM_CONFIG = "/etc/mise/config.toml";

/** Where AL2023's systemd keeps the proxy that stands in front of each worker's daemon. */
export const SOCKET_PROXYD = "/usr/lib/systemd/systemd-socket-proxyd";
/**
 * Each worker's Docker socket, the one projects get as `DOCKER_HOST`; `%t` is
 * the user's runtime directory, `/run/user/<uid>`. It belongs to `docker.socket`.
 */
export const DOCKER_SOCKET = "%t/docker.sock";
/** The real rootless daemon's socket, private behind the proxy. */
export const DOCKER_PRIVATE_SOCKET = "%t/docker-rootless/docker.sock";

/** The repository the runner is built from on the image, and where it lands. */
export const RUNNER_REPOSITORY = "https://github.com/wildorder/nightshift.git";
export const RUNNER_INSTALL_DIR = "/opt/nightshift";
export const RUNNER_WORKSPACE = "/workspace";
/** The device the dispatch Lambda attaches the workspace volume as (T3). */
export const WORKSPACE_DEVICE = "/dev/xvdf";
/** How many worker users the image carries: the largest tier's vCPUs. */
export const WORKER_USERS = 16;

/** Image Builder's limit on a component's inline document, in characters. */
export const IMAGE_COMPONENT_MAX_CHARS = 16_000;
export const ENGINE_USER = "engine";
/** The group the engine and the workers share (D-P10-25); `apps/mcp/src/run-as.ts` names the same. */
export const WORKER_GROUP = "nightshift";

/** A component document's header. */
const component = (name: string, description: string, steps: string): string =>
  `name: ${name}
description: ${description}
schemaVersion: 1.0
phases:
  - name: build
    steps:
${steps}`;

const shell = (name: string, lines: readonly string[]): string =>
  `      - name: ${name}
        action: ExecuteBash
        inputs:
          commands:
${lines.map((line) => `            - ${JSON.stringify(line)}`).join("\n")}`;

/** System packages, Node 24, pnpm, the harness CLIs, Rust and uv. */
/** The two machine architectures an image is built for; the arm64 one is the tiers' (D-P10-13). */
export const IMAGE_ARCHITECTURES = ["arm64", "x86_64"] as const;
export type ImageArchitecture = (typeof IMAGE_ARCHITECTURES)[number];

/** How each upstream names the architecture in its download. */
const ARCH_NAMES: Readonly<
  Record<
    ImageArchitecture,
    { node: string; docker: string; slirp: string; uv: string; mise: string }
  >
> = {
  arm64: {
    node: "linux-arm64",
    docker: "aarch64",
    slirp: "aarch64",
    uv: "aarch64-unknown-linux-gnu",
    mise: "linux-arm64",
  },
  x86_64: {
    node: "linux-x64",
    docker: "x86_64",
    slirp: "x86_64",
    uv: "x86_64-unknown-linux-gnu",
    mise: "linux-x64",
  },
};

const miseAsset = (architecture: ImageArchitecture): string =>
  `mise-v${RUNNER_TOOLCHAIN.mise}-${ARCH_NAMES[architecture].mise}`;

export const toolchainComponent = (architecture: ImageArchitecture = "arm64"): string =>
  component(
    "nightshift-toolchain",
    "Node, git, Docker (rootless prerequisites), browser libraries, build tools, Rust, pnpm, Python",
    [
      shell("packages", [
        "set -euo pipefail",
        "dnf -y update --security",
        "dnf -y install git tar gzip xz unzip jq nftables shadow-utils sudo rsync",
        // Docker from AL2023; its rootless pieces come from Docker's static builds
        // below, because AL2023 packages neither rootlesskit nor slirp4netns.
        "dnf -y install docker shadow-utils-subid iptables-nft",
        "dnf -y install gcc gcc-c++ make cmake pkgconf openssl-devel python3 python3-pip",
        // Chromium's shared libraries, for playwright and puppeteer (the audit's Keki
        // and Keyart). Not strict: a library AL2023 names differently is reported by
        // the browser measurement (T2 §15), not a reason the whole image fails.
        "dnf -y --setopt=strict=0 install atk at-spi2-atk cups-libs libXcomposite libXdamage libXrandr libXfixes libXext libX11 pango alsa-lib nss nspr libxkbcommon mesa-libgbm libdrm expat glib2 dbus-libs",
        "systemctl disable --now docker.service docker.socket || true",
      ]),
      shell("node", [
        "set -euo pipefail",
        `curl -fsSL https://nodejs.org/dist/v${RUNNER_TOOLCHAIN.node}/node-v${RUNNER_TOOLCHAIN.node}-${ARCH_NAMES[architecture].node}.tar.xz -o /tmp/node.tar.xz`,
        "mkdir -p /usr/local/lib/nodejs",
        "tar -xJf /tmp/node.tar.xz -C /usr/local/lib/nodejs",
        `ln -sfn /usr/local/lib/nodejs/node-v${RUNNER_TOOLCHAIN.node}-${ARCH_NAMES[architecture].node}/bin/node /usr/local/bin/node`,
        `ln -sfn /usr/local/lib/nodejs/node-v${RUNNER_TOOLCHAIN.node}-${ARCH_NAMES[architecture].node}/bin/npm /usr/local/bin/npm`,
        `ln -sfn /usr/local/lib/nodejs/node-v${RUNNER_TOOLCHAIN.node}-${ARCH_NAMES[architecture].node}/bin/npx /usr/local/bin/npx`,
        `ln -sfn /usr/local/lib/nodejs/node-v${RUNNER_TOOLCHAIN.node}-${ARCH_NAMES[architecture].node}/bin/corepack /usr/local/bin/corepack`,
        "node --version",
        `corepack enable && corepack prepare pnpm@${RUNNER_TOOLCHAIN.pnpm} --activate`,
        `ln -sfn /usr/local/lib/nodejs/node-v${RUNNER_TOOLCHAIN.node}-${ARCH_NAMES[architecture].node}/bin/pnpm /usr/local/bin/pnpm`,
        `npm install -g @anthropic-ai/claude-code@${RUNNER_TOOLCHAIN.claude} @openai/codex@${RUNNER_TOOLCHAIN.codex}`,
        `ln -sfn /usr/local/lib/nodejs/node-v${RUNNER_TOOLCHAIN.node}-${ARCH_NAMES[architecture].node}/bin/claude /usr/local/bin/claude`,
        `ln -sfn /usr/local/lib/nodejs/node-v${RUNNER_TOOLCHAIN.node}-${ARCH_NAMES[architecture].node}/bin/codex /usr/local/bin/codex`,
        "claude --version && codex --version",
      ]),
      shell("rootless-docker", [
        "set -euo pipefail",
        // rootlesskit, dockerd-rootless.sh and dockerd-rootless-setuptool.sh; the
        // kernel's overlay2 works in a user namespace on AL2023, so no fuse-overlayfs.
        `curl -fsSL https://download.docker.com/linux/static/stable/${ARCH_NAMES[architecture].docker}/docker-rootless-extras-${RUNNER_TOOLCHAIN.dockerRootlessExtras}.tgz -o /tmp/rootless.tgz`,
        "tar -xzf /tmp/rootless.tgz -C /tmp && install -m 0755 /tmp/docker-rootless-extras/* /usr/local/bin/",
        // The setup tool runs `docker` from its own directory to smoke-test the daemon.
        "ln -sfn /usr/bin/docker /usr/local/bin/docker",
        `curl -fsSL https://github.com/rootless-containers/slirp4netns/releases/download/v${RUNNER_TOOLCHAIN.slirp4netns}/slirp4netns-${ARCH_NAMES[architecture].slirp} -o /usr/local/bin/slirp4netns && chmod 0755 /usr/local/bin/slirp4netns`,
        "rootlesskit --version && slirp4netns --version",
      ]),
      shell("rust-and-uv", [
        "set -euo pipefail",
        "curl -fsSL https://sh.rustup.rs -o /tmp/rustup.sh",
        "RUSTUP_HOME=/opt/rust/rustup CARGO_HOME=/opt/rust/cargo sh /tmp/rustup.sh -y --profile minimal --default-toolchain stable",
        "ln -sfn /opt/rust/cargo/bin/cargo /usr/local/bin/cargo && ln -sfn /opt/rust/cargo/bin/rustc /usr/local/bin/rustc",
        "chmod -R a+rX /opt/rust",
        // The rustup proxies find the shared toolchain through RUSTUP_HOME; each
        // user's own CARGO_HOME (its registry cache) stays in its home.
        "printf '%s\n' 'export RUSTUP_HOME=/opt/rust/rustup' > /etc/profile.d/nightshift-rust.sh",
        `curl -fsSL https://github.com/astral-sh/uv/releases/download/${RUNNER_TOOLCHAIN.uv}/uv-${ARCH_NAMES[architecture].uv}.tar.gz -o /tmp/uv.tar.gz`,
        `tar -xzf /tmp/uv.tar.gz -C /tmp && install -m 0755 /tmp/uv-${ARCH_NAMES[architecture].uv}/uv /usr/local/bin/uv`,
      ]),
      shell("mise", [
        "set -euo pipefail",
        // For the engine only (D-04): no activation in any profile or rc file and
        // no shims directory on PATH. The engine runs it with MISE_DATA_DIR at
        // RUNTIMES_DIR and puts each runtime's own bin first on a project's PATH.
        `curl -fsSL https://github.com/jdx/mise/releases/download/v${RUNNER_TOOLCHAIN.mise}/${miseAsset(architecture)} -o /tmp/${miseAsset(architecture)}`,
        `echo '${MISE_SHA256[architecture]}  /tmp/${miseAsset(architecture)}' | sha256sum --check --strict -`,
        `install -m 0755 /tmp/${miseAsset(architecture)} /usr/local/bin/mise`,
        // Idiomatic version files (.nvmrc, .node-version, .python-version) are off
        // unless a tool is named here.
        "mkdir -p /etc/mise",
        `printf '%s\\n' '[settings]' 'idiomatic_version_file_enable_tools = ["node", "python"]' > ${MISE_SYSTEM_CONFIG}`,
        "mise --version",
      ]),
    ].join("\n"),
  );

/**
 * A command run as a worker against its own systemd user manager. `$uid` is the
 * worker's uid, set by the line that runs it; the PATH puts the rootless extras
 * first, and is the one the setup tool writes into the worker's `docker.service`.
 */
const asWorker = (worker: string, command: string): string =>
  `sudo -u ${worker} -H env XDG_RUNTIME_DIR=/run/user/$uid DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$uid/bus PATH=/usr/local/bin:/usr/bin:/usr/local/sbin:/usr/sbin ${command}`;

/** The user units every worker's Docker is made of (D-05), as `printf` lines that write them. */
const dockerUserUnits = (): string[] => [
  "mkdir -p /etc/systemd/user/docker.service.d",
  // The setup tool's own ExecStart, with the daemon moved to the private socket.
  // No setup flags are lost: --skip-iptables is not used (AL2023's kernel has
  // ip_tables built in), so the tool's ExecStart has none.
  `printf '%s\\n' '[Service]' 'ExecStartPre=/usr/bin/mkdir -p %t/docker-rootless' 'ExecStart=' 'ExecStart=/usr/local/bin/dockerd-rootless.sh -H unix://${DOCKER_PRIVATE_SOCKET}' > /etc/systemd/user/docker.service.d/nightshift-private-socket.conf`,
  // Service= names the proxy: a connection activates it, never dockerd, and
  // docker.service inherits no descriptor from a socket that does not trigger it.
  `printf '%s\\n' '[Unit]' 'Description=The worker Docker socket: the first connection starts the rootless daemon (D-05)' '[Socket]' 'ListenStream=${DOCKER_SOCKET}' 'SocketMode=0600' 'Service=docker-proxy.service' '[Install]' 'WantedBy=sockets.target' > /etc/systemd/user/docker.socket`,
  `printf '%s\\n' '[Unit]' 'Description=Forwards the worker Docker socket to its rootless daemon (D-05)' 'Requires=docker.service' 'After=docker.service' '[Service]' 'ExecStartPre=/usr/bin/timeout 60 /bin/sh -c "until [ -S ${DOCKER_PRIVATE_SOCKET} ]; do sleep 0.2; done"' 'ExecStart=${SOCKET_PROXYD} ${DOCKER_PRIVATE_SOCKET}' > /etc/systemd/user/docker-proxy.service`,
];

/** The users, the sudoers rule, the firewall unit and the runner's units (D-P10-17). */
export const containmentComponent = (): string => {
  const workers = Array.from({ length: WORKER_USERS }, (_, index) => `worker-${index + 1}`);
  return component(
    "nightshift-containment",
    "The engine and worker users, rootless Docker per worker, the sudoers rule and the IMDS firewall",
    [
      shell("users", [
        "set -euo pipefail",
        // One group for the engine and every worker (D-P10-25): the workspace is
        // theirs together; the engine's token and credentials are the engine's alone.
        `groupadd ${WORKER_GROUP}`,
        `useradd --system --create-home --home-dir /home/${ENGINE_USER} --shell /bin/bash -G ${WORKER_GROUP} ${ENGINE_USER}`,
        // Git refuses a repository owned by another user ("dubious ownership");
        // here the checkout is the engine's and the workers commit into it, and
        // every user on the machine is Nightshift's, so every directory is safe.
        "git config --system --add safe.directory '*'",
        // One loop per step over the workers, never a line per worker: an Image
        // Builder component's document is capped at 16,000 characters, and the
        // unrolled form passed it at sixteen workers (2026-10-09).
        // Each worker's subordinate ids are one block, for rootless Docker.
        `i=0; for w in ${workers.join(" ")}; do { useradd --create-home --home-dir /home/$w --shell /bin/bash -G ${WORKER_GROUP} $w && loginctl enable-linger $w && echo "$w:$((100000 + i * 65536)):65536" >> /etc/subuid && echo "$w:$((100000 + i * 65536)):65536" >> /etc/subgid; } || exit 1; i=$((i + 1)); done`,
        `echo "${ENGINE_USER}:${100000 + WORKER_USERS * 65536}:65536" >> /etc/subuid`,
      ]),
      shell("rootless-docker", [
        "set -euo pipefail",
        "cd /",
        // First each worker's docker.service, installed by Docker's own tool while
        // the daemon listens on the conventional /run/user/<uid>/docker.sock: the
        // tool starts the daemon and smoke-tests exactly that socket with
        // `docker version`, so nothing may move the daemon off it yet. The tool
        // enables and starts docker.service; it is disabled and stopped at once,
        // because no worker's daemon starts at boot (D-05).
        `for w in ${workers.join(" ")}; do { uid=$(id -u $w) && systemctl start user@$uid.service && ${asWorker("$w", "dockerd-rootless-setuptool.sh install")} && ${asWorker("$w", "systemctl --user disable --now docker.service")}; } || exit 1; done`,
        // Then the daemon moves to a private socket, and the worker's socket path
        // belongs to docker.socket, which activates the proxy.
        ...dockerUserUnits(),
        `for w in ${workers.join(" ")}; do { uid=$(id -u $w) && ${asWorker("$w", "systemctl --user daemon-reload")} && ${asWorker("$w", "systemctl --user enable docker.socket")}; } || exit 1; done`,
        // An idle worker after boot: the socket enabled, the daemon not.
        `for w in ${workers.join(" ")}; do { uid=$(id -u $w) && [ "$(${asWorker("$w", "systemctl --user is-enabled docker.service")} || true)" = disabled ] && [ "$(${asWorker("$w", "systemctl --user is-enabled docker.socket")})" = enabled ] && systemctl stop user@$uid.service; } || exit 1; done`,
      ]),
      shell("sudoers", [
        "set -euo pipefail",
        // `engine` may become any worker (to start a worker's process in its
        // worktree) and run exactly the root commands the runner needs at boot.
        // No password, no shell escape, nothing else.
        `printf '%s\\n' 'Defaults:${ENGINE_USER} !requiretty' 'Runas_Alias WORKERS = ${workers.join(", ")}' '${ENGINE_USER} ALL=(WORKERS) NOPASSWD: ALL' '${ENGINE_USER} ALL=(root) NOPASSWD: /usr/sbin/nft, /usr/bin/mount, /usr/bin/umount, /usr/sbin/mkfs.ext4, /usr/sbin/blkid, /usr/bin/chown, /usr/bin/mkdir, /usr/bin/rsync, /usr/bin/loginctl, /usr/bin/machinectl, /usr/bin/systemctl' > /etc/sudoers.d/nightshift-engine`,
        "chmod 0440 /etc/sudoers.d/nightshift-engine && visudo -cf /etc/sudoers.d/nightshift-engine",
      ]),
      shell("imds-firewall", [
        "set -euo pipefail",
        // Only `engine` reaches the instance metadata endpoint, and so the
        // instance's role (D-P10-17). Workers asking for AWS credentials get the
        // project's, from Nightshift, never the machine's.
        "mkdir -p /etc/nftables.d",
        `printf '%s\\n' '#!/usr/sbin/nft -f' 'table inet nightshift {' '  chain output {' '    type filter hook output priority 0; policy accept;' '    ip daddr 169.254.169.254 meta skuid != "${ENGINE_USER}" meta skuid != 0 drop' '  }' '}' > /etc/nftables.d/nightshift-imds.nft`,
        `printf '%s\\n' '[Unit]' 'Description=Nightshift IMDS firewall: only engine reaches the metadata endpoint' 'Before=nightshift-runner.service' '[Service]' 'Type=oneshot' 'ExecStart=/usr/sbin/nft -f /etc/nftables.d/nightshift-imds.nft' 'RemainAfterExit=yes' '[Install]' 'WantedBy=multi-user.target' > /etc/systemd/system/nightshift-imds.service`,
        "systemctl enable nightshift-imds.service",
      ]),
    ].join("\n"),
  );
};

/** The runner itself: this repository, built at a commit, and its unit (D-P10-16). */
export const runnerComponent = (commit: string): string =>
  component(
    "nightshift-runner",
    `The Nightshift runner, built from ${RUNNER_REPOSITORY} at ${commit}`,
    [
      shell("build", [
        "set -euo pipefail",
        `git clone --filter=blob:none ${RUNNER_REPOSITORY} ${RUNNER_INSTALL_DIR}`,
        `cd ${RUNNER_INSTALL_DIR} && git checkout --detach ${commit}`,
        `cd ${RUNNER_INSTALL_DIR} && npm ci --no-audit --no-fund`,
        `cd ${RUNNER_INSTALL_DIR} && npx tsc -b`,
        `cd ${RUNNER_INSTALL_DIR} && git rev-parse HEAD > ${RUNNER_INSTALL_DIR}/COMMIT`,
        `chown -R ${ENGINE_USER}:${ENGINE_USER} ${RUNNER_INSTALL_DIR}`,
        `mkdir -p ${RUNNER_WORKSPACE} && chown ${ENGINE_USER}:${ENGINE_USER} ${RUNNER_WORKSPACE}`,
      ]),
      shell("unit", [
        "set -euo pipefail",
        `printf '%s\\n' '[Unit]' 'Description=Nightshift runner: the engine on this machine' 'After=network-online.target nightshift-imds.service' 'Wants=network-online.target' '[Service]' 'Type=simple' 'User=${ENGINE_USER}' 'UMask=0002' 'WorkingDirectory=${RUNNER_INSTALL_DIR}' 'Environment=NIGHTSHIFT_WORKSPACE=${RUNNER_WORKSPACE}' 'Environment=NIGHTSHIFT_WORKER_USERS=${WORKER_USERS}' 'Environment=NIGHTSHIFT_WORKSPACE_DEVICE=${WORKSPACE_DEVICE}' 'ExecStart=/usr/local/bin/node ${RUNNER_INSTALL_DIR}/apps/mcp/dist/bin/nightshift-runner.js' 'Restart=on-failure' 'RestartSec=5' 'StandardOutput=journal' 'StandardError=journal' '[Install]' 'WantedBy=multi-user.target' > /etc/systemd/system/nightshift-runner.service`,
        "systemctl enable nightshift-runner.service",
      ]),
    ].join("\n"),
  );
