# Development image; release digest and NAS architecture still require acceptance.
FROM python:3.12-slim-bookworm
LABEL org.opencontainers.image.source="https://github.com/yudacheng666/KindleHomeDashboard"
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 khd && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin khd \
    && mkdir -p /var/lib/khd && chown 10001:10001 /var/lib/khd
WORKDIR /app
COPY dashboard/ /app/dashboard/
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
USER 10001:10001
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=60s --timeout=5s --start-period=15s --retries=3 CMD ["python","-c","import urllib.request; r=urllib.request.urlopen('http://127.0.0.1:8080/display',timeout=3); assert r.status==200; r.close()"]
ENTRYPOINT ["python","-m","dashboard"]
CMD ["--directory","/var/lib/khd","--enable-household"]
