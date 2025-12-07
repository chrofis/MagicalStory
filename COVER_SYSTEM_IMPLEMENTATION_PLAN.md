# Cover System Implementation Plan

## Goal
Add 3 cover pages to stories: Front Cover/Title Page, Page 0, and Back Cover

## Current Status (Dec 7, 2025)
- ✅ All shipping address issues FIXED
- ✅ PDF layout improvements complete (font sizing, alignment)
- ✅ PDF dimensions correct (140x140mm + cover spread)
- ⏳ Cover system - ready to implement in fresh session

## What Needs to be Built

### 1. Three Cover Images
- **Front Cover / Title Page** (same image) - shows story title
- **Page 0** - dedication/introduction page
- **Back Cover** - ending page

### 2. Display Order in App
```
Front Cover → Page 0 → Story Pages → Back Cover
```

### 3. PDF Print Order
```
PDF Page 1: Back Cover + Front Cover (spread, 290.27 x 146.0 mm)
PDF Page 2: Page 0 (140x140mm)
PDF Pages 3+: Story content (alternating text/image)
```

### 4. Story Metadata
- Extract/save story title
- Use front cover as thumbnail
- Display in story list

## Implementation Steps

### Phase 1: State & Generation (index.html)

**Add State Variables** (around line 708):
```javascript
const [coverImages, setCoverImages] = useState({
  frontCover: null,
  page0: null,
  backCover: null
});
const [storyTitle, setStoryTitle] = useState('');
```

**Extract Title from Story Type** (in generateOutline or after story generation):
```javascript
const title = storyTypes.find(t => t.id === storyType)?.name[language] || 'My Story';
setStoryTitle(title);
```

**Generate Cover Images** (around line 2515, in parallel with scene images):
```javascript
// Add to imagePromises array:
const coverPromises = [
  // Front cover/title
  generateCoverImage('front', `Create a beautiful title page for a children's book called "${storyTitle}". ${styleDescription}. Include decorative elements but leave space for the title text.`),

  // Page 0
  generateCoverImage('page0', `Create a dedication page or introduction illustration for "${storyTitle}". ${styleDescription}. Warm, inviting scene.`),

  // Back cover
  generateCoverImage('back', `Create a back cover illustration for "${storyTitle}". ${styleDescription}. Conclusive, satisfying ending scene.`)
];

// Await all
const [frontCover, page0, backCover] = await Promise.all(coverPromises);
setCoverImages({ frontCover, page0, backCover });
```

### Phase 2: PDF Generation (server.js)

**Update PDF Structure** (around line 2267):
```javascript
// Page 1: Back + Front cover spread (290.27 x 146.0 mm)
doc.addPage({ size: [coverWidth, coverHeight], margins: 0 });
if (coverImages.backCover) {
  // Add back cover on left half
  doc.image(backCoverBuffer, 0, 0, { width: coverWidth/2, height: coverHeight });
}
if (coverImages.frontCover) {
  // Add front cover on right half
  doc.image(frontCoverBuffer, coverWidth/2, 0, { width: coverWidth/2, height: coverHeight });
}

// Page 2: Page 0 (140x140mm)
doc.addPage({ size: [pageSize, pageSize], margins: 0 });
if (coverImages.page0) {
  doc.image(page0Buffer, 0, 0, { width: pageSize, height: pageSize });
}

// Pages 3+: Story content (existing logic)
```

**Update API endpoint** (/api/generate-pdf):
- Accept `coverImages` and `storyTitle` in request body
- Extract base64 buffers for covers
- Use in PDF generation

### Phase 3: Storage & Display

**Save with Covers** (in save story):
```javascript
const storyData = {
  // ... existing fields
  title: storyTitle,
  coverImages: coverImages,
  thumbnail: coverImages.frontCover // Use front cover as thumbnail
};
```

**Display in Story List** (around line 6800):
```javascript
{savedStories.map(story => (
  <div key={story.id}>
    {story.thumbnail && (
      <img src={story.thumbnail} alt={story.title} />
    )}
    <h3>{story.title || story.storyType}</h3>
    <p>Pages: {story.pages}</p>
  </div>
))}
```

**Display in Story Viewer** (around line 5400):
```javascript
// Add before story pages
{coverImages.frontCover && (
  <div className="cover-page">
    <img src={coverImages.frontCover} />
    <h1>{storyTitle}</h1>
  </div>
)}

{coverImages.page0 && (
  <img src={coverImages.page0} />
)}

// ... story pages ...

{coverImages.backCover && (
  <img src={coverImages.backCover} />
)}
```

## Files to Modify

1. **index.html** (~300 lines changed)
   - State variables
   - Title extraction
   - Cover image generation
   - Display logic

2. **server.js** (~50 lines changed)
   - PDF generation structure
   - Cover image handling

3. **Database** (optional)
   - Migration to add title column if needed
   - Backward compatibility

## Testing Checklist

- [ ] Generate new story with covers
- [ ] Covers appear in viewer in correct order
- [ ] PDF has correct structure (back+front, page0, content)
- [ ] Story saves with title and covers
- [ ] Thumbnail shows in story list
- [ ] Old stories still work (backward compatibility)
- [ ] Cover images quality is good
- [ ] PDF dimensions correct

## Notes

- Keep existing image generation parallel for performance
- Covers should match selected art style
- Title should be extracted from story type or generated
- Front cover serves dual purpose (cover + thumbnail)
- Backward compatibility: old stories without covers should still work

## Current Working Features (Don't Break!)

- ✅ Shipping address save/load
- ✅ PDF generation with correct dimensions
- ✅ Smart font sizing (auto-reduce if text too long)
- ✅ Left-aligned, vertically-centered text
- ✅ Story loading with progress bar
- ✅ Image generation in parallel
- ✅ Character consistency system
