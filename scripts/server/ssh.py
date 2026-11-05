"""Work on the course server over SSH (it only allows password logins).

The login comes from scripts/server/.env (git-ignored; copy .env.example), never from
the command line. The server's host key is pinned in scripts/server/known_hosts.

    python scripts/server/ssh.py "<command>"             run a command, print its output
    python scripts/server/ssh.py --put <local> <remote>  upload a file (remote: relative to home)
    python scripts/server/ssh.py --tunnel 9999:9999 8000:8000 --reverse 15432:db:5432
        forward localhost:9999 to the server's 127.0.0.1:9999 (and so on), and the server's
        127.0.0.1:15432 back to db:5432 on this side, until Ctrl+C or the connection drops.
        TUNNEL_BIND=0.0.0.0 listens on every interface (inside a container).

Setup (one time): python -m venv scripts/server/.venv
                  scripts/server/.venv/Scripts/pip install paramiko
"""
import os
import select
import socket
import socketserver
import sys
import threading
from pathlib import Path

import paramiko

HERE = Path(__file__).resolve().parent
ENV_FILE = Path(os.environ.get("SERVER_ENV_FILE", HERE / ".env"))
KNOWN_HOSTS = HERE / "known_hosts"


def load_env() -> dict[str, str]:
    env = {}
    for line in ENV_FILE.read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            env[key.strip()] = value.strip()
    return env


def connect() -> paramiko.SSHClient:
    env = load_env()
    client = paramiko.SSHClient()
    client.load_host_keys(str(KNOWN_HOSTS))
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    client.connect(env["SERVER_HOST"], int(env["SERVER_PORT"]), env["SERVER_USER"],
                   password=env["SERVER_PASSWORD"], look_for_keys=False, allow_agent=False, timeout=15)
    client.get_transport().set_keepalive(30)
    return client


def pump(a, b) -> None:
    """Copy bytes both ways between two sockets/channels until either side closes."""
    try:
        while True:
            ready, _, _ = select.select([a, b], [], [])
            for src, dst in ((a, b), (b, a)):
                if src in ready:
                    data = src.recv(65536)
                    if not data:
                        return
                    dst.sendall(data)
    except OSError:
        pass
    finally:
        a.close()
        b.close()


def tunnel(client: paramiko.SSHClient, local: int, remote: int, bind: str) -> None:
    """Forward bind:local on this side to the server's 127.0.0.1:remote."""
    transport = client.get_transport()

    class Handler(socketserver.BaseRequestHandler):
        def handle(self):
            try:
                chan = transport.open_channel("direct-tcpip", ("127.0.0.1", remote), self.request.getpeername())
            except Exception as e:
                print(f"tunnel {local}->{remote}: {e}", flush=True)
                return
            pump(self.request, chan)

    class Server(socketserver.ThreadingTCPServer):
        daemon_threads = True
        allow_reuse_address = True

    server = Server((bind, local), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print(f"tunnel {bind}:{local} -> server 127.0.0.1:{remote}", flush=True)


def reverse(client: paramiko.SSHClient, remote: int, host: str, port: int) -> None:
    """Forward the server's 127.0.0.1:remote back to host:port on this side."""
    def handler(chan, _origin, _server):
        try:
            sock = socket.create_connection((host, port), timeout=10)
        except OSError as e:
            print(f"reverse {remote}->{host}:{port}: {e}", flush=True)
            chan.close()
            return
        threading.Thread(target=pump, args=(sock, chan), daemon=True).start()

    client.get_transport().request_port_forward("127.0.0.1", remote, handler)
    print(f"reverse server 127.0.0.1:{remote} -> {host}:{port}", flush=True)


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    client = connect()
    if sys.argv[1] == "--put":
        client.open_sftp().put(sys.argv[2], sys.argv[3])
        print(f"uploaded {sys.argv[2]} -> {sys.argv[3]}")
    elif sys.argv[1] == "--tunnel":
        bind = os.environ.get("TUNNEL_BIND", "127.0.0.1")
        args = sys.argv[2:]
        reverse_specs = args[args.index("--reverse") + 1:] if "--reverse" in args else []
        local_specs = args[:args.index("--reverse")] if "--reverse" in args else args
        for spec in local_specs:
            local, remote = spec.split(":")
            tunnel(client, int(local), int(remote), bind)
        for spec in reverse_specs:
            remote, host, port = spec.split(":")
            reverse(client, int(remote), host, int(port))
        try:
            while client.get_transport().is_active():
                threading.Event().wait(5)
        except KeyboardInterrupt:
            client.close()
            print("tunnel closed", flush=True)
            return
        print("connection to the server lost", flush=True)
        sys.exit(1)  # a container restarts and reconnects
    else:
        _, out, err = client.exec_command(sys.argv[1], timeout=3600)
        sys.stdout.write(out.read().decode(errors="replace"))
        sys.stderr.write(err.read().decode(errors="replace"))
        sys.exit(out.channel.recv_exit_status())
    client.close()


if __name__ == "__main__":
    main()
