FROM node:22.13.0-alpine@sha256:f2dc6eea95f787e25f173ba9904c9d0647ab2506178c7b5b7c5a3d02bc4af145

# Set working directory
WORKDIR /bacstack

# Install the exact locked dependency graph
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Add node-bacstack
COPY . .

# Run compliance tests
CMD ["npm", "run", "compliance"]
