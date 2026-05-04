from celery import shared_task
import ipaddress

import requests


@shared_task
def ping():
    import datetime
    return f"pong {datetime.datetime.now(datetime.timezone.utc)}"


@shared_task
def ping_device(ip: str):
    """Ping a device from the backend network via its local HTTP endpoint."""
    parsed_ip = ipaddress.ip_address(ip)
    if parsed_ip.version != 4 or not parsed_ip.is_private:
        raise ValueError("Only private IPv4 addresses are allowed")

    response = requests.get(f"http://{parsed_ip}:80/identify/", timeout=5)
    return {
        "ip": str(parsed_ip),
        "status_code": response.status_code,
        "ok": response.ok,
        "body": response.text[:500],
    }
