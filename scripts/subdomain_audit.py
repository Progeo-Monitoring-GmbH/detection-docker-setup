#!/usr/bin/env python3
"""
subdomain_audit.py - DNS + HTTP audit of progeo.com subdomains.

For every hostname in SUBDOMAIN_LABELS this:
  1. Resolves it (CNAME chain -> final A/AAAA records), so you can see
     exactly *how* - or whether - a name resolves. Uses dnspython when
     available (gives the real hop-by-hop CNAME chain); falls back to the
     stdlib `socket` resolver otherwise. Also captures the raw output of the
     system `nslookup` binary, best-effort, purely for manual inspection -
     it is not parsed, since its wording is locale/platform-specific (tested
     on Windows: German-locale nslookup phrases both success and NXDOMAIN
     completely differently from Linux's bind-utils, so parsing it directly
     is not a reliable basis for a verdict).
  2. Probes the hostname over HTTPS then HTTP (GET, redirects followed) to
     see whether *anything* is actually listening, and if so what (status
     code, final URL, Server header, page <title>).
  3. Classifies each host as ACTIVE / DEAD (no DNS) / SUSPICIOUS (DNS
     resolves but nothing answers over HTTP(S)) / an HTTP error, so unused
     subdomains are easy to spot.

Usage:
    python scripts/subdomain_audit.py
    python scripts/subdomain_audit.py --json report.json
    python scripts/subdomain_audit.py --timeout 8 --workers 12
"""

import argparse
import json
import re
import socket
import subprocess
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict, dataclass, field

import requests
from requests.exceptions import RequestException

try:
    import dns.exception
    import dns.resolver

    HAVE_DNSPYTHON = True
except ImportError:
    HAVE_DNSPYTHON = False

BASE_DOMAIN = "progeo.com"

# XXX in "XXX.progeo.com" - two entries are already full/multi-label names
# (monitoringserver.progeo.com, www.dach-webportal, www.sma) and are used
# as-is; everything else gets ".progeo.com" appended.
SUBDOMAIN_LABELS = [
    "a-record", "api", "contact", "corona", "dach-webportal", "dashboard",
    "data", "dns", "emailtest", "geocontact", "hochbau", "ifat", "intern",
    "kundenportal", "monitest", "monitoring", "monitoringserver.progeo.com",
    "privatkunden", "progeo", "qr", "redir", "roofus", "shop", "sma",
    "stage", "status", "tb", "test", "ticket", "tiefbau", "veranstaltung",
    "vertrieb", "verwaltung", "vt-webportal", "wiki", "www.dach-webportal",
    "www.sma",
]


def build_hostname(label: str) -> str:
    label = label.strip().rstrip(".")
    if label.lower() == BASE_DOMAIN or label.lower().endswith(f".{BASE_DOMAIN}"):
        return label
    return f"{label}.{BASE_DOMAIN}"


@dataclass
class DnsResult:
    resolved: bool
    chain: list = field(default_factory=list)      # CNAME hops, in order
    addresses: list = field(default_factory=list)  # final A/AAAA records
    error: str | None = None
    nslookup_raw: str | None = None


@dataclass
class HttpResult:
    scheme: str | None = None
    status_code: int | None = None
    final_url: str | None = None
    server: str | None = None
    redirected: bool = False
    title: str | None = None
    error: str | None = None


@dataclass
class HostReport:
    hostname: str
    dns: DnsResult
    http: HttpResult
    verdict: str


def _raw_nslookup(hostname: str, timeout: int) -> str | None:
    """Best-effort raw `nslookup` output for manual inspection - never used
    to decide the verdict (see module docstring for why)."""
    try:
        proc = subprocess.run(
            ["nslookup", hostname],
            capture_output=True,
            text=True,
            timeout=timeout,
            errors="replace",
            check=False,
        )
        return (proc.stdout + proc.stderr).strip() or None
    except (OSError, subprocess.SubprocessError):
        return None


def _resolve_with_dnspython(hostname: str, timeout: int) -> DnsResult:
    resolver = dns.resolver.Resolver()
    resolver.timeout = timeout
    resolver.lifetime = timeout

    chain = []
    current = hostname
    seen = set()

    # Follow the CNAME chain (if any) to its end.
    for _ in range(10):  # guard against a resolver loop
        if current in seen:
            break
        seen.add(current)
        try:
            answer = resolver.resolve(current, "CNAME")
        except dns.resolver.NoAnswer:
            break
        except dns.resolver.NXDOMAIN:
            return DnsResult(resolved=False, chain=chain, error="NXDOMAIN")
        except dns.exception.Timeout:
            return DnsResult(resolved=bool(chain), chain=chain, error="timeout")
        except Exception as exc:  # noqa: BLE001 - report, don't crash the audit
            return DnsResult(resolved=bool(chain), chain=chain, error=str(exc))
        target = str(answer[0].target).rstrip(".")
        chain.append(target)
        current = target

    addresses = []
    last_error = None
    for record_type in ("A", "AAAA"):
        try:
            answer = resolver.resolve(current, record_type)
            addresses.extend(str(record) for record in answer)
        except dns.resolver.NoAnswer:
            continue
        except dns.resolver.NXDOMAIN:
            last_error = "NXDOMAIN"
        except dns.exception.Timeout:
            last_error = "timeout"
        except Exception as exc:  # noqa: BLE001
            last_error = str(exc)

    resolved = bool(chain) or bool(addresses)
    return DnsResult(
        resolved=resolved,
        chain=chain,
        addresses=addresses,
        error=None if (resolved or last_error is None) else last_error,
    )


def _resolve_with_socket(hostname: str) -> DnsResult:
    try:
        canonical, aliases, addresses = socket.gethostbyname_ex(hostname)
    except socket.gaierror as exc:
        return DnsResult(resolved=False, error=str(exc))
    chain = [canonical] if canonical and canonical != hostname else list(aliases)
    return DnsResult(resolved=True, chain=chain, addresses=list(addresses))


def resolve_dns(hostname: str, timeout: int, include_raw_nslookup: bool) -> DnsResult:
    result = (
        _resolve_with_dnspython(hostname, timeout)
        if HAVE_DNSPYTHON
        else _resolve_with_socket(hostname)
    )
    if include_raw_nslookup:
        result.nslookup_raw = _raw_nslookup(hostname, timeout)
    return result


def probe_http(hostname: str, timeout: int) -> HttpResult:
    last_error = None
    for scheme in ("https", "http"):
        url = f"{scheme}://{hostname}/"
        try:
            response = requests.get(
                url,
                timeout=timeout,
                allow_redirects=True,
                headers={"User-Agent": "progeo-subdomain-audit/1.0"},
            )
        except RequestException as exc:
            last_error = f"{scheme}: {exc.__class__.__name__}"
            continue

        title_match = re.search(
            r"<title[^>]*>(.*?)</title>", response.text or "", re.IGNORECASE | re.DOTALL
        )
        title = re.sub(r"\s+", " ", title_match.group(1)).strip()[:120] if title_match else None

        return HttpResult(
            scheme=scheme,
            status_code=response.status_code,
            final_url=response.url,
            server=response.headers.get("Server"),
            redirected=response.url.rstrip("/") != url.rstrip("/"),
            title=title,
        )
    return HttpResult(error=last_error or "no response on http or https")


def classify(dns_result: DnsResult, http_result: HttpResult) -> str:
    if not dns_result.resolved:
        return "DEAD (no DNS record)"
    if http_result.status_code is not None:
        if 200 <= http_result.status_code < 400:
            return "ACTIVE"
        return f"RESOLVES, HTTP {http_result.status_code}"
    return "SUSPICIOUS (DNS resolves, no HTTP response)"


def audit_host(label: str, timeout: int, include_raw_nslookup: bool) -> HostReport:
    hostname = build_hostname(label)
    dns_result = resolve_dns(hostname, timeout, include_raw_nslookup)
    http_result = probe_http(hostname, timeout) if dns_result.resolved else HttpResult(
        error="skipped - no DNS record"
    )
    return HostReport(
        hostname=hostname,
        dns=dns_result,
        http=http_result,
        verdict=classify(dns_result, http_result),
    )


def render_table(reports: list) -> str:
    lines = [f"{'HOSTNAME':38} {'VERDICT':34} {'RESOLVES TO':32} HTTP", "-" * 130]
    for report in reports:
        route = ", ".join(report.dns.chain + report.dns.addresses) or "-"
        if report.http.error:
            http_summary = f"error: {report.http.error}"
        else:
            http_summary = f"{report.http.scheme}:{report.http.status_code} -> {report.http.final_url}"
            if report.http.server:
                http_summary += f" [{report.http.server}]"
            if report.http.title:
                http_summary += f" \"{report.http.title}\""
        lines.append(
            f"{report.hostname:38} {report.verdict:34} {route[:32]:32} {http_summary}"
        )
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description="Audit progeo.com subdomains for dead/unused entries.")
    parser.add_argument("--timeout", type=int, default=6, help="Per-lookup timeout in seconds (default: 6)")
    parser.add_argument("--workers", type=int, default=8, help="Parallel workers (default: 8)")
    parser.add_argument("--json", metavar="PATH", help="Also write the full report as JSON to PATH")
    parser.add_argument(
        "--no-nslookup", action="store_true",
        help="Skip capturing raw `nslookup` output (dnspython/socket resolution still runs)",
    )
    args = parser.parse_args()

    if not HAVE_DNSPYTHON:
        print("[warn] dnspython not installed - falling back to socket resolution "
              "(no intermediate CNAME hops, just the final canonical name).\n")

    reports = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {
            pool.submit(audit_host, label, args.timeout, not args.no_nslookup): label
            for label in SUBDOMAIN_LABELS
        }
        for future in as_completed(futures):
            reports.append(future.result())

    reports.sort(key=lambda r: r.hostname)

    print(render_table(reports))

    dead = [r for r in reports if r.verdict.startswith("DEAD")]
    suspicious = [r for r in reports if r.verdict.startswith("SUSPICIOUS")]
    http_errors = [r for r in reports if r.verdict.startswith("RESOLVES, HTTP")]
    active = [r for r in reports if r.verdict == "ACTIVE"]

    print()
    print(
        f"Total: {len(reports)}  Active: {len(active)}  "
        f"Dead (no DNS): {len(dead)}  Suspicious (DNS only): {len(suspicious)}  "
        f"HTTP errors: {len(http_errors)}"
    )
    if dead:
        print("\nDead (safe to consider removing the DNS record):")
        for r in dead:
            print(f"  - {r.hostname}")
    if suspicious:
        print("\nSuspicious (DNS record exists, nothing answers over HTTP(S) - check for a stale record):")
        for r in suspicious:
            print(f"  - {r.hostname}  ({', '.join(r.dns.chain + r.dns.addresses) or 'no route info'})")

    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump([asdict(r) for r in reports], f, indent=2, ensure_ascii=False)
        print(f"\nFull report written to {args.json}")


if __name__ == "__main__":
    main()
