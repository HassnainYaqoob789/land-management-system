// The official Mari Energies logo. One component so every surface (sign-in,
// header, sidebar, printouts) uses the same asset, alt text and proportions.
//
//   variant 'full' — the approved logo (public/images/mari-energies-logo.png,
//                    600×600, opaque white): `size` is its height and width.
//   variant 'mark' — the symbol alone, cropped from the same file without
//                    redrawing (public/images/mari-energies-mark.png, 560×256):
//                    `size` is its height; the width keeps the aspect ratio.
//
// Both PNGs have a white background, so on dark surfaces they read as a white
// tile (rounded by the .brand-logo rule in src/styles/app.css).
// A plain <img>: a static asset, so next/image adds nothing here.

export const BRAND_LOGO_SRC = '/images/mari-energies-logo.png';
export const BRAND_MARK_SRC = '/images/mari-energies-mark.png';
const MARK_RATIO = 560 / 256;

export default function BrandLogo({ variant = 'full', size = 40 }: { variant?: 'full' | 'mark'; size?: number }) {
  const h = Math.max(8, Math.round(size));
  const w = variant === 'mark' ? Math.round(h * MARK_RATIO) : h;
  return (
    <img
      className={`brand-logo brand-logo-${variant}`}
      src={variant === 'mark' ? BRAND_MARK_SRC : BRAND_LOGO_SRC}
      alt="Mari Energies"
      width={w}
      height={h}
      decoding="async"
      style={{ width: w, height: h, objectFit: 'contain', display: 'block', flex: 'none' }}
    />
  );
}
