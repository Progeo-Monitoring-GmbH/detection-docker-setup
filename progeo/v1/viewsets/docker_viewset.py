from docker.errors import DockerException, NotFound
from rest_framework import viewsets
from rest_framework.authentication import SessionAuthentication
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework_simplejwt.authentication import JWTAuthentication

import docker
from progeo.authentication import ExpiringTokenAuthentication
from progeo.decorator import require_module_permissions
from progeo.helper.basics import RequestFailed, RequestSuccess, ilog
from progeo.helper.docker_helper import get_docker_status, is_container_running

# Logs: the last this many lines by default - a long-running container's
# whole log can be megabytes. ?tail= (body "tail") up to LOG_TAIL_MAX.
LOG_TAIL_DEFAULT = 1000
LOG_TAIL_MAX = 20000


class DockerViewSet(viewsets.ViewSet):
    """The host's containers (Developer -> Docker, /api/docker/...): list,
    start, stop, restart, remove and read logs. Staff with
    module_docker_enabled only. Every action takes {"container_id": <id or
    name>} and answers {"success": true, "name"} or 400 {"reason"}."""

    authentication_classes = [JWTAuthentication, ExpiringTokenAuthentication, SessionAuthentication]
    permission_classes = [IsAuthenticated]

    def initial(self, request, *args, **kwargs):
        # Restarting/removing the host's containers and reading their logs is
        # never a customer's business, whatever module permission they hold.
        super().initial(request, *args, **kwargs)
        from rest_framework.exceptions import PermissionDenied

        from progeo.helper.location_access import is_staff_admin

        if not is_staff_admin(request.user):
            raise PermissionDenied("Staff access required")

    @staticmethod
    def _get_client_or_error():
        try:
            return docker.from_env(), None
        except (DockerException, PermissionError) as exc:
            return None, RequestFailed({"reason": f"Docker client unavailable: {exc}"})

    def _container(self, request):
        """(container, None) for the body's container_id, else (None, error response)."""
        container_id = request.data.get("container_id")
        if not isinstance(container_id, str) or not container_id.strip():
            return None, RequestFailed({"reason": "container_id required"})
        client, error = self._get_client_or_error()
        if error:
            return None, error
        try:
            return client.containers.get(container_id.strip()), None
        except NotFound:
            return None, RequestFailed({"reason": "Container not found"})
        except (DockerException, PermissionError) as exc:
            return None, RequestFailed({"reason": f"Docker unavailable: {exc}"})

    def _run(self, request, verb, operation, container=None):
        if container is None:
            container, error = self._container(request)
            if error:
                return error
        try:
            operation(container)
        except (DockerException, PermissionError) as exc:
            return RequestFailed({"reason": f"Failed to {verb} container: {exc}"})
        ilog(f"{verb} container {container.name} by user {request.user.pk}", tag="[DOCKER]")
        return RequestSuccess({"name": container.name})

    @action(detail=False, url_path="status", methods=["GET"])
    @require_module_permissions("module_docker_enabled")
    def docker_status(self, request: Request, *args, **kwargs):
        try:
            return Response({"container": get_docker_status()})
        except (DockerException, PermissionError) as exc:
            return RequestFailed({"reason": f"Could not read docker status: {exc}"})

    @action(detail=False, url_path="start", methods=["POST"])
    @require_module_permissions("module_docker_enabled")
    def start_docker_container(self, request: Request, *args, **kwargs):
        return self._run(request, "start", lambda container: container.start())

    @action(detail=False, url_path="stop", methods=["POST"])
    @require_module_permissions("module_docker_enabled")
    def stop_docker_container(self, request: Request, *args, **kwargs):
        return self._run(request, "stop", lambda container: container.stop())

    @action(detail=False, url_path="restart", methods=["POST"])
    @require_module_permissions("module_docker_enabled")
    def restart_docker_container(self, request: Request, *args, **kwargs):
        return self._run(request, "restart", lambda container: container.restart())

    @action(detail=False, url_path="remove", methods=["POST"])
    @require_module_permissions("module_docker_enabled")
    def remove_docker_container(self, request: Request, *args, **kwargs):
        container, error = self._container(request)
        if error:
            return error
        # A running container is stopped first in the UI - never removed by force here.
        if is_container_running(container):
            return RequestFailed({"reason": "Stop the container before removing it"})
        return self._run(request, "remove", lambda target: target.remove(), container)

    @action(detail=False, url_path="logs", methods=["POST"])
    @require_module_permissions("module_docker_enabled")
    def get_container_logs(self, request: Request, *args, **kwargs):
        """{"logs", "name", "tail"}: the last `tail` lines (body, default
        LOG_TAIL_DEFAULT, at most LOG_TAIL_MAX), with timestamps."""
        try:
            tail = int(request.data.get("tail") or LOG_TAIL_DEFAULT)
        except (TypeError, ValueError):
            return RequestFailed({"reason": "tail must be an integer"})
        tail = max(1, min(tail, LOG_TAIL_MAX))
        container, error = self._container(request)
        if error:
            return error
        try:
            logs = container.logs(tail=tail, timestamps=True).decode("utf-8", errors="replace")
        except (DockerException, PermissionError) as exc:
            return RequestFailed({"reason": f"Failed to read container logs: {exc}"})
        return RequestSuccess({"logs": logs, "name": container.name, "tail": tail})

    @action(detail=False, url_path="ping", methods=["POST"])
    @require_module_permissions("module_docker_enabled")
    def ping_docker(self, request: Request, *args, **kwargs):
        name = request.data.get("name")
        if name:
            client, error_response = self._get_client_or_error()
            if error_response:
                return Response({"running": False})
            try:
                container = client.containers.get(name)
                if container:
                    return Response({"running": is_container_running(container)})
            except (NotFound, DockerException, PermissionError):
                pass
        return Response({"running": False})
