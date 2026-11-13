import './GalleryHelper.css';

export interface IPreview {
  src: string;
  width: string;
  height?: number | string;
  name?: string;
  alt: string;
  /** data-testid of the image (told apart by its src). */
  testId?: string;
}

export function Thumbnail({
  src,
  alt,
  width = '100%',
  height = 250,
  testId = 'gallery-thumbnail',
}: IPreview) {
  // You can style this however you like
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      className="gallery-thumbnail"
      style={{ width, height }}
      data-testid={testId}
      data-test-key={src}
    />
  );
}
