"""Upload hardening drop-in + script and run it on the VPS.

Usage (Powershell):
    $env:QSDM_VPS_PASS = '...'
    python deploy/remote_harden_ssh_paramiko.py [--known-hosts FILE]

The VPS host key must already be in known_hosts (--known-hosts FILE, else
QSDM_SSH_KNOWN_HOSTS, else ~/.ssh/known_hosts); unknown hosts are refused.
"""
from __future__ import annotations

import os
import socket
import sys
from pathlib import Path

import paramiko
from paramiko import Transport

from _deploy_host import (
    host as _host,
    known_hosts_argument as _known_hosts_argument,
    port as _port,
    require_root_user as _require_root_user,
    start_pinned_transport as _start_pinned_transport,
    user as _user,
)

HOST = _host()
USER = _user()
PORT = _port()
BASE = Path(__file__).resolve().parent.parent
REMOTE_DIR = "/root/qsdm-deploy"


def upload_text(sftp: paramiko.SFTPClient, local: Path, remote: str) -> None:
    raw = local.read_bytes().replace(b"\r\n", b"\n").replace(b"\r", b"\n")
    with sftp.open(remote, "wb") as f:
        f.write(raw)


def main() -> int:
    _require_root_user("remote_harden_ssh_paramiko.py")
    known_hosts, args = _known_hosts_argument(sys.argv[1:])
    pw = os.environ.get("QSDM_VPS_PASS") or (args[0] if args else "")
    if not pw:
        print("Set QSDM_VPS_PASS", file=sys.stderr)
        return 1

    sock = socket.create_connection((HOST, PORT), timeout=30)
    t = Transport(sock)
    _start_pinned_transport(t, HOST, PORT, known_hosts, timeout=30)
    t.auth_password(USER, pw)
    t.set_keepalive(30)

    sftp = paramiko.SFTPClient.from_transport(t)
    assert sftp is not None
    try:
        try:
            sftp.mkdir(REMOTE_DIR)
        except IOError:
            pass
        upload_text(sftp, BASE / "deploy/99-qsdm-hardening.conf", f"{REMOTE_DIR}/99-qsdm-hardening.conf")
        upload_text(sftp, BASE / "deploy/harden-ssh.sh", f"{REMOTE_DIR}/harden-ssh.sh")
    finally:
        sftp.close()

    ch0 = t.open_session()
    ch0.exec_command(f"chmod +x {REMOTE_DIR}/harden-ssh.sh")
    ch0.recv_exit_status()

    print("--- Running harden-ssh.sh ---", flush=True)
    ch = t.open_session()
    ch.exec_command(f"bash {REMOTE_DIR}/harden-ssh.sh")
    while True:
        if ch.recv_ready():
            sys.stdout.buffer.write(ch.recv(65536))
            sys.stdout.buffer.flush()
        if ch.recv_stderr_ready():
            sys.stderr.buffer.write(ch.recv_stderr(65536))
            sys.stderr.buffer.flush()
        if ch.exit_status_ready():
            break
    while ch.recv_ready():
        sys.stdout.buffer.write(ch.recv(65536))
    while ch.recv_stderr_ready():
        sys.stderr.buffer.write(ch.recv_stderr(65536))
    sys.stdout.buffer.flush()
    sys.stderr.buffer.flush()
    st = ch.recv_exit_status()
    t.close()
    sock.close()
    return st


if __name__ == "__main__":
    raise SystemExit(main())
