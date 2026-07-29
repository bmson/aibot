FROM postgres:17
# gosu exists for the stock postgres entrypoint's root→postgres privilege drop.
# This image never runs that entrypoint (its own ENTRYPOINT runs as USER
# postgres), so the binary is dead weight — and as a static Go executable it
# drags the base image's stale Go stdlib CVEs into the release scan.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && rm -f /usr/local/bin/gosu

COPY infra/docker/backup.sh /usr/local/bin/assistant-backup
RUN chmod 0555 /usr/local/bin/assistant-backup

USER postgres
ENTRYPOINT ["/usr/local/bin/assistant-backup"]
