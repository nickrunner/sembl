export { ImageSourceError } from "./errors.js";
export type { ImageSourceErrorKind } from "./errors.js";

export { sniffImageType, detectImageType, isSupportedImageType, imageTypeName } from "./sniff.js";
export type { DetectedImageType, UnsupportedImageType } from "./sniff.js";

export { imageDimensions } from "./dimensions.js";
export type { ImageDimensions } from "./dimensions.js";

export { extractExif, parseExifBlock, findExifBlock, parseExifDate, describeOrientation } from "./exif.js";
export type { ImageMetadata, GpsPosition, ExifOrientation } from "./exif.js";

export { encodeExif, writeExif, exifApp1Segment } from "./exif-writer.js";
export type { WritableImageMetadata, EncodeExifOptions } from "./exif-writer.js";

export { renderImageMetadata, metadataLabel, METADATA_LABEL_SUFFIX } from "./render.js";

export {
  imageSource,
  imageSources,
  metadataSource,
  readImageBytes,
  checkImageBytes,
  DEFAULT_MAX_BYTES,
  DEFAULT_LABEL,
} from "./image-source.js";
export type { ImageInput, ImageSourceOptions, ImageSourcesOptions } from "./image-source.js";

export { fetchImages } from "./fetch-images.js";
export type {
  FetchImageItem,
  FetchImagesOptions,
  FetchedImages,
  SkippedImage,
  FetchImageSkipReason,
} from "./fetch-images.js";

export { NoopResizer, prepareImages, isMetadataSource, fromBase64 } from "./resizer.js";
export type { ImageResizer, ResizeOptions, ResizeFormat, ResizedImage, PrepareImagesOptions } from "./resizer.js";
