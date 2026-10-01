// Renders the social card, src/assets/og.svg, to public/og.png: unfurlers (Slack, X, LinkedIn)
// do not render an SVG og:image. The PNG is committed rather than built in CI, whose fonts differ
// from the machine it was checked on, so re-run this after editing the SVG.
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const path = (relative) => fileURLToPath(new URL(relative, import.meta.url));

await sharp(path('../src/assets/og.svg')).png().toFile(path('../public/og.png'));
