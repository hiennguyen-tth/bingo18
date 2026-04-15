FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

# Install all deps (including devDeps) so the build step has @babel/core etc.
RUN npm install

COPY . .

# Pre-compile JSX → plain JS (eliminates Babel Standalone from browser load path)
RUN npm run build

# Strip devDependencies for the final production image
RUN npm prune --production

# Ensure dataset and logs dirs exist (dataset/history.json excluded from .dockerignore)
RUN mkdir -p dataset logs

# Preserve trained weights OUTSIDE the Fly volume path (/app/dataset is mounted as a Volume).
# start.sh will copy this into /app/dataset/model.json on first boot if not already there.
RUN cp dataset/model.json /app/model_weights.json 2>/dev/null || true

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

COPY start.sh ./
RUN chmod +x start.sh

CMD ["/bin/sh", "start.sh"]