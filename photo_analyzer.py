#!/usr/bin/env python3
"""
Photo Analyzer API - Face Detection and Attribute Extraction
Uses MediaPipe for face/body detection, DeepFace for age/gender
"""

from flask import Flask, request, jsonify, send_file
from flask_cors import CORS
from deepface import DeepFace
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

# Initialize MediaPipe
mp_face_detection = mp.solutions.face_detection
mp_pose = mp.solutions.pose
mp_selfie_segmentation = mp.solutions.selfie_segmentation

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


def detect_face_mediapipe(image):
    """
    Detect face using MediaPipe Face Detection
    Returns bounding box as percentage of image dimensions (0-100)
    """
    h, w = image.shape[:2]

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


def detect_body_mediapipe(image):
    """
    Detect body using MediaPipe Pose
    Returns bounding box as percentage of image dimensions (0-100)
    Uses pose landmarks to calculate body bounds
    """
    h, w = image.shape[:2]

    with mp_pose.Pose(
        static_image_mode=True,
        model_complexity=1,
        min_detection_confidence=0.5
    ) as pose:
        # Convert BGR to RGB
        rgb_image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        results = pose.process(rgb_image)

        if results.pose_landmarks:
            landmarks = results.pose_landmarks.landmark

            # Get all visible landmark coordinates
            x_coords = []
            y_coords = []

            for landmark in landmarks:
                if landmark.visibility > 0.5:  # Only use visible landmarks
                    x_coords.append(landmark.x)
                    y_coords.append(landmark.y)

            if x_coords and y_coords:
                # Calculate bounding box from landmarks
                x_min = min(x_coords)
                x_max = max(x_coords)
                y_min = min(y_coords)
                y_max = max(y_coords)

                # Add generous padding (30% of body size) to avoid cutting off limbs/clothing
                # Background removal will handle the extra space
                padding_x = (x_max - x_min) * 0.3
                padding_y = (y_max - y_min) * 0.3

                x_min = max(0, x_min - padding_x)
                x_max = min(1, x_max + padding_x)
                y_min = max(0, y_min - padding_y)
                y_max = min(1, y_max + padding_y)

                # Convert to percentage (0-100)
                return {
                    'x': x_min * 100,
                    'y': y_min * 100,
                    'width': (x_max - x_min) * 100,
                    'height': (y_max - y_min) * 100
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

    Args:
        mask: Binary mask (0 = background, 255 = person)
        padding_percent: Extra padding around the detected bounds (0.05 = 5%)

    Returns:
        dict with x, y, width, height in percentage (0-100) or None if no person found
    """
    h, w = mask.shape[:2]

    # Find non-zero pixels (the person)
    non_zero = cv2.findNonZero(mask)

    if non_zero is None:
        return None

    # Get bounding rectangle
    x, y, bw, bh = cv2.boundingRect(non_zero)

    # Add small padding (the mask already follows body contour, so minimal padding needed)
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
    Process uploaded photo using BACKGROUND-FIRST approach:
    1. Remove background first (get accurate body mask)
    2. Find body bounds from mask (more accurate than pose landmarks)
    3. Detect face with MediaPipe
    4. Extract age/gender with DeepFace

    Args:
        image_data: Base64 encoded image or file path
        is_base64: Whether image_data is base64 encoded

    Returns:
        dict with success status, attributes, bounding boxes, and cropped images
    """
    temp_input = os.path.join(TEMP_DIR, f'input_{os.getpid()}.jpg')

    try:
        # 1. DECODE AND SAVE IMAGE
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

        # 2. REMOVE BACKGROUND FIRST (this gives us accurate body segmentation)
        print("🎭 Step 1: Removing background from full image...")
        full_img_rgba = None
        body_mask = None
        try:
            full_img_rgba, body_mask = remove_background(img)
            print("✅ Background removed successfully")
        except Exception as bg_error:
            print(f"⚠️ Background removal failed: {bg_error}")

        # 3. GET BODY BOUNDS FROM MASK (more accurate than pose landmarks)
        body_box = None
        if body_mask is not None:
            body_box = get_body_bounds_from_mask(body_mask, padding_percent=0.05)
            print(f"📦 Body bounds from mask: {body_box}")

        # Fallback to pose detection if mask-based detection failed
        if body_box is None:
            print("⚠️ Mask-based body detection failed, falling back to pose landmarks...")
            body_box = detect_body_mediapipe(img)
            print(f"📦 MediaPipe pose body detection: {body_box}")

        # 4. DETECT FACE WITH MEDIAPIPE
        face_box = detect_face_mediapipe(img)
        print(f"📦 MediaPipe face detection: {face_box}")

        # 5. GET AGE/GENDER WITH DEEPFACE
        age = None
        gender = None
        try:
            results = DeepFace.analyze(
                img_path=temp_input,
                actions=['age', 'gender'],
                detector_backend='skip',  # Skip detection, we already have face box
                enforce_detection=False
            )
            first_face = results[0] if results else None
            if first_face:
                age = int(first_face['age'])
                gender_raw = first_face['dominant_gender']
                gender = 'male' if gender_raw.lower() in ['man', 'male'] else 'female'
        except Exception as df_error:
            print(f"⚠️ DeepFace analysis failed: {df_error}")

        # Estimate height and build if we have age/gender
        height, build = (None, None)
        if age and gender:
            height, build = estimate_height_build(age, gender)

        # 6. CREATE CROPPED IMAGES
        face_thumbnail = None
        body_crop = None
        body_no_bg = None

        # Face thumbnail (from original image)
        if face_box:
            # Create face thumbnail with extra padding (50% on each side for more context)
            padded_face_box = add_padding_to_box(face_box, padding_percent=0.5)
            face_img = crop_to_box(img, padded_face_box)
            if face_img.size > 0:
                # Make it square by padding the shorter side
                size = max(face_img.shape[0], face_img.shape[1])
                square = np.zeros((size, size, 3), dtype=np.uint8)
                y_off = (size - face_img.shape[0]) // 2
                x_off = (size - face_img.shape[1]) // 2
                square[y_off:y_off+face_img.shape[0], x_off:x_off+face_img.shape[1]] = face_img
                # Resize to 200x200 (larger for better quality)
                face_thumb = cv2.resize(square, (200, 200))
                _, buffer = cv2.imencode('.jpg', face_thumb, [cv2.IMWRITE_JPEG_QUALITY, 90])
                face_thumbnail = f"data:image/jpeg;base64,{base64.b64encode(buffer).decode('utf-8')}"

        # Body crop (with and without background)
        if body_box:
            # Create body crop WITH background (for display)
            body_img = crop_to_box(img, body_box)
            if body_img.size > 0:
                # Resize if too large (max 600x800)
                bh, bw = body_img.shape[:2]
                if bw > 600 or bh > 800:
                    scale = min(600/bw, 800/bh)
                    new_size = (int(bw*scale), int(bh*scale))
                    body_img = cv2.resize(body_img, new_size)

                # Encode body crop with background
                _, buffer = cv2.imencode('.jpg', body_img, [cv2.IMWRITE_JPEG_QUALITY, 85])
                body_crop = f"data:image/jpeg;base64,{base64.b64encode(buffer).decode('utf-8')}"

            # Create body crop WITHOUT background (from pre-segmented full image)
            if full_img_rgba is not None:
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
                    print("✅ Body crop with transparent background created")

            # Fallback: if we don't have pre-segmented image, segment the crop
            if body_no_bg is None and body_img is not None and body_img.size > 0:
                try:
                    print("🎭 Fallback: Removing background from body crop...")
                    body_rgba, _ = remove_background(body_img)
                    _, buffer_png = cv2.imencode('.png', body_rgba)
                    body_no_bg = f"data:image/png;base64,{base64.b64encode(buffer_png).decode('utf-8')}"
                    print("✅ Background removed from crop")
                except Exception as bg_error:
                    print(f"⚠️ Fallback background removal failed: {bg_error}")
                    body_no_bg = body_crop  # Use version with background

        # Clean up temp files
        if os.path.exists(temp_input) and is_base64:
            os.remove(temp_input)

        return {
            "success": True,
            "attributes": {
                "age": age,
                "gender": gender,
                "height": height,
                "build": build
            },
            "face_box": face_box,
            "body_box": body_box,
            "face_thumbnail": face_thumbnail,
            "body_crop": body_crop,
            "body_no_bg": body_no_bg,  # Body with transparent background for image generation
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
    """Test endpoint to verify all dependencies are working"""
    try:
        import deepface
        import cv2
        import mediapipe
        return jsonify({
            "success": True,
            "deepface_version": deepface.__version__,
            "mediapipe_version": mediapipe.__version__,
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
