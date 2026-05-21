import docker
from docker.errors import NotFound
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

    @action(detail=False, url_path="status", methods=["GET"])
    def docker_status(self, request: Request, *args, **kwargs):
        return Response({"container": get_docker_status()})

    @action(detail=False, url_path="restart", methods=["POST"])
    def restart_docker_container(self, request: Request, *args, **kwargs):
        container_id = request.data.get("container_id")
        if container_id:
            client = docker.from_env()
            container = client.containers.get(container_id)
            if container:
                container.restart()
                return RequestSuccess()

        return RequestFailed()

    @action(detail=False, url_path="remove", methods=["POST"])
    def remove_docker_container(self, request: Request, *args, **kwargs):
        container_id = request.data.get("container_id")
        if container_id:
            client = docker.from_env()
            container = client.containers.get(container_id)
            if container:
                container.remove()
                return RequestSuccess()

        return RequestFailed()

    @action(detail=False, url_path="logs", methods=["POST"])
    def get_container_logs(self, request: Request, *args, **kwargs):
        container_id = request.data.get("container_id")
        if container_id:
            client = docker.from_env()
            container = client.containers.get(container_id)
            if container:
                return RequestSuccess({"logs": container.logs(), "name": f"Logs of '{container.name}'"})

        return RequestFailed()

    @action(detail=False, url_path="ping", methods=["POST"])
    def ping_docker(self, request: Request, *args, **kwargs):
        name = request.data.get("name")
        if name:
            client = docker.from_env()
            try:
                container = client.containers.get(name)
                if container:
                    return Response({"running": is_container_running(container)})
            except NotFound:
                pass
        return Response({"running": False})