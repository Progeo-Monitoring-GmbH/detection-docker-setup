from rest_framework import viewsets
from rest_framework.authentication import SessionAuthentication
from rest_framework.decorators import action
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework_simplejwt.authentication import JWTAuthentication

from progeo.authentication import ExpiringTokenAuthentication
from progeo.decorator import require_module_permissions
from progeo.helper import docker_access
from progeo.helper.basics import RequestFailed, RequestSuccess, ilog

# Logs: the last this many lines by default - a long-running container's
# whole log can be megabytes. ?tail= (body "tail") up to LOG_TAIL_MAX.
LOG_TAIL_DEFAULT = 1000
LOG_TAIL_MAX = docker_access.ops.LOG_TAIL_MAX


class DockerViewSet(viewsets.ViewSet):
    """The host's containers (Developer -> Docker, /api/docker/...): list,
    start, stop, restart, remove and read logs. Staff with
    module_docker_enabled only. Every action takes {"container_id": <id or
    name>} and answers {"success": true, "name"} or 400 {"reason"}.

    Docker itself is reached through helper/docker_access.py - in production
    the progeo-docker-agent, the only container with the Docker socket."""

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
    def _container_id(request):
        container_id = request.data.get("container_id")
        return container_id.strip() if isinstance(container_id, str) else ""

    def _run(self, request, verb):
        try:
            name = docker_access.container_action(self._container_id(request), verb)
        except docker_access.DockerOpsError as error:
            return RequestFailed({"reason": error.reason})
        ilog(f"{verb} container {name} by user {request.user.pk}", tag="[DOCKER]")
        return RequestSuccess({"name": name})

    @action(detail=False, url_path="status", methods=["GET"])
    @require_module_permissions("module_docker_enabled")
    def docker_status(self, request: Request, *args, **kwargs):
        try:
            return Response({"container": docker_access.status()})
        except docker_access.DockerOpsError as error:
            return RequestFailed({"reason": error.reason})

    @action(detail=False, url_path="start", methods=["POST"])
    @require_module_permissions("module_docker_enabled")
    def start_docker_container(self, request: Request, *args, **kwargs):
        return self._run(request, "start")

    @action(detail=False, url_path="stop", methods=["POST"])
    @require_module_permissions("module_docker_enabled")
    def stop_docker_container(self, request: Request, *args, **kwargs):
        return self._run(request, "stop")

    @action(detail=False, url_path="restart", methods=["POST"])
    @require_module_permissions("module_docker_enabled")
    def restart_docker_container(self, request: Request, *args, **kwargs):
        return self._run(request, "restart")

    @action(detail=False, url_path="remove", methods=["POST"])
    @require_module_permissions("module_docker_enabled")
    def remove_docker_container(self, request: Request, *args, **kwargs):
        # A running container is refused (stop it first) - never removed by force.
        return self._run(request, "remove")

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
        try:
            name, logs = docker_access.container_logs(self._container_id(request), tail, timestamps=True)
        except docker_access.DockerOpsError as error:
            return RequestFailed({"reason": error.reason})
        return RequestSuccess({"logs": logs, "name": name, "tail": tail})

    @action(detail=False, url_path="ping", methods=["POST"])
    @require_module_permissions("module_docker_enabled")
    def ping_docker(self, request: Request, *args, **kwargs):
        name = request.data.get("name")
        if not isinstance(name, str) or not name.strip():
            return Response({"running": False})
        try:
            state = docker_access.container_state(name.strip())
        except docker_access.DockerOpsError:
            state = None
        return Response({"running": bool(state and state["running"])})
