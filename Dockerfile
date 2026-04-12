FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

COPY . .

# Ensure dataset and logs dirs exist (dataset/history.json excluded from .dockerignore)
RUN mkdir -p dataset logs

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

COPY start.sh ./
RUN chmod +x start.sh

CMD ["/bin/sh", "start.sh"]