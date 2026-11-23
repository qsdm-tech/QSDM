"""Run arbitrary bash via stdin on VPS. Usage: QSDM_VPS_PASS=... python remote_cmd_paramiko.py < script.sh
Or: echo 'some commands' | python remote_cmd_paramiko.py [--known-hosts FILE]
The VPS host key must already be in known_hosts (--known-hosts FILE, else
QSDM_SSH_KNOWN_HOSTS, else ~/.ssh/known_hosts); unknown hosts are refused."""
import os
import socket
import sys
from paramiko import Transport

from _deploy_host import (
    host as _host,
    known_hosts_argument as _known_hosts_argument,
    port as _port,
    start_pinned_transport as _start_pinned_transport,
    user as _user,
)

HOST = _host()
USER = _user()
PORT = _port()


def main() -> int:
    known_hosts, args = _known_hosts_argument(sys.argv[1:])
    pw = os.environ.get("QSDM_VPS_PASS") or (args[0] if args else "")
    if not pw:
        print("Set QSDM_VPS_PASS", file=sys.stderr)
        return 1
    script = sys.stdin.read()
    if not script.strip():
        print("provide bash on stdin", file=sys.stderr)
        return 1
    sock = socket.create_connection((HOST, PORT), timeout=30)
    t = Transport(sock)
    _start_pinned_transport(t, HOST, PORT, known_hosts, timeout=30)
    t.auth_password(USER, pw)
    ch = t.open_session()
    ch.exec_command("bash -s")
    ch.sendall(script.encode())
    ch.shutdown_write()
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
    st = ch.recv_exit_status()
    t.close()
    sock.close()
    return st


if __name__ == "__main__":
    raise SystemExit(main())
