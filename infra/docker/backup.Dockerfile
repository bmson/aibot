FROM postgres:18
# gosu exists for the stock postgres entrypoint's root→postgres privilege drop.
# This image never runs that entrypoint (its own ENTRYPOINT runs as USER
# postgres), so the binary is dead weight — and as a static Go executable it
# drags the base image's stale Go stdlib CVEs into the release scan.
#
# The util-linux upgrade is deliberately targeted rather than a blanket
# `apt-get upgrade`: this image restores backups, so a wide upgrade could shift
# the postgres client version out from under a restore. Debian ships the fix for
# CVE-2026-53615 (integer overflow in libblkid's DOS partition parser) in
# util-linux 2.41.5-0+deb13u1, and every package listed below is built from that
# one source package — the release scan fails the deploy on all nine. Drop this
# once the postgres:17 base image carries the patched packages itself; if it
# already does, --only-upgrade is a no-op and this line costs nothing.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && apt-get install -y --only-upgrade \
    bsdutils libblkid1 liblastlog2-2 libmount1 libsmartcols1 libuuid1 login mount util-linux \
  && rm -rf /var/lib/apt/lists/* \
  && rm -f /usr/local/bin/gosu

COPY infra/docker/backup.sh /usr/local/bin/assistant-backup
RUN chmod 0555 /usr/local/bin/assistant-backup

USER postgres
ENTRYPOINT ["/usr/local/bin/assistant-backup"]
