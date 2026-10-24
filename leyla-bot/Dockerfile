FROM node:22-alpine
WORKDIR /app
COPY package.json server.js prompt.md ./
COPY knowledge ./knowledge
COPY placement ./placement
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
