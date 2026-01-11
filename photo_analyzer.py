#!/usr/bin/env python3
"""
Photo Analyzer API - Face Detection and Background Removal
Uses MediaPipe for fast face detection and background removal (no heavy AI models)
"""

# Disable MediaPipe GPU to avoid OpenGL/EGL errors on headless systems
import os
os.environ["MEDIAPIPE_DISABLE_GPU"] = "1"

from flask import Flask, request, jsonify
from flask_cors import CORS
import cv2
import numpy as np
import base64
from io import BytesIO
from PIL import Image
import traceback
import logging
import sys

# Fix Windows encoding issues - force UTF-8 for stdout/stderr
if sys.platform == 'win32':
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

# Suppress Flask development server warning
cli = sys.modules.get('flask.cli')
if cli:
    cli.show_server_banner = lambda *args: None
logging.getLogger('werkzeug').setLevel(logging.ERROR)

app = Flask(__name__)
CORS(app)

# Try to initialize MediaPipe (may fail on newer Python versions)
mp_face_detection = None
mp_selfie_segmentation = None
MEDIAPIPE_AVAILABLE = False
MEDIAPIPE_TASKS_AVAILABLE = False
mp_tasks_face_detector = None

try:
    import mediapipe as mp
    # Check if legacy solutions API is available
    if hasattr(mp, 'solutions'):
        mp_face_detection = mp.solutions.face_detection
        mp_selfie_segmentation = mp.solutions.selfie_segmentation
        MEDIAPIPE_AVAILABLE = True
        print("[OK] MediaPipe legacy API available")
    elif hasattr(mp, 'tasks'):
        # Try new Tasks API (Python 3.14+)
        from mediapipe.tasks import python as mp_python
        from mediapipe.tasks.python import vision as mp_vision

        # Download model if needed
        model_path = os.path.join(os.path.dirname(__file__), 'blaze_face_short_range.tflite')
        if not os.path.exists(model_path):
            print("[INFO] Downloading MediaPipe face detection model...")
            import urllib.request
            model_url = "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite"
            urllib.request.urlretrieve(model_url, model_path)
            print(f"[OK] Downloaded model to {model_path}")

        MEDIAPIPE_TASKS_AVAILABLE = True
        print("[OK] MediaPipe Tasks API available (Python 3.14+)")
    else:
        print("[WARN] MediaPipe installed but no usable API found")
except ImportError:
    print("[WARN] MediaPipe not installed - face detection disabled")

# Try to initialize RetinaFace (best accuracy)
RETINAFACE_AVAILABLE = False
try:
    from deepface import DeepFace
    RETINAFACE_AVAILABLE = True
    print("[OK] RetinaFace available (via deepface)")
except ImportError:
    print("[INFO] RetinaFace not available - using MediaPipe/OpenCV fallback")

# Create temp directory for processing
TEMP_DIR = os.path.join(os.path.dirname(__file__), 'temp_photos')
os.makedirs(TEMP_DIR, exist_ok=True)


def detect_all_faces_retinaface(image, min_confidence=0.5):
    """
    Detect ALL faces using RetinaFace (most accurate detector).
    Returns list of faces sorted by confidence (highest first).
    """
    if not RETINAFACE_AVAILABLE:
        return []

    try:
        # Save image temporarily (deepface needs file path or numpy array)
        img_h, img_w = image.shape[:2]

        # DeepFace expects RGB, OpenCV uses BGR
        rgb_image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)

        # Extract faces using RetinaFace
        faces_data = DeepFace.extract_faces(
            rgb_image,
            detector_backend='retinaface',
            enforce_detection=False,
            align=False
        )

        faces = []
        for idx, face in enumerate(faces_data):
            conf = face.get('confidence', 0)
            if conf < min_confidence:
                continue

            area = face.get('facial_area', {})
            x = area.get('x', 0)
            y = area.get('y', 0)
            w = area.get('w', 0)
            h = area.get('h', 0)

            faces.append({
                'id': idx,
                'x': (x / img_w) * 100,
                'y': (y / img_h) * 100,
                'width': (w / img_w) * 100,
                'height': (h / img_h) * 100,
                'confidence': conf
            })

        # Sort by confidence (highest first) and re-number
        faces.sort(key=lambda f: f['confidence'], reverse=True)
        for i, face in enumerate(faces):
            face['id'] = i

        print(f"[RETINAFACE] Detected {len(faces)} faces")
        return faces

    except Exception as e:
        print(f"[RETINAFACE] Error: {e}")
        return []


def detect_face_opencv(image):
    """
    Fallback face detection using OpenCV's Haar cascade.
    Used when MediaPipe is not available (e.g., Python 3.14+).
    Returns bounding box as percentage of image dimensions (0-100)
    """
    # Load the Haar cascade for face detection
    cascade_path = cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
    face_cascade = cv2.CascadeClassifier(cascade_path)

    # Convert to grayscale for detection
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

    # Detect faces
    faces = face_cascade.detectMultiScale(
        gray,
        scaleFactor=1.1,
        minNeighbors=5,
        minSize=(30, 30)
    )

    if len(faces) > 0:
        # Get the largest face (by area)
        largest = max(faces, key=lambda f: f[2] * f[3])
        x, y, w, h = largest
        img_h, img_w = image.shape[:2]

        return {
            'x': (x / img_w) * 100,
            'y': (y / img_h) * 100,
            'width': (w / img_w) * 100,
            'height': (h / img_h) * 100,
            'confidence': 0.8  # Haar cascade doesn't provide confidence
        }

    return None


def detect_face_mediapipe(image):
    """
    Detect face using MediaPipe Face Detection.
    Falls back to OpenCV Haar cascade if MediaPipe is unavailable.
    Returns bounding box as percentage of image dimensions (0-100)
    """
    if not MEDIAPIPE_AVAILABLE:
        # Fallback to OpenCV when MediaPipe is not available (Python 3.14+)
        return detect_face_opencv(image)

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


def detect_all_faces_opencv(image):
    """
    Fallback to detect all faces using OpenCV's Haar cascade.
    Returns list of faces sorted by size (largest first).
    More strict settings to reduce false positives.
    """
    cascade_path = cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
    face_cascade = cv2.CascadeClassifier(cascade_path)

    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    img_h, img_w = image.shape[:2]

    # Minimum face size: at least 4% of smaller image dimension (not too strict)
    min_face_size = int(min(img_w, img_h) * 0.04)
    min_face_size = max(min_face_size, 30)  # At least 30px (original OpenCV default)

    faces_detected = face_cascade.detectMultiScale(
        gray,
        scaleFactor=1.1,
        minNeighbors=5,  # Keep original to catch more faces
        minSize=(min_face_size, min_face_size)
    )

    faces = []

    for idx, (x, y, w, h) in enumerate(faces_detected):
        # Additional filter: face should be roughly square-ish (not too elongated)
        aspect_ratio = w / h if h > 0 else 0
        if aspect_ratio < 0.5 or aspect_ratio > 2.0:
            continue  # Skip non-face-shaped detections

        faces.append({
            'id': idx,
            'x': (x / img_w) * 100,
            'y': (y / img_h) * 100,
            'width': (w / img_w) * 100,
            'height': (h / img_h) * 100,
            'confidence': 0.5  # Lower confidence - OpenCV is less reliable than MediaPipe
        })

    # Sort by size (area) descending - larger faces first
    faces.sort(key=lambda f: f['width'] * f['height'], reverse=True)

    # Re-number IDs after filtering
    for i, face in enumerate(faces):
        face['id'] = i

    return faces


def detect_all_faces_mediapipe_tasks(image, min_confidence=0.15):
    """
    Detect ALL faces using MediaPipe Tasks API (Python 3.14+).
    Returns list of faces sorted by confidence (highest first).
    """
    from mediapipe.tasks import python as mp_python
    from mediapipe.tasks.python import vision as mp_vision

    model_path = os.path.join(os.path.dirname(__file__), 'blaze_face_short_range.tflite')

    # Create face detector
    base_options = mp_python.BaseOptions(model_asset_path=model_path)
    options = mp_vision.FaceDetectorOptions(
        base_options=base_options,
        min_detection_confidence=min_confidence
    )

    faces = []
    with mp_vision.FaceDetector.create_from_options(options) as detector:
        # Convert BGR to RGB
        rgb_image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)

        # Create MediaPipe Image
        import mediapipe as mp
        mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_image)

        # Detect faces
        detection_result = detector.detect(mp_image)

        img_h, img_w = image.shape[:2]

        for idx, detection in enumerate(detection_result.detections):
            bbox = detection.bounding_box
            confidence = detection.categories[0].score if detection.categories else 0.5

            face = {
                'id': idx,
                'x': (bbox.origin_x / img_w) * 100,
                'y': (bbox.origin_y / img_h) * 100,
                'width': (bbox.width / img_w) * 100,
                'height': (bbox.height / img_h) * 100,
                'confidence': confidence
            }
            faces.append(face)

    # Sort by confidence
    faces.sort(key=lambda f: f['confidence'], reverse=True)
    for i, face in enumerate(faces):
        face['id'] = i

    return faces


def detect_all_faces_mediapipe(image, min_confidence=0.15):
    """
    Detect ALL faces using MediaPipe Face Detection.
    Falls back to OpenCV Haar cascade if MediaPipe is unavailable.
    Returns list of faces sorted by confidence (highest first).
    Filters out faces below min_confidence threshold.

    Returns: list of {id, x, y, width, height, confidence}
    """
    # Try MediaPipe Tasks API first (Python 3.14+)
    if MEDIAPIPE_TASKS_AVAILABLE:
        # Tasks API has worse detection than legacy - use lower threshold initially
        faces = detect_all_faces_mediapipe_tasks(image, min_confidence=0.05)

        # Filter by the requested confidence threshold
        high_conf_faces = [f for f in faces if f['confidence'] >= min_confidence]

        # If we have few high-confidence faces, also try OpenCV
        # OpenCV often detects faces that Tasks API misses (especially in group photos)
        if len(high_conf_faces) < 2:
            opencv_faces = detect_all_faces_opencv(image)
            if len(opencv_faces) > len(high_conf_faces):
                print(f"[FACE] Tasks API found {len(high_conf_faces)} (>={min_confidence}), OpenCV found {len(opencv_faces)} - using OpenCV")
                faces = opencv_faces
            else:
                faces = high_conf_faces
        else:
            faces = high_conf_faces

        # Re-sort and re-number
        faces.sort(key=lambda f: f['confidence'], reverse=True)
        for i, face in enumerate(faces):
            face['id'] = i

        return faces

    if not MEDIAPIPE_AVAILABLE:
        # Fallback to OpenCV when MediaPipe is not available
        return detect_all_faces_opencv(image)

    faces = []
    rgb_image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)

    # Try BOTH model types and combine results for better detection
    # model_selection=0: close faces (within 2m), model_selection=1: far faces (up to 5m)
    for model_type in [0, 1]:
        with mp_face_detection.FaceDetection(
            model_selection=model_type,
            min_detection_confidence=0.1  # Very low - we filter ourselves at 0.15
        ) as face_detection:
            results = face_detection.process(rgb_image)

            if results.detections:
                for idx, detection in enumerate(results.detections):
                    confidence = detection.score[0]

                    # Filter by our threshold
                    if confidence < min_confidence:
                        continue

                    bbox = detection.location_data.relative_bounding_box
                    face = {
                        'id': len(faces),
                        'x': bbox.xmin * 100,
                        'y': bbox.ymin * 100,
                        'width': bbox.width * 100,
                        'height': bbox.height * 100,
                        'confidence': confidence
                    }

                    # Check if this face overlaps with existing faces (avoid duplicates)
                    is_duplicate = False
                    for existing in faces:
                        # Check if centers are close (within 10% of image)
                        center_x = face['x'] + face['width'] / 2
                        center_y = face['y'] + face['height'] / 2
                        existing_cx = existing['x'] + existing['width'] / 2
                        existing_cy = existing['y'] + existing['height'] / 2
                        if abs(center_x - existing_cx) < 10 and abs(center_y - existing_cy) < 10:
                            # Keep the higher confidence one
                            if face['confidence'] > existing['confidence']:
                                existing.update(face)
                            is_duplicate = True
                            break

                    if not is_duplicate:
                        faces.append(face)

    # Sort by confidence and re-number
    faces.sort(key=lambda f: f['confidence'], reverse=True)
    for i, face in enumerate(faces):
        face['id'] = i

    # If legacy MediaPipe found few faces, also try OpenCV as backup
    # OpenCV sometimes detects faces that MediaPipe misses (especially in group photos)
    if len(faces) < 2:
        opencv_faces = detect_all_faces_opencv(image)
        if len(opencv_faces) > len(faces):
            print(f"[FACE] Legacy MediaPipe found {len(faces)}, OpenCV found {len(opencv_faces)} - using OpenCV")
            return opencv_faces

    return faces


def create_face_thumbnail(image, face_box, size=200):
    """
    Create a square thumbnail for a detected face.
    Uses 30% padding around face, centers in square.

    Args:
        image: BGR or BGRA image (numpy array)
        face_box: dict with x, y, width, height (percentages 0-100)
        size: output thumbnail size (default 200x200)

    Returns: base64-encoded JPEG string
    """
    # Add 30% padding around face (increased from 15% to show full head)
    face_box_padded = add_padding_to_box(face_box, padding_percent=0.30)
    face_img = crop_to_box(image, face_box_padded)

    if face_img.size == 0:
        return None

    # Make it square with warm peach background
    h, w = face_img.shape[:2]
    max_dim = max(h, w)

    # Create square canvas
    if len(face_img.shape) == 3 and face_img.shape[2] == 4:
        # BGRA image - composite with peach background
        square = np.full((max_dim, max_dim, 4), [230, 240, 255, 255], dtype=np.uint8)
        y_off = (max_dim - h) // 2
        x_off = (max_dim - w) // 2

        face_region = square[y_off:y_off+h, x_off:x_off+w]
        alpha = face_img[:, :, 3:4] / 255.0
        face_region[:, :, :3] = (face_img[:, :, :3] * alpha + face_region[:, :, :3] * (1 - alpha)).astype(np.uint8)
        face_region[:, :, 3] = 255

        # Convert to BGR for encoding
        square_bgr = cv2.cvtColor(square, cv2.COLOR_BGRA2BGR)
    else:
        # BGR image - just place on background
        square_bgr = np.full((max_dim, max_dim, 3), [230, 240, 255], dtype=np.uint8)
        y_off = (max_dim - h) // 2
        x_off = (max_dim - w) // 2
        square_bgr[y_off:y_off+h, x_off:x_off+w] = face_img[:, :, :3] if len(face_img.shape) == 3 else cv2.cvtColor(face_img, cv2.COLOR_GRAY2BGR)

    # Resize to target size
    thumbnail = cv2.resize(square_bgr, (size, size), interpolation=cv2.INTER_LANCZOS4)

    # Encode as JPEG
    _, buffer = cv2.imencode('.jpg', thumbnail, [cv2.IMWRITE_JPEG_QUALITY, 90])
    return f"data:image/jpeg;base64,{base64.b64encode(buffer).decode('utf-8')}"


def remove_faces_except(image, keep_face_id, all_faces):
    """
    Remove all faces AND bodies EXCEPT the selected one by making them transparent.
    Uses midpoint approach: calculates midpoint between selected face and each other face,
    removes everything on "their side" of the midpoint (below their face level).

    Args:
        image: BGRA numpy array (must have alpha channel)
        keep_face_id: ID of face to keep (0-indexed)
        all_faces: list of face dicts with x, y, width, height (percentages 0-100)

    Returns: image with non-selected faces and bodies made transparent
    """
    if not all_faces or len(all_faces) <= 1:
        return image

    result = image.copy()
    h, w = image.shape[:2]

    # Ensure image has alpha channel
    if len(result.shape) == 2 or result.shape[2] == 3:
        # Convert BGR to BGRA
        result = cv2.cvtColor(result, cv2.COLOR_BGR2BGRA)

    # Find the selected face
    selected_face = None
    for face in all_faces:
        if face['id'] == keep_face_id:
            selected_face = face
            break

    if selected_face is None:
        return result

    # Calculate selected face center (in pixels)
    selected_center_x = int((selected_face['x'] + selected_face['width'] / 2) / 100 * w)

    for face in all_faces:
        if face['id'] == keep_face_id:
            continue  # Skip the selected face

        # Calculate other face center (in pixels)
        other_center_x = int((face['x'] + face['width'] / 2) / 100 * w)

        # Calculate midpoint X between selected and other face
        midpoint_x = (selected_center_x + other_center_x) // 2

        # Determine which side to remove (left or right of midpoint)
        remove_left = other_center_x < midpoint_x  # Other is to the left

        # Calculate face top position (for face removal - with padding above)
        face_padding = 0.3
        face_top = int(max(0, (face['y'] / 100 - face['height'] / 100 * face_padding)) * h)
        face_bottom = int(min(1.0, (face['y'] + face['height']) / 100 + face['height'] / 100 * face_padding) * h)

        # Face X boundaries (with padding)
        face_x1 = int(max(0, (face['x'] / 100 - face['width'] / 100 * face_padding)) * w)
        face_x2 = int(min(1.0, (face['x'] + face['width']) / 100 + face['width'] / 100 * face_padding) * w)

        # 1. Remove the face region - set to WHITE and transparent
        # (White RGB ensures AI models don't "see through" transparency to original data)
        if face_x2 > face_x1 and face_bottom > face_top:
            result[face_top:face_bottom, face_x1:face_x2, 0:3] = 255  # BGR = white
            result[face_top:face_bottom, face_x1:face_x2, 3] = 0      # Alpha = transparent
            print(f"   Removed face {face['id']} at ({face_x1},{face_top})-({face_x2},{face_bottom})")

        # 2. Remove body region: from face bottom to image bottom, on "their side" of midpoint
        body_top = face_bottom  # Start from where face ends
        if remove_left:
            # Other person is to the left - remove from left edge to midpoint
            result[body_top:h, 0:midpoint_x, 0:3] = 255  # BGR = white
            result[body_top:h, 0:midpoint_x, 3] = 0       # Alpha = transparent
            print(f"   Removed body {face['id']}: left side (0 to {midpoint_x}) below y={body_top}")
        else:
            # Other person is to the right - remove from midpoint to right edge
            result[body_top:h, midpoint_x:w, 0:3] = 255  # BGR = white
            result[body_top:h, midpoint_x:w, 3] = 0       # Alpha = transparent
            print(f"   Removed body {face['id']}: right side ({midpoint_x} to {w}) below y={body_top}")

    return result


def remove_background(image):
    """
    Remove background from image using MediaPipe Selfie Segmentation.
    Returns tuple: (image with transparent background (RGBA), binary mask)
    """
    if not MEDIAPIPE_AVAILABLE:
        return None, None

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

        # Set RGB to white where background is removed (alpha < 128)
        # This ensures AI models don't "see through" transparency to original data
        bg_mask = binary_mask < 128
        bgra[bg_mask, 0:3] = 255  # BGR = white

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


def process_photo(image_data, is_base64=True, selected_face_id=None):
    """
    Process uploaded photo - FAST version with multi-face support:

    Two modes:
    1. Initial analysis (selected_face_id=None):
       - Detect ALL faces
       - If multiple valid faces (>=35% confidence), return thumbnails for selection
       - If single face, process normally

    2. After selection (selected_face_id=N):
       - Use the selected face
       - Blur non-selected faces in body crop

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
        print(f"[PHOTO] Processing image: {img_w}x{img_h}")

        # 2. DETECT FACES - scale while maintaining aspect ratio
        # IMPORTANT: Never distort the image - faces become undetectable when squished
        print("[FACE] Detecting faces...")

        aspect_ratio = img_h / img_w
        detection_img = img

        # Scale to max dimension 1200px while maintaining aspect ratio
        max_dim = max(img_w, img_h)
        if max_dim > 1200:
            scale = 1200 / max_dim
            new_w = int(img_w * scale)
            new_h = int(img_h * scale)
            detection_img = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA)
            print(f"[FACE] Scaled {img_w}x{img_h} -> {new_w}x{new_h} (aspect preserved: {aspect_ratio:.2f})")
        else:
            print(f"[FACE] Using original size {img_w}x{img_h} (aspect: {aspect_ratio:.2f})")

        # DEBUG: Save detection image to see what MediaPipe analyzes
        debug_path = os.path.join(TEMP_DIR, 'debug_detection_input.jpg')
        cv2.imwrite(debug_path, detection_img)
        print(f"[DEBUG] Saved detection input to: {debug_path}")

        all_faces = detect_all_faces_mediapipe(detection_img, min_confidence=0.15)

        # Filter out tiny faces (likely false positives - hair tips, noise)
        # Real faces should be at least 3% of image width/height
        all_faces = [f for f in all_faces if f['width'] >= 3.0 and f['height'] >= 3.0]

        # DEBUG: Draw detected faces on image and save
        if len(all_faces) > 0:
            debug_img = detection_img.copy()
            det_h, det_w = debug_img.shape[:2]
            for f in all_faces:
                x1 = int(f['x'] * det_w / 100)
                y1 = int(f['y'] * det_h / 100)
                x2 = int((f['x'] + f['width']) * det_w / 100)
                y2 = int((f['y'] + f['height']) * det_h / 100)
                cv2.rectangle(debug_img, (x1, y1), (x2, y2), (0, 255, 0), 2)
                cv2.putText(debug_img, f"{f['confidence']*100:.0f}%", (x1, y1-5), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 1)
            debug_result_path = os.path.join(TEMP_DIR, 'debug_detection_result.jpg')
            cv2.imwrite(debug_result_path, debug_img)
            print(f"[DEBUG] Saved detection result to: {debug_result_path}")

        # Note: coordinates are percentages, so they map correctly to original image
        # Log each face with confidence AND position
        if len(all_faces) > 0:
            for f in all_faces:
                print(f"   Face {f['id']+1}: {f['confidence']*100:.0f}% at x={f['x']:.1f}%, y={f['y']:.1f}%, w={f['width']:.1f}%, h={f['height']:.1f}%")
            face_scores = ", ".join([f"face {f['id']+1}: {f['confidence']*100:.0f}%" for f in all_faces])
            print(f"   Faces detected: {len(all_faces)} ({face_scores})")
        else:
            print(f"   Faces detected: 0")

        # If no face detected, return error immediately
        if len(all_faces) == 0:
            print("[ERROR] No face detected in photo")
            # Clean up temp files
            if os.path.exists(temp_input) and is_base64:
                os.remove(temp_input)
            return {
                "success": False,
                "error": "no_face_detected",
                "error_message": "No face was detected in the photo. Please upload a clear photo showing your face."
            }

        # 3. MULTI-FACE HANDLING
        # If multiple faces and no selection made yet, return face thumbnails for selection
        if len(all_faces) > 1 and selected_face_id is None:
            print(f"[MULTI] Multiple faces detected ({len(all_faces)}), returning thumbnails for selection")

            # Create thumbnails for each face (using original image for speed)
            face_thumbnails = []
            for face in all_faces:
                thumbnail = create_face_thumbnail(img, face, size=200)
                if thumbnail:
                    face_thumbnails.append({
                        'id': face['id'],
                        'confidence': round(face['confidence'], 2),
                        'face_box': {
                            'x': face['x'],
                            'y': face['y'],
                            'width': face['width'],
                            'height': face['height']
                        },
                        'thumbnail': thumbnail
                    })

            # Clean up temp files
            if os.path.exists(temp_input) and is_base64:
                os.remove(temp_input)

            return {
                "success": True,
                "multiple_faces_detected": True,
                "face_count": len(all_faces),
                "faces": face_thumbnails,
                # These are null until face is selected
                "face_thumbnail": None,
                "body_no_bg": None,
                "body_crop": None,
                "face_box": None,
                "body_box": None,
                "image_dimensions": {
                    "width": img_w,
                    "height": img_h
                }
            }

        # 4. SINGLE FACE OR FACE SELECTED - continue with normal processing
        # Determine which face to use
        if selected_face_id is not None and selected_face_id < len(all_faces):
            face_box = all_faces[selected_face_id]
            print(f"   Using face {selected_face_id + 1} (selected, {face_box['confidence']*100:.0f}%)")
        else:
            face_box = all_faces[0]  # Use highest confidence face
            print(f"   Using face 1 ({face_box['confidence']*100:.0f}%)")

        # 5. REMOVE BACKGROUND (fast - ~100ms)
        print("[BG] Removing background...")
        full_img_rgba = None
        body_mask = None
        try:
            full_img_rgba, body_mask = remove_background(img)
            print("   Background removed")
        except Exception as bg_error:
            print(f"   Background removal failed: {bg_error}")

        # 6. REMOVE NON-SELECTED FACES (if multiple faces and one was selected)
        # Make them transparent so AI can't use them for avatar generation
        if len(all_faces) > 1 and selected_face_id is not None:
            print(f"[REMOVE] Removing {len(all_faces) - 1} non-selected faces...")
            if full_img_rgba is not None:
                full_img_rgba = remove_faces_except(full_img_rgba, selected_face_id, all_faces)

        # 7. GET BODY BOUNDS
        # For multi-face: use alpha channel (only selected person is visible after remove_faces_except)
        # For single-face: use the segmentation mask
        body_box = None
        if len(all_faces) > 1 and selected_face_id is not None and full_img_rgba is not None:
            # Multi-face: use alpha channel to find bounds of selected person
            alpha_mask = full_img_rgba[:, :, 3]
            body_box = get_body_bounds_from_mask(alpha_mask, padding_percent=0.05)
            if body_box:
                print(f"   Body box from alpha mask: x={body_box['x']:.1f}%, y={body_box['y']:.1f}%, w={body_box['width']:.1f}%, h={body_box['height']:.1f}%")
        elif len(all_faces) == 1 and body_mask is not None:
            # Single person - use segmentation mask bounds
            body_box = get_body_bounds_from_mask(body_mask, padding_percent=0.05)

        # 8. CREATE OUTPUTS
        face_thumbnail = None
        body_no_bg = None
        body_crop = None

        # Face thumbnail with background removed (768x768 for avatar generation)
        if face_box and full_img_rgba is not None:
            # Add 30% padding around face (increased from 15% to show full head)
            face_box_padded = add_padding_to_box(face_box, padding_percent=0.30)
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

                # Resize to 768x768 (high quality for avatar generation)
                face_thumb = cv2.resize(square, (768, 768), interpolation=cv2.INTER_LANCZOS4)
                face_thumb_bgr = cv2.cvtColor(face_thumb, cv2.COLOR_BGRA2BGR)
                _, buffer = cv2.imencode('.jpg', face_thumb_bgr, [cv2.IMWRITE_JPEG_QUALITY, 95])
                face_thumbnail = f"data:image/jpeg;base64,{base64.b64encode(buffer).decode('utf-8')}"
                print("   Face thumbnail created (768x768)")

        # Max dimensions for body images (efficient for avatar generation)
        max_w, max_h = 512, 768

        # Body with transparent background
        if full_img_rgba is not None:
            # Crop to body_box (calculated from alpha mask for multi-face, or segmentation mask for single-face)
            if body_box:
                body_img_rgba = crop_to_box(full_img_rgba, body_box)
                print(f"   Cropped body_no_bg to bounds")
            else:
                body_img_rgba = full_img_rgba.copy()
                print(f"   Using full image for body_no_bg (no body_box)")

            if body_img_rgba.size > 0:
                bh, bw = body_img_rgba.shape[:2]
                if bw > max_w or bh > max_h:
                    scale = min(max_w/bw, max_h/bh)
                    new_w, new_h = int(bw*scale), int(bh*scale)
                    body_img_rgba = cv2.resize(body_img_rgba, (new_w, new_h), interpolation=cv2.INTER_AREA)
                    print(f"   Resized body_no_bg from {bw}x{bh} to {new_w}x{new_h}")

                # Encode as PNG with max compression (level 9) to preserve transparency
                _, buffer_png = cv2.imencode('.png', body_img_rgba, [cv2.IMWRITE_PNG_COMPRESSION, 9])
                body_no_bg = f"data:image/png;base64,{base64.b64encode(buffer_png).decode('utf-8')}"
                print(f"   Body no-bg created: {len(buffer_png)//1024}KB")

        # Also create body with background (for display)
        if body_box and img is not None:
            body_img = crop_to_box(img, body_box)
            if body_img.size > 0:
                bh, bw = body_img.shape[:2]
                if bw > max_w or bh > max_h:
                    scale = min(max_w/bw, max_h/bh)
                    body_img = cv2.resize(body_img, (int(bw*scale), int(bh*scale)), interpolation=cv2.INTER_AREA)
                _, buffer = cv2.imencode('.jpg', body_img, [cv2.IMWRITE_JPEG_QUALITY, 85])
                body_crop = f"data:image/jpeg;base64,{base64.b64encode(buffer).decode('utf-8')}"

        # Clean up temp files
        if os.path.exists(temp_input) and is_base64:
            os.remove(temp_input)

        print("[OK] Photo processing complete")

        return {
            "success": True,
            "multiple_faces_detected": False,
            "face_count": len(all_faces),
            "selected_face_id": selected_face_id,
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
    # Check LPIPS availability
    lpips_available = False
    try:
        import lpips
        lpips_available = True
    except ImportError:
        pass
    return jsonify({
        "status": "ok",
        "service": "photo-analyzer",
        "mediapipe_available": MEDIAPIPE_AVAILABLE,
        "lpips_available": lpips_available
    })


@app.route('/analyze', methods=['POST'])
def analyze_photo():
    """
    Analyze uploaded photo - returns face thumbnail and body with background removed.
    Supports multi-face detection and selection.

    Expected JSON:
    {
        "image": "data:image/jpeg;base64,..." or base64 string,
        "selected_face_id": null (for initial) or 0/1/2... (after selection)
    }

    Returns (if multiple faces and no selection):
    {
        "success": true,
        "multiple_faces_detected": true,
        "faces": [
            {"id": 0, "confidence": 0.95, "face_box": {...}, "thumbnail": "data:..."},
            {"id": 1, "confidence": 0.72, "face_box": {...}, "thumbnail": "data:..."}
        ]
    }

    Returns (single face or after selection):
    {
        "success": true,
        "multiple_faces_detected": false,
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
        selected_face_id = data.get('selected_face_id')  # None for initial, int after selection

        result = process_photo(image_data, is_base64=True, selected_face_id=selected_face_id)

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
        lpips_available = False
        try:
            import lpips
            lpips_available = True
        except ImportError:
            pass
        return jsonify({
            "success": True,
            "mediapipe_version": mediapipe.__version__,
            "opencv_installed": True,
            "lpips_available": lpips_available,
            "note": "DeepFace removed - age/gender from Gemini"
        })
    except Exception as e:
        return jsonify({
            "success": False,
            "error": str(e)
        }), 500


# LPIPS model (lazy loaded)
_lpips_model = None

def get_lpips_model():
    """Lazy load LPIPS model to avoid startup delay"""
    global _lpips_model
    if _lpips_model is None:
        try:
            import lpips
            print("[LPIPS] Loading LPIPS model (AlexNet)...")
            _lpips_model = lpips.LPIPS(net='alex')
            print("   LPIPS model loaded")
        except ImportError:
            print("[WARN] LPIPS not available - install with: pip install lpips")
            return None
    return _lpips_model


def decode_image_to_tensor(image_data):
    """Decode base64 image to normalized tensor for LPIPS"""
    import torch

    # Remove data URL prefix if present
    if ',' in image_data:
        image_data = image_data.split(',')[1]

    # Decode base64
    image_bytes = base64.b64decode(image_data)
    img_pil = Image.open(BytesIO(image_bytes)).convert('RGB')

    # Convert to numpy, then to tensor
    img_np = np.array(img_pil).astype(np.float32) / 255.0

    # Normalize to [-1, 1] range (LPIPS requirement)
    img_np = img_np * 2 - 1

    # Convert to tensor: [H, W, C] -> [1, C, H, W]
    img_tensor = torch.from_numpy(img_np).permute(2, 0, 1).unsqueeze(0)

    return img_tensor, img_pil.size


def crop_tensor_to_bbox(img_tensor, bbox, img_size):
    """
    Crop tensor to bounding box region
    bbox: [ymin, xmin, ymax, xmax] normalized 0.0-1.0
    img_size: (width, height)
    """
    import torch

    width, height = img_size
    ymin, xmin, ymax, xmax = bbox

    # Convert normalized coords to pixels
    y1 = int(ymin * height)
    x1 = int(xmin * width)
    y2 = int(ymax * height)
    x2 = int(xmax * width)

    # Ensure valid bounds
    y1 = max(0, y1)
    x1 = max(0, x1)
    y2 = min(height, y2)
    x2 = min(width, x2)

    # Crop: tensor is [1, C, H, W]
    cropped = img_tensor[:, :, y1:y2, x1:x2]

    # Ensure we have a valid crop (at least 1x1)
    if cropped.shape[2] == 0 or cropped.shape[3] == 0:
        print(f"[LPIPS] Warning: crop resulted in empty tensor, using original")
        return img_tensor

    return cropped


@app.route('/lpips', methods=['POST'])
def compare_lpips():
    """
    Compare two images using LPIPS perceptual similarity.

    Expected JSON:
    {
        "image1": "data:image/jpeg;base64,...",  # Original/reference image (face photo)
        "image2": "data:image/jpeg;base64,...",  # Generated/modified image (e.g., 2x2 grid)
        "bbox": [ymin, xmin, ymax, xmax],        # Optional: crop image2 to this region (0.0-1.0)
        "resize_to": 256                          # Optional: resize for faster comparison
    }

    Note: bbox only applies to image2. This is useful when comparing a face photo (image1)
    against a 2x2 grid avatar (image2) - use bbox=[0,0,0.5,0.5] to compare against top-left face.

    Returns:
    {
        "success": true,
        "lpips_score": 0.123,      # 0 = identical, 1 = very different
        "interpretation": "very_similar",
        "region": "full" or "cropped"
    }
    """
    try:
        model = get_lpips_model()
        if model is None:
            return jsonify({
                "success": False,
                "error": "LPIPS not available. Install with: pip install lpips torch torchvision"
            }), 503

        import torch

        data = request.get_json()
        if not data or 'image1' not in data or 'image2' not in data:
            return jsonify({
                "success": False,
                "error": "Missing 'image1' or 'image2' in request"
            }), 400

        # Decode images
        img1_tensor, img1_size = decode_image_to_tensor(data['image1'])
        img2_tensor, img2_size = decode_image_to_tensor(data['image2'])

        region = "full"

        # Optional: crop to bounding box
        # bbox: crops only image2 (for comparing face photo vs 2x2 grid)
        # bbox_both: crops both images (for comparing two 2x2 grids against each other)
        bbox = data.get('bbox')
        bbox_both = data.get('bbox_both')

        if bbox_both and len(bbox_both) == 4:
            # Crop BOTH images to the same region (e.g., compare faces from two 2x2 grids)
            img1_tensor = crop_tensor_to_bbox(img1_tensor, bbox_both, img1_size)
            img2_tensor = crop_tensor_to_bbox(img2_tensor, bbox_both, img2_size)
            region = "cropped_both"
        elif bbox and len(bbox) == 4:
            # Crop only image2 (for comparing face photo vs 2x2 grid)
            img2_tensor = crop_tensor_to_bbox(img2_tensor, bbox, img2_size)
            region = "cropped_img2"

        # Optional: resize for faster comparison
        resize_to = data.get('resize_to')
        if resize_to:
            import torch.nn.functional as F
            img1_tensor = F.interpolate(img1_tensor, size=(resize_to, resize_to), mode='bilinear', align_corners=False)
            img2_tensor = F.interpolate(img2_tensor, size=(resize_to, resize_to), mode='bilinear', align_corners=False)

        # Ensure same size (resize img2 to match img1 if needed)
        if img1_tensor.shape != img2_tensor.shape:
            import torch.nn.functional as F
            img2_tensor = F.interpolate(img2_tensor, size=img1_tensor.shape[2:], mode='bilinear', align_corners=False)

        # DEBUG: Save images being compared
        try:
            from torchvision.utils import save_image
            save_image(img1_tensor * 0.5 + 0.5, 'test-results/lpips_debug_img1.png')
            save_image(img2_tensor * 0.5 + 0.5, 'test-results/lpips_debug_img2.png')
            print(f"[LPIPS DEBUG] Saved comparison images to test-results/lpips_debug_img1.png and img2.png")
            print(f"[LPIPS DEBUG] img1 shape: {img1_tensor.shape}, img2 shape: {img2_tensor.shape}")
        except Exception as e:
            print(f"[LPIPS DEBUG] Failed to save debug images: {e}")

        # Compute LPIPS
        with torch.no_grad():
            lpips_score = model(img1_tensor, img2_tensor).item()

        # Interpret score
        if lpips_score < 0.05:
            interpretation = "nearly_identical"
        elif lpips_score < 0.15:
            interpretation = "very_similar"
        elif lpips_score < 0.30:
            interpretation = "somewhat_similar"
        else:
            interpretation = "different"

        return jsonify({
            "success": True,
            "lpips_score": round(lpips_score, 4),
            "interpretation": interpretation,
            "region": region,
            "image1_size": list(img1_size),
            "image2_size": list(img2_size)
        }), 200

    except Exception as e:
        return jsonify({
            "success": False,
            "error": str(e),
            "traceback": traceback.format_exc()
        }), 500


@app.route('/split-grid', methods=['POST'])
def split_grid():
    """
    Split a 2x2 grid image into 4 quadrants and extract face from top-left.

    Expected JSON:
    {
        "image": "data:image/jpeg;base64,..."  # 2x2 grid image from avatar generation
    }

    Returns:
    {
        "success": true,
        "quadrants": {
            "faceFront": "base64...",     # Top-left: face looking at camera
            "faceProfile": "base64...",   # Top-right: face 3/4 profile
            "bodyFront": "base64...",     # Bottom-left: full body front
            "bodyProfile": "base64..."    # Bottom-right: full body profile
        },
        "faceThumbnail": "base64..."      # Extracted face from faceFront
    }
    """
    try:
        data = request.get_json()
        if not data or 'image' not in data:
            return jsonify({
                "success": False,
                "error": "Missing 'image' in request body"
            }), 400

        # Decode base64 image
        image_data = data['image']
        if ',' in image_data:
            image_data = image_data.split(',')[1]

        image_bytes = base64.b64decode(image_data)
        nparr = np.frombuffer(image_bytes, np.uint8)
        image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

        if image is None:
            return jsonify({
                "success": False,
                "error": "Failed to decode image"
            }), 400

        height, width = image.shape[:2]
        print(f"[SPLIT-GRID] Input image size: {width}x{height}")

        # Split into 4 quadrants
        mid_h = height // 2
        mid_w = width // 2

        quadrants = {
            'faceFront': image[0:mid_h, 0:mid_w],           # Top-left
            'faceProfile': image[0:mid_h, mid_w:width],     # Top-right
            'bodyFront': image[mid_h:height, 0:mid_w],      # Bottom-left
            'bodyProfile': image[mid_h:height, mid_w:width] # Bottom-right
        }

        print(f"[SPLIT-GRID] Quadrant sizes: {mid_w}x{mid_h} each")

        # Encode each quadrant as base64 JPEG
        encoded_quadrants = {}
        for name, quad in quadrants.items():
            _, buffer = cv2.imencode('.jpg', quad, [cv2.IMWRITE_JPEG_QUALITY, 90])
            encoded_quadrants[name] = f"data:image/jpeg;base64,{base64.b64encode(buffer).decode('utf-8')}"
            print(f"[SPLIT-GRID] Encoded {name}: {len(encoded_quadrants[name])} bytes")

        # Extract face from top-left quadrant (faceFront)
        face_thumbnail = None
        face_front = quadrants['faceFront']

        # Try MediaPipe first, fall back to OpenCV
        face_box = detect_face_mediapipe(face_front)

        if face_box:
            print(f"[SPLIT-GRID] Face detected at: x={face_box['x']:.1f}%, y={face_box['y']:.1f}%, w={face_box['width']:.1f}%, h={face_box['height']:.1f}%")
            face_thumbnail = create_face_thumbnail(face_front, face_box, size=768)
        else:
            print("[SPLIT-GRID] No face detected in faceFront quadrant, using full quadrant as thumbnail")
            # If no face detected, use the whole faceFront quadrant resized to square
            h, w = face_front.shape[:2]
            max_dim = max(h, w)
            square = np.full((max_dim, max_dim, 3), [230, 240, 255], dtype=np.uint8)
            y_off = (max_dim - h) // 2
            x_off = (max_dim - w) // 2
            square[y_off:y_off+h, x_off:x_off+w] = face_front
            thumbnail = cv2.resize(square, (768, 768), interpolation=cv2.INTER_LANCZOS4)
            _, buffer = cv2.imencode('.jpg', thumbnail, [cv2.IMWRITE_JPEG_QUALITY, 90])
            face_thumbnail = f"data:image/jpeg;base64,{base64.b64encode(buffer).decode('utf-8')}"

        print(f"[SPLIT-GRID] Face thumbnail generated: {len(face_thumbnail) if face_thumbnail else 0} bytes")

        return jsonify({
            "success": True,
            "quadrants": encoded_quadrants,
            "faceThumbnail": face_thumbnail
        }), 200

    except Exception as e:
        print(f"[SPLIT-GRID] Error: {e}")
        return jsonify({
            "success": False,
            "error": str(e),
            "traceback": traceback.format_exc()
        }), 500


@app.route('/extract-face', methods=['POST'])
def extract_face():
    """
    Extract just the face from an image, optionally from a specific quadrant.
    This is useful for LPIPS comparison where we want to compare face-to-face only.

    Expected JSON:
    {
        "image": "data:image/jpeg;base64,...",
        "quadrant": "top-left" | "top-right" | "bottom-left" | "bottom-right" | null,
        "size": 256  # Output size (default 256x256)
    }

    If quadrant is specified, the image is assumed to be a 2x2 grid and will be
    cropped to that quadrant first before face extraction.

    Returns:
    {
        "success": true,
        "face": "data:image/jpeg;base64,...",  # Extracted face image
        "faceBbox": [ymin, xmin, ymax, xmax],  # Face location (normalized 0-1)
        "faceDetected": true                    # Whether a face was found
    }
    """
    try:
        data = request.get_json()
        if not data or 'image' not in data:
            return jsonify({
                "success": False,
                "error": "Missing 'image' in request body"
            }), 400

        # Decode base64 image
        image_data = data['image']
        if ',' in image_data:
            image_data = image_data.split(',')[1]

        image_bytes = base64.b64decode(image_data)
        nparr = np.frombuffer(image_bytes, np.uint8)
        image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

        if image is None:
            return jsonify({
                "success": False,
                "error": "Failed to decode image"
            }), 400

        height, width = image.shape[:2]
        quadrant = data.get('quadrant')
        output_size = data.get('size', 256)

        print(f"[EXTRACT-FACE] Input: {width}x{height}, quadrant: {quadrant}")

        # Crop to quadrant if specified
        if quadrant:
            mid_h = height // 2
            mid_w = width // 2
            quadrant_map = {
                'top-left': (0, mid_h, 0, mid_w),
                'top-right': (0, mid_h, mid_w, width),
                'bottom-left': (mid_h, height, 0, mid_w),
                'bottom-right': (mid_h, height, mid_w, width)
            }
            if quadrant in quadrant_map:
                y1, y2, x1, x2 = quadrant_map[quadrant]
                image = image[y1:y2, x1:x2]
                height, width = image.shape[:2]
                print(f"[EXTRACT-FACE] Cropped to {quadrant}: {width}x{height}")

        # Detect face
        face_box = detect_face_mediapipe(image)

        if face_box:
            print(f"[EXTRACT-FACE] Face detected: x={face_box['x']:.1f}%, y={face_box['y']:.1f}%, w={face_box['width']:.1f}%, h={face_box['height']:.1f}%")

            # Convert face_box (percentage 0-100) to normalized (0-1) bbox
            face_bbox = [
                face_box['y'] / 100,          # ymin
                face_box['x'] / 100,          # xmin
                (face_box['y'] + face_box['height']) / 100,  # ymax
                (face_box['x'] + face_box['width']) / 100    # xmax
            ]

            # Add 10% padding around face for context (but minimal to exclude shoulders)
            padding = 0.10
            face_bbox_padded = [
                max(0, face_bbox[0] - (face_bbox[2] - face_bbox[0]) * padding),  # ymin
                max(0, face_bbox[1] - (face_bbox[3] - face_bbox[1]) * padding),  # xmin
                min(1, face_bbox[2] + (face_bbox[2] - face_bbox[0]) * padding),  # ymax
                min(1, face_bbox[3] + (face_bbox[3] - face_bbox[1]) * padding)   # xmax
            ]

            # Crop to face
            y1 = int(face_bbox_padded[0] * height)
            x1 = int(face_bbox_padded[1] * width)
            y2 = int(face_bbox_padded[2] * height)
            x2 = int(face_bbox_padded[3] * width)

            face_img = image[y1:y2, x1:x2]

            # Make square and resize
            h, w = face_img.shape[:2]
            max_dim = max(h, w)
            square = np.full((max_dim, max_dim, 3), [230, 240, 255], dtype=np.uint8)  # Peach background
            y_off = (max_dim - h) // 2
            x_off = (max_dim - w) // 2
            square[y_off:y_off+h, x_off:x_off+w] = face_img

            face_resized = cv2.resize(square, (output_size, output_size), interpolation=cv2.INTER_LANCZOS4)

            # Encode as JPEG
            _, buffer = cv2.imencode('.jpg', face_resized, [cv2.IMWRITE_JPEG_QUALITY, 95])
            face_base64 = f"data:image/jpeg;base64,{base64.b64encode(buffer).decode('utf-8')}"

            print(f"[EXTRACT-FACE] Face extracted: {output_size}x{output_size}")

            return jsonify({
                "success": True,
                "face": face_base64,
                "faceBbox": face_bbox,
                "faceDetected": True
            }), 200

        else:
            # No face detected - return center crop as fallback
            print("[EXTRACT-FACE] No face detected, using center crop")

            # Center crop to square
            min_dim = min(height, width)
            y1 = (height - min_dim) // 2
            x1 = (width - min_dim) // 2
            center_crop = image[y1:y1+min_dim, x1:x1+min_dim]

            face_resized = cv2.resize(center_crop, (output_size, output_size), interpolation=cv2.INTER_LANCZOS4)

            _, buffer = cv2.imencode('.jpg', face_resized, [cv2.IMWRITE_JPEG_QUALITY, 95])
            face_base64 = f"data:image/jpeg;base64,{base64.b64encode(buffer).decode('utf-8')}"

            return jsonify({
                "success": True,
                "face": face_base64,
                "faceBbox": None,
                "faceDetected": False
            }), 200

    except Exception as e:
        print(f"[EXTRACT-FACE] Error: {e}")
        return jsonify({
            "success": False,
            "error": str(e),
            "traceback": traceback.format_exc()
        }), 500


# DeepFace for ArcFace embeddings (lazy loaded)
_deepface_loaded = False

def get_arcface_embedding(image_path_or_array, assume_face_crop=False):
    """
    Extract 512-D ArcFace embedding using DeepFace.
    ArcFace is style-invariant - can match photo to cartoon.

    Args:
        image_path_or_array: Either a file path or numpy array (BGR)
        assume_face_crop: If True, skip face detection (input is already a face)

    Returns:
        tuple: (512-dimensional normalized embedding, face_detected boolean)
    """
    global _deepface_loaded

    try:
        from deepface import DeepFace

        if not _deepface_loaded:
            print("[ARCFACE] Loading ArcFace model via DeepFace...")
            _deepface_loaded = True

        face_detected = False

        # Strategy:
        # 1. If assume_face_crop=True, skip detection entirely
        # 2. Otherwise, try detection with opencv first
        # 3. If that fails, try with skip (assume input is face)

        if assume_face_crop:
            # Input is already a face crop - skip detection
            result = DeepFace.represent(
                img_path=image_path_or_array,
                model_name='ArcFace',
                enforce_detection=False,
                detector_backend='skip'  # No detection, assume input is face
            )
            face_detected = True  # We trust caller that this is a face
        else:
            # Try to detect face first
            try:
                result = DeepFace.represent(
                    img_path=image_path_or_array,
                    model_name='ArcFace',
                    enforce_detection=True,  # Require face detection
                    detector_backend='opencv'
                )
                face_detected = True
            except ValueError as e:
                # Face not detected - try with skip (assume input is already face)
                if "Face could not be detected" in str(e):
                    print("[ARCFACE] No face detected by opencv, assuming input is face crop")
                    result = DeepFace.represent(
                        img_path=image_path_or_array,
                        model_name='ArcFace',
                        enforce_detection=False,
                        detector_backend='skip'
                    )
                    face_detected = False  # Mark as not detected for transparency
                else:
                    raise

        if result and len(result) > 0:
            embedding = np.array(result[0]['embedding'])
            # Normalize for cosine similarity
            embedding = embedding / np.linalg.norm(embedding)
            return embedding, face_detected

        return None, False

    except Exception as e:
        print(f"[ARCFACE] Error: {e}")
        return None, False


def extract_embedding_from_image(image_data, assume_face_crop=False):
    """
    Extract face embedding from image data (base64, PIL Image, or numpy array).
    Returns tuple: (512-dimensional normalized ArcFace embedding, face_detected boolean)
    """
    # Handle base64 input
    if isinstance(image_data, str):
        if ',' in image_data:
            image_data = image_data.split(',')[1]
        image_bytes = base64.b64decode(image_data)
        img_pil = Image.open(BytesIO(image_bytes)).convert('RGB')
        img_np = np.array(img_pil)
        # Convert RGB to BGR for OpenCV/DeepFace
        img_np = cv2.cvtColor(img_np, cv2.COLOR_RGB2BGR)
    elif hasattr(image_data, 'convert'):
        # PIL Image
        img_pil = image_data.convert('RGB')
        img_np = np.array(img_pil)
        img_np = cv2.cvtColor(img_np, cv2.COLOR_RGB2BGR)
    else:
        # Assume numpy array (BGR)
        img_np = image_data

    return get_arcface_embedding(img_np, assume_face_crop=assume_face_crop)


@app.route('/face-embedding', methods=['POST'])
def get_face_embedding():
    """
    Extract face embedding from an image.

    Expected JSON:
    {
        "image": "data:image/jpeg;base64,...",
        "quadrant": "top-left" | null,  # Optional: crop to quadrant first
        "extract_face": true            # Optional: detect and crop to face first
    }

    Returns:
    {
        "success": true,
        "embedding": [0.123, 0.456, ...],  # 2048-D normalized vector
        "dimensions": 2048,
        "faceDetected": true/false          # If extract_face was requested
    }
    """
    try:
        import torch

        data = request.get_json()
        if not data or 'image' not in data:
            return jsonify({
                "success": False,
                "error": "Missing 'image' in request body"
            }), 400

        image_data = data['image']
        quadrant = data.get('quadrant')
        extract_face_flag = data.get('extract_face', True)

        face_detected = False

        # If we need to extract face first, use the /extract-face logic
        if extract_face_flag or quadrant:
            # Decode image
            if ',' in image_data:
                image_data_clean = image_data.split(',')[1]
            else:
                image_data_clean = image_data

            image_bytes = base64.b64decode(image_data_clean)
            nparr = np.frombuffer(image_bytes, np.uint8)
            image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

            if image is None:
                return jsonify({
                    "success": False,
                    "error": "Failed to decode image"
                }), 400

            height, width = image.shape[:2]

            # Crop to quadrant if specified (supports 2x2, 3x3, and 3x4 grids)
            if quadrant:
                grid_size = data.get('grid_size', 2)

                if grid_size == '3x4' or grid_size == 34:
                    # 3 rows, 4 columns
                    third_h = height // 3
                    fourth_w = width // 4
                    quadrant_map = {
                        'top-col1': (0, third_h, 0, fourth_w),
                        'top-col2': (0, third_h, fourth_w, 2*fourth_w),
                        'top-col3': (0, third_h, 2*fourth_w, 3*fourth_w),
                        'top-col4': (0, third_h, 3*fourth_w, width),
                        'middle-col1': (third_h, 2*third_h, 0, fourth_w),
                        'middle-col2': (third_h, 2*third_h, fourth_w, 2*fourth_w),
                        'middle-col3': (third_h, 2*third_h, 2*fourth_w, 3*fourth_w),
                        'middle-col4': (third_h, 2*third_h, 3*fourth_w, width),
                        'bottom-col1': (2*third_h, height, 0, fourth_w),
                        'bottom-col2': (2*third_h, height, fourth_w, 2*fourth_w),
                        'bottom-col3': (2*third_h, height, 2*fourth_w, 3*fourth_w),
                        'bottom-col4': (2*third_h, height, 3*fourth_w, width)
                    }
                elif grid_size == 3:
                    third_h = height // 3
                    third_w = width // 3
                    quadrant_map = {
                        'top-left': (0, third_h, 0, third_w),
                        'top-center': (0, third_h, third_w, 2*third_w),
                        'top-right': (0, third_h, 2*third_w, width),
                        'middle-left': (third_h, 2*third_h, 0, third_w),
                        'middle-center': (third_h, 2*third_h, third_w, 2*third_w),
                        'middle-right': (third_h, 2*third_h, 2*third_w, width),
                        'bottom-left': (2*third_h, height, 0, third_w),
                        'bottom-center': (2*third_h, height, third_w, 2*third_w),
                        'bottom-right': (2*third_h, height, 2*third_w, width)
                    }
                else:
                    mid_h = height // 2
                    mid_w = width // 2
                    quadrant_map = {
                        'top-left': (0, mid_h, 0, mid_w),
                        'top-right': (0, mid_h, mid_w, width),
                        'bottom-left': (mid_h, height, 0, mid_w),
                        'bottom-right': (mid_h, height, mid_w, width)
                    }
                    
                if quadrant in quadrant_map:
                    y1, y2, x1, x2 = quadrant_map[quadrant]
                    image = image[y1:y2, x1:x2]
                    height, width = image.shape[:2]

            # Detect and crop face
            if extract_face_flag:
                face_box = detect_face_mediapipe(image)
                if face_box:
                    face_detected = True
                    # Add padding and crop
                    padding = 0.15
                    x = face_box['x'] / 100
                    y = face_box['y'] / 100
                    w = face_box['width'] / 100
                    h = face_box['height'] / 100

                    y1 = int(max(0, y - h * padding) * height)
                    x1 = int(max(0, x - w * padding) * width)
                    y2 = int(min(1, y + h * (1 + padding)) * height)
                    x2 = int(min(1, x + w * (1 + padding)) * width)

                    image = image[y1:y2, x1:x2]

            # Convert to PIL for embedding extraction
            image_rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
            img_pil = Image.fromarray(image_rgb)

            # If we extracted a face, tell ArcFace to skip detection
            embedding, arcface_detected = extract_embedding_from_image(img_pil, assume_face_crop=face_detected)
            face_detected = face_detected or arcface_detected
        else:
            embedding, arcface_detected = extract_embedding_from_image(image_data)
            face_detected = arcface_detected

        if embedding is None:
            return jsonify({
                "success": False,
                "error": "Failed to extract embedding"
            }), 500

        print(f"[FACE-EMBED] Extracted {len(embedding)}-D embedding, face_detected: {face_detected}")

        return jsonify({
            "success": True,
            "embedding": embedding.tolist(),
            "dimensions": len(embedding),
            "faceDetected": face_detected
        }), 200

    except Exception as e:
        print(f"[FACE-EMBED] Error: {e}")
        return jsonify({
            "success": False,
            "error": str(e),
            "traceback": traceback.format_exc()
        }), 500


@app.route('/compare-identity', methods=['POST'])
def compare_identity():
    """
    Compare two face embeddings for identity match using cosine similarity.

    Expected JSON (option 1 - pre-computed embeddings):
    {
        "embedding1": [0.123, 0.456, ...],
        "embedding2": [0.123, 0.456, ...]
    }

    Expected JSON (option 2 - images):
    {
        "image1": "data:image/jpeg;base64,...",
        "image2": "data:image/jpeg;base64,...",
        "quadrant1": null,       # Optional: crop image1 to quadrant
        "quadrant2": "top-left"  # Optional: crop image2 to quadrant
    }

    Returns:
    {
        "success": true,
        "similarity": 0.85,           # Cosine similarity (-1 to 1)
        "same_person": true,          # similarity > threshold
        "confidence": "high",         # high/medium/low
        "interpretation": "very_similar"
    }
    """
    try:
        import torch

        data = request.get_json()
        if not data:
            return jsonify({
                "success": False,
                "error": "Missing request body"
            }), 400

        # Option 1: Pre-computed embeddings
        if 'embedding1' in data and 'embedding2' in data:
            emb1 = np.array(data['embedding1'])
            emb2 = np.array(data['embedding2'])

        # Option 2: Extract from images
        elif 'image1' in data and 'image2' in data:
            # Get embeddings using the /face-embedding logic
            emb1 = None
            emb2 = None

            # Process image1
            img1_data = data['image1']
            q1 = data.get('quadrant1')

            if ',' in img1_data:
                img1_clean = img1_data.split(',')[1]
            else:
                img1_clean = img1_data

            image_bytes = base64.b64decode(img1_clean)
            nparr = np.frombuffer(image_bytes, np.uint8)
            image1 = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

            if q1:
                h, w = image1.shape[:2]
                mid_h, mid_w = h // 2, w // 2
                qmap = {
                    'top-left': (0, mid_h, 0, mid_w),
                    'top-right': (0, mid_h, mid_w, w),
                    'bottom-left': (mid_h, h, 0, mid_w),
                    'bottom-right': (mid_h, h, mid_w, w)
                }
                if q1 in qmap:
                    y1, y2, x1, x2 = qmap[q1]
                    image1 = image1[y1:y2, x1:x2]

            # Detect face in image1
            face_box1 = detect_face_mediapipe(image1)
            face1_detected = False
            if face_box1:
                face1_detected = True
                h, w = image1.shape[:2]
                padding = 0.15
                x, y = face_box1['x'] / 100, face_box1['y'] / 100
                fw, fh = face_box1['width'] / 100, face_box1['height'] / 100
                y1 = int(max(0, y - fh * padding) * h)
                x1 = int(max(0, x - fw * padding) * w)
                y2 = int(min(1, y + fh * (1 + padding)) * h)
                x2 = int(min(1, x + fw * (1 + padding)) * w)
                image1 = image1[y1:y2, x1:x2]

            img1_rgb = cv2.cvtColor(image1, cv2.COLOR_BGR2RGB)
            img1_pil = Image.fromarray(img1_rgb)
            emb1, _ = extract_embedding_from_image(img1_pil, assume_face_crop=face1_detected)

            # Process image2 similarly
            img2_data = data['image2']
            q2 = data.get('quadrant2')

            if ',' in img2_data:
                img2_clean = img2_data.split(',')[1]
            else:
                img2_clean = img2_data

            image_bytes = base64.b64decode(img2_clean)
            nparr = np.frombuffer(image_bytes, np.uint8)
            image2 = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

            if q2:
                h, w = image2.shape[:2]
                mid_h, mid_w = h // 2, w // 2
                qmap = {
                    'top-left': (0, mid_h, 0, mid_w),
                    'top-right': (0, mid_h, mid_w, w),
                    'bottom-left': (mid_h, h, 0, mid_w),
                    'bottom-right': (mid_h, h, mid_w, w)
                }
                if q2 in qmap:
                    y1, y2, x1, x2 = qmap[q2]
                    image2 = image2[y1:y2, x1:x2]

            face_box2 = detect_face_mediapipe(image2)
            face2_detected = False
            if face_box2:
                face2_detected = True
                h, w = image2.shape[:2]
                padding = 0.15
                x, y = face_box2['x'] / 100, face_box2['y'] / 100
                fw, fh = face_box2['width'] / 100, face_box2['height'] / 100
                y1 = int(max(0, y - fh * padding) * h)
                x1 = int(max(0, x - fw * padding) * w)
                y2 = int(min(1, y + fh * (1 + padding)) * h)
                x2 = int(min(1, x + fw * (1 + padding)) * w)
                image2 = image2[y1:y2, x1:x2]

            img2_rgb = cv2.cvtColor(image2, cv2.COLOR_BGR2RGB)
            img2_pil = Image.fromarray(img2_rgb)
            emb2, _ = extract_embedding_from_image(img2_pil, assume_face_crop=face2_detected)

            if emb1 is None or emb2 is None:
                return jsonify({
                    "success": False,
                    "error": "Failed to extract embeddings from images"
                }), 500
        else:
            return jsonify({
                "success": False,
                "error": "Must provide either (embedding1, embedding2) or (image1, image2)"
            }), 400

        # Normalize embeddings (should already be normalized, but ensure)
        emb1 = emb1 / np.linalg.norm(emb1)
        emb2 = emb2 / np.linalg.norm(emb2)

        # Compute cosine similarity
        similarity = float(np.dot(emb1, emb2))

        # Determine if same person and confidence
        # Thresholds tuned for ArcFace 512-D embeddings
        # ArcFace is style-invariant: photo vs anime can still match!
        if similarity > 0.60:
            same_person = True
            confidence = "high"
            interpretation = "very_similar"
        elif similarity > 0.45:
            same_person = True
            confidence = "medium"
            interpretation = "similar"
        elif similarity > 0.30:
            same_person = False
            confidence = "low"
            interpretation = "somewhat_similar"
        else:
            same_person = False
            confidence = "high"
            interpretation = "different"

        print(f"[COMPARE-ID] Similarity: {similarity:.4f}, same_person: {same_person}, confidence: {confidence}")

        return jsonify({
            "success": True,
            "similarity": round(similarity, 4),
            "same_person": same_person,
            "confidence": confidence,
            "interpretation": interpretation
        }), 200

    except Exception as e:
        print(f"[COMPARE-ID] Error: {e}")
        return jsonify({
            "success": False,
            "error": str(e),
            "traceback": traceback.format_exc()
        }), 500


@app.route('/detect-all-faces', methods=['POST'])
def detect_all_faces():
    """
    Detect ALL faces in an image and optionally compare each to a reference.
    Uses DeepFace to find multiple faces.

    Expected JSON:
    {
        "image": "data:image/jpeg;base64,...",
        "reference_image": "data:image/jpeg;base64,..."  # Optional: compare each face to this
    }

    Returns:
    {
        "success": true,
        "faces": [
            {
                "index": 0,
                "box": {"x": 100, "y": 50, "width": 80, "height": 100},
                "similarity": 0.72,  # Only if reference_image provided
                "same_person": true
            },
            ...
        ],
        "total_faces": 12
    }
    """
    try:
        data = request.get_json()
        image_data = data.get('image')
        reference_data = data.get('reference_image')

        if not image_data:
            return jsonify({"success": False, "error": "No image provided"}), 400

        # Decode main image
        if ',' in image_data:
            image_data = image_data.split(',')[1]
        image_bytes = base64.b64decode(image_data)
        nparr = np.frombuffer(image_bytes, np.uint8)
        image = cv2.imdecode(nparr, cv2.IMREAD_COLOR)

        if image is None:
            return jsonify({"success": False, "error": "Failed to decode image"}), 400

        height, width = image.shape[:2]
        print(f"[DETECT-ALL] Image size: {width}x{height}")

        # Get reference embedding if provided
        ref_embedding = None
        if reference_data:
            if ',' in reference_data:
                reference_data = reference_data.split(',')[1]
            ref_bytes = base64.b64decode(reference_data)
            ref_arr = np.frombuffer(ref_bytes, np.uint8)
            ref_image = cv2.imdecode(ref_arr, cv2.IMREAD_COLOR)
            if ref_image is not None:
                ref_rgb = cv2.cvtColor(ref_image, cv2.COLOR_BGR2RGB)
                ref_pil = Image.fromarray(ref_rgb)
                ref_embedding, _ = extract_embedding_from_image(ref_pil, assume_face_crop=False)
                if ref_embedding is not None:
                    ref_embedding = ref_embedding / np.linalg.norm(ref_embedding)
                    print(f"[DETECT-ALL] Reference embedding extracted")

        # Use DeepFace to detect all faces
        from deepface import DeepFace

        image_rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)

        # Try multiple detectors - retinaface works on photos, opencv/mtcnn better on illustrations
        face_objs = []
        detectors = ['opencv', 'mtcnn', 'retinaface']

        for detector in detectors:
            try:
                print(f"[DETECT-ALL] Trying detector: {detector}")
                face_objs = DeepFace.extract_faces(
                    img_path=image_rgb,
                    detector_backend=detector,
                    enforce_detection=False,
                    align=True
                )
                if face_objs:
                    print(f"[DETECT-ALL] {detector} found {len(face_objs)} faces")
                    break
            except Exception as e:
                print(f"[DETECT-ALL] {detector} error: {e}")
                continue

        print(f"[DETECT-ALL] Found {len(face_objs)} faces")

        faces = []
        for i, face_obj in enumerate(face_objs):
            facial_area = face_obj.get('facial_area', {})
            face_img = face_obj.get('face')
            confidence = face_obj.get('confidence', 0)

            # Skip low confidence detections
            if confidence < 0.5:
                continue

            face_info = {
                "index": i,
                "box": {
                    "x": facial_area.get('x', 0),
                    "y": facial_area.get('y', 0),
                    "width": facial_area.get('w', 0),
                    "height": facial_area.get('h', 0)
                },
                "confidence": round(confidence, 3)
            }

            # If reference provided, compute similarity
            if ref_embedding is not None and face_img is not None:
                try:
                    # face_img is already a numpy array (RGB, float 0-1)
                    face_uint8 = (face_img * 255).astype(np.uint8)
                    face_pil = Image.fromarray(face_uint8)
                    face_emb, _ = extract_embedding_from_image(face_pil, assume_face_crop=True)

                    if face_emb is not None:
                        face_emb = face_emb / np.linalg.norm(face_emb)
                        similarity = float(np.dot(ref_embedding, face_emb))
                        face_info["similarity"] = round(similarity, 4)
                        face_info["same_person"] = similarity > 0.45
                        face_info["match_confidence"] = "high" if similarity > 0.6 else "medium" if similarity > 0.45 else "low"
                except Exception as e:
                    print(f"[DETECT-ALL] Error computing similarity for face {i}: {e}")

            faces.append(face_info)

        # Sort by similarity if available (highest first)
        if faces and 'similarity' in faces[0]:
            faces.sort(key=lambda f: f.get('similarity', 0), reverse=True)

        print(f"[DETECT-ALL] Returning {len(faces)} valid faces")

        return jsonify({
            "success": True,
            "faces": faces,
            "total_faces": len(faces),
            "image_size": {"width": width, "height": height}
        }), 200

    except Exception as e:
        print(f"[DETECT-ALL] Error: {e}")
        import traceback
        return jsonify({
            "success": False,
            "error": str(e),
            "traceback": traceback.format_exc()
        }), 500


if __name__ == '__main__':
    port = int(os.environ.get('PHOTO_ANALYZER_PORT', 5000))
    print(f"[START] Photo Analyzer API starting on port {port}")
    print(f"   MediaPipe available: {MEDIAPIPE_AVAILABLE}")
    print("   LPIPS: checking on first request")
    print("   Face embeddings: ArcFace via DeepFace (512-D, style-invariant)")
    app.run(host='0.0.0.0', port=port, debug=False)
