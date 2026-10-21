/**
 * The runner image's components, as the text Image Builder runs (P16 S-01).
 *
 * The image cannot be built or booted here, so every assertion is on the
 * synthesised component: the commands, in order, that a build instance runs.
 * mise is pinned, checksum-verified and invisible to projects (D-04); every
 * worker's rootless Docker is installed by Docker's own tool on the
 * conventional socket, then moved behind a socket-activated proxy so it starts
 * on first connection and not at boot (D-05).
 */
import { describe, expect, it } from "vitest";
import {
  AWSCLI_SHA256,
  containmentComponent,
  DOCKER_FORWARD,
  DOCKER_PRIVATE_SOCKET,
  DOCKER_SOCKET,
  DOCKER_SOCKET_UNIT,
  IMAGE_ARCHITECTURES,
  IMAGE_COMPONENT_MAX_CHARS,
  MISE_SHA256,
  MISE_SYSTEM_CONFIG,
  PROJECT_USER,
  RUNNER_TOOLCHAIN,
  RUNTIMES_DIR,
  runnerComponent,
  toolchainComponent,
} from "./runner-image.js";

/** A component's shell commands, in the order the build runs them, unquoted. */
const commandsOf = (component: string): string[] =>
  component
    .split("\n")
    .filter((line) => line.startsWith("            - "))
    .map((line) => JSON.parse(line.slice("            - ".length)) as string);

/** The text of a unit a `printf '%s\n' ... > path` command writes, one directive a line. */
const unitWrittenTo = (commands: readonly string[], path: string): string => {
  const command = commands.find((c) => c.startsWith("printf ") && c.endsWith(`> ${path}`));
  if (command === undefined) throw new Error(`no command writes ${path}`);
  const body = command.slice(0, -`> ${path}`.length);
  return [...body.matchAll(/'([^']*)'/g)]
    .slice(1)
    .map((match) => match[1])
    .join("\n");
};

// One project user runs all project code (D-P10-30).
const workers = [PROJECT_USER];

/**
 * The one command that runs `step` for every worker: a loop over all of them,
 * in order, that stops the build on the first worker it fails for. One loop,
 * never a line per worker, keeps the component under Image Builder's limit.
 */
const everyWorker = (commands: readonly string[], step: string): string => {
  const command = commands.find((c) => c.includes(step));
  if (command === undefined) throw new Error(`no command runs ${step}`);
  expect(command.startsWith(`for w in ${workers.join(" ")}; do {`)).toBe(true);
  expect(command.endsWith("} || exit 1; done")).toBe(true);
  return command;
};

describe("the runner image", () => {
  describe("Ubuntu 24.04", () => {
    for (const architecture of IMAGE_ARCHITECTURES) {
      it(`installs strict, noninteractive Ubuntu packages on ${architecture}`, () => {
        const commands = commandsOf(toolchainComponent(architecture));
        expect(commands).toContain("export DEBIAN_FRONTEND=noninteractive");
        expect(commands).toContain("apt-get -o Acquire::Retries=3 update");
        const packages = commands.filter((c) => c.startsWith("apt-get -y install ")).join(" ");
        for (const name of [
          "ca-certificates",
          "curl",
          "amazon-ec2-utils",
          "uidmap",
          "dbus-user-session",
          "systemd-container",
          "apparmor",
          "fuse-overlayfs",
          "python3-venv",
          "libasound2t64",
          "libatk1.0-0t64",
          "libgbm1",
          "libnss3",
          "xvfb",
        ])
          expect(packages.split(" ")).toContain(name);
        expect(commands.join("\n")).not.toMatch(/\bdnf\b|strict=0|--ignore-missing/);
        expect(commands).toContain("aws --version");
      });

      it(`leaves nothing to upgrade a machine under a run on ${architecture} (2026-10-21)`, () => {
        const commands = commandsOf(toolchainComponent(architecture));
        expect(commands).toContain("systemctl mask --now apt-daily.timer apt-daily-upgrade.timer");
        expect(commands).toContain("systemctl disable --now unattended-upgrades.service || true");
      });
    }

    for (const architecture of IMAGE_ARCHITECTURES) {
      it(`installs a pinned AWS CLI with its own runtime on ${architecture}`, () => {
        const commands = commandsOf(toolchainComponent(architecture));
        const arch = architecture === "arm64" ? "aarch64" : "x86_64";
        const download = commands.findIndex((c) =>
          c.includes(
            `https://awscli.amazonaws.com/awscli-exe-linux-${arch}-${RUNNER_TOOLCHAIN.awscli}.zip`,
          ),
        );
        const checksum = commands.indexOf(
          `echo '${AWSCLI_SHA256[architecture]}  /tmp/nightshift-awscli.zip' | sha256sum --check --strict -`,
        );
        const extract = commands.indexOf(
          "unzip -q /tmp/nightshift-awscli.zip -d /tmp/nightshift-awscli",
        );
        const install = commands.indexOf(
          "/tmp/nightshift-awscli/aws/install --install-dir /usr/local/aws-cli --bin-dir /usr/local/bin",
        );
        expect(download).toBeGreaterThan(-1);
        expect(checksum).toBeGreaterThan(download);
        expect(extract).toBeGreaterThan(checksum);
        expect(install).toBeGreaterThan(extract);
        expect(commands.indexOf("aws --version")).toBeGreaterThan(install);
      });
    }

    it("allows the pinned rootlesskit's user namespaces without disabling host AppArmor", () => {
      const commands = commandsOf(toolchainComponent());
      expect(unitWrittenTo(commands, "/etc/apparmor.d/nightshift-rootlesskit")).toBe(
        "abi <abi/4.0>,\ninclude <tunables/global>\n/usr/local/bin/rootlesskit flags=(unconfined) {\n  userns,\n}",
      );
      expect(commands).toContain("apparmor_parser -r /etc/apparmor.d/nightshift-rootlesskit");
      expect(commands.join("\n")).not.toMatch(
        /apparmor_restrict_unprivileged_userns=0|disable.*apparmor/,
      );
    });

    it("allocates subordinate ids without overlapping Ubuntu's existing user", () => {
      const commands = commandsOf(containmentComponent());
      const create = everyWorker(commands, "useradd --create-home");
      expect(create).toContain("-K SUB_UID_COUNT=65536 -K SUB_GID_COUNT=65536");
      expect(commands.join("\n")).not.toMatch(/>> \/etc\/sub(uid|gid)/);
    });
  });

  // Image Builder refuses a component document over 16,000 characters, and
  // only at deploy: P16's containment component reached 31,163 (2026-10-09).
  it("keeps every component's document under Image Builder's limit", () => {
    const documents = [
      ...IMAGE_ARCHITECTURES.map((architecture) => toolchainComponent(architecture)),
      containmentComponent(),
      runnerComponent("0".repeat(40)),
    ];
    for (const document of documents) {
      expect(document.length).toBeLessThanOrEqual(IMAGE_COMPONENT_MAX_CHARS);
    }
  });

  describe("mise (D-04)", () => {
    it("is pinned to an exact release, never latest", () => {
      expect(RUNNER_TOOLCHAIN.mise).toMatch(/^\d{4}\.\d{1,2}\.\d+$/);
      expect(RUNTIMES_DIR).toBe("/workspace/stores/runtimes");
    });

    for (const architecture of IMAGE_ARCHITECTURES) {
      it(`downloads and checksum-verifies the ${architecture} binary before installing it`, () => {
        const commands = commandsOf(toolchainComponent(architecture));
        const asset = `mise-v${RUNNER_TOOLCHAIN.mise}-${architecture === "arm64" ? "linux-arm64" : "linux-x64"}`;
        const download = commands.findIndex((c) =>
          c.includes(
            `https://github.com/jdx/mise/releases/download/v${RUNNER_TOOLCHAIN.mise}/${asset} -o /tmp/${asset}`,
          ),
        );
        const verify = commands.indexOf(
          `echo '${MISE_SHA256[architecture]}  /tmp/${asset}' | sha256sum --check --strict -`,
        );
        const install = commands.indexOf(`install -m 0755 /tmp/${asset} /usr/local/bin/mise`);
        expect(MISE_SHA256[architecture]).toMatch(/^[0-9a-f]{64}$/);
        expect(download).toBeGreaterThan(-1);
        expect(verify).toBeGreaterThan(download);
        expect(install).toBeGreaterThan(verify);
        expect(commands.indexOf("mise --version")).toBeGreaterThan(install);
      });
    }

    it("pins a different checksum for each architecture", () => {
      expect(MISE_SHA256.arm64).not.toBe(MISE_SHA256.x86_64);
    });

    it("enables node's and python's idiomatic version files in the system config", () => {
      const commands = commandsOf(toolchainComponent());
      expect(MISE_SYSTEM_CONFIG).toBe("/etc/mise/config.toml");
      expect(unitWrittenTo(commands, MISE_SYSTEM_CONFIG)).toBe(
        '[settings]\nidiomatic_version_file_enable_tools = ["node", "python"]',
      );
    });

    it("is never activated in a shell and puts no shims on PATH: projects never see it", () => {
      const everything = [
        ...IMAGE_ARCHITECTURES.flatMap((a) => commandsOf(toolchainComponent(a))),
        ...commandsOf(containmentComponent()),
      ];
      for (const command of everything) {
        expect(command).not.toMatch(/mise activate|mise\/shims|mise.*shims|mise hook-env/);
        if (/profile\.d|bashrc|bash_profile|\/etc\/environment/.test(command)) {
          expect(command).not.toContain("mise");
        }
      }
    });
  });

  describe("rootless Docker per worker (D-05)", () => {
    const commands = commandsOf(containmentComponent());
    const dropIn = "/etc/systemd/user/docker.service.d/nightshift-private-socket.conf";

    it("runs Docker's setup tool as every worker, with its own runtime directory and bus", () => {
      const setup = everyWorker(commands, "dockerd-rootless-setuptool.sh install");
      expect(setup).toContain("uid=$(id -u $w) && systemctl start user@$uid.service");
      expect(setup).toContain("sudo -u $w -H env XDG_RUNTIME_DIR=/run/user/$uid");
      expect(setup).toContain("DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$uid/bus");
    });

    it("installs every worker's daemon before it is moved off the socket the tool smoke-tests", () => {
      // The setup tool runs `docker version` against /run/user/<uid>/docker.sock
      // and fails without it, so the private-socket override and the proxy must
      // come after every worker's setup, never before.
      const lastSetup = commands.reduce(
        (last, c, index) => (c.includes("dockerd-rootless-setuptool.sh install") ? index : last),
        -1,
      );
      const override = commands.findIndex((c) => c.endsWith(`> ${dropIn}`));
      const socket = commands.findIndex((c) =>
        c.endsWith(`> /etc/systemd/user/${DOCKER_SOCKET_UNIT}`),
      );
      const proxy = commands.findIndex((c) =>
        c.endsWith("> /etc/systemd/user/docker-proxy@.service"),
      );
      const firstEnable = commands.findIndex((c) =>
        c.includes(`systemctl --user enable ${DOCKER_SOCKET_UNIT}`),
      );
      expect(lastSetup).toBeGreaterThan(-1);
      for (const step of [override, socket, proxy, firstEnable]) {
        expect(step).toBeGreaterThan(lastSetup);
      }
      expect(firstEnable).toBeGreaterThan(Math.max(override, socket, proxy));
    });

    it("leaves every worker's docker.service disabled and stopped, and its socket enabled", () => {
      expect(everyWorker(commands, "systemctl --user disable --now docker.service")).toContain(
        "sudo -u $w ",
      );
      expect(everyWorker(commands, `systemctl --user enable ${DOCKER_SOCKET_UNIT}`)).toContain(
        "sudo -u $w ",
      );
      expect(
        commands.some((c) => /enable docker\.service|enable --now docker\.service/.test(c)),
      ).toBe(false);
      const check = everyWorker(commands, "is-enabled docker.service");
      expect(check).toContain("= disabled ]");
      expect(check).toContain(`is-enabled ${DOCKER_SOCKET_UNIT})" = enabled ]`);
    });

    it("keeps the rootful system units disabled", () => {
      expect(commandsOf(toolchainComponent())).toContain(
        "systemctl disable --now docker.service docker.socket || true",
      );
    });

    it("puts the worker's socket on its conventional path, one forwarder per connection, never dockerd", () => {
      expect(DOCKER_SOCKET).toBe("%t/docker.sock");
      expect(DOCKER_SOCKET_UNIT).toBe("docker-proxy.socket");
      const lines = unitWrittenTo(commands, `/etc/systemd/user/${DOCKER_SOCKET_UNIT}`).split("\n");
      expect(lines).toEqual(
        expect.arrayContaining([
          "[Socket]",
          "ListenStream=%t/docker.sock",
          "SocketMode=0600",
          "Accept=yes",
          "WantedBy=sockets.target",
        ]),
      );
      // Accept=yes starts the template named after the socket, so no Service= line.
      expect(lines.some((line) => line.startsWith("Service="))).toBe(false);
    });

    it("moves the daemon to a private socket, different from the worker's", () => {
      expect(DOCKER_PRIVATE_SOCKET).not.toBe(DOCKER_SOCKET);
      const lines = unitWrittenTo(commands, dropIn).split("\n");
      expect(lines).toEqual([
        "[Service]",
        "ExecStartPre=/usr/bin/mkdir -p %t/docker-rootless",
        "ExecStart=",
        `ExecStart=/usr/local/bin/dockerd-rootless.sh -H unix://${DOCKER_PRIVATE_SOCKET}`,
      ]);
    });

    it("forwards each connection with socat, which carries exec's upgraded stream, after pulling the daemon up", () => {
      // systemd-socket-proxyd made every `docker exec` return 0 with no output
      // (2026-10-10); socat carries each direction's close on its own.
      expect(DOCKER_FORWARD).toBe("/usr/bin/socat -t 86400 STDIO");
      expect(
        commandsOf(toolchainComponent()).some((c) =>
          /apt-get -y install docker.io .*\bsocat\b/.test(c),
        ),
      ).toBe(true);
      const lines = unitWrittenTo(commands, "/etc/systemd/user/docker-proxy@.service").split("\n");
      expect(lines).toEqual(
        expect.arrayContaining([
          "Requires=docker.service",
          "After=docker.service",
          `ExecStart=${DOCKER_FORWARD} UNIX-CONNECT:${DOCKER_PRIVATE_SOCKET}`,
          "StandardInput=socket",
          "StandardOutput=socket",
        ]),
      );
      expect(commands.some((c) => c.includes("systemd-socket-proxyd"))).toBe(false);
      const wait = lines.find((line) => line.startsWith("ExecStartPre="));
      expect(wait).toContain("/usr/bin/timeout 60");
      expect(wait).toContain(`[ -S ${DOCKER_PRIVATE_SOCKET} ]`);
    });
  });
});
