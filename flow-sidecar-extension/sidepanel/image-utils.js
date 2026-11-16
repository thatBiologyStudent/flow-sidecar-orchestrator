/**
 * Flow Sidecar Orchestrator - Client-Side Image Utilities
 * Handles client-side canvas downscaling (max 1024px) for vision token efficiency
 * and Data URL conversions for chat attachments and Img2Img references.
 */

const MAX_DEFAULT_DIMENSION = 1024;
const ALLOWED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);

/**
 * Validates whether a File or Blob is an accepted image format (PNG/JPG/WEBP).
 * @param {File|Blob} file
 * @returns {boolean}
 */
export function isSupportedImageFile(file) {
  if (!file) return false;
  if (file.type && ALLOWED_MIME_TYPES.has(file.type.toLowerCase())) {
    return true;
  }
  if (typeof file.name === "string") {
    return /\.(png|jpe?g|webp)$/i.test(file.name);
  }
  return false;
}

/**
 * Reads a File or Blob as a base64 Data URL.
 * @param {File|Blob} file
 * @returns {Promise<string>}
 */
export function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("FileReader did not produce a valid Data URL string."));
      }
    };
    reader.onerror = () => reject(reader.error || new Error("Failed to read file."));
    reader.readAsDataURL(file);
  });
}

/**
 * Loads a Data URL or image URL into an HTMLImageElement.
 * @param {string} src
 * @returns {Promise<HTMLImageElement>}
 */
export function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to decode image source."));
    img.src = src;
  });
}

/**
 * Downscales an image File, Blob, or Data URL client-side via <canvas> so its
 * largest dimension does not exceed `maxDimension` (default 1024px).
 * Preserves aspect ratio and returns metadata alongside the Data URL.
 *
 * @param {File|Blob|string} source - Image File/Blob or existing Data URL
 * @param {object} [options]
 * @param {number} [options.maxDimension=1024] - Max width or height in pixels
 * @param {number} [options.quality=0.88] - Compression quality for JPEG/WEBP
 * @param {string} [options.outputMimeType] - Optional forced output MIME type
 * @returns {Promise<{dataUrl: string, width: number, height: number, originalWidth: number, originalHeight: number, mimeType: string, name: string}>}
 */
export async function downscaleImage(source, options = {}) {
  const maxDimension = Number(options.maxDimension) > 0 ? Number(options.maxDimension) : MAX_DEFAULT_DIMENSION;
  const quality = typeof options.quality === "number" ? options.quality : 0.88;

  let rawDataUrl;
  let sourceName = "reference.png";
  let sourceMime = "image/jpeg";

  if (typeof source === "string") {
    rawDataUrl = source;
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,/i.exec(source);
    if (match) {
      sourceMime = match[1].toLowerCase();
    }
  } else if (source instanceof Blob) {
    if (!isSupportedImageFile(source)) {
      throw new Error("Unsupported image format. Please attach PNG, JPG, or WEBP images.");
    }
    rawDataUrl = await readFileAsDataUrl(source);
    sourceName = typeof source.name === "string" && source.name ? source.name : sourceName;
    sourceMime = source.type ? source.type.toLowerCase() : sourceMime;
  } else {
    throw new Error("Invalid image source provided to downscaleImage.");
  }

  const img = await loadImageElement(rawDataUrl);
  const originalWidth = img.naturalWidth || img.width;
  const originalHeight = img.naturalHeight || img.height;

  if (!originalWidth || !originalHeight) {
    throw new Error("Image has invalid dimensions (0x0).");
  }

  let targetWidth = originalWidth;
  let targetHeight = originalHeight;

  if (originalWidth > maxDimension || originalHeight > maxDimension) {
    if (originalWidth >= originalHeight) {
      targetWidth = maxDimension;
      targetHeight = Math.max(1, Math.round((originalHeight * maxDimension) / originalWidth));
    } else {
      targetHeight = maxDimension;
      targetWidth = Math.max(1, Math.round((originalWidth * maxDimension) / originalHeight));
    }
  }

  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Unable to initialize 2D canvas context for image downscaling.");
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

  // Preserve PNG transparency when input is PNG and fits comfortably, otherwise use JPEG/WEBP
  const targetMime =
    options.outputMimeType ||
    (sourceMime === "image/png" || sourceMime === "image/webp" ? sourceMime : "image/jpeg");

  const dataUrl = canvas.toDataURL(targetMime, quality);

  return {
    dataUrl,
    width: targetWidth,
    height: targetHeight,
    originalWidth,
    originalHeight,
    mimeType: targetMime,
    name: sourceName
  };
}

/* ==========================================================================
   File System Access API Directory Handle Persistence (IndexedDB) & Direct Write
   ========================================================================== */

const IDB_NAME = "flow_sidecar_fs_db";
const IDB_STORE = "handles";
const DIR_HANDLE_KEY = "download_dir_handle";

function openHandlesDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("Failed to open IndexedDB for folder handle."));
  });
}

/**
 * Persists a `FileSystemDirectoryHandle` in IndexedDB so the chosen Explorer folder
 * is remembered across Side Panel sessions.
 * @param {FileSystemDirectoryHandle} handle
 */
export async function saveDirectoryHandleToIdb(handle) {
  const db = await openHandlesDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(handle, DIR_HANDLE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("Failed to store directory handle."));
  });
}

/**
 * Loads a previously persisted `FileSystemDirectoryHandle` from IndexedDB.
 * @returns {Promise<FileSystemDirectoryHandle|null>}
 */
export async function loadDirectoryHandleFromIdb() {
  try {
    const db = await openHandlesDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(DIR_HANDLE_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (_) {
    return null;
  }
}

/**
 * Removes the stored `FileSystemDirectoryHandle` from IndexedDB.
 */
export async function clearDirectoryHandleFromIdb() {
  try {
    const db = await openHandlesDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).delete(DIR_HANDLE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (_) {
    // ignore
  }
}

/**
 * Writes a base64 Data URL image directly into a user-selected `FileSystemDirectoryHandle`.
 * @param {FileSystemDirectoryHandle} dirHandle
 * @param {string} imageDataUrl
 * @param {string} filename
 * @returns {Promise<string>} Saved filename
 */
export async function writeImageToDirectoryHandle(dirHandle, imageDataUrl, filename) {
  if (!dirHandle) {
    throw new Error("No directory handle available.");
  }

  // Verify or request readwrite permission on the directory handle
  if (typeof dirHandle.queryPermission === "function") {
    let perm = await dirHandle.queryPermission({ mode: "readwrite" });
    if (perm !== "granted" && typeof dirHandle.requestPermission === "function") {
      perm = await dirHandle.requestPermission({ mode: "readwrite" });
    }
    if (perm !== "granted") {
      throw new Error("Write permission to the selected folder was not granted.");
    }
  }

  const resp = await fetch(imageDataUrl);
  const blob = await resp.blob();

  const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();

  return `${dirHandle.name}/${filename}`;
}
