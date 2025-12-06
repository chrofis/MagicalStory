#!/bin/bash
set -e

echo "Starting Python photo analyzer service..."
python photo_analyzer.py &
PYTHON_PID=$!

echo "Waiting for Python service to start..."
sleep 5

echo "Starting Node.js server..."
node server.js

# If Node.js exits, kill Python service
kill $PYTHON_PID 2>/dev/null || true
