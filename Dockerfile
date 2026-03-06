# Use Node.js 18 base image with Python pre-installed
FROM node:18

# Install Python and pip
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    python3-dev \
    build-essential \
    libgl1-mesa-glx \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files for server
COPY package*.json ./
COPY requirements.txt ./

# Install Node.js dependencies for server
RUN npm install --production

# Install Python dependencies (--break-system-packages is safe in Docker containers)
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

# Copy client package files and install dependencies
COPY client/package*.json ./client/
RUN cd client && npm install

# Copy all application files
COPY . .

# Build the React client (outputs to ./dist in root, per vite.config.ts)
RUN cd client && npm run build

# Expose ports
EXPOSE 3000 5000

# Start both services
CMD ["bash", "start.sh"]
