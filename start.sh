#!/bin/bash
set -e

echo "================================"
echo "Starting MagicalStory Services"
echo "================================"

echo ""
echo "[1/2] Starting Python photo analyzer service on port 5000..."
python3 photo_analyzer.py > /tmp/python-service.log 2>&1 &
PYTHON_PID=$!

echo "Python service PID: $PYTHON_PID"
echo "Waiting for Python service to initialize..."
sleep 5

# Check if Python service is still running
if kill -0 $PYTHON_PID 2>/dev/null; then
    echo "✓ Python service started successfully"
else
    echo "✗ Python service failed to start"
    echo "Last 20 lines of log:"
    tail -n 20 /tmp/python-service.log || echo "No log file found"
    echo "WARNING: Continuing without photo analysis service"
fi

echo ""
echo "[2/2] Starting Node.js server..."
node server.js

# If Node.js exits, kill Python service
kill $PYTHON_PID 2>/dev/null || true
