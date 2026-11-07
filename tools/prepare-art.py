"""Prepare website-sized copies without changing the source artwork or fonts."""
import hashlib
import json
import shutil
import sys
from pathlib import Path
from PIL import Image

site = Path(__file__).resolve().parents[1]
project = site.parent
art = site / 'public' / 'art'
fonts = site / 'public' / 'fonts'
originals = site / 'artwork'
for folder in (art, fonts, originals):
    folder.mkdir(parents=True, exist_ok=True)

generated = Path(sys.argv[1])
original = originals / 'labraduck-detective-original.png'
if original.exists() and original.read_bytes() != generated.read_bytes():
    raise SystemExit('Keep the retained original; use a new revision for changed artwork.')
shutil.copyfile(generated, original)
inputs = [
    (original, art / 'labraduck-detective.webp', (960, 640)),
    (project / 'assets/branding/thats-my-egg-logo-v5.png', art / 'game-logo.png', (510, 249)),
    (project / 'assets/branding/promotion-v2/thats-my-egg-game-icon.png', art / 'game-icon.png', (64, 64)),
    (project / 'assets/ui/collection-biomes/backyard-v1.png', art / 'game-world.webp', (1440, 960)),
]
records = []
for source, target, size in inputs:
    with Image.open(source) as image:
        image.thumbnail(size, Image.Resampling.LANCZOS)
        image.save(target, **({'lossless': True, 'method': 6} if target.suffix == '.webp' and image.mode == 'RGBA' else {'quality': 86, 'method': 6} if target.suffix == '.webp' else {'optimize': True}))
        dimensions = list(image.size)
    records.append({'source': str(source), 'source_sha256': hashlib.sha256(source.read_bytes()).hexdigest(), 'runtime': str(target.relative_to(site)), 'dimensions': dimensions, 'bytes': target.stat().st_size, 'sha256': hashlib.sha256(target.read_bytes()).hexdigest()})

font_source = Path(sys.argv[2])
for weight in ('Medium', 'Bold', 'ExtraBold'):
    source = font_source / f'BuilderSans-{weight}.otf'
    target = fonts / source.name
    shutil.copyfile(source, target)
    records.append({'source': str(source), 'runtime': str(target.relative_to(site)), 'sha256': hashlib.sha256(target.read_bytes()).hexdigest(), 'unchanged_bytes': True})

manifest = {'date': '2026-11-07', 'art_tool': 'built-in image_gen', 'generated_original': str(original.relative_to(site)), 'prompt_file': 'artwork/prompt.txt', 'theme_source': 'src/ui_theme.luau', 'theme_source_sha256': hashlib.sha256((project / 'src/ui_theme.luau').read_bytes()).hexdigest(), 'design': 'Canonical logo, dark window/card colours, blue primary gradient and semantic Builder Sans weights. New Labraduck detective artwork. No replacement game UI renderer or new icon.', 'assets': records}
(originals / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'assets': len(records), 'runtime_art_bytes': sum(item.get('bytes', 0) for item in records)}, indent=2))
