import json
import os
import re
import ssl
from typing import Any, Dict, List, Optional
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from progeo.helper.basics import read_env
from progeo.tests.settings import BASE_DIR
from django.core.management.base import BaseCommand
from progeo.helper.basics import okaylog


TARGET_URL = f"http://192.168.0.107:8282/v1/device/sample/field/?token={os.getenv('API_TOKEN')}"
INPUT_URL = "https://data-progeo.net/dragino/dragino.txt"
SPECIAL_FORWARD_IMEIS = {
    "863663069826155",
    "860631079044187",
    "863663069840180",
    "863663069840008",
}

# Separator appears as dashed lines and can optionally be wrapped by markdown fences.
BLOCK_SEPARATOR = re.compile(r"\s*`{0,3}\s*-{10,}\s*`{0,3}\s*", re.MULTILINE)




def fetch_input_text(url: str) -> str:
    request = Request(url, headers={"User-Agent": "dragino-parser/1.0"})
    try:
        with urlopen(request, timeout=30) as response:
            raw = response.read()
    except URLError as exc:
        if not isinstance(exc.reason, ssl.SSLCertVerificationError):
            raise
        # Fallback for endpoints with incomplete cert chains in local/dev environments.
        insecure_context = ssl._create_unverified_context()
        with urlopen(request, timeout=30, context=insecure_context) as response:
            raw = response.read()
    return raw.decode("utf-8", errors="replace")


def extract_trailing_json(block: str) -> Optional[Dict[str, Any]]:
    decoder = json.JSONDecoder()
    candidate: Optional[Dict[str, Any]] = None

    for index, char in enumerate(block):
        if char != "{":
            continue
        try:
            value, consumed = decoder.raw_decode(block[index:])
        except ValueError:
            continue

        if not isinstance(value, dict):
            continue

        tail = block[index + consumed :].strip()
        if tail == "":
            candidate = value

    return candidate


def extract_imei(payload: Dict[str, Any]) -> str:
    direct_imei = payload.get("IMEI")
    if direct_imei is not None:
        return str(direct_imei).strip()

    nested_imei = ((payload.get("payload") or {}).get("value") or {}).get("IMEI")
    if nested_imei is not None:
        return str(nested_imei).strip()

    return ""


def collect_matching_payloads(text: str) -> List[Dict[str, Any]]:
    payloads: List[Dict[str, Any]] = []

    for block in BLOCK_SEPARATOR.split(text):
        if not block or not block.strip():
            continue

        body = extract_trailing_json(block)
        if not body:
            continue

        imei = extract_imei(body)
        if imei in SPECIAL_FORWARD_IMEIS:
            payloads.append(body)

    return payloads


class Command(BaseCommand):
    help = 'Just a simple ping command to check if the management command system is working'

    def handle(self, *args, **options):
        try:
            text = fetch_input_text(INPUT_URL)
        except (HTTPError, URLError, TimeoutError) as exc:
            print(f"Failed to download input file: {exc}")
            return

        payloads = collect_matching_payloads(text)
    
        for payload in payloads:
            content = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            forward_request = Request(TARGET_URL, data=content, headers={"Content-Type": "application/json"})

            try:
                with urlopen(forward_request, timeout=30) as response:
                    response_body = response.read().decode("utf-8", errors="replace")
                    print(f"Forwarded payload: {response_body}")
            except (HTTPError, URLError, TimeoutError) as exc:
                print(f"Failed to forward payload: {exc}: {TARGET_URL}")
