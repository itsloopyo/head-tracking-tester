# Base image pinned by manifest-list digest (tags are mutable); the tag in the
# comment is what the digest resolved from.
FROM node:26-alpine@sha256:2d984a15c9b54fd0aeb608b8e0d0d83529eb34d2966db27a1fb4f1edc3d298a3 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# `docker build --target test .` is the whole test suite: same runtime, same
# dependency tree, no host toolchain. The suite needs only the prod deps.
FROM deps AS test
COPY server.js ./
COPY public ./public
COPY tests ./tests
RUN npm test

FROM node:26-alpine@sha256:2d984a15c9b54fd0aeb608b8e0d0d83529eb34d2966db27a1fb4f1edc3d298a3 AS runtime

LABEL org.opencontainers.image.title="head-tracking-tester" \
      org.opencontainers.image.description="Browser-based 6DoF viewer driven by OpenTrack UDP output." \
      org.opencontainers.image.url="https://github.com/itsloopyo/head-tracking-tester" \
      org.opencontainers.image.source="https://github.com/itsloopyo/head-tracking-tester" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    HTTP_PORT=8080 \
    UDP_PORT=4242

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json LICENSE ./
COPY server.js ./
COPY public ./public

USER node

EXPOSE 8080/tcp
EXPOSE 4242/udp 4243/udp 4244/udp 4245/udp

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.HTTP_PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
