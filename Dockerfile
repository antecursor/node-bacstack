FROM node:22.13.0-alpine

# Set working directory
WORKDIR /bacstack

# Install the exact locked dependency graph
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Add node-bacstack
COPY . .

# Run compliance tests
CMD ["npm", "run", "compliance"]
