FROM postgres:16
RUN apt-get update \
    && apt-get install -y --no-install-recommends pgbackrest \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/lib/pgbackrest \
    && chown postgres:postgres /var/lib/pgbackrest \
    && chmod 750 /var/lib/pgbackrest
COPY pgbackrest.conf /etc/pgbackrest.conf
RUN chown postgres:postgres /etc/pgbackrest.conf && chmod 640 /etc/pgbackrest.conf
COPY restore-and-start.sh /usr/local/bin/restore-and-start.sh
RUN chmod 755 /usr/local/bin/restore-and-start.sh
