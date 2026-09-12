FROM postgres:17
# gosu exists for the stock postgres entrypoint's root→postgres privilege drop.
# This image never runs that entrypoint (its own ENTRYPOINT runs as USER
# postgres), so the binary is dead weight — and as a static Go executable it
# drags the base image's stale Go stdlib CVEs into the release scan.
#
# These security upgrades are deliberately targeted rather than a blanket
# `apt-get upgrade`: this image restores backups, so a wide upgrade could shift
# the postgres client version out from under a restore. Drop these packages
# once the postgres:17 base image carries the patched versions itself; if it
# already does, --only-upgrade is a no-op and these lines cost nothing.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && apt-get install -y --only-upgrade \
    bsdutils libblkid1 liblastlog2-2 libmount1 libsmartcols1 libuuid1 login mount util-linux \
    libssl3t64 openssl openssl-provider-legacy libpcre2-8-0 \
    gzip libperl5.40 perl perl-base perl-modules-5.40 libsqlite3-0 \
  && rm -rf /var/lib/apt/lists/* \
  && rm -f /usr/local/bin/gosu

COPY infra/docker/database-admin.sh /usr/local/bin/database-admin.sh
COPY infra/docker/backup.sh /usr/local/bin/assistant-backup
RUN chmod 0555 /usr/local/bin/database-admin.sh /usr/local/bin/assistant-backup

USER postgres
ENTRYPOINT ["/usr/local/bin/assistant-backup"]
