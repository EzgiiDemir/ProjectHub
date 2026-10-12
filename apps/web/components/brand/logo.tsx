import Image from 'next/image';
import arucadLogo from './arucad-logo.png';

/**
 * ARUCAD logo. Imported (not served from /public) so Next bundles it into `.next/static/media`, which the production
 * image already ships. The wordmark is dark grey, so dark mode shows it on a light chip.
 */
export function ArucadLogo({ height = 28, priority }: { height?: number; priority?: boolean }) {
  const width = Math.round((arucadLogo.width / arucadLogo.height) * height);
  return (
    <span className="brand-logo" style={{ height: height + 8 }}>
      <Image src={arucadLogo} alt="ARUCAD" height={height} width={width} priority={priority} unoptimized />
    </span>
  );
}
