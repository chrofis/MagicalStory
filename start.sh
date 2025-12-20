#!/bin/bash
set -e

echo "================================"
echo "Starting MagicalStory Services"
echo "================================"

echo ""
echo "[1/2] Starting Python photo analyzer service on port 5000..."
echo "Python version: $(python3 --version)"
echo "Checking Python dependencies..."
python3 -c "import flask; import cv2; import mediapipe; print('All dependencies OK')" || echo "WARNING: Some dependencies missing"

# Start Python with unbuffered output so logs appear immediately
python3 -u photo_analyzer.py 2>&1 | tee /tmp/python-service.log &
PYTHON_PID=$!

echo "Python service PID: $PYTHON_PID"
echo "Waiting for Python service to initialize (10 seconds)..."
sleep 10

# Check if Python service is still running
if kill -0 $PYTHON_PID 2>/dev/null; then
    echo "✓ Python service process is running"
    # Try to hit the health endpoint
    echo "Testing health endpoint..."
    curl -s http://127.0.0.1:5000/health || echo "Health endpoint not responding yet"
else
    echo "✗ Python service failed to start"
    echo "=== Python service log ==="
    cat /tmp/python-service.log || echo "No log file found"
    echo "==========================="
    echo "WARNING: Continuing without photo analysis service"
fi

echo ""
echo "[2/2] Starting Node.js server..."
node server.js

# If Node.js exits, kill Python service
kill $PYTHON_PID 2>/dev/null || true
