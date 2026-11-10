"""The CAD factory run of the CAD import (helper/cad_import.py).

The Docker work itself is in progeo/docker_agent/ops.py; helper/docker_access.py
reaches it - in production through progeo-docker-agent, the only container
with the Docker socket.
"""
from progeo.helper.docker_access import run_cad_factory

__all__ = ["run_cad_factory"]
