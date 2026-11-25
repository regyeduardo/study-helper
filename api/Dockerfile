# The Estudo backend (spec 003): a static Go binary with ffmpeg, and (spec 007, história 2, research R10b) a Chromium that runs the
# app itself for the jobs of generating in the account.
FROM golang:1.27-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/estudo ./cmd/estudo
# spec 007: the seeder of the test library (only ever touches an account ending in @local)
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/estudo-semear ./cmd/semear

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg chromium fonts-noto-core fonts-noto-color-emoji \
 && apt-get clean \
 && useradd --system --uid 10001 --home-dir /data estudo \
 && mkdir -p /data && chown estudo /data
COPY --from=build /out/estudo /usr/local/bin/estudo
COPY --from=build /out/estudo-semear /usr/local/bin/estudo-semear
USER estudo
ENV ESTUDO_ADDR=:8080 ESTUDO_DB=/data/estudo.db ESTUDO_CHROMIUM=/usr/bin/chromium
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD curl -fsS http://127.0.0.1:8080/v1/health || exit 1
CMD ["estudo"]
