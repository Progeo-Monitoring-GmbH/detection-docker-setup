"""progeo-docker-agent: the only container with the Docker socket.

ops.py holds the Docker operations the portal needs, server.py serves them to
the backend over HTTP (helper/docker_access.py is the backend's side).
"""
