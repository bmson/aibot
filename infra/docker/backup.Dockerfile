FROM postgres:17
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

COPY infra/docker/backup.sh /usr/local/bin/assistant-backup
RUN chmod 0555 /usr/local/bin/assistant-backup

USER postgres
ENTRYPOINT ["/usr/local/bin/assistant-backup"]
