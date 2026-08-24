"""Helpers for talking to Progeo measurement devices (HTTP config download/upload)."""

import ipaddress
import socket
from urllib.parse import quote, unquote, urlparse

ALLOWED_DEVICE_CONFIG_PATH = "config/device_config.lua"


def normalize_device_base_url(device_ip: str) -> str:
    value = (device_ip or "").strip()
    if not value:
        raise ValueError("Missing device IP")

    if not value.startswith("http://") and not value.startswith("https://"):
        value = f"http://{value}"

    parsed = urlparse(value)
    host = parsed.hostname
    if not host:
        raise ValueError("Invalid device address")

    parsed_ip = ipaddress.ip_address(host)
    if parsed_ip.version != 4 or not parsed_ip.is_private:
        raise ValueError("Only private IPv4 addresses are allowed")

    scheme = parsed.scheme or "http"
    port = f":{parsed.port}" if parsed.port else ""
    return f"{scheme}://{parsed_ip}{port}"


def normalize_config_path(path: str) -> str:
    decoded_path = unquote((path or "").strip()).lstrip("/")
    if decoded_path != ALLOWED_DEVICE_CONFIG_PATH:
        raise ValueError(f"Unsupported config path: {decoded_path}")
    return quote(decoded_path, safe="")


def socket_upload(base_url: str, encoded_path: str, body: bytes, timeout: int = 10) -> tuple[bool, int | None, str]:
    parsed = urlparse(base_url)
    host = parsed.hostname
    if not host:
        raise ValueError("Invalid device host")

    scheme = (parsed.scheme or "http").lower()
    if scheme != "http":
        raise ValueError("Only HTTP upload is supported for raw socket mode")

    port = parsed.port or 80
    target = f"/upload?path={encoded_path}"

    head = (
        f"POST {target} HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        "User-Agent: progeo-upload/1.0\r\n"
        "Accept: */*\r\n"
        "Content-Type: text/plain\r\n"
        f"Content-Length: {len(body)}\r\n"
        "Connection: close\r\n\r\n"
    ).encode("ascii")
    raw_request = head + body

    with socket.create_connection((host, port), timeout=timeout) as sock:
        sock.settimeout(timeout)
        sock.sendall(raw_request)

        chunks = []
        while True:
            chunk = sock.recv(4096)
            if not chunk:
                break
            chunks.append(chunk)

    raw_response = b"".join(chunks)
    response_head, sep, response_body = raw_response.partition(b"\r\n\r\n")

    status_code = None
    if sep:
        first_line = response_head.split(b"\r\n", 1)[0].decode("latin-1", errors="replace")
        parts = first_line.split(" ")
        if len(parts) >= 2 and parts[1].isdigit():
            status_code = int(parts[1])

    content = response_body.decode("utf-8", errors="replace")
    ok = status_code is not None and 200 <= status_code < 300
    return ok, status_code, content
