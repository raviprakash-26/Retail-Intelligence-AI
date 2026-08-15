# The backup job: Postgres client tools plus the AWS CLI.
#
# Two tools, one image, because the job needs both in the same process tree —
# it dumps, verifies, uploads and verifies again, and splitting that across
# containers would mean sharing the dump through a volume and coordinating who
# deletes it.
#
# Based on the Postgres image rather than adding libpq to something smaller:
# pg_dump and pg_restore must match the server's major version, and inheriting
# them from the same image family is what keeps that true when the database is
# upgraded.
FROM postgres:16-bookworm

# awscli from Debian rather than the vendored installer: it is a smaller
# install, it is patched by the distribution, and nothing here needs a feature
# newer than what bookworm carries. `s3 cp` and `s3api` have been stable for
# years.
RUN apt-get update \
    && apt-get install --no-install-recommends -y awscli ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Scripts are mounted read-only by compose rather than copied in, so editing
# one does not mean rebuilding this image.
WORKDIR /

# No CMD. The compose service supplies the loop, because how often to run is a
# deployment decision rather than a property of the image.
