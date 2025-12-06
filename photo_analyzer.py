#!/usr/bin/env python3
"""
Photo Analyzer API - Face Detection and Attribute Extraction
Uses DeepFace for analyzing uploaded photos
"""

from flask import Flask, request, jsonify, send_file
from flask_cors import CORS
from deepface import DeepFace
import cv2
import numpy as np
import os
import base64
from io import BytesIO
from PIL import Image
import traceback

app = Flask(__name__)
CORS(app)

# Create temp directory for processing
TEMP_DIR = os.path.join(os.path.dirname(__file__), 'temp_photos')
os.makedirs(TEMP_DIR, exist_ok=True)

def estimate_height_build(age, gender):
    """
    Estimate default height and build based on age and gender
    Note: This is a rough estimate. Actual values should be user-editable.
    """
    # Default heights in cm
    if gender.lower() in ['man', 'male']:
        if age < 12:
            height = int(100 + (age * 5))  # Child growth estimate
            build = 'slim'
        elif age < 18:
            height = int(140 + ((age - 12) * 5))  # Teen growth
            build = 'slim'
        else:
            height = 175  # Average adult male
            build = 'average'
    else:  # Woman/Female
        if age < 12:
            height = int(100 + (age * 5))
            build = 'slim'
        elif age < 18:
            height = int(135 + ((age - 12) * 4.5))
            build = 'slim'
        else:
            height = 165  # Average adult female
            build = 'average'

    return height, build

def process_photo(image_data, is_base64=True):
    """
    Process uploaded photo: detect face, crop, and extract attributes

    Args:
        image_data: Base64 encoded image or file path
        is_base64: Whether image_data is base64 encoded

    Returns:
        dict with success status, attributes, and cropped image
    """
    temp_input = os.path.join(TEMP_DIR, f'input_{os.getpid()}.jpg')
    temp_output = os.path.join(TEMP_DIR, f'crop_{os.getpid()}.jpg')

    try:
        # 1. DECODE AND SAVE IMAGE
        if is_base64:
            # Remove data URL prefix if present
            if ',' in image_data:
                image_data = image_data.split(',')[1]

            # Decode base64
            image_bytes = base64.b64decode(image_data)
            img = Image.open(BytesIO(image_bytes))
            img.save(temp_input)
        else:
            temp_input = image_data

        # 2. RUN DEEPFACE ANALYSIS
        # Single call detects face AND extracts age/gender
        results = DeepFace.analyze(
            img_path=temp_input,
            actions=['age', 'gender'],
            detector_backend='opencv',  # Fast. Use 'retinaface' for better accuracy
            enforce_detection=True
        )

        # Take first face if multiple detected
        first_face = results[0]

        # 3. EXTRACT ATTRIBUTES
        age = int(first_face['age'])
        gender_raw = first_face['dominant_gender']  # "Man" or "Woman"

        # Normalize gender
        gender = 'male' if gender_raw.lower() in ['man', 'male'] else 'female'

        # Estimate height and build based on age/gender
        height, build = estimate_height_build(age, gender)

        # 4. CROP FACE
        region = first_face['region']
        x, y, w, h = region['x'], region['y'], region['w'], region['h']

        # Load original image
        img = cv2.imread(temp_input)

        # Add padding (20% of face size)
        padding_x = int(w * 0.2)
        padding_y = int(h * 0.2)

        y1 = max(0, y - padding_y)
        y2 = min(img.shape[0], y + h + padding_y)
        x1 = max(0, x - padding_x)
        x2 = min(img.shape[1], x + w + padding_x)

        cropped_face = img[y1:y2, x1:x2]

        # Save cropped image
        cv2.imwrite(temp_output, cropped_face)

        # 5. ENCODE CROPPED IMAGE TO BASE64
        with open(temp_output, 'rb') as f:
            cropped_base64 = base64.b64encode(f.read()).decode('utf-8')

        # Clean up temp files
        if os.path.exists(temp_input) and is_base64:
            os.remove(temp_input)
        if os.path.exists(temp_output):
            os.remove(temp_output)

        return {
            "success": True,
            "attributes": {
                "age": age,
                "gender": gender,
                "height": height,
                "build": build
            },
            "cropped_image": f"data:image/jpeg;base64,{cropped_base64}",
            "face_region": {
                "x": x,
                "y": y,
                "width": w,
                "height": h
            }
        }

    except Exception as e:
        # Clean up on error
        if os.path.exists(temp_input) and is_base64:
            os.remove(temp_input)
        if os.path.exists(temp_output):
            os.remove(temp_output)

        return {
            "success": False,
            "error": str(e),
            "traceback": traceback.format_exc()
        }

@app.route('/health', methods=['GET'])
def health_check():
    """Health check endpoint"""
    return jsonify({"status": "ok", "service": "photo-analyzer"})

@app.route('/analyze', methods=['POST'])
def analyze_photo():
    """
    Analyze uploaded photo

    Expected JSON:
    {
        "image": "data:image/jpeg;base64,..." or base64 string
    }

    Returns:
    {
        "success": true,
        "attributes": {
            "age": 25,
            "gender": "male",
            "height": 175,
            "build": "average"
        },
        "cropped_image": "data:image/jpeg;base64,...",
        "face_region": {...}
    }
    """
    try:
        data = request.get_json()

        if not data or 'image' not in data:
            return jsonify({
                "success": False,
                "error": "Missing 'image' field in request"
            }), 400

        image_data = data['image']
        result = process_photo(image_data, is_base64=True)

        if result['success']:
            return jsonify(result), 200
        else:
            return jsonify(result), 500

    except Exception as e:
        return jsonify({
            "success": False,
            "error": str(e),
            "traceback": traceback.format_exc()
        }), 500

@app.route('/test', methods=['GET'])
def test():
    """Test endpoint to verify DeepFace is working"""
    try:
        # Just import to verify it's installed
        import deepface
        import cv2
        return jsonify({
            "success": True,
            "deepface_version": deepface.__version__,
            "opencv_installed": True
        })
    except Exception as e:
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500

if __name__ == '__main__':
    port = int(os.environ.get('PHOTO_ANALYZER_PORT', 5000))
    print(f"🔍 Photo Analyzer API starting on port {port}")
    app.run(host='0.0.0.0', port=port, debug=False)
