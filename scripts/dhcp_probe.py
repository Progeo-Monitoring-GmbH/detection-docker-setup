#!/usr/bin/env python3
"""Checks whether a DHCP server answers on an interface, without taking a lease.

Sends a single DHCPDISCOVER and waits for a DHCPOFFER. Nothing on the host is
reconfigured, so it is safe to run while the interface uses a static address.
Used by setup_uplink_network.sh to switch back from the static fallback.

Usage: sudo python3 scripts/dhcp_probe.py <iface> [timeout_seconds]
Exit codes: 0 = offer received, 1 = no offer, 2 = probe could not run.
"""

import os
import socket
import struct
import sys
import time

ETH_P_IP = 0x0800
SO_BINDTODEVICE = 25
MAGIC_COOKIE = b"\x63\x82\x53\x63"
DHCPDISCOVER = 1
DHCPOFFER = 2


def build_discover(xid, mac):
    # BOOTREQUEST, ethernet, broadcast flag set so the offer reaches us
    # although the interface may hold an address from another subnet.
    header = struct.pack("!BBBBIHH4s4s4s4s16s64s128s", 1, 1, 6, 0, xid, 0, 0x8000,
                         bytes(4), bytes(4), bytes(4), bytes(4), mac.ljust(16, b"\x00"),
                         bytes(64), bytes(128))
    options = bytes([53, 1, DHCPDISCOVER, 55, 3, 1, 3, 6, 255])
    # Some servers ignore requests shorter than the classic 300 byte BOOTP size.
    return (header + MAGIC_COOKIE + options).ljust(300, b"\x00")


def parse_offer(packet, xid):
    """Returns (offered_ip, server_ip) for a matching DHCPOFFER, else None."""
    if len(packet) < 20 or packet[9] != socket.IPPROTO_UDP:
        return None
    ihl = (packet[0] & 0x0F) * 4
    udp = packet[ihl:]
    if len(udp) < 8 or struct.unpack("!H", udp[2:4])[0] != 68:
        return None
    bootp = udp[8:]
    if len(bootp) < 240 or bootp[0] != 2 or struct.unpack("!I", bootp[4:8])[0] != xid:
        return None
    if bootp[236:240] != MAGIC_COOKIE:
        return None

    message_type = None
    options = bootp[240:]
    i = 0
    while i < len(options) and options[i] != 255:
        if options[i] == 0:
            i += 1
            continue
        if i + 1 >= len(options):
            break
        code, length = options[i], options[i + 1]
        if code == 53 and length == 1 and i + 2 < len(options):
            message_type = options[i + 2]
        i += 2 + length

    if message_type != DHCPOFFER:
        return None
    return socket.inet_ntoa(bootp[16:20]), socket.inet_ntoa(packet[12:16])


def main():
    if len(sys.argv) not in (2, 3):
        print(__doc__.strip(), file=sys.stderr)
        return 2
    iface = sys.argv[1]
    timeout = float(sys.argv[2]) if len(sys.argv) == 3 else 5.0

    try:
        with open(f"/sys/class/net/{iface}/address") as f:
            mac = bytes.fromhex(f.read().strip().replace(":", ""))
    except OSError as exc:
        print(f"Error: cannot read MAC of {iface}: {exc}", file=sys.stderr)
        return 2

    xid = struct.unpack("!I", os.urandom(4))[0]

    try:
        # Offers are read from a packet socket, so a DHCP client that already
        # holds UDP port 68 (dhcpcd) does not keep them from us.
        receiver = socket.socket(socket.AF_PACKET, socket.SOCK_DGRAM, socket.htons(ETH_P_IP))
        receiver.bind((iface, 0))

        sender = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sender.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sender.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        sender.setsockopt(socket.SOL_SOCKET, SO_BINDTODEVICE, iface.encode())
        try:
            sender.bind(("", 68))
        except OSError:
            sender.bind(("", 0))
        sender.sendto(build_discover(xid, mac), ("255.255.255.255", 67))
    except OSError as exc:
        print(f"Error: DHCP probe on {iface} failed: {exc} (run as root?)", file=sys.stderr)
        return 2

    deadline = time.monotonic() + timeout
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            print(f"No DHCP offer on {iface} within {timeout:g}s")
            return 1
        receiver.settimeout(remaining)
        try:
            packet = receiver.recv(65535)
        except socket.timeout:
            continue
        offer = parse_offer(packet, xid)
        if offer:
            print(f"DHCP offer on {iface}: {offer[0]} from server {offer[1]}")
            return 0


if __name__ == "__main__":
    sys.exit(main())
