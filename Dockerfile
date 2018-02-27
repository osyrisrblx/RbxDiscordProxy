FROM node:alpine
WORKDIR /Project
COPY . .
RUN npm install
RUN npm install -g typescript
RUN tsc
CMD npm start