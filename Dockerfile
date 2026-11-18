# kinde-testkit as a container, for CI jobs and docker compose setups.
#   docker build -t kinde-testkit https://github.com/sholajegede/kinde-testkit.git
#   docker run --rm -p 4400:4400 -v "$PWD:/work" kinde-testkit
ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsup.config.ts README.md CHANGELOG.md LICENSE ./
COPY src ./src
RUN npm run build && npm pack --pack-destination /tmp && mv /tmp/kinde-testkit-*.tgz /tmp/kinde-testkit.tgz

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
COPY --from=build /tmp/kinde-testkit.tgz /tmp/kinde-testkit.tgz
RUN npm install -g /tmp/kinde-testkit.tgz --no-audit --no-fund && rm /tmp/kinde-testkit.tgz && npm cache clean --force
# start reads kinde-testkit.json, .yaml, .yml, .js or .mjs from here. Mount your project to /work.
WORKDIR /work
USER node
EXPOSE 4400
HEALTHCHECK --interval=5s --timeout=3s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:4400/testkit/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
ENTRYPOINT ["kinde-testkit"]
# Listen on every interface inside the container. The issuer is the URL your app and browser use.
CMD ["start", "--host", "0.0.0.0", "--port", "4400", "--allow-public", "--issuer", "http://localhost:4400"]
