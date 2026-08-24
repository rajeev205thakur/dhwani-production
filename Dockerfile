FROM node:20

# Install FFmpeg
RUN apt-get update && apt-get install -y ffmpeg

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
COPY package*.json ./
RUN npm install

# Bundle app source
COPY . .

# Expose port
EXPOSE 3001

# Start the server
CMD [ "node", "server.js" ]
