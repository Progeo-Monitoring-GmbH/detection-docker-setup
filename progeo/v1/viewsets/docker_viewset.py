import docker
from docker.errors import DockerException, NotFound
from rest_framework import viewsets
from rest_framework.authentication import SessionAuthentication, TokenAuthentication
from rest_framework.permissions import IsAuthenticated
from rest_framework.decorators import action
from rest_framework.request import Request
from rest_framework.response import Response
from rest_framework_simplejwt.authentication import JWTAuthentication
from progeo.helper.basics import RequestSuccess, RequestFailed
from progeo.helper.docker_helper import is_container_running
from progeo.helper.docker_helper import get_docker_status


class DockerViewSet(viewsets.ViewSet):

    authentication_classes = [JWTAuthentication, TokenAuthentication, SessionAuthentication]
    permission_classes = [IsAuthenticated]

    @staticmethod
    def _get_client_or_error():
        try:
            return docker.from_env(), None
        except (DockerException, PermissionError) as exc:
            return None, RequestFailed({"reason": f"Docker client unavailable: {exc}"})

    @action(detail=False, url_path="status", methods=["GET"])
    def docker_status(self, request: Request, *args, **kwargs):
        try:
            return Response({"container": get_docker_status()})
        except (DockerException, PermissionError) as exc:
            return RequestFailed({"reason": f"Could not read docker status: {exc}"})

    @action(detail=False, url_path="restart", methods=["POST"])
    def restart_docker_container(self, request: Request, *args, **kwargs):
        container_id = request.data.get("container_id")
        if container_id:
            client, error_response = self._get_client_or_error()
            if error_response:
                return error_response
            try:
                container = client.containers.get(container_id)
                if container:
                    container.restart()
                    return RequestSuccess()
            except (DockerException, PermissionError) as exc:
                return RequestFailed({"reason": f"Failed to restart container: {exc}"})

        return RequestFailed()

    @action(detail=False, url_path="remove", methods=["POST"])
    def remove_docker_container(self, request: Request, *args, **kwargs):
        container_id = request.data.get("container_id")
        if container_id:
            client, error_response = self._get_client_or_error()
            if error_response:
                return error_response
            try:
                container = client.containers.get(container_id)
                if container:
                    container.remove()
                    return RequestSuccess()
            except (DockerException, PermissionError) as exc:
                return RequestFailed({"reason": f"Failed to remove container: {exc}"})

        return RequestFailed()

    @action(detail=False, url_path="logs", methods=["POST"])
    def get_container_logs(self, request: Request, *args, **kwargs):
        container_id = request.data.get("container_id")
        if container_id:
            client, error_response = self._get_client_or_error()
            if error_response:
                return error_response
            try:
                container = client.containers.get(container_id)
                if container:
                    logs = container.logs().decode("utf-8", errors="replace")
                    return RequestSuccess({"logs": logs, "name": f"Logs of '{container.name}'"})
            except (DockerException, PermissionError) as exc:
                return RequestFailed({"reason": f"Failed to read container logs: {exc}"})

        return RequestFailed()

    @action(detail=False, url_path="ping", methods=["POST"])
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