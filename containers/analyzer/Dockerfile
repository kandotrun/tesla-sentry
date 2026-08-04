FROM python:3.11.15-slim-bookworm@sha256:b18992999dbe963a45a8a4da40ac2b1975be1a776d939d098c647482bcad5cba

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/src

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 --system analyzer \
    && useradd --uid 10001 --gid analyzer --system --no-create-home analyzer

WORKDIR /app
COPY --chown=10001:10001 src/ /app/src/

USER 10001:10001
ENTRYPOINT ["python", "-m", "sentry_analyzer"]
