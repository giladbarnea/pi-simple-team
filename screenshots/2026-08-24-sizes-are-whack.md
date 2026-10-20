No. I checked every file README.md references against the recommended range (~1760–2300 px wide). Here is the audit:

| Screenshot | Size | Verdict |
|---|---|---|
| `team-view.png` | 1883×1173 | Matches. This is the model citizen, both width and height. |
| `team-graph.png` | 2172×724 | Width matches. Height is short, but that is fine. It is a diagram, and less height just means less scroll. |
| `pi-simple-team-banner.png` | 1672×669 | About 5% under the floor. It is a decorative banner, not text, so this does not matter. |
| `team-status-multiple.png` | 2938×1772 | Over the ceiling by ~27%. |
| `team-log-multiple.png` | 2934×1124 | Over the ceiling by ~27%. |
| `abstract-tool-output-preview-640.png` | 640×360 | Deliberately small. It is the known preview-plus-link pattern, so it is exempt. |
| `abstract-tool-output-preview.png` | 1280×720 | Under the floor. On click-through, a 14" MacBook upscales it 2.4x, so it renders soft there. |

Two real deviations stand out:

**The 48% pair** (`team-status-multiple`, `team-log-multiple`). These render side by side at `width="48%"`, so inline they occupy about 420 CSS px, or ~840 physical px on Retina. Their ~2900 px sources get squeezed 3.5x, so terminal text loses sharpness exactly like the fullscreen-capture failure mode we discussed. Recapturing them at roughly half the width (about 1700–1900 px) would make them crisper and much lighter.

**The hero full version** (`abstract-tool-output-preview.png`, 1280 px). It sits below the crispness floor everywhere. It predates the convention, and since it links from the 640 px preview, recapturing it near ~1900 px wide would bring it in line.

