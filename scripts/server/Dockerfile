# Stands in for ml-service in Docker when ml-service runs on the course server
# (docker-compose.remote-ml.yml). Forwards ml-service:9999 and :8000 to the server over SSH,
# and the server's 127.0.0.1:15432 back to db:5432. The login is mounted, never baked in.
FROM python:3.12-slim
RUN pip install --no-cache-dir paramiko==5.1.0
WORKDIR /app
COPY ssh.py known_hosts ./
ENV TUNNEL_BIND=0.0.0.0 \
    SERVER_ENV_FILE=/run/secrets/server.env \
    PYTHONUNBUFFERED=1
CMD ["python", "ssh.py", "--tunnel", "9999:9999", "8000:8000", "--reverse", "15432:db:5432"]
