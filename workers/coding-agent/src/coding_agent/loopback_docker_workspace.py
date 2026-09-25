"""Loopback-only Docker port publishing for OpenHands' DockerWorkspace.

ADR-0005 named this gap and ADR-0007 promoted the fix to a blocking
prerequisite (Phase 3A) for the realtime-execution work: the installed
`openhands-workspace` SDK's `DockerWorkspace._start_container` publishes the
Agent Server container's port to *all* host network interfaces via
``docker run ... -p {host_port}:8000`` (no ``127.0.0.1:`` prefix) —
confirmed by reading
``.venv/Lib/site-packages/openhands/workspace/docker/workspace.py`` directly,
not just its docs. There is no Pydantic field, environment variable, or
smaller overridable hook on the installed class that controls the publish
bind address: the port flags are built inline inside one large, non-factored
``_start_container`` method, interleaved with container creation, the
health-wait, and `RemoteWorkspace` initialization. (The container's own
internal `--host 0.0.0.0 --port 8000` bind, a few lines below the port
flags, is unrelated and intentionally unchanged — that's the process's bind
*inside* its own network namespace; only the host-side `-p` publish needs to
change.)

The narrowest correct fix, consistent with ADR-0005's own stated intent ("a
small subclass, not an SDK fork") and ADR-0007 Phase 3A, is this local
subclass: it copies the vendored method verbatim and changes only the
docker `-p` flag(s) to bind `127.0.0.1` explicitly. Every other behavior —
health check, cleanup, pause/resume, `forward_env`, GPU/network flags — is
inherited unchanged from `DockerWorkspace`.

This is a full-method override, not a small patch, because the vendored
method offers no smaller seam to hook into. To keep that safe across
dependency upgrades, `_assert_pinned_version()` runs at import time and
fails loudly if the installed `openhands-workspace` distribution is not the
exact version this override was copied from and verified line-by-line
against. Any future upgrade of `openhands-workspace` (or the matched
`openhands-sdk`/`openhands-tools`/`openhands-agent-server` set it ships
with) MUST re-diff the new `_start_container` against the copy below,
update both `LoopbackDockerWorkspace._start_container` and
`_PINNED_OPENHANDS_WORKSPACE_VERSION` together, and re-run the empirical
network-containment checks described in
docs/adr/0005-agent-server-execution-isolation.md and
docs/adr/0007-secure-realtime-execution.md. Do not silence or remove this
check as a way to unblock an upgrade.

No vendored/upstream source under `.venv/` is modified by this module.
"""

import os
import threading
import uuid
from importlib.metadata import PackageNotFoundError, version
from typing import Any

from openhands.sdk.logger import get_logger
from openhands.sdk.utils.command import execute_command
from openhands.workspace import DockerWorkspace
from openhands.workspace.docker.workspace import (
    check_port_available,
    find_available_tcp_port,
)

logger = get_logger(__name__)

# The exact `openhands-workspace` distribution version this override's
# _start_container body was copied from and verified against, line by line
# (see module docstring). Must match workers/coding-agent/pyproject.toml's
# `openhands-workspace==` pin.
_DISTRIBUTION_NAME = "openhands-workspace"
_PINNED_OPENHANDS_WORKSPACE_VERSION = "1.41.0"


def _assert_pinned_version() -> None:
    """Fail fast at import time if the installed SDK no longer matches the
    version this override was written against. A full-method override with
    no upstream test coverage of its own must not silently drift out of
    sync with a `pip install`/dependency upgrade that changes
    `_start_container`'s behavior."""
    try:
        installed = version(_DISTRIBUTION_NAME)
    except PackageNotFoundError as exc:
        raise RuntimeError(
            f"{__name__}: cannot determine the installed "
            f"'{_DISTRIBUTION_NAME}' version (package metadata not found). "
            "Refusing to apply the loopback-only Docker port override: it "
            "duplicates a private method body from a specific pinned "
            "version and may silently bind the wrong interface against a "
            "different one."
        ) from exc
    if installed != _PINNED_OPENHANDS_WORKSPACE_VERSION:
        raise RuntimeError(
            f"{__name__}: installed '{_DISTRIBUTION_NAME}' version "
            f"{installed!r} does not match {_PINNED_OPENHANDS_WORKSPACE_VERSION!r}, "
            "the version LoopbackDockerWorkspace._start_container was copied "
            "from and verified against. DockerWorkspace._start_container may "
            "have changed upstream in a way that silently reintroduces the "
            "all-interfaces port-publish gap (ADR-0005/ADR-0007 Phase 3A). "
            "Re-diff openhands/workspace/docker/workspace.py's "
            "_start_container against this file's copy, update both, then "
            "bump _PINNED_OPENHANDS_WORKSPACE_VERSION. Do not remove or "
            "silence this check to unblock an upgrade."
        )


_assert_pinned_version()


class LoopbackDockerWorkspace(DockerWorkspace):
    """`DockerWorkspace` subclass that publishes the Agent Server
    container's port(s) to `127.0.0.1` only, instead of all host network
    interfaces.

    This is a verbatim copy of
    `openhands.workspace.docker.workspace.DockerWorkspace._start_container`
    (openhands-workspace==1.41.0), with exactly the docker `-p` flag(s)
    changed to bind loopback explicitly (marked below). See module
    docstring for why a full-method override was necessary and how it is
    kept safe across SDK upgrades.
    """

    def _start_container(self, image: str, context: Any) -> None:
        # Store the image name for cleanup
        self._image_name = image

        # Determine port
        if self.host_port is None:
            self.host_port = find_available_tcp_port()
        else:
            self.host_port = int(self.host_port)

        if not check_port_available(self.host_port):
            raise RuntimeError(f"Port {self.host_port} is not available")

        if self.extra_ports:
            if not check_port_available(self.host_port + 1):
                raise RuntimeError(
                    f"Port {self.host_port + 1} is not available for VSCode"
                )
            if not check_port_available(self.host_port + 2):
                raise RuntimeError(
                    f"Port {self.host_port + 2} is not available for VNC"
                )

        # Ensure docker is available
        docker_ver = execute_command(["docker", "version"]).returncode
        if docker_ver != 0:
            raise RuntimeError(
                "Docker is not available. Please install and start "
                "Docker Desktop/daemon."
            )

        # Prepare Docker run flags
        flags: list[str] = []
        for key in self.forward_env:
            if key in os.environ:
                flags += ["-e", f"{key}={os.environ[key]}"]

        for volume in self.volumes:
            flags += ["-v", volume]
            logger.info(f"Adding volume mount: {volume}")

        # --- AtherNull change vs. upstream (ADR-0005 / ADR-0007 Phase 3A) ---
        # Bind the host-side publish to 127.0.0.1 explicitly instead of
        # publishing to all host interfaces. The container's own internal
        # bind (--host 0.0.0.0 below, inside its own network namespace) is
        # unrelated and unchanged.
        ports = ["-p", f"127.0.0.1:{self.host_port}:8000"]
        if self.extra_ports:
            ports += [
                "-p",
                f"127.0.0.1:{self.host_port + 1}:8001",  # VSCode
                "-p",
                f"127.0.0.1:{self.host_port + 2}:8002",  # Desktop VNC
            ]
        # --- end AtherNull change ---
        flags += ports

        # Add GPU support if enabled
        if self.enable_gpu:
            flags += ["--gpus", "all"]

        # Connect container to the specified Docker network
        if self.network:
            flags += ["--network", self.network]

        # Run container
        run_cmd = [
            "docker",
            "run",
            "-d",
            "--platform",
            self.platform,
            "--rm",
            "--ulimit",
            "nofile=65536:65536",  # prevent "too many open files" errors
            "--name",
            f"agent-server-{uuid.uuid4()}",
            *flags,
            image,
            "--host",
            "0.0.0.0",
            "--port",
            "8000",
        ]
        proc = execute_command(run_cmd)
        if proc.returncode != 0:
            raise RuntimeError(f"Failed to run docker container: {proc.stderr}")

        self._container_id = proc.stdout.strip()
        logger.info(f"Started container: {self._container_id}")

        # Optionally stream logs in background
        if self.detach_logs:
            self._logs_thread = threading.Thread(
                target=self._stream_docker_logs, daemon=True
            )
            self._logs_thread.start()

        # Set host for RemoteWorkspace to use
        # The container exposes port 8000, mapped to self.host_port
        # Override parent's host initialization
        if not self.host:
            object.__setattr__(self, "host", f"http://127.0.0.1:{self.host_port}")
        object.__setattr__(self, "api_key", None)

        # Wait for container to be healthy
        self._wait_for_health(timeout=self.health_check_timeout)
        logger.info(f"Docker workspace is ready at {self.host}")

        # Now initialize the parent RemoteWorkspace with the container URL.
        #
        # NOTE: this deliberately uses the explicit two-argument `super()`
        # form, not bare `super()`. Bare `super()` inside a method defined on
        # LoopbackDockerWorkspace resolves (via the implicit __class__ cell)
        # to `super(LoopbackDockerWorkspace, self)`, whose MRO lookup lands
        # on `DockerWorkspace.model_post_init` next — which calls
        # `self.get_image()` + `self._start_container(...)` again, causing
        # infinite recursion. The explicit form below skips both
        # LoopbackDockerWorkspace and DockerWorkspace and lands on
        # `RemoteWorkspace.model_post_init`, matching upstream's own
        # behavior when this method is defined directly on DockerWorkspace.
        super(DockerWorkspace, self).model_post_init(context)
