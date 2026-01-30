

# E-Commerce Photo Color Corrector

A browser-based tool for calibrating and batch-correcting product photography colors using reference color cards.

---

## Core Workflow

### 1. Reference Image Calibration
- Upload your reference photo containing the color card
- Interactive canvas where you can click to place calibration points
- Default presets for common color card points (white, grey, black)
- Option to add custom color points for multi-point calibration
- Input target hex codes for each selected point
- Live preview showing before/after comparison

### 2. Color Correction Engine
- Calculate color transformation matrix from your calibration points
- 3-point mode: Quick white balance and exposure correction
- Multi-point mode: Advanced color curve adjustment for higher accuracy
- Real-time preview of corrections on the reference image
- Fine-tuning sliders for additional adjustments if needed

### 3. Preset Management
- Save calibration as named presets (stored in browser)
- Organize presets by shooting environment or product type
- Load, edit, and delete saved presets
- Quick-apply recently used presets

### 4. Batch Processing
- Drag-and-drop zone for uploading multiple images (20-100)
- Progress indicator showing batch processing status
- Thumbnail grid with before/after toggle for each image
- Option to exclude individual images from the batch
- Efficient canvas-based processing with web workers for performance

### 5. Export & Download
- Download individual corrected images
- Bulk download as ZIP file
- Choose output format (JPEG with quality slider, PNG)
- Maintain original filenames with optional suffix

---

## User Interface Design

**Modern & Friendly Style:**
- Clean, light-themed interface with intuitive navigation
- Step-by-step guided workflow (Calibrate → Apply → Download)
- Helpful tooltips and visual cues for first-time users
- Responsive design for desktop use (optimized for larger screens)

**Key Screens:**
1. **Home/Landing** - Quick start options and recent presets
2. **Calibration Studio** - Interactive reference image editor
3. **Batch Processor** - Grid view of images with bulk actions
4. **Preset Library** - Manage saved calibration presets

---

## Technical Approach

- **All client-side processing** - No server needed, images never leave your browser
- **Canvas API** for image manipulation and color transformation
- **Web Workers** for background processing to keep UI responsive during batches
- **Local Storage** for saving presets
- **JSZip library** for creating downloadable ZIP archives

