"""Regression tests for the shared Python deployment SSH resolver."""
from __future__ import annotations

import json
import os
from pathlib import Path
import socket
import tempfile
import threading
import unittest
from unittest import mock

import _deploy_host

try:
    import paramiko
except ImportError:  # the resolver tests run without paramiko
    paramiko = None


_ENV_KEYS = (
    "QSDM_ENDPOINTS_FILE",
    "QSDM_RELEASE_SSH_TARGET",
    "QSDM_VPS_HOST",
    "QSDM_VPS_USER",
    "QSDM_VPS_PORT",
    "QSDM_PUBLIC_API_BASE_URL",
)


class DeploymentHostTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.config = Path(self.temp_dir.name) / "public-endpoints.json"
        self._environment = {name: os.environ.get(name) for name in _ENV_KEYS}
        for name in _ENV_KEYS:
            os.environ.pop(name, None)

    def tearDown(self) -> None:
        for name, value in self._environment.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value

    def write_config(self, target: str | None = None, **values: str) -> None:
        payload = dict(values)
        if target is not None:
            payload["vps_ssh_target"] = target
        self.config.write_text(json.dumps(payload), encoding="utf-8")
        os.environ["QSDM_ENDPOINTS_FILE"] = str(self.config)


    def test_config_target_supports_user_and_port(self) -> None:
        self.write_config("root@next-vps.example:2202")
        self.assertEqual(
            _deploy_host.target(),
            _deploy_host.DeploymentTarget("next-vps.example", "root", 2202),
        )

    def test_release_target_overrides_config_and_supports_ipv6(self) -> None:
        self.write_config("root@old-vps.example")
        os.environ["QSDM_RELEASE_SSH_TARGET"] = "deploy@[2001:db8::20]:2222"
        self.assertEqual(
            _deploy_host.target(),
            _deploy_host.DeploymentTarget("2001:db8::20", "deploy", 2222),
        )

    def test_host_user_and_port_overrides_win(self) -> None:
        self.write_config("root@old-vps.example")
        os.environ["QSDM_VPS_HOST"] = "staging-vps.example"
        os.environ["QSDM_VPS_USER"] = "qsdm-deploy"
        os.environ["QSDM_VPS_PORT"] = "2203"
        self.assertEqual(
            _deploy_host.target(),
            _deploy_host.DeploymentTarget("staging-vps.example", "qsdm-deploy", 2203),
        )

    def test_direct_target_overrides_support_cli_host_user_and_port(self) -> None:
        self.write_config("root@old-vps.example")
        self.assertEqual(
            _deploy_host.target("next-vps.example", "root", "2204"),
            _deploy_host.DeploymentTarget("next-vps.example", "root", 2204),
        )
    def test_explicit_missing_config_is_not_silently_ignored(self) -> None:
        os.environ["QSDM_ENDPOINTS_FILE"] = str(self.config)
        with self.assertRaisesRegex(_deploy_host.DeploymentTargetError, "was not found"):
            _deploy_host.target()

    def test_invalid_target_is_rejected_before_connection(self) -> None:
        os.environ["QSDM_RELEASE_SSH_TARGET"] = "root@bad host"
        with self.assertRaisesRegex(_deploy_host.DeploymentTargetError, "whitespace"):
            _deploy_host.target()

    def test_malformed_unbracketed_ipv6_is_rejected(self) -> None:
        os.environ["QSDM_RELEASE_SSH_TARGET"] = "root@not:an:ipv6"
        with self.assertRaisesRegex(_deploy_host.DeploymentTargetError, "valid IPv6"):
            _deploy_host.target()

    def test_legacy_helpers_share_the_target_resolver(self) -> None:
        deploy_dir = Path(__file__).resolve().parent
        privileged = (
            "remote_apply_paramiko.py",
            "remote_bootstrap_paramiko.py",
            "remote_fix_service_paramiko.py",
            "remote_harden_ssh_paramiko.py",
            "remote_install_caddy_paramiko.py",
            "remote_verify_paramiko.py",
        )
        for filename in privileged:
            source = (deploy_dir / filename).read_text(encoding="utf-8")
            self.assertIn("port as _port", source, filename)
            self.assertIn("require_root_user", source, filename)
            self.assertNotIn("206.189.132.232", source, filename)
        command_source = (deploy_dir / "remote_cmd_paramiko.py").read_text(encoding="utf-8")
        self.assertIn("port as _port", command_source)
        self.assertNotIn("206.189.132.232", command_source)
        observability_source = (deploy_dir / "scripts" / "install_observability.sh").read_text(encoding="utf-8")
        self.assertIn("QSDM_OBSERVABILITY_SSH_TARGET", observability_source)
        self.assertNotIn("206.189.132.232", observability_source)

    def test_compatibility_default_is_a_hostname_not_retired_ip(self) -> None:
        with mock.patch.object(_deploy_host, "_DEFAULT_ENDPOINTS_PATH", self.config):
            self.assertEqual(
                _deploy_host.target(),
                _deploy_host.DeploymentTarget("node.qsdm.tech", "root", 22),
            )

    def test_privileged_helpers_reject_non_root_targets(self) -> None:
        os.environ["QSDM_RELEASE_SSH_TARGET"] = "operator@next-vps.example"
        with self.assertRaisesRegex(_deploy_host.DeploymentTargetError, "requires root SSH access"):
            _deploy_host.require_root_user("remote_apply_paramiko.py")


    def test_public_api_base_uses_shared_endpoint_config(self) -> None:
        self.write_config(public_api_base="https://staging-api.qsdm.example/")
        self.assertEqual(_deploy_host.public_api_base(), "https://staging-api.qsdm.example")
        self.assertEqual(
            _deploy_host.ngc_proof_ingest_url(),
            "https://staging-api.qsdm.example/api/v1/monitoring/ngc-proof",
        )

    def test_public_api_environment_override_wins(self) -> None:
        self.write_config(public_api_base="https://old-api.qsdm.example")
        os.environ["QSDM_PUBLIC_API_BASE_URL"] = "https://new-api.qsdm.example:9443"
        self.assertEqual(_deploy_host.public_api_base(), "https://new-api.qsdm.example:9443")

    def test_public_api_base_rejects_non_origin_or_cleartext_values(self) -> None:
        for value in ("http://api.qsdm.example", "https://api.qsdm.example/api/v1", "https://user@api.qsdm.example"):
            with self.subTest(value=value):
                with self.assertRaisesRegex(_deploy_host.DeploymentTargetError, "HTTPS origin"):
                    _deploy_host.normalize_public_api_base(value)

    def test_ngc_installers_use_shared_public_api_resolution(self) -> None:
        deploy_dir = Path(__file__).resolve().parent
        for filename in ("install_ngc_sidecar_vps.py", "install_ngc_sidecar_oci.py"):
            source = (deploy_dir / filename).read_text(encoding="utf-8")
            self.assertIn("public_api_base", source, filename)
            self.assertNotIn("https://api.qsdm.tech/api/v1", source, filename)
        vps_source = (deploy_dir / "install_ngc_sidecar_vps.py").read_text(encoding="utf-8")
        self.assertIn("port=resolved_target.port", vps_source)

    def test_known_hosts_file_order(self) -> None:
        base = Path(self.temp_dir.name)
        explicit, from_env = base / "explicit_known_hosts", base / "env_known_hosts"
        (base / "home" / ".ssh").mkdir(parents=True)
        default = base / "home" / ".ssh" / "known_hosts"
        for path in (explicit, from_env, default):
            path.write_text("", encoding="utf-8")
        os.environ["QSDM_SSH_KNOWN_HOSTS"] = str(from_env)
        self.addCleanup(os.environ.pop, "QSDM_SSH_KNOWN_HOSTS", None)
        with mock.patch.object(Path, "home", return_value=base / "home"):
            self.assertEqual(_deploy_host.known_hosts_file(str(explicit)), explicit)
            self.assertEqual(_deploy_host.known_hosts_file(), from_env)
            os.environ.pop("QSDM_SSH_KNOWN_HOSTS")
            self.assertEqual(_deploy_host.known_hosts_file(), default)

    def test_missing_known_hosts_file_is_refused(self) -> None:
        with self.assertRaisesRegex(_deploy_host.DeploymentTargetError, "Pin the host's SSH key first"):
            _deploy_host.known_hosts_file(Path(self.temp_dir.name) / "missing")

    def test_known_hosts_argument_is_split_from_positional_arguments(self) -> None:
        self.assertEqual(_deploy_host.known_hosts_argument([]), (None, []))
        self.assertEqual(_deploy_host.known_hosts_argument(["pw"]), (None, ["pw"]))
        self.assertEqual(_deploy_host.known_hosts_argument(["--known-hosts", "kh", "pw"]), ("kh", ["pw"]))
        self.assertEqual(_deploy_host.known_hosts_argument(["pw", "--known-hosts=kh"]), ("kh", ["pw"]))
        for argv in (["--known-hosts"], ["--known-hosts="]):
            with self.subTest(argv=argv):
                with self.assertRaisesRegex(_deploy_host.DeploymentTargetError, "needs a file path"):
                    _deploy_host.known_hosts_argument(argv)

    def test_host_key_name_brackets_ports_other_than_22(self) -> None:
        self.assertEqual(_deploy_host.host_key_name("vps.example", 22), "vps.example")
        self.assertEqual(_deploy_host.host_key_name("vps.example", 2202), "[vps.example]:2202")

    def test_no_deploy_script_trusts_an_unknown_host_key(self) -> None:
        deploy_dir = Path(__file__).resolve().parent
        pinned_by = {
            "install_ngc_sidecar_oci.py": "pin_host_keys(c, args.known_hosts)",
            "install_ngc_sidecar_vps.py": "pin_host_keys(c, args.known_hosts)",
            "remote_bootstrap_paramiko.py": "_pin_host_keys(c, known_hosts)",
            "remote_fix_service_paramiko.py": "_pin_host_keys(c, known_hosts)",
            "remote_apply_paramiko.py": "_start_pinned_transport(t, HOST, PORT, known_hosts",
            "remote_cmd_paramiko.py": "_start_pinned_transport(t, HOST, PORT, known_hosts",
            "remote_harden_ssh_paramiko.py": "_start_pinned_transport(t, HOST, PORT, known_hosts",
            "remote_install_caddy_paramiko.py": "_start_pinned_transport(t, HOST, PORT, known_hosts",
            "remote_verify_paramiko.py": "_start_pinned_transport(t, HOST, PORT, known_hosts",
        }
        for path in sorted(deploy_dir.glob("*.py")):
            if path.name in ("_deploy_host.py", "test_deploy_host.py"):
                continue
            source = path.read_text(encoding="utf-8")
            with self.subTest(file=path.name):
                self.assertNotIn("AutoAddPolicy", source)
                self.assertNotIn("WarningPolicy", source)
                self.assertNotIn(".start_client(", source)
                if "import paramiko" in source or "from paramiko" in source:
                    self.assertIn(path.name, pinned_by, "a paramiko deploy script must pin host keys")
                    self.assertIn(pinned_by[path.name], source)


if paramiko is not None:

    class _PasswordServer(paramiko.ServerInterface):
        def __init__(self, attempts: list[str]) -> None:
            self.attempts = attempts

        def get_allowed_auths(self, username: str) -> str:
            return "password"

        def check_auth_password(self, username: str, password: str) -> int:
            self.attempts.append(username)
            return paramiko.AUTH_SUCCESSFUL if password == "pw" else paramiko.AUTH_FAILED


@unittest.skipUnless(paramiko is not None, "paramiko is not installed")
class HostKeyPinningTests(unittest.TestCase):
    """Real SSH handshakes against a local paramiko server on 127.0.0.1."""

    def setUp(self) -> None:
        temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(temp_dir.cleanup)
        self.known_hosts_path = Path(temp_dir.name) / "known_hosts"
        self.auth_attempts: list[str] = []
        self.server_transports: list = []
        self.host_keys = [paramiko.ECDSAKey.generate()]
        self.listener = socket.socket()
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen()
        self.port = self.listener.getsockname()[1]
        threading.Thread(target=self._serve, daemon=True).start()
        self.addCleanup(self._stop)

    def _serve(self) -> None:
        while True:
            try:
                conn, _ = self.listener.accept()
            except OSError:
                return
            transport = paramiko.Transport(conn)
            for key in self.host_keys:
                transport.add_server_key(key)
            self.server_transports.append(transport)
            try:
                transport.start_server(server=_PasswordServer(self.auth_attempts))
            except Exception:  # the client hung up during the handshake
                transport.close()

    def _stop(self) -> None:
        self.listener.close()
        for transport in self.server_transports:
            transport.close()

    def write_known_hosts(self, key=None, name: str | None = None) -> str:
        keys = paramiko.HostKeys()
        key = key or self.host_keys[0]
        keys.add(name or f"[127.0.0.1]:{self.port}", key.get_name(), key)
        keys.save(str(self.known_hosts_path))
        return str(self.known_hosts_path)

    def client_connect(self, known_hosts: str):
        client = paramiko.SSHClient()
        self.addCleanup(client.close)
        _deploy_host.pin_host_keys(client, known_hosts)
        client.connect(
            "127.0.0.1", port=self.port, username="root", password="pw",
            allow_agent=False, look_for_keys=False, timeout=10,
        )
        return client

    def transport_connect(self, known_hosts: str):
        transport = paramiko.Transport(socket.create_connection(("127.0.0.1", self.port), timeout=10))
        self.addCleanup(transport.close)
        _deploy_host.start_pinned_transport(transport, "127.0.0.1", self.port, known_hosts, timeout=10)
        transport.auth_password("root", "pw")
        return transport

    def test_client_connects_to_a_pinned_host(self) -> None:
        client = self.client_connect(self.write_known_hosts())
        self.assertTrue(client.get_transport().is_authenticated())

    def test_client_refuses_an_unknown_host(self) -> None:
        with self.assertRaisesRegex(paramiko.SSHException, "not found in known_hosts"):
            self.client_connect(self.write_known_hosts(name="other.example"))
        self.assertEqual(self.auth_attempts, [])

    def test_client_refuses_a_changed_key(self) -> None:
        with self.assertRaises(paramiko.BadHostKeyException):
            self.client_connect(self.write_known_hosts(key=paramiko.ECDSAKey.generate()))
        self.assertEqual(self.auth_attempts, [])

    def test_transport_connects_to_a_pinned_host(self) -> None:
        transport = self.transport_connect(self.write_known_hosts())
        self.assertTrue(transport.is_authenticated())
        self.assertEqual(self.auth_attempts, ["root"])

    def test_transport_refuses_an_unknown_host(self) -> None:
        with self.assertRaisesRegex(_deploy_host.DeploymentTargetError, "refusing an unknown host"):
            self.transport_connect(self.write_known_hosts(name="other.example"))
        self.assertEqual(self.auth_attempts, [])

    def test_transport_refuses_a_changed_key_before_sending_the_password(self) -> None:
        with self.assertRaisesRegex(_deploy_host.DeploymentTargetError, "does not match"):
            self.transport_connect(self.write_known_hosts(key=paramiko.ECDSAKey.generate()))
        self.assertEqual(self.auth_attempts, [])

    def test_transport_asks_for_the_pinned_rsa_key(self) -> None:
        # The server also offers ECDSA, which paramiko would pick by default.
        rsa_key = paramiko.RSAKey.generate(2048)
        self.host_keys.append(rsa_key)
        transport = self.transport_connect(self.write_known_hosts(key=rsa_key))
        self.assertTrue(transport.is_authenticated())
        self.assertEqual(transport.get_remote_server_key().get_name(), "ssh-rsa")


if __name__ == "__main__":
    unittest.main(verbosity=2)
