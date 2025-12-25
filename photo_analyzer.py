#!/usr/bin/env python3
"""
Photo Analyzer API - Face Detection and Background Removal
Uses MediaPipe for fast face detection and background removal (no heavy AI models)
"""

from flask import Flask, request, jsonify
from flask_cors import CORS
import mediapipe as mp
import cv2
import numpy as np
import os
import base64
from io import BytesIO
from PIL import Image
import traceback

app = Flask(__name__)
CORS(app)

# Initialize MediaPipe (lightweight, no model downloads needed)
mp_face_detection = mp.solutions.face_detection
mp_selfie_segmentation = mp.solutions.selfie_segmentation

# Create temp directory for processing
TEMP_DIR = os.path.join(os.path.dirname(__file__), 'temp_photos')
os.makedirs(TEMP_DIR, exist_ok=True)


def detect_face_mediapipe(image):
    """
    Detect face using MediaPipe Face Detection
    Returns bounding box as percentage of image dimensions (0-100)
    """
    with mp_face_detection.FaceDetection(
        model_selection=1,  # 0 for close faces, 1 for far faces
        min_detection_confidence=0.5
    ) as face_detection:
        # Convert BGR to RGB
        rgb_image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        results = face_detection.process(rgb_image)

        if results.detections:
            # Get the first (most confident) detection
            detection = results.detections[0]
            bbox = detection.location_data.relative_bounding_box

            # Convert to percentage (0-100)
            return {
                'x': bbox.xmin * 100,
                'y': bbox.ymin * 100,
                'width': bbox.width * 100,
                'height': bbox.height * 100,
                'confidence': detection.score[0]
            }

    return None


def remove_background(image):
    """
    Remove background from image using MediaPipe Selfie Segmentation.
    Returns tuple: (image with transparent background (RGBA), binary mask)
    """
    with mp_selfie_segmentation.SelfieSegmentation(model_selection=1) as segmentation:
        # Convert BGR to RGB
        rgb_image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        results = segmentation.process(rgb_image)

        # Get segmentation mask (0-1 float values)
        mask = results.segmentation_mask

        # Create binary mask with threshold
        binary_mask = (mask > 0.5).astype(np.uint8) * 255

        # Optional: Smooth the mask edges
        binary_mask = cv2.GaussianBlur(binary_mask, (5, 5), 0)

        # Create 4-channel image (BGRA)
        bgra = cv2.cvtColor(image, cv2.COLOR_BGR2BGRA)

        # Apply mask to alpha channel
        bgra[:, :, 3] = binary_mask

        return bgra, binary_mask


def get_body_bounds_from_mask(mask, padding_percent=0.05):
    """
    Find bounding box of non-zero pixels in mask.
    Returns bounding box as percentage of image dimensions (0-100).
    """
    h, w = mask.shape[:2]

    # Find non-zero pixels (the person)
    non_zero = cv2.findNonZero(mask)

    if non_zero is None:
        return None

    # Get bounding rectangle
    x, y, bw, bh = cv2.boundingRect(non_zero)

    # Add small padding
    pad_x = int(bw * padding_percent)
    pad_y = int(bh * padding_percent)

    x = max(0, x - pad_x)
    y = max(0, y - pad_y)
    bw = min(w - x, bw + 2 * pad_x)
    bh = min(h - y, bh + 2 * pad_y)

    # Convert to percentage (0-100)
    return {
        'x': (x / w) * 100,
        'y': (y / h) * 100,
        'width': (bw / w) * 100,
        'height': (bh / h) * 100
    }


def add_padding_to_box(box, padding_percent=0.5):
    """
    Add padding around a bounding box.
    padding_percent: 0.5 means 50% extra on each side
    Box is in percentage 0-100 format.
    """
    pad_x = box['width'] * padding_percent
    pad_y = box['height'] * padding_percent

    return {
        'x': max(0, box['x'] - pad_x),
        'y': max(0, box['y'] - pad_y),
        'width': min(100 - max(0, box['x'] - pad_x), box['width'] + 2 * pad_x),
        'height': min(100 - max(0, box['y'] - pad_y), box['height'] + 2 * pad_y)
    }


def crop_to_box(image, box, output_size=None):
    """
    Crop image to bounding box (box is in percentage 0-100)
    Returns cropped image
    """
    h, w = image.shape[:2]

    x = int((box['x'] / 100) * w)
    y = int((box['y'] / 100) * h)
    width = int((box['width'] / 100) * w)
    height = int((box['height'] / 100) * h)

    # Ensure bounds are valid
    x = max(0, x)
    y = max(0, y)
    x2 = min(w, x + width)
    y2 = min(h, y + height)

    cropped = image[y:y2, x:x2]

    if output_size and cropped.size > 0:
        cropped = cv2.resize(cropped, output_size)

    return cropped


def process_photo(image_data, is_base64=True):
    """
    Process uploaded photo - FAST version:
    1. Detect face with MediaPipe (fast, no downloads)
    2. Remove background with MediaPipe (fast, no downloads)
    3. Create cropped face thumbnail and body image

    Returns dict with face_thumbnail, body_no_bg, and bounding boxes
    """
    temp_input = os.path.join(TEMP_DIR, f'input_{os.getpid()}.jpg')

    try:
        # 1. DECODE IMAGE
        if is_base64:
            # Remove data URL prefix if present
            if ',' in image_data:
                image_data = image_data.split(',')[1]

            # Decode base64
            image_bytes = base64.b64decode(image_data)
            img_pil = Image.open(BytesIO(image_bytes))
            img_pil.save(temp_input)
        else:
            temp_input = image_data

        # Load image with OpenCV
        img = cv2.imread(temp_input)
        if img is None:
            raise ValueError("Failed to load image")

        img_h, img_w = img.shape[:2]
        print(f"📸 Processing image: {img_w}x{img_h}")

        # 2. DETECT FACE (fast - ~50ms)
        print("👤 Detecting face...")
        face_box = detect_face_mediapipe(img)
        print(f"   Face detected: {face_box is not None}")

        # If no face detected, return error immediately
        if face_box is None:
            print("❌ No face detected in photo")
            # Clean up temp files
            if os.path.exists(temp_input) and is_base64:
                os.remove(temp_input)
            return {
                "success": False,
                "error": "no_face_detected",
                "error_message": "No face was detected in the photo. Please upload a clear photo showing your face."
            }

        # 3. REMOVE BACKGROUND (fast - ~100ms)
        print("🎭 Removing background...")
        full_img_rgba = None
        body_mask = None
        try:
            full_img_rgba, body_mask = remove_background(img)
            print("   Background removed")
        except Exception as bg_error:
            print(f"   Background removal failed: {bg_error}")

        # 4. GET BODY BOUNDS FROM MASK
        body_box = None
        if body_mask is not None:
            body_box = get_body_bounds_from_mask(body_mask, padding_percent=0.05)

        # 5. CREATE OUTPUTS
        face_thumbnail = None
        body_no_bg = None
        body_crop = None

        # Face thumbnail with background removed
        if face_box and full_img_rgba is not None:
            # Add 15% padding around face
            face_box_padded = add_padding_to_box(face_box, padding_percent=0.15)
            face_img = crop_to_box(full_img_rgba, face_box_padded)

            if face_img.size > 0:
                # Make it square with soft warm peach background
                size = max(face_img.shape[0], face_img.shape[1])
                # Create square with warm peach background (BGRA: B=230, G=240, R=255, A=255)
                square = np.full((size, size, 4), [230, 240, 255, 255], dtype=np.uint8)
                y_off = (size - face_img.shape[0]) // 2
                x_off = (size - face_img.shape[1]) // 2

                # Composite face onto background
                face_region = square[y_off:y_off+face_img.shape[0], x_off:x_off+face_img.shape[1]]
                alpha = face_img[:, :, 3:4] / 255.0
                face_region[:, :, :3] = (face_img[:, :, :3] * alpha + face_region[:, :, :3] * (1 - alpha)).astype(np.uint8)
                face_region[:, :, 3] = 255

                # Resize to 200x200
                face_thumb = cv2.resize(square, (200, 200))
                face_thumb_bgr = cv2.cvtColor(face_thumb, cv2.COLOR_BGRA2BGR)
                _, buffer = cv2.imencode('.jpg', face_thumb_bgr, [cv2.IMWRITE_JPEG_QUALITY, 90])
                face_thumbnail = f"data:image/jpeg;base64,{base64.b64encode(buffer).decode('utf-8')}"
                print("   Face thumbnail created")

        # Body with transparent background
        if body_box and full_img_rgba is not None:
            body_img_rgba = crop_to_box(full_img_rgba, body_box)
            if body_img_rgba.size > 0:
                # Resize if too large
                bh, bw = body_img_rgba.shape[:2]
                if bw > 600 or bh > 800:
                    scale = min(600/bw, 800/bh)
                    body_img_rgba = cv2.resize(body_img_rgba, (int(bw*scale), int(bh*scale)))

                # Encode as PNG to preserve transparency
                _, buffer_png = cv2.imencode('.png', body_img_rgba)
                body_no_bg = f"data:image/png;base64,{base64.b64encode(buffer_png).decode('utf-8')}"
                print("   Body crop created")

            # Also create body with background (for display)
            body_img = crop_to_box(img, body_box)
            if body_img.size > 0:
                bh, bw = body_img.shape[:2]
                if bw > 600 or bh > 800:
                    scale = min(600/bw, 800/bh)
                    body_img = cv2.resize(body_img, (int(bw*scale), int(bh*scale)))
                _, buffer = cv2.imencode('.jpg', body_img, [cv2.IMWRITE_JPEG_QUALITY, 85])
                body_crop = f"data:image/jpeg;base64,{base64.b64encode(buffer).decode('utf-8')}"

        # Clean up temp files
        if os.path.exists(temp_input) and is_base64:
            os.remove(temp_input)

        print("✅ Photo processing complete")

        return {
            "success": True,
            "attributes": {
                # Age/gender now come from Gemini, not Python
                "age": None,
                "gender": None,
                "height": None,
                "build": None
            },
            "face_box": face_box,
            "body_box": body_box,
            "face_thumbnail": face_thumbnail,
            "body_crop": body_crop,
            "body_no_bg": body_no_bg,
            "image_dimensions": {
                "width": img_w,
                "height": img_h
            }
        }

    except Exception as e:
        # Clean up on error
        if os.path.exists(temp_input) and is_base64:
            os.remove(temp_input)

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
    Analyze uploaded photo - returns face thumbnail and body with background removed.
    Age/gender analysis is done by Gemini on the server side.

    Expected JSON:
    {
        "image": "data:image/jpeg;base64,..." or base64 string
    }

    Returns:
    {
        "success": true,
        "face_thumbnail": "data:image/jpeg;base64,...",
        "body_no_bg": "data:image/png;base64,...",
        "face_box": {...},
        "body_box": {...}
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
    """Test endpoint to verify dependencies are working"""
    try:
        import cv2
        import mediapipe
        return jsonify({
            "success": True,
            "mediapipe_version": mediapipe.__version__,
            "opencv_installed": True,
            "note": "DeepFace removed - age/gender from Gemini"
        })
    except Exception as e:
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500


if __name__ == '__main__':
    port = int(os.environ.get('PHOTO_ANALYZER_PORT', 5000))
    print(f"🔍 Photo Analyzer API starting on port {port}")
    print("   Using MediaPipe for face detection and background removal")
    print("   No heavy model downloads required!")
    app.run(host='0.0.0.0', port=port, debug=False)
