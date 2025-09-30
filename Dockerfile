FROM node:20-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ffmpeg (mirror/encode için şart)
RUN apk add --no-cache ffmpeg

COPY . .
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server/index.js"]
