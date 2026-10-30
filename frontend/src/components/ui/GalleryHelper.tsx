export interface IPreview {
  src: string;
  width: string;
  height?: number | string;
  name?: string;
  alt: string;
}

export function Thumbnail({
  src,
  alt,
  width = '100%',
  height = 250,
}: IPreview) {
  // You can style this however you like
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      style={{
        display: 'block',
        width: width,
        height: height,
        objectFit: 'cover',
        borderRadius: 8,
      }}
    />
  );
}
