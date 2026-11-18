# progeo-e2e_screens: full-page screenshots of every screen of the app for the
# screen review (python manage.py e2e_screenshots, /review/screens/) - the
# frontend's dev server and Playwright's Chromium, every API request answered
# by frontend/e2e/screenshots/mockApi.mjs. No backend, no database, no network.
#
# Started per run by the Docker agent (progeo/docker_agent/ops.py
# run_e2e_screens) as DOCKER_UID:DOCKER_GID, with the run's folder
# media/uploads/e2e/<run>/ mounted at /workspace/out.
FROM node:24.22.1-bookworm-slim

# The browser in a fixed place, readable for the run's user; HOME for npm,
# Chromium's crash files and Vite (the run's user has no home).
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    HOME=/tmp \
    NODE_ENV=development

WORKDIR /workspace/frontend

COPY ./frontend/package.json ./frontend/package-lock.json ./
# The Chromium of exactly the locked Playwright version, with its system libraries.
RUN npm ci --no-audit --no-fund \
    && npx playwright install --with-deps chromium \
    && chmod -R a+rX /ms-playwright \
    && rm -rf /var/lib/apt/lists/* /tmp/* /root/.npm

COPY ./frontend .
COPY ./docker/e2e_screens/run.sh /usr/local/bin/e2e-screens

# Vite writes its dependency cache and the bundled config (node_modules/.vite,
# .vite-temp) - writable for any user, the rest of the sources stay read-only.
RUN mkdir -p node_modules/.vite node_modules/.vite-temp \
    && chmod 1777 node_modules/.vite node_modules/.vite-temp \
    && sed -i 's/\r$//' /usr/local/bin/e2e-screens \
    && chmod 755 /usr/local/bin/e2e-screens

ENTRYPOINT ["/usr/local/bin/e2e-screens"]
