# The on-site gateway's SSH tunnel to the Azure VM (see ../docker-compose.yml).
FROM alpine:3.22
RUN apk add --no-cache openssh-client
COPY known_hosts /etc/ssh/ssh_known_hosts
COPY tunnel.sh /tunnel.sh
# A Windows checkout may give these CRLF endings, which ssh and sh reject.
RUN sed -i 's/\r$//' /etc/ssh/ssh_known_hosts /tunnel.sh
CMD ["sh", "/tunnel.sh"]
