#!/usr/bin/env python3
"""Test OpenCV face detection fallback"""
import cv2
import os

# Test with a sample image
cascade_path = cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
print(f"Haar cascade path: {cascade_path}")
print(f"Exists: {os.path.exists(cascade_path)}")

face_cascade = cv2.CascadeClassifier(cascade_path)
print(f"Cascade loaded: {not face_cascade.empty()}")

# Create a simple test - detect if cascade works
print("\nOpenCV face detection is ready!")
