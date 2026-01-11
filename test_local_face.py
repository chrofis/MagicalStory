"""
Local face detection testing - compare different methods
"""
import cv2
import os
import urllib.request

import mediapipe as mp
from mediapipe.tasks import python as mp_python
from mediapipe.tasks.python import vision

print(f"MediaPipe version: {mp.__version__}")

# Download model if not exists
MODEL_PATH = "blaze_face_short_range.tflite"
MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite"

if not os.path.exists(MODEL_PATH):
    print(f"Downloading model...")
    urllib.request.urlretrieve(MODEL_URL, MODEL_PATH)

def detect_faces_tasks_api(image, min_confidence=0.1):
    """Detect faces using Tasks API"""
    h, w = image.shape[:2]
    rgb_image = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
    mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_image)

    base_options = mp_python.BaseOptions(model_asset_path=MODEL_PATH)
    options = vision.FaceDetectorOptions(
        base_options=base_options,
        min_detection_confidence=min_confidence
    )

    faces = []
    with vision.FaceDetector.create_from_options(options) as detector:
        result = detector.detect(mp_image)
        if result.detections:
            for idx, detection in enumerate(result.detections):
                confidence = detection.categories[0].score if detection.categories else 0
                bbox = detection.bounding_box
                faces.append({
                    'id': idx,
                    'x': (bbox.origin_x / w) * 100,
                    'y': (bbox.origin_y / h) * 100,
                    'width': (bbox.width / w) * 100,
                    'height': (bbox.height / h) * 100,
                    'confidence': confidence
                })

    faces.sort(key=lambda f: f['confidence'], reverse=True)
    return faces

def print_faces(faces, label=""):
    if label:
        print(f"\n{label}")
    if faces:
        print(f"  Found {len(faces)} faces:")
        for f in faces:
            print(f"    Face {f['id']+1}: {f['confidence']*100:.1f}% at x={f['x']:.1f}%, y={f['y']:.1f}%, w={f['width']:.1f}%, h={f['height']:.1f}%")
    else:
        print("  NO FACES")

def test_image(image_path):
    img = cv2.imread(image_path)
    if img is None:
        print(f"ERROR: Could not load {image_path}")
        return

    h, w = img.shape[:2]
    print(f"\n{'='*70}")
    print(f"IMAGE: {os.path.basename(image_path)}")
    print(f"Size: {w}x{h}, Aspect ratio: {h/w:.2f}")
    print(f"{'='*70}")

    # METHOD 1: Original image
    faces1 = detect_faces_tasks_api(img, min_confidence=0.1)
    print_faces(faces1, "METHOD 1: Original image")

    # METHOD 2: Normalized 640x480 (squished)
    img_640x480 = cv2.resize(img, (640, 480))
    faces2 = detect_faces_tasks_api(img_640x480, min_confidence=0.1)
    print_faces(faces2, "METHOD 2: Normalized 640x480 (squished)")

    # METHOD 3: Scale to 640 width, maintain aspect
    scale = 640 / w
    img_scaled = cv2.resize(img, (640, int(h * scale)))
    faces3 = detect_faces_tasks_api(img_scaled, min_confidence=0.1)
    print_faces(faces3, f"METHOD 3: Scaled to 640 width ({640}x{int(h*scale)})")

    # METHOD 4: Pad to square then resize
    max_dim = max(h, w)
    padded = cv2.copyMakeBorder(img,
        top=(max_dim - h) // 2,
        bottom=(max_dim - h + 1) // 2,
        left=(max_dim - w) // 2,
        right=(max_dim - w + 1) // 2,
        borderType=cv2.BORDER_CONSTANT,
        value=[128, 128, 128])
    img_square = cv2.resize(padded, (640, 640))
    faces4 = detect_faces_tasks_api(img_square, min_confidence=0.1)
    print_faces(faces4, f"METHOD 4: Padded to square then 640x640")

    # METHOD 5: Try different confidence thresholds on 640x480
    print(f"\nMETHOD 5: Different thresholds on 640x480:")
    for thresh in [0.05, 0.1, 0.15, 0.2, 0.3]:
        faces = detect_faces_tasks_api(img_640x480, min_confidence=thresh)
        print(f"  thresh={thresh}: {len(faces)} faces")

    # METHOD 6: Try cropping top half (where faces likely are)
    top_half = img[0:h//2, :]
    faces6 = detect_faces_tasks_api(top_half, min_confidence=0.1)
    print_faces(faces6, f"METHOD 6: Top half only ({w}x{h//2})")

    # METHOD 7: Try with histogram equalization (improve contrast)
    img_yuv = cv2.cvtColor(img, cv2.COLOR_BGR2YUV)
    img_yuv[:,:,0] = cv2.equalizeHist(img_yuv[:,:,0])
    img_eq = cv2.cvtColor(img_yuv, cv2.COLOR_YUV2BGR)
    img_eq_640 = cv2.resize(img_eq, (640, 480))
    faces7 = detect_faces_tasks_api(img_eq_640, min_confidence=0.1)
    print_faces(faces7, "METHOD 7: Histogram equalized + 640x480")

    # Print summary
    print(f"\n{'='*70}")
    print("SUMMARY:")
    print(f"  Method 1 (original): {len(faces1)} faces")
    print(f"  Method 2 (640x480): {len(faces2)} faces")
    print(f"  Method 3 (scaled): {len(faces3)} faces")
    print(f"  Method 4 (square): {len(faces4)} faces")
    print(f"  Method 6 (top half): {len(faces6)} faces")
    print(f"  Method 7 (equalized): {len(faces7)} faces")
    print(f"{'='*70}")

if __name__ == "__main__":
    test_image(r"C:\Users\roger\OneDrive\Pictures\Manu, Luki, Luis.jpg")
